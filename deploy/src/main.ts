import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as core from '@actions/core';
import {
  AppsScriptClient,
  DEFAULT_IGNORE,
  GasDeployError,
  deploy,
  getAccessToken,
  parseClaspIgnore,
  parseCredentials,
  type ProjectType,
} from '@gas-deploy/core';
import { renderSummary } from './summary.js';

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

export async function run(): Promise<void> {
  // ネットワーク呼び出し（getAccessToken / deploy）の前に、ローカルで検証できる入力を
  // すべて読み切って失敗させる。script-id が無いだけで OAuth トークンを無駄に取得しない。
  const rootDir = core.getInput('root-dir') || '.';
  const scriptId = core.getInput('script-id', { required: true });
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
