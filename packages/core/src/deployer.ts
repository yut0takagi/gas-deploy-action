import type { AppsScriptClient } from './api-client.js';
import { diffFiles, hasChanges } from './differ.js';
import { collectFiles } from './file-collector.js';
import type { FileDiff, ProjectType } from './types.js';

/** バージョン付きデプロイの上限。実測で確定（21個目で FAILED_PRECONDITION）。 */
export const DEPLOYMENT_LIMIT = 20;

/** 上限に達する手前で警告する。 */
export const DEPLOYMENT_COUNT_WARN_THRESHOLD = 18;

export interface DeployOptions {
  scriptId: string;
  rootDir: string;
  ignore: readonly string[];
  deploymentId?: string;
  projectType?: ProjectType;
  dryRun: boolean;
  createVersion: boolean;
  description: string;
}

export interface DeployResult {
  changed: boolean;
  diff: FileDiff;
  warnings: string[];
  versionNumber?: number;
  deploymentId?: string;
  webAppUrl?: string;
}

const URL_CHANGE_WARNING =
  'deployment-id が指定されていません。新しいデプロイが作成され、Web アプリの URL が変わります。既存の URL を維持するには deployment-id を指定してください';

export async function deploy(client: AppsScriptClient, options: DeployOptions): Promise<DeployResult> {
  const warnings: string[] = [];

  const local = await collectFiles(options.rootDir, options.ignore);
  const remote = await client.getContent(options.scriptId);
  const diff = diffFiles(local, remote);

  if (!hasChanges(diff)) {
    return { changed: false, diff, warnings };
  }

  // 差分がある場合にのみ警告する。何もしない実行で毎回警告すると、本当に危険な実行の
  // 警告が埋もれる。dry-run では「実際に走らせたらどうなるか」を示す必要があるため出す。
  const needsStableUrl = options.projectType === 'webapp' || options.projectType === 'addon';
  if (needsStableUrl && !options.deploymentId) {
    warnings.push(URL_CHANGE_WARNING);
  }

  if (options.dryRun) {
    return { changed: true, diff, warnings };
  }

  await client.updateContent(options.scriptId, local);

  if (!options.createVersion) {
    return { changed: true, diff, warnings };
  }

  const versionNumber = await client.createVersion(options.scriptId, options.description);

  const deployment = options.deploymentId
    ? await client.updateDeployment(options.scriptId, options.deploymentId, versionNumber, options.description)
    : await client.createDeployment(options.scriptId, versionNumber, options.description);

  const deployments = await client.listDeployments(options.scriptId);
  // @HEAD は常に存在し上限の対象外なので、総数ではなくバージョン付きのみを数える。
  const versioned = deployments.filter((entry) => entry.versionNumber !== undefined);
  if (versioned.length >= DEPLOYMENT_COUNT_WARN_THRESHOLD) {
    warnings.push(
      `バージョン付きデプロイ数が ${versioned.length} 件です。上限は ${DEPLOYMENT_LIMIT} 件なので、不要なデプロイを削除してください`,
    );
  }

  const result: DeployResult = { changed: true, diff, warnings, versionNumber, deploymentId: deployment.deploymentId };
  if (deployment.webAppUrl !== undefined) {
    result.webAppUrl = deployment.webAppUrl;
  }
  return result;
}
