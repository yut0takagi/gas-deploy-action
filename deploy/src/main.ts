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

function parseProjectType(raw: string): ProjectType {
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

async function resolveIgnorePatterns(rootDir: string, rawInput: string): Promise<readonly string[]> {
  const fromInput = parseClaspIgnore(rawInput);
  if (fromInput.length > 0) {
    return fromInput;
  }
  try {
    const content = await readFile(join(rootDir, '.claspignore'), 'utf8');
    return parseClaspIgnore(content);
  } catch {
    return DEFAULT_IGNORE;
  }
}

async function run(): Promise<void> {
  const credentials = parseCredentials(core.getInput('credentials', { required: true }));
  core.setSecret(credentials.clientSecret);
  core.setSecret(credentials.refreshToken);

  const accessToken = await getAccessToken(credentials);
  core.setSecret(accessToken);

  const rootDir = core.getInput('root-dir') || '.';
  const deploymentId = core.getInput('deployment-id');
  const descriptionInput = core.getInput('description');

  const result = await deploy(new AppsScriptClient(accessToken), {
    scriptId: core.getInput('script-id', { required: true }),
    rootDir,
    ignore: await resolveIgnorePatterns(rootDir, core.getInput('ignore')),
    ...(deploymentId ? { deploymentId } : {}),
    projectType: parseProjectType(core.getInput('project-type') || 'standalone'),
    dryRun: core.getBooleanInput('dry-run'),
    createVersion: core.getBooleanInput('create-version'),
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

// esbuild の cjs 出力はトップレベル await を扱えないため、必ず関数の中で await する。
void run().catch((error: unknown) => {
  if (error instanceof GasDeployError) {
    core.setFailed(error.format());
  } else {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
});
