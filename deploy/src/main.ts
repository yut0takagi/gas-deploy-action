import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as core from '@actions/core';
import {
  AppsScriptClient,
  DEFAULT_IGNORE,
  GasDeployError,
  deploy,
  deployAll,
  getAccessToken,
  parseClaspIgnore,
  parseConfig,
  parseCredentials,
  resolveTargets,
  type DeployTarget,
  type ProjectType,
  type ResolvedTarget,
} from '@gas-deploy/core';
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

function defaultDescription(): string {
  const sha = (process.env['GITHUB_SHA'] ?? 'local').slice(0, 7);
  const runNumber = process.env['GITHUB_RUN_NUMBER'] ?? '0';
  return `ci-${sha}-${runNumber}`;
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
 * 複数プロジェクトモードの設定ファイルを読み込む。
 * 存在しない場合は、script-id を使う単一プロジェクトモードか、設定ファイルを
 * 追加するかのどちらが必要かを案内する `GasDeployError` にする。
 */
export async function readConfigFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new GasDeployError(`設定ファイルが見つかりません: ${path}`, {
        cause: error,
        nextSteps: [
          '単一プロジェクトとしてデプロイする場合は script-id 入力を指定してください',
          `複数プロジェクトとしてデプロイする場合は ${path} に gasdeploy.yml 形式の設定ファイルを作成してください`,
          'config 入力で別のパスを指定している場合は、そのパスが正しいか確認してください',
        ],
      });
    }
    throw new GasDeployError(`設定ファイルを読み取れませんでした: ${path}`, {
      cause: error,
      nextSteps: [
        '設定ファイルのパーミッションを確認してください',
        'config パスがディレクトリになっていないか確認してください',
      ],
    });
  }
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
    });
  }
  return result;
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
  // ネットワーク呼び出し（getAccessToken / deploy）の前に、ローカルで検証できる入力を
  // すべて読み切って失敗させる。
  const rootDir = core.getInput('root-dir') || '.';
  const deploymentId = core.getInput('deployment-id');
  const descriptionInput = core.getInput('description');
  const projectType = parseProjectType(core.getInput('project-type') || 'standalone');
  const dryRun = parseBooleanInput('dry-run');
  const createVersion = parseBooleanInput('create-version');
  const ignore = await resolveIgnorePatterns(rootDir, core.getInput('ignore'));

  const credentials = parseCredentials(core.getInput('credentials', { required: true }));
  core.setSecret(credentials.clientSecret);
  core.setSecret(credentials.refreshToken);

  const accessToken = await getAccessToken(credentials);
  core.setSecret(accessToken);

  const result = await deploy(new AppsScriptClient(accessToken), {
    scriptId,
    rootDir,
    ignore,
    ...(deploymentId ? { deploymentId } : {}),
    projectType,
    dryRun,
    createVersion,
    description: descriptionInput || defaultDescription(),
  });

  for (const warning of result.warnings) {
    core.warning(warning);
  }

  const summary = renderSummary(result);
  core.setOutput('changed', String(result.changed));
  core.setOutput('version-number', result.versionNumber ?? '');
  core.setOutput('deployment-id', result.deploymentId ?? '');
  core.setOutput('web-app-url', result.webAppUrl ?? '');
  core.setOutput('summary', summary);

  await core.summary.addRaw(summary).write();
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

  const yamlText = await readConfigFile(configPath);
  const config = parseConfig(yamlText);
  const targets = resolveTargets(config, { environment, projects, env: process.env });

  const dryRun = parseBooleanInput('dry-run');
  const createVersion = parseBooleanInput('create-version');
  const descriptionInput = core.getInput('description');
  const deployTargets = await buildDeployTargets(targets, {
    ignoreInput: core.getInput('ignore'),
    dryRun,
    createVersion,
    description: descriptionInput || defaultDescription(),
  });

  const credentials = parseCredentials(core.getInput('credentials', { required: true }));
  core.setSecret(credentials.clientSecret);
  core.setSecret(credentials.refreshToken);

  const accessToken = await getAccessToken(credentials);
  core.setSecret(accessToken);

  const client = new AppsScriptClient(accessToken);
  const multiResult = await deployAll(client, deployTargets);

  // 完了したプロジェクトごとに警告を出す。10 プロジェクトの実行でどのプロジェクトの
  // 警告か分からなくならないよう、必ずプロジェクト名を前置する。
  for (const entry of multiResult.completed) {
    for (const warning of entry.result.warnings) {
      core.warning(`[${entry.project}] ${warning}`);
    }
  }

  const deployments = multiResult.completed.map((entry) => ({
    project: entry.project,
    environment: entry.environment,
    scriptId: entry.scriptId,
    changed: entry.result.changed,
    versionNumber: entry.result.versionNumber ?? null,
    deploymentId: entry.result.deploymentId ?? null,
    webAppUrl: entry.result.webAppUrl ?? null,
  }));

  const summary = renderMultiSummary(multiResult, targets);
  core.setOutput('changed', String(multiResult.changed));
  core.setOutput('deployments', JSON.stringify(deployments));
  core.setOutput('summary', summary);

  await core.summary.addRaw(summary).write();

  // deployAll は例外を投げず、代わりに failed を返す。ここで明示的に setFailed する
  // ことで、赤い実行結果からどのプロジェクトが完了/未実行かをサマリで追える状態を保ったまま
  // ジョブを失敗として報告できる（先に throw すると、この関数はサマリの書き込みや出力の
  // 設定を終える前に打ち切られてしまう）。
  if (multiResult.failed) {
    core.setFailed(multiResult.failed.error.format());
  }
}
