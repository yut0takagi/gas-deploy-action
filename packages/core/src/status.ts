import type { AppsScriptClient } from './api-client.js';
import { GasDeployError } from './errors.js';
import { type Provenance, parseVersionDescription } from './provenance.js';
import type { Deployment } from './types.js';

export interface DeploymentStatus {
  deploymentId: string;
  /** `@HEAD` デプロイの場合は undefined。 */
  versionNumber?: number;
  /** バージョン説明の生の値。 */
  description?: string;
  createdAt?: string;
  webAppUrl?: string;
  /** 由来情報を復元できた場合のみ設定される。 */
  provenance?: Provenance;
}

export interface StatusOptions {
  scriptId: string;
  /** 省略時は、バージョン付きがちょうど1つ、または全体で1つの場合に自動特定する。 */
  deploymentId?: string;
}

function describeDeployment(deployment: Deployment): string {
  const version = deployment.versionNumber === undefined ? '@HEAD' : `v${deployment.versionNumber}`;
  return `${deployment.deploymentId} (${version})`;
}

/**
 * 対象のデプロイを特定する。
 *
 * `rollback` と同じ「バージョン付きがちょうど1つなら自動特定」の規則を採るが、実装は
 * 共有しない。`rollback` の分岐は `@HEAD` を書き換え不能として失敗させ、文言も
 * ロールバック前提になっている。読み取りである `status` では `@HEAD` は正常な報告対象で、
 * 同じコードに両方の意味を持たせると読めなくなる。
 */
async function resolveTargetDeployment(client: AppsScriptClient, scriptId: string): Promise<Deployment> {
  const deployments = await client.listDeployments(scriptId);

  if (deployments.length === 0) {
    throw new GasDeployError('このスクリプトにはデプロイがありません', {
      nextSteps: [
        'scriptId が正しいか確認してください（スクリプトエディタの「プロジェクトの設定」で確認できます）',
        'まだ一度もデプロイしていない場合は、先に deploy アクションを実行してください',
      ],
    });
  }

  const versioned = deployments.filter((entry) => entry.versionNumber !== undefined);

  if (versioned.length > 1) {
    throw new GasDeployError(`バージョン付きデプロイが ${versioned.length} 件あるため、対象を自動で特定できません`, {
      nextSteps: [
        'deployment-id 入力で対象を明示してください',
        `候補: ${versioned.map(describeDeployment).join(' / ')}`,
      ],
    });
  }

  // 上の分岐で0件か1件が確定している。1件ならそれが対象。
  const onlyVersioned = versioned[0];
  if (onlyVersioned !== undefined) {
    return onlyVersioned;
  }

  // ここに来るのはバージョン付きが0件の場合。@HEAD しか無いのは異常ではない。
  if (deployments.length > 1) {
    throw new GasDeployError(`バージョンを固定したデプロイがなく、@HEAD デプロイが ${deployments.length} 件あります`, {
      nextSteps: [
        'deployment-id 入力で対象を明示してください',
        `候補: ${deployments.map(describeDeployment).join(' / ')}`,
      ],
    });
  }

  const onlyDeployment = deployments[0];
  if (onlyDeployment === undefined) {
    // 冒頭で0件を弾き、直前で2件以上を弾いているので到達しない。
    // noUncheckedIndexedAccess のため明示的に扱う。
    throw new GasDeployError('デプロイ一覧の解決に失敗しました');
  }
  return onlyDeployment;
}

/**
 * デプロイが指すバージョンと、そこに埋め込まれた由来情報を取得する。
 *
 * 書き込みは一切しない。直前に書き込みが無いため、`rollback` が必要とする
 * 読み取り一貫性の待機も行わない。
 */
export async function getDeploymentStatus(
  client: AppsScriptClient,
  options: StatusOptions,
): Promise<DeploymentStatus> {
  let deployment: Deployment;
  if (options.deploymentId === undefined) {
    deployment = await resolveTargetDeployment(client, options.scriptId);
  } else {
    try {
      deployment = await client.getDeployment(options.scriptId, options.deploymentId);
    } catch (error) {
      // 404 のときだけ一覧を取って候補を示す。成功時に余分な API を叩かないため、
      // 一覧の取得は失敗経路に限る。
      if (error instanceof GasDeployError && error.code === 'not-found') {
        const deployments = await client.listDeployments(options.scriptId);
        throw new GasDeployError(`デプロイ ${options.deploymentId} が見つかりません`, {
          nextSteps: [
            'deployment-id が正しいか確認してください（スクリプトエディタの [デプロイ] → [デプロイを管理] で確認できます）',
            deployments.length > 0
              ? `このスクリプトのデプロイ: ${deployments.map(describeDeployment).join(' / ')}`
              : 'このスクリプトにはデプロイがありません',
          ],
        });
      }
      throw error;
    }
  }

  const status: DeploymentStatus = { deploymentId: deployment.deploymentId };
  if (deployment.webAppUrl !== undefined) status.webAppUrl = deployment.webAppUrl;

  if (deployment.versionNumber === undefined) {
    // @HEAD は常に最新のソースを指し、バージョンを持たない。由来情報も存在しない。
    return status;
  }

  status.versionNumber = deployment.versionNumber;
  const version = await client.getVersion(options.scriptId, deployment.versionNumber);
  if (version.createTime !== undefined) status.createdAt = version.createTime;
  if (version.description !== undefined) {
    status.description = version.description;
    const provenance = parseVersionDescription(version.description);
    if (provenance !== undefined) status.provenance = provenance;
  }
  return status;
}
