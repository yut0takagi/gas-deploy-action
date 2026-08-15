import * as core from '@actions/core';
import {
  AppsScriptClient,
  GasDeployError,
  getAccessToken,
  parseConfig,
  parseCredentials,
  readConfigFile,
  resolveTargets,
  rollback,
} from '@gas-deploy/core';
import { renderRollbackSummary } from './summary.js';

/** `core.getBooleanInput` の raw throw を、次の手順つきの `GasDeployError` に包み直す。 */
function parseBooleanInput(name: string): boolean {
  try {
    return core.getBooleanInput(name);
  } catch (error) {
    throw new GasDeployError(`${name} には true または false を指定してください`, {
      cause: error,
      nextSteps: [
        '現在の値は真偽値として解釈できません',
        'GitHub Actions の式を使う場合は ${{ ... }} が true / false を返すか確認してください',
      ],
    });
  }
}

/**
 * `version-number` 入力をパースする。空文字列は「1つ前に戻す」を意味する `undefined`。
 *
 * `Number()` に任せると "1.5" が 1.5、"1e3" が 1000、" 12 " が 12 として通ってしまい、
 * 意図しないバージョンに戻る。バージョン番号は 1 以上の整数しかありえないので、
 * 形として整数でないものはすべて入力ミスとして扱う。
 */
export function parseVersionNumberInput(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return undefined;
  }

  const invalid = (): never => {
    throw new GasDeployError(`version-number には 1 以上の整数を指定してください（実際の値: ${raw}）`, {
      nextSteps: [
        'バージョン番号は 1 から始まる整数です。小数や指数表記は使えません',
        'スクリプトエディタの [デプロイ] → [デプロイを管理] でバージョン番号を確認してください',
        '1つ前のバージョンに戻す場合は version-number を省略してください',
      ],
    });
  };

  if (!/^\d+$/.test(trimmed)) {
    invalid();
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1) {
    invalid();
  }
  return value;
}

export interface RollbackTarget {
  scriptId: string;
  deploymentId?: string;
}

/**
 * gasdeploy.yml から単一のロールバック対象を解決する。
 *
 * `resolveTargets` にプロジェクト名を1つだけ渡すことで、「そのプロジェクトはその
 * environment を持っていなければならない」という既存の検証をそのまま流用する。
 */
export function resolveConfigTarget(
  yamlText: string,
  environment: string,
  project: string,
  env: Record<string, string | undefined>,
): RollbackTarget {
  // resolveTargets は projects: ['all'] を「全プロジェクト」として解釈する。ここで弾かないと
  // 全対象が返り、その先頭1件だけが静かにロールバックされる。ユーザーが "all" と書いた意図
  // （全部）とも、実際の挙動（先頭1件）とも食い違う最悪の組み合わせになるため、明示的に拒否する。
  if (project === 'all') {
    throw new GasDeployError('project に "all" は指定できません。ロールバックは一度に1プロジェクトのみを対象とします', {
      nextSteps: [
        'ロールバックするプロジェクト名を1つ指定してください',
        '複数プロジェクトを戻す必要がある場合は、プロジェクトごとにこの Action を実行してください',
        '障害時に無関係なプロジェクトまで巻き戻さないための制約です',
      ],
    });
  }

  const config = parseConfig(yamlText);
  const targets = resolveTargets(config, { environment, projects: [project], env });

  if (targets.length > 1) {
    // 単一のプロジェクト名を渡している以上ここには到達しないはずだが、到達した場合に
    // 先頭を黙って採用すると、意図しないプロジェクトを巻き戻すことになる。
    throw new GasDeployError(`${project} (${environment}) が ${targets.length} 件のロールバック対象に解決されました`, {
      nextSteps: ['gasdeploy.yml のプロジェクト定義に重複がないか確認してください'],
    });
  }

  const target = targets[0];
  if (target === undefined) {
    // resolveTargets は明示指定したプロジェクトが解決できない場合に必ず例外を投げるため、
    // ここには到達しないはず。到達したとしても、空配列を「成功」と誤読して
    // 後続が undefined を触るより、明示的に失敗させる。
    throw new GasDeployError(`${project} (${environment}) のロールバック対象を解決できませんでした`, {
      nextSteps: [
        'gasdeploy.yml に該当するプロジェクトと environment が定義されているか確認してください',
      ],
    });
  }
  return target.deploymentId === undefined
    ? { scriptId: target.scriptId }
    : { scriptId: target.scriptId, deploymentId: target.deploymentId };
}

export async function run(): Promise<void> {
  // ネットワーク呼び出しの前に、ローカルで判定できる入力をすべて読み切って失敗させる。
  const versionNumber = parseVersionNumberInput(core.getInput('version-number'));
  const dryRun = parseBooleanInput('dry-run');
  const descriptionInput = core.getInput('description');
  const deploymentIdInput = core.getInput('deployment-id');

  const scriptIdInput = core.getInput('script-id');
  let target: RollbackTarget;
  if (scriptIdInput) {
    target = { scriptId: scriptIdInput };
  } else {
    const environment = core.getInput('environment');
    const project = core.getInput('project');
    if (!environment || !project) {
      throw new GasDeployError('config モードでは environment と project の両方の指定が必要です', {
        nextSteps: [
          'environment 入力に gasdeploy.yml で定義した環境名（例: prod）を指定してください',
          'project 入力にロールバックするプロジェクト名を1つ指定してください',
          'ロールバックは一度に1プロジェクトのみを対象とします。障害時に無関係なプロジェクトまで巻き戻さないための制約です',
          'gasdeploy.yml を使わない場合は script-id 入力で直接指定してください',
        ],
      });
    }
    const configPath = core.getInput('config') || 'gasdeploy.yml';
    const yamlText = await readConfigFile(configPath, {
      notFoundSteps: [
        'scriptId を直接指定する場合は script-id 入力を使ってください',
        `gasdeploy.yml を使う場合は ${configPath} に設定ファイルを作成してください`,
        'config 入力で別のパスを指定している場合は、そのパスが正しいか確認してください',
      ],
    });
    target = resolveConfigTarget(yamlText, environment, project, process.env);
  }

  // deployment-id 入力は config の値より優先する。障害対応で config を書き換えずに
  // 特定のデプロイを名指ししたい場面があるため。
  const deploymentId = deploymentIdInput || target.deploymentId;

  const credentials = parseCredentials(core.getInput('credentials', { required: true }));
  core.setSecret(credentials.clientSecret);
  core.setSecret(credentials.refreshToken);

  const accessToken = await getAccessToken(credentials);
  core.setSecret(accessToken);

  const result = await rollback(new AppsScriptClient(accessToken), {
    scriptId: target.scriptId,
    ...(deploymentId ? { deploymentId } : {}),
    ...(versionNumber !== undefined ? { versionNumber } : {}),
    dryRun,
    ...(descriptionInput ? { description: descriptionInput } : {}),
  });

  for (const warning of result.warnings) {
    core.warning(warning);
  }

  const summary = renderRollbackSummary(result);
  core.setOutput('rolled-back', String(result.rolledBack));
  core.setOutput('from-version', String(result.fromVersion));
  core.setOutput('to-version', String(result.toVersion));
  core.setOutput('deployment-id', result.deploymentId);
  core.setOutput('web-app-url', result.webAppUrl ?? '');
  core.setOutput('summary', summary);

  await core.summary.addRaw(summary).write();
}
