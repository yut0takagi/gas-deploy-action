import type { AppsScriptClient } from './api-client.js';
import type { ResolvedTarget } from './config.js';
import { deploy, type DeployOptions, type DeployResult } from './deployer.js';
import { GasDeployError } from './errors.js';

/**
 * `ResolvedTarget` にはプロジェクトごとの設定（scriptId, rootDir, ignore, ...）しか
 * 含まれない。dryRun / createVersion / description はプロジェクトごとではなく実行全体で
 * 共通の設定であり、config には現れない（呼び出し元の action 入力に由来する）ため、
 * `deploy()` に渡す前にこれらを合成する必要がある。この型がその合成後の形。
 */
export type DeployTarget = ResolvedTarget &
  Pick<DeployOptions, 'dryRun' | 'createVersion' | 'description' | 'allowDelete'>;

export interface ProjectDeployResult {
  project: string;
  environment: string;
  scriptId: string;
  result: DeployResult;
}

export interface MultiDeployResult {
  changed: boolean;
  completed: ProjectDeployResult[];
  failed?: { project: string; environment: string; error: GasDeployError };
}

export type DeployImpl = (client: AppsScriptClient, options: DeployOptions) => Promise<DeployResult>;

function toDeployOptions(target: DeployTarget): DeployOptions {
  const options: DeployOptions = {
    scriptId: target.scriptId,
    rootDir: target.rootDir,
    ignore: target.ignore,
    dryRun: target.dryRun,
    createVersion: target.createVersion,
    description: target.description,
  };
  if (target.allowDelete !== undefined) options.allowDelete = target.allowDelete;
  if (target.deploymentId !== undefined) options.deploymentId = target.deploymentId;
  if (target.projectType !== undefined) options.projectType = target.projectType;
  return options;
}

/**
 * 複数プロジェクトを宣言順に逐次デプロイする。
 *
 * API のレート制限があるため並列実行はしない。1件でも失敗したら直ちに停止し、
 * 例外を投げるのではなく `failed` を含む結果を通常どおり返す。ここで投げてしまうと、
 * 呼び出し元が「どこまで完了していたか」を失ってしまい、部分的な失敗が
 * 読み取れない状態になる（Action 全体で最も守りたい性質）。
 */
export async function deployAll(
  client: AppsScriptClient,
  targets: readonly DeployTarget[],
  deployImpl: DeployImpl = deploy,
): Promise<MultiDeployResult> {
  const completed: ProjectDeployResult[] = [];

  for (const target of targets) {
    let result: DeployResult;
    try {
      result = await deployImpl(client, toDeployOptions(target));
    } catch (cause) {
      const error =
        cause instanceof GasDeployError
          ? cause
          : new GasDeployError(
              `${target.project} (${target.environment}) のデプロイに失敗しました: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
              { cause },
            );
      return {
        changed: completed.some((entry) => entry.result.changed),
        completed,
        failed: { project: target.project, environment: target.environment, error },
      };
    }

    completed.push({ project: target.project, environment: target.environment, scriptId: target.scriptId, result });
  }

  return { changed: completed.some((entry) => entry.result.changed), completed };
}
