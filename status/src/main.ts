import * as core from '@actions/core';
import {
  AppsScriptClient,
  type DeploymentStatus,
  GasDeployError,
  getAccessToken,
  getDeploymentStatus,
  parseConfig,
  parseCredentials,
  readConfigFile,
  resolveTargets,
} from '@gas-deploy/core';
import { renderStatusSummary } from './summary.js';

export interface StatusTargetResult {
  /** config モードのみ。単一対象モードでは設定しない。 */
  project?: string;
  environment?: string;
  scriptId: string;
  deploymentId?: string;
  versionNumber?: number;
  /** 由来情報を復元できたか。 */
  managed: boolean;
  sha?: string;
  runId?: string;
  pr?: number;
  actor?: string;
  createdAt?: string;
  webAppUrl?: string;
  /** 読み取りに失敗した場合のメッセージ。 */
  error?: string;
}

interface StatusTarget {
  project?: string;
  environment?: string;
  scriptId: string;
  deploymentId?: string;
}

export function parseProjectsInput(raw: string): string[] {
  return raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

export interface ResolveStatusTargetsOptions {
  environment: string;
  projects: readonly string[];
  /** 空文字列は「未指定」を意味する。 */
  deploymentIdInput: string;
  env: Record<string, string | undefined>;
}

/**
 * config モードの対象一覧を解決する。
 *
 * deployment-id はスクリプト単位の ID なので、複数プロジェクトに同じ値を当てはめると
 * 対象外のプロジェクトは軒並み 404 になり、サマリが「取得失敗」の行で埋まる。これは
 * rollback が project: "all" を禁じているのと同じ理由なので、ここでも対象が複数
 * 解決された場合は拒否する。
 */
export function resolveStatusTargets(yamlText: string, options: ResolveStatusTargetsOptions): StatusTarget[] {
  const config = parseConfig(yamlText);
  const targets = resolveTargets(config, {
    environment: options.environment,
    projects: [...options.projects],
    env: options.env,
  });

  if (options.deploymentIdInput && targets.length > 1) {
    throw new GasDeployError('deployment-id を指定した場合、対象は1つのプロジェクトに限られます', {
      nextSteps: [
        'deployment-id はスクリプトごとに異なる ID のため、複数プロジェクトに同じ値を当てはめることはできません',
        'projects 入力を1つのプロジェクト名に絞ってください（または script-id 入力で直接指定してください）',
        'deployment-id を省略すると、各対象のデプロイをそれぞれ自動で特定します',
      ],
    });
  }

  return targets.map((target) => {
    // deployment-id 入力は config の値より優先する。障害対応で config を書き換えずに
    // 特定のデプロイを名指ししたい場面があるため。
    const deploymentId = options.deploymentIdInput || target.deploymentId;
    return {
      project: target.project,
      environment: target.environment,
      scriptId: target.scriptId,
      ...(deploymentId ? { deploymentId } : {}),
    };
  });
}

/**
 * 取得結果を出力用の形に平坦化する。
 *
 * `error` にはメッセージだけを入れる。`cause` には API の生レスポンスが入りうるため、
 * 出力とサマリには絶対に載せない。
 *
 * `{ status } | { error }` のような単純な共用体では「どちらも渡さない」は弾けるが、
 * 「両方渡す」は弾けない。TypeScript の過剰プロパティチェックは、共用体のどのメンバーにも
 * 存在しないキーしか拒否しないため、`status` は片方のメンバーに、`error` はもう片方の
 * メンバーに存在する以上、両方同時に渡したオブジェクトリテラルも型チェックを通ってしまう
 * （実行時は `error` が黙って勝つ）。各メンバーで相手のキーを `?: never` として明示的に
 * 塞ぐことで、「両方」も「どちらも無し」も型エラーにする。
 */
export function toTargetResult(
  target: StatusTarget,
  outcome: { status: DeploymentStatus; error?: never } | { status?: never; error: unknown },
): StatusTargetResult {
  const result: StatusTargetResult = { scriptId: target.scriptId, managed: false };
  if (target.project !== undefined) result.project = target.project;
  if (target.environment !== undefined) result.environment = target.environment;

  if ('error' in outcome) {
    const error = outcome.error;
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }

  const status = outcome.status;
  result.deploymentId = status.deploymentId;
  if (status.versionNumber !== undefined) result.versionNumber = status.versionNumber;
  if (status.createdAt !== undefined) result.createdAt = status.createdAt;
  if (status.webAppUrl !== undefined) result.webAppUrl = status.webAppUrl;

  const provenance = status.provenance;
  if (provenance !== undefined) {
    result.managed = true;
    result.sha = provenance.sha;
    if (provenance.runId !== undefined) result.runId = provenance.runId;
    if (provenance.pr !== undefined) result.pr = provenance.pr;
    if (provenance.actor !== undefined) result.actor = provenance.actor;
  }
  return result;
}

export async function run(): Promise<void> {
  // ネットワーク呼び出しの前に、ローカルで判定できる入力を読み切る。
  const scriptIdInput = core.getInput('script-id');
  const deploymentIdInput = core.getInput('deployment-id');

  let targets: StatusTarget[];
  if (scriptIdInput) {
    targets = [
      { scriptId: scriptIdInput, ...(deploymentIdInput ? { deploymentId: deploymentIdInput } : {}) },
    ];
  } else {
    const environment = core.getInput('environment');
    if (!environment) {
      throw new GasDeployError('environment の指定が必要です（config モードでは必須です）', {
        nextSteps: [
          'environment 入力に gasdeploy.yml で定義した環境名（例: prod）を指定してください',
          'gasdeploy.yml を使わない場合は script-id 入力で直接指定してください',
        ],
      });
    }
    const configPath = core.getInput('config') || 'gasdeploy.yml';
    const projects = parseProjectsInput(core.getInput('projects') || 'all');
    const yamlText = await readConfigFile(configPath, {
      notFoundSteps: [
        'scriptId を直接指定する場合は script-id 入力を使ってください',
        `gasdeploy.yml を使う場合は ${configPath} に設定ファイルを作成してください`,
        'config 入力で別のパスを指定している場合は、そのパスが正しいか確認してください',
      ],
    });
    targets = resolveStatusTargets(yamlText, { environment, projects, deploymentIdInput, env: process.env });
  }

  const credentials = parseCredentials(core.getInput('credentials', { required: true }));
  core.setSecret(credentials.clientSecret);
  core.setSecret(credentials.refreshToken);

  const accessToken = await getAccessToken(credentials);
  core.setSecret(accessToken);
  const client = new AppsScriptClient(accessToken);

  // 全対象を試行してから返す。読み取りなので途中で止めると「調べたかったのに一部しか
  // 分からない」という最も困る結果になる。
  const results: StatusTargetResult[] = [];
  for (const target of targets) {
    try {
      const status = await getDeploymentStatus(client, {
        scriptId: target.scriptId,
        ...(target.deploymentId ? { deploymentId: target.deploymentId } : {}),
      });
      results.push(toTargetResult(target, { status }));
    } catch (error) {
      results.push(toTargetResult(target, { error }));
    }
  }

  const summary = renderStatusSummary(results);
  core.setOutput('summary', summary);

  if (scriptIdInput) {
    const only = results[0];
    if (only === undefined) {
      // 単一対象モードでは必ず1件ある。noUncheckedIndexedAccess のため明示的に扱う。
      throw new GasDeployError('対象の解決に失敗しました');
    }
    core.setOutput('managed', String(only.managed));
    core.setOutput('version-number', only.versionNumber ?? '');
    core.setOutput('sha', only.sha ?? '');
    core.setOutput('run-id', only.runId ?? '');
    core.setOutput('pr', only.pr ?? '');
    core.setOutput('actor', only.actor ?? '');
    core.setOutput('created-at', only.createdAt ?? '');
    core.setOutput('deployment-id', only.deploymentId ?? '');
    core.setOutput('web-app-url', only.webAppUrl ?? '');
  } else {
    core.setOutput('targets', JSON.stringify(results));
  }

  await core.summary.addRaw(summary).write();

  const failed = results.filter((result) => result.error !== undefined);
  if (failed.length > 0) {
    core.setFailed(`${failed.length} 件の対象で状況を取得できませんでした`);
  }
}
