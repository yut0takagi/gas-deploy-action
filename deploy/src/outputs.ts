import type { MultiDeployResult, ResolvedTarget } from '@gas-deploy/core';

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
