/**
 * 実 GAS に対する E2E 検証（テスト戦略レベル4）。
 *
 * push → getContent 検証 → デプロイ → ロールバック → 後片付け を実 API に通す。
 * モックでは絶対に捕まらない種類の破綻（clasp 互換の崩れ、API 仕様の変更、スコープの
 * 不足、読み取り一貫性の悪化）を検出するのが目的である。
 *
 * ⚠️ 指定した scriptId の内容を実際に書き換える。専用のテストプロジェクトにのみ向けること。
 *
 * 後片付けについて:
 * - HEAD は必ず元の内容に戻す（失敗しても finally で戻す）
 * - デプロイは固定の deploymentId を毎回更新するため、20個の上限には近づかない
 * - バージョンは1回の実行で1つ増える。Apps Script にバージョンを削除する API は存在しない
 *   ため、これは仕様上避けられない（週次で年52個。上限はデプロイ数のみで、バージョン数には無い）
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AppsScriptClient,
  GasDeployError,
  type ScriptFile,
  deploy,
  getAccessToken,
  parseCredentials,
  rollback,
} from '@gas-deploy/core';

/** 読み取り一貫性の収束待ち。実測で30秒以上ずれることがあるため余裕を持たせる。 */
const CONVERGENCE_ATTEMPTS = 15;
const CONVERGENCE_INTERVAL_MS = 5_000;

const steps: string[] = [];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`環境変数 ${name} が設定されていません`);
  }
  return value;
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`検証に失敗しました: ${message}`);
  }
  steps.push(`- OK: ${message}`);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function findManifest(files: readonly ScriptFile[]): ScriptFile {
  const manifest = files.find((file) => file.name === 'appsscript');
  if (manifest === undefined) {
    throw new Error('対象プロジェクトに appsscript.json がありません。scriptId を確認してください');
  }
  return manifest;
}

/**
 * デプロイが指すバージョンが期待値に収束するまで待つ。
 *
 * Apps Script API のデプロイ読み取りは書き込み直後の一貫性を保証しない。ここで即座に
 * 判定すると、実装ではなく API の遅延で E2E が落ちる。
 */
async function waitForDeploymentVersion(
  client: AppsScriptClient,
  scriptId: string,
  deploymentId: string,
  expected: number,
): Promise<void> {
  let observed: number | undefined;
  for (let attempt = 1; attempt <= CONVERGENCE_ATTEMPTS; attempt += 1) {
    const deployment = await client.getDeployment(scriptId, deploymentId);
    observed = deployment.versionNumber;
    if (observed === expected) {
      steps.push(`- OK: デプロイが v${expected} に収束しました（${attempt}回目の読み取り）`);
      return;
    }
    if (attempt < CONVERGENCE_ATTEMPTS) {
      await sleep(CONVERGENCE_INTERVAL_MS);
    }
  }
  throw new Error(
    `デプロイが v${expected} に収束しませんでした（最後に観測した値: ${observed ?? 'なし'}）。` +
      'Apps Script API 側の読み取り一貫性が悪化している可能性があります',
  );
}

async function main(): Promise<void> {
  const credentials = parseCredentials(requireEnv('GAS_E2E_CREDENTIALS'));
  const scriptId = requireEnv('GAS_E2E_SCRIPT_ID');
  const deploymentId = requireEnv('GAS_E2E_DEPLOYMENT_ID');
  const runId = process.env.GITHUB_RUN_ID ?? `local-${process.pid}`;

  const client = new AppsScriptClient(await getAccessToken(credentials));

  // 元の内容を先に確保する。これが取れない限り安全に書き換えられない。
  const original = await client.getContent(scriptId);
  const manifest = findManifest(original);
  assert(original.length > 0, `元の内容を取得できました（${original.length} ファイル）`);

  const rootDir = await mkdtemp(join(tmpdir(), 'gas-e2e-'));
  let restored = false;
  try {
    const marker = `e2e-${runId}`;
    await writeFile(join(rootDir, 'appsscript.json'), manifest.source, 'utf8');
    await writeFile(join(rootDir, 'Code.js'), `function e2eMarker() {\n  return '${marker}';\n}\n`, 'utf8');
    // .claspignore 互換の除外が実 API 経路でも効くことを確認するための、除外されるべきファイル。
    await writeFile(join(rootDir, 'Skipped.test.js'), 'function shouldNotBeUploaded() {}\n', 'utf8');

    const deployResult = await deploy(client, {
      scriptId,
      rootDir,
      ignore: ['**/*.test.js'],
      deploymentId,
      dryRun: false,
      createVersion: true,
      description: marker,
    });

    assert(deployResult.changed, 'デプロイが差分を検出しました');
    assert(deployResult.versionNumber !== undefined, `バージョン v${deployResult.versionNumber} を作成しました`);
    assert(
      deployResult.previousVersionNumber !== undefined,
      `更新前のバージョン v${deployResult.previousVersionNumber} を取得できました`,
    );

    const afterDeploy = await client.getContent(scriptId);
    assert(
      afterDeploy.some((file) => file.name === 'Code' && file.source.includes(marker)),
      'アップロードした内容が HEAD に反映されています',
    );
    assert(
      !afterDeploy.some((file) => file.name === 'Skipped.test'),
      'ignore パターンに一致するファイルはアップロードされていません',
    );

    const target = deployResult.previousVersionNumber as number;
    const rollbackResult = await rollback(client, {
      scriptId,
      deploymentId,
      versionNumber: target,
      dryRun: false,
    });

    assert(rollbackResult.rolledBack, `デプロイを v${rollbackResult.fromVersion} → v${target} に戻しました`);
    assert(rollbackResult.toVersion === target, 'ロールバック先が指定したバージョンと一致します');
    await waitForDeploymentVersion(client, scriptId, deploymentId, target);

    const afterRollback = await client.getContent(scriptId);
    assert(
      afterRollback.some((file) => file.name === 'Code' && file.source.includes(marker)),
      'ロールバックしても HEAD は戻らない（仕様どおりの挙動）ことを確認しました',
    );

    await client.updateContent(scriptId, original);
    restored = true;
    steps.push('- OK: HEAD を元の内容に復元しました');
  } finally {
    if (!restored) {
      // 途中で失敗した場合も、マーカー入りの内容を残さない。復元自体が失敗したら
      // その事実を必ず出す（黙って握り潰すと、次回の実行が汚れた HEAD から始まる）。
      try {
        await client.updateContent(scriptId, original);
        steps.push('- OK: 失敗しましたが HEAD は元の内容に復元しました');
      } catch (error) {
        steps.push(`- 要対応: HEAD の復元に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await rm(rootDir, { recursive: true, force: true });
  }
}

void main()
  .then(() => {
    console.log(['E2E 検証: 成功', '', ...steps].join('\n'));
  })
  .catch((error: unknown) => {
    console.error(
      [
        'E2E 検証: 失敗',
        '',
        ...steps,
        '',
        error instanceof GasDeployError ? error.format() : error instanceof Error ? error.message : String(error),
      ].join('\n'),
    );
    process.exitCode = 1;
  });
