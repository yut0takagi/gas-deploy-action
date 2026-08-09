import type { AppsScriptClient } from './api-client.js';
import { GasDeployError } from './errors.js';
import type { Deployment } from './types.js';

/**
 * ロールバックで最も誤解されやすい点。必ず出す。
 *
 * ロールバックが書き換えるのはデプロイが指すバージョン番号だけで、プロジェクトの HEAD
 * （エディタで開いたときに見えるソース、および `projects.getContent` が返す内容）は
 * 問題のあるコードのまま残る。この状態でリポジトリを直さずに次のデプロイを走らせると、
 * 差分は「その後の変更」だけでも、作られるバージョンは問題のあるコードを含んだ HEAD
 * 全体のスナップショットになる。結果としてロールバックが静かに巻き戻る。
 *
 * この文言に「新しい」を含めないこと（ロールフォワード警告と区別できなくなる）。
 */
export const HEAD_NOT_REVERTED_WARNING =
  'ロールバックはデプロイの参照先バージョンを変更するだけで、スクリプトの HEAD（エディタ上のソース）は元に戻りません。リポジトリ側も revert しないと、次回のデプロイで問題のあるコードが再び本番に反映されます';

export interface RollbackOptions {
  scriptId: string;
  /** 省略時は、バージョン付きデプロイがちょうど1つある場合に限り自動で特定する。 */
  deploymentId?: string;
  /** 省略時は現在のバージョンの1つ前。 */
  versionNumber?: number;
  dryRun: boolean;
  /** 省略時は戻し元・戻り先のバージョンを含む既定の説明。 */
  description?: string;
}

export interface RollbackResult {
  /** 実際にデプロイを書き換えたか。dry-run と「すでに戻り先を指していた」場合は false。 */
  rolledBack: boolean;
  deploymentId: string;
  fromVersion: number;
  toVersion: number;
  toVersionDescription?: string;
  toVersionCreateTime?: string;
  webAppUrl?: string;
  warnings: string[];
}

function describeDeployment(deployment: Deployment): string {
  const description = deployment.description ? `: ${deployment.description}` : '';
  return `${deployment.deploymentId} (v${deployment.versionNumber})${description}`;
}

/**
 * 書き換える対象のデプロイを1つに絞り込む。
 *
 * 自動特定を「バージョン付きデプロイがちょうど1つ」に限るのは、複数ある状況（本番と
 * ステージングを同じスクリプトで運用している等）で当てずっぽうに選ぶと、無関係な環境を
 * 巻き戻す事故になるため。曖昧なら選ばずに候補を見せて止める。
 */
function resolveTargetDeployment(deployments: readonly Deployment[], deploymentId: string | undefined): Deployment {
  // @HEAD は versionNumber を持たない。常に最新ソースを指す性質上、バージョンを
  // 指し直すという操作自体が成立しないので、候補から外す。
  const versioned = deployments.filter((entry) => entry.versionNumber !== undefined);

  if (deploymentId !== undefined) {
    const found = deployments.find((entry) => entry.deploymentId === deploymentId);
    if (found === undefined) {
      throw new GasDeployError(`デプロイ ${deploymentId} が見つかりません`, {
        nextSteps: [
          'deployment-id が正しいか確認してください（スクリプトエディタの [デプロイ] → [デプロイを管理] で確認できます）',
          versioned.length > 0
            ? `このスクリプトのバージョン付きデプロイ: ${versioned.map(describeDeployment).join(' / ')}`
            : 'このスクリプトにはバージョン付きデプロイがありません',
        ],
      });
    }
    if (found.versionNumber === undefined) {
      throw new GasDeployError(`デプロイ ${deploymentId} は @HEAD（バージョン未固定）のためロールバックできません`, {
        nextSteps: [
          '@HEAD のデプロイは常に最新のソースを指すため、特定のバージョンに戻すことはできません',
          'バージョンを固定したデプロイの ID を指定してください',
          'HEAD のソース自体を戻したい場合は、リポジトリを revert して通常のデプロイを実行してください',
        ],
      });
    }
    return found;
  }

  if (versioned.length === 0) {
    throw new GasDeployError('ロールバックできるバージョン付きデプロイがありません', {
      nextSteps: [
        'このスクリプトには @HEAD のデプロイしかありません。@HEAD は常に最新のソースを指すため、バージョンを戻すことはできません',
        'HEAD のソース自体を戻したい場合は、リポジトリを revert して通常のデプロイを実行してください',
      ],
    });
  }

  if (versioned.length > 1) {
    throw new GasDeployError(`バージョン付きデプロイが ${versioned.length} 件あるため、対象を自動で特定できません`, {
      nextSteps: [
        'deployment-id 入力でロールバック対象を明示してください',
        `候補: ${versioned.map(describeDeployment).join(' / ')}`,
      ],
    });
  }

  // 上の分岐で length === 1 が確定しているが、noUncheckedIndexedAccess のため明示的に扱う。
  const only = versioned[0];
  if (only === undefined) {
    throw new GasDeployError('デプロイ一覧の解決に失敗しました');
  }
  return only;
}

/**
 * デプロイが指すバージョンを過去のバージョンに戻す。
 *
 * ファイル内容の書き込み（`updateContent`）もバージョンの作成（`versions.create`）も
 * 行わない。書き込みは `deployments.update` の1回だけで、これはべき等なので、
 * 途中で失敗しても中途半端な状態は残らない。
 */
export async function rollback(client: AppsScriptClient, options: RollbackOptions): Promise<RollbackResult> {
  const deployments = await client.listDeployments(options.scriptId);
  const target = resolveTargetDeployment(deployments, options.deploymentId);

  // resolveTargetDeployment が versionNumber を持つものだけを返すことは保証されているが、
  // 型としては optional なので明示的に取り出す。
  const fromVersion = target.versionNumber;
  if (fromVersion === undefined) {
    throw new GasDeployError('デプロイのバージョン番号を取得できませんでした');
  }

  let toVersion: number;
  if (options.versionNumber !== undefined) {
    toVersion = options.versionNumber;
  } else {
    if (fromVersion <= 1) {
      throw new GasDeployError(
        `デプロイは最初のバージョン（v${fromVersion}）を指しているため、戻り先がありません`,
        {
          nextSteps: [
            'ロールバック先となる過去のバージョンが存在しません',
            'version-number 入力で戻り先を明示すると、そのバージョンを指定できます',
          ],
        },
      );
    }
    toVersion = fromVersion - 1;
  }

  const warnings: string[] = [HEAD_NOT_REVERTED_WARNING];

  if (toVersion === fromVersion) {
    // 「すでにそうなっている」を成功として黙って返すと、ロールバックが効いたのか
    // 元から同じだったのか区別できない。書き込みは行わず、その旨を警告として残す。
    warnings.push(`デプロイはすでに v${toVersion} を指しています。変更は行いませんでした`);
    return { rolledBack: false, deploymentId: target.deploymentId, fromVersion, toVersion, warnings };
  }

  // 戻り先の実在確認。dry-run でも必ず行う。ここを省くと dry-run が
  // 「実行すれば成功する」という誤った確信だけを与える。
  let version;
  try {
    version = await client.getVersion(options.scriptId, toVersion);
  } catch (error) {
    if (error instanceof GasDeployError && error.status === 404) {
      throw new GasDeployError(`バージョン ${toVersion} は存在しません`, {
        cause: error,
        nextSteps: [
          'スクリプトエディタの [デプロイ] → [デプロイを管理] で、実在するバージョン番号を確認してください',
          `現在デプロイされているのは v${fromVersion} です`,
          'scriptId が正しいか確認してください（スクリプト自体が存在しない場合も 404 になります）',
        ],
      });
    }
    throw error;
  }

  if (toVersion > fromVersion) {
    warnings.push(
      `指定された v${toVersion} は現在の v${fromVersion} より新しいバージョンです。これはロールバックではなくロールフォワードです`,
    );
  }

  const result: RollbackResult = {
    rolledBack: false,
    deploymentId: target.deploymentId,
    fromVersion,
    toVersion,
    warnings,
  };
  if (version.description !== undefined) result.toVersionDescription = version.description;
  if (version.createTime !== undefined) result.toVersionCreateTime = version.createTime;

  if (options.dryRun) {
    return result;
  }

  const description = options.description ?? `rollback to v${toVersion} (was v${fromVersion})`;
  const updated = await client.updateDeployment(options.scriptId, target.deploymentId, toVersion, description);

  result.rolledBack = true;
  if (updated.webAppUrl !== undefined) result.webAppUrl = updated.webAppUrl;
  return result;
}
