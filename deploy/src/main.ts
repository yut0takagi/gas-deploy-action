import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as core from '@actions/core';
import {
  AppsScriptClient,
  DEFAULT_IGNORE,
  GasDeployError,
  buildVersionDescription,
  deploy,
  deployAll,
  parseClaspIgnore,
  parseConfig,
  parseCredentials,
  preflight,
  readConfigFile,
  resolveTargets,
  type DeployTarget,
  type MultiDeployResult,
  type ProjectType,
  type ProvenanceSource,
  type ResolvedTarget,
} from '@gas-deploy/core';
import { resolvePullRequestNumber, upsertComment } from './comment.js';
import { renderMultiSummary, renderSummary } from './summary.js';

const PROJECT_TYPES: ProjectType[] = ['webapp', 'addon', 'bound', 'standalone'];

export function parseProjectType(raw: string): ProjectType {
  if ((PROJECT_TYPES as string[]).includes(raw)) {
    return raw as ProjectType;
  }
  throw new GasDeployError(`project-type の値が不正です: ${raw}`, {
    nextSteps: [`次のいずれかを指定してください: ${PROJECT_TYPES.join(' | ')}`],
  });
}

/**
 * イベントペイロードを読む。読めない・壊れている場合は undefined を返す。
 *
 * 由来情報と PR コメントの両方が同じファイルを必要とし、以前はそれぞれが readFile と
 * JSON.parse と catch を個別に持っていた。片方だけを直したときに catch の範囲がずれる
 * （実際にずれていた）ため1箇所にまとめる。JSON.parse は成功時に undefined を返さない
 * ので、undefined は「取得できなかった」ことだけを意味する。
 * cause は付けない（ペイロードには非公開のリポジトリ情報が含まれうる）。
 */
async function readEventPayload(eventPath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(eventPath, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * 由来情報の材料を GHA の環境変数とイベントペイロードから集める。
 *
 * 各項目は独立に読む。揃っていることは前提にしない（Actions 外では全て欠けるが、
 * それを保証するのは実行環境であってこの関数ではない）。「sha が無ければ由来情報を
 * 作らない」という判断は buildVersionDescription 側が持つ。
 */
export async function resolveProvenanceSource(
  env: Record<string, string | undefined>,
): Promise<ProvenanceSource> {
  const source: ProvenanceSource = {};

  const sha = env['GITHUB_SHA'];
  if (sha) source.sha = sha;
  const runId = env['GITHUB_RUN_ID'];
  if (runId) source.runId = runId;
  const actor = env['GITHUB_ACTOR'];
  if (actor) source.actor = actor;

  const eventPath = env['GITHUB_EVENT_PATH'];
  if (eventPath) {
    const payload = await readEventPayload(eventPath);
    if (payload !== undefined) {
      const pr = resolvePullRequestNumber(payload);
      if (pr !== undefined) source.pr = pr;
    }
  }

  return source;
}

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

export async function resolveIgnorePatterns(rootDir: string, rawInput: string): Promise<readonly string[]> {
  const fromInput = parseClaspIgnore(rawInput);
  if (fromInput.length > 0) {
    return fromInput;
  }
  try {
    return parseClaspIgnore(await readFile(join(rootDir, '.claspignore'), 'utf8'));
  } catch (error) {
    // ファイルが無いのは正常。既定値にフォールバックする。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return DEFAULT_IGNORE;
    }
    // 存在するのに読めない場合に黙って既定値へ落とすと、利用者が除外したつもりの
    // ファイルがデプロイされる。既定値は実際の .claspignore よりはるかに狭い。
    throw new GasDeployError('.claspignore を読み取れませんでした', {
      cause: error,
      nextSteps: [
        '.claspignore のパーミッションを確認してください',
        '.claspignore がディレクトリになっていないか確認してください',
        '意図的に除外設定を使わない場合は、.claspignore を削除するか ignore 入力を指定してください',
      ],
    });
  }
}

/** `projects` 入力をパースする。空文字列または `all` は「全プロジェクト」を意味する `undefined`。 */
export function parseProjectsInput(raw: string): string[] | undefined {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'all') {
    return undefined;
  }
  return trimmed
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * ターゲットの `ignore` を解決する。`resolveTargets` はプロジェクトにも defaults にも
 * ignore が無いとき `[]` を返す。この空を「除外パターン無し」と早合点せず、単一プロジェクト
 * モードと同じ優先順位（ignore 入力 → .claspignore → DEFAULT_IGNORE）にフォールバックする
 * かどうかは、config を知らない core 側ではなくこのアダプタが決める。
 */
export async function resolveTargetIgnore(
  target: Pick<ResolvedTarget, 'ignore' | 'rootDir'>,
  ignoreInput: string,
): Promise<readonly string[]> {
  if (target.ignore.length > 0) {
    return target.ignore;
  }
  return resolveIgnorePatterns(target.rootDir, ignoreInput);
}

export interface GlobalDeployOptions {
  ignoreInput: string;
  dryRun: boolean;
  createVersion: boolean;
  description: string;
  allowDelete: boolean;
}

/**
 * `resolveTargets` が返す `ResolvedTarget`（プロジェクトごとの設定）に、dry-run /
 * create-version / description といった実行全体で共通の設定（config には現れない、
 * action 入力由来の値）を合成し、`deployAll` にそのまま渡せる形にする。
 */
export async function buildDeployTargets(
  targets: readonly ResolvedTarget[],
  options: GlobalDeployOptions,
): Promise<DeployTarget[]> {
  const result: DeployTarget[] = [];
  for (const target of targets) {
    const ignore = await resolveTargetIgnore(target, options.ignoreInput);
    result.push({
      ...target,
      ignore,
      dryRun: options.dryRun,
      createVersion: options.createVersion,
      description: options.description,
      allowDelete: options.allowDelete,
    });
  }
  return result;
}

export type DeploymentStatus = 'deployed' | 'unchanged' | 'failed' | 'skipped';

export interface DeploymentOutputEntry {
  project: string;
  environment: string;
  scriptId: string;
  status: DeploymentStatus;
  versionNumber?: number;
  /** 更新前に指していたバージョン番号。ロールバック先として使える。 */
  previousVersionNumber?: number;
  deploymentId?: string;
  webAppUrl?: string;
  error?: string;
}

/**
 * `deployments` 出力を組み立てる。`multiResult.completed` だけを使うと、失敗後に
 * 未実行のまま終わったプロジェクトが配列から静かに消える。`continue-on-error: true` で
 * この出力を機械的にパースする利用者は、3件中3件成功した実行と、5件中2件が未実行だった
 * 実行を区別できなくなる。それを防ぐため、必ず `targets`（宣言順の全対象）を基準にし、
 * 各要素に status を持たせて「何も欠けていない」配列にする。
 *
 * `error` には `GasDeployError#message` のみを入れる。`nextSteps` は人間向けの手順であり、
 * `cause` には API の生レスポンスなど秘匿情報を含みうるため、機械可読な出力に含めない。
 */
export function buildDeploymentsOutput(
  targets: readonly ResolvedTarget[],
  multiResult: MultiDeployResult,
): DeploymentOutputEntry[] {
  const completedByProject = new Map(multiResult.completed.map((entry) => [entry.project, entry] as const));

  return targets.map((target) => {
    const completedEntry = completedByProject.get(target.project);
    if (completedEntry !== undefined) {
      const entry: DeploymentOutputEntry = {
        project: target.project,
        environment: target.environment,
        scriptId: target.scriptId,
        status: completedEntry.result.changed ? 'deployed' : 'unchanged',
      };
      if (completedEntry.result.versionNumber !== undefined) entry.versionNumber = completedEntry.result.versionNumber;
      if (completedEntry.result.previousVersionNumber !== undefined)
        entry.previousVersionNumber = completedEntry.result.previousVersionNumber;
      if (completedEntry.result.deploymentId !== undefined) entry.deploymentId = completedEntry.result.deploymentId;
      if (completedEntry.result.webAppUrl !== undefined) entry.webAppUrl = completedEntry.result.webAppUrl;
      return entry;
    }

    if (multiResult.failed !== undefined && target.project === multiResult.failed.project) {
      return {
        project: target.project,
        environment: target.environment,
        scriptId: target.scriptId,
        status: 'failed',
        error: multiResult.failed.error.message,
      };
    }

    return {
      project: target.project,
      environment: target.environment,
      scriptId: target.scriptId,
      status: 'skipped',
    };
  });
}

export interface PrCommentContext {
  owner: string;
  repo: string;
  prNumber: number;
}

/**
 * PR コメントの宛先を GHA の環境変数から決める。PR の実行でなければ undefined。
 *
 * push で走らせているワークフローに comment-on-pr が付いたままでも失敗させない。
 * 「PR ではない」は異常ではなく通常の状態として扱う。
 */
export async function resolvePrCommentContext(
  env: Record<string, string | undefined>,
): Promise<PrCommentContext | undefined> {
  const repository = env['GITHUB_REPOSITORY'];
  const eventPath = env['GITHUB_EVENT_PATH'];
  if (!repository || !eventPath) {
    return undefined;
  }

  const [owner, repo] = repository.split('/');
  if (!owner || !repo) {
    return undefined;
  }

  // ペイロードが読めない・壊れているのはコメントを諦めるに足る理由だが、
  // デプロイを止める理由にはならない。
  const payload = await readEventPayload(eventPath);
  if (payload === undefined) {
    return undefined;
  }

  const prNumber = resolvePullRequestNumber(payload);
  if (prNumber === undefined) {
    return undefined;
  }
  return { owner, repo, prNumber };
}

/**
 * サマリを PR にコメントする。
 *
 * 失敗しても例外にしない。コメントは補助であり、成功した本番デプロイを赤い実行結果として
 * 報告すると、それを見て動くロールバック自動化や人間の判断を誤らせる。内容自体は
 * この時点で既にジョブサマリに書き出してあるので、コメントが出なくても失われない。
 */
async function commentIfRequested(enabled: boolean, summary: string, defaultKey: string): Promise<void> {
  if (!enabled) {
    return;
  }

  const token = core.getInput('github-token');
  if (!token) {
    core.warning('comment-on-pr が有効ですが github-token が空のため、コメントを投稿しません');
    return;
  }
  core.setSecret(token);

  const context = await resolvePrCommentContext(process.env);
  if (context === undefined) {
    core.info('PR の実行ではないため、コメントは投稿しません');
    return;
  }

  const key = core.getInput('comment-key') || defaultKey;
  try {
    const result = await upsertComment({ ...context, token }, key, summary);
    core.info(
      `PR #${context.prNumber} のコメントを${result.action === 'created' ? '作成' : '更新'}しました (id: ${result.id})`,
    );
  } catch (error) {
    core.warning(
      `PR へのコメントに失敗しました（デプロイ自体の結果は上記のとおりで、この失敗の影響を受けていません）: ${
        error instanceof GasDeployError ? error.format() : String(error)
      }`,
    );
  }
}

export async function run(): Promise<void> {
  // script-id が指定されていれば単一プロジェクトモード、無ければ config を使う
  // 複数プロジェクトモード。両者を混ぜると挙動が予測しづらくなるため、
  // script-id が有るときは config を一切読まない。
  const scriptId = core.getInput('script-id');
  if (scriptId) {
    await runSingleProject(scriptId);
    return;
  }
  await runMultiProject();
}

async function runSingleProject(scriptId: string): Promise<void> {
  // ネットワーク呼び出し（preflight / deploy）の前に、ローカルで検証できる入力を
  // すべて読み切って失敗させる。
  const rootDir = core.getInput('root-dir') || '.';
  const deploymentId = core.getInput('deployment-id');
  const descriptionInput = core.getInput('description');
  const projectType = parseProjectType(core.getInput('project-type') || 'standalone');
  const dryRun = parseBooleanInput('dry-run');
  const createVersion = parseBooleanInput('create-version');
  const allowDelete = parseBooleanInput('allow-delete');
  const commentOnPr = parseBooleanInput('comment-on-pr');
  const ignore = await resolveIgnorePatterns(rootDir, core.getInput('ignore'));
  const provenanceSource = await resolveProvenanceSource(process.env);
  const versionDescription = buildVersionDescription(provenanceSource, descriptionInput);
  for (const warning of versionDescription.warnings) {
    core.warning(warning);
  }

  const credentials = parseCredentials(core.getInput('credentials', { required: true }));
  core.setSecret(credentials.clientSecret);
  core.setSecret(credentials.refreshToken);

  // 単一プロジェクトでは scriptIds を渡さない。deploy() が書き込みの前に必ず
  // getContent を呼ぶため、ここで projects.get を足しても得られる情報は同じで、
  // リクエストが1つ増えるだけになる。スコープの検証だけを先に済ませる。
  const { accessToken, warnings: preflightWarnings } = await preflight({ credentials, scriptIds: [] });
  core.setSecret(accessToken);
  for (const warning of preflightWarnings) {
    core.warning(warning);
  }

  const result = await deploy(new AppsScriptClient(accessToken), {
    scriptId,
    rootDir,
    ignore,
    ...(deploymentId ? { deploymentId } : {}),
    projectType,
    dryRun,
    createVersion,
    allowDelete,
    description: versionDescription.description,
  });

  for (const warning of result.warnings) {
    core.warning(warning);
  }

  const summary = renderSummary(result);
  core.setOutput('changed', String(result.changed));
  core.setOutput('version-number', result.versionNumber ?? '');
  core.setOutput('previous-version-number', result.previousVersionNumber ?? '');
  core.setOutput('deployment-id', result.deploymentId ?? '');
  core.setOutput('web-app-url', result.webAppUrl ?? '');
  core.setOutput('summary', summary);

  await core.summary.addRaw(summary).write();

  // 単一プロジェクトモードには環境という概念が無いため、既定のキーは固定。1つの
  // ワークフローで複数回実行する場合は comment-key で分ける必要がある。
  await commentIfRequested(commentOnPr, summary, 'default');
}

async function runMultiProject(): Promise<void> {
  // environment はネットワーク呼び出しは元より、設定ファイルの読み込みより前に検証する。
  // 単一プロジェクトモードと同じく「ローカルで判定できる入力ミスは、I/O の前に落とす」順序。
  const environment = core.getInput('environment');
  if (!environment) {
    throw new GasDeployError('environment の指定が必要です（複数プロジェクトモードでは必須です）', {
      nextSteps: [
        'environment 入力に gasdeploy.yml で定義した環境名（例: prod, dev）を指定してください',
        '単一プロジェクトとしてデプロイする場合は script-id 入力を指定してください',
      ],
    });
  }

  const configPath = core.getInput('config') || 'gasdeploy.yml';
  const projects = parseProjectsInput(core.getInput('projects') || 'all');

  const yamlText = await readConfigFile(configPath, {
    notFoundSteps: [
      '単一プロジェクトとしてデプロイする場合は script-id 入力を指定してください',
      `複数プロジェクトとしてデプロイする場合は ${configPath} に gasdeploy.yml 形式の設定ファイルを作成してください`,
      'config 入力で別のパスを指定している場合は、そのパスが正しいか確認してください',
    ],
  });
  const config = parseConfig(yamlText);
  const targets = resolveTargets(config, { environment, projects, env: process.env });

  const dryRun = parseBooleanInput('dry-run');
  const createVersion = parseBooleanInput('create-version');
  const allowDelete = parseBooleanInput('allow-delete');
  const commentOnPr = parseBooleanInput('comment-on-pr');
  const descriptionInput = core.getInput('description');
  const provenanceSource = await resolveProvenanceSource(process.env);
  const versionDescription = buildVersionDescription(provenanceSource, descriptionInput);
  for (const warning of versionDescription.warnings) {
    core.warning(warning);
  }
  const deployTargets = await buildDeployTargets(targets, {
    ignoreInput: core.getInput('ignore'),
    dryRun,
    createVersion,
    allowDelete,
    description: versionDescription.description,
  });

  const credentials = parseCredentials(core.getInput('credentials', { required: true }));
  core.setSecret(credentials.clientSecret);
  core.setSecret(credentials.refreshToken);

  // 逐次デプロイなので、3件目で権限切れに気づくと1・2件目は既に置き換わった後になる。
  // 対象全件の読み取り権限をここでまとめて確認し、1件でも欠ければ何も書かずに止める。
  // 同じプロジェクトを複数の対象が指す構成がありうるため、重複は除いてから渡す。
  const scriptIds = [...new Set(targets.map((target) => target.scriptId))];
  const { accessToken, warnings: preflightWarnings } = await preflight({ credentials, scriptIds });
  core.setSecret(accessToken);
  for (const warning of preflightWarnings) {
    core.warning(warning);
  }
  core.info(`デプロイ前の確認: ${scriptIds.length} 件のプロジェクトの読み取り権限を確認しました`);

  const client = new AppsScriptClient(accessToken);
  const multiResult = await deployAll(client, deployTargets);

  // 完了したプロジェクトごとに警告を出す。10 プロジェクトの実行でどのプロジェクトの
  // 警告か分からなくならないよう、必ずプロジェクト名を前置する。
  for (const entry of multiResult.completed) {
    for (const warning of entry.result.warnings) {
      core.warning(`[${entry.project}] ${warning}`);
    }
  }

  const deployments = buildDeploymentsOutput(targets, multiResult);

  const summary = renderMultiSummary(multiResult, targets);
  core.setOutput('changed', String(multiResult.changed));
  core.setOutput('deployments', JSON.stringify(deployments));
  core.setOutput('summary', summary);

  await core.summary.addRaw(summary).write();

  // 既定のキーを environment にすることで、同じ PR に dev と prod のコメントが
  // 並んでも互いを上書きしない。
  await commentIfRequested(commentOnPr, summary, environment);

  // deployAll は例外を投げず、代わりに failed を返す。ここで明示的に setFailed する
  // ことで、赤い実行結果からどのプロジェクトが完了/未実行かをサマリで追える状態を保ったまま
  // ジョブを失敗として報告できる（先に throw すると、この関数はサマリの書き込みや出力の
  // 設定を終える前に打ち切られてしまう）。
  if (multiResult.failed) {
    core.setFailed(multiResult.failed.error.format());
  }
}
