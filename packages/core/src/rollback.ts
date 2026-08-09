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

/**
 * 読み取りが安定するまでの最大試行回数。実測では書き込みから約 8.5 秒で安定した。
 */
export const STABILITY_ATTEMPTS = 6;

/** 安定化のための読み取り間隔。 */
export const STABILITY_DELAY_MS = 2000;

/**
 * `deployments.update` の直後、`deployments.list` は数秒間にわたり古い値を返しうる。
 * さらに読み取りは単調ですらなく、新しい値 → 古い値 → 新しい値 と揺れる（実測）。
 * レプリカごとに反映状況が異なるためと思われる。
 *
 * これを放置すると、デプロイ直後のロールバックが古い versionNumber を「現在」と
 * 誤認し、意図より1つ余計に古いバージョンへ静かに戻る。障害対応で最もありがちな
 * 流れがそのまま事故になるため、連続2回の読み取りが一致するまで待つ。
 *
 * これは確率を下げるだけで、保証ではない（2回とも同じ古いレプリカに当たる可能性は
 * 残る）。確実性が要る場面では version-number を明示すること。
 */
async function getDeploymentStable(
  client: AppsScriptClient,
  scriptId: string,
  deploymentId: string,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<{ deployment: Deployment; stable: boolean }> {
  let previous = await client.getDeployment(scriptId, deploymentId);
  for (let attempt = 1; attempt < STABILITY_ATTEMPTS; attempt += 1) {
    await sleep(STABILITY_DELAY_MS);
    const current = await client.getDeployment(scriptId, deploymentId);
    if (current.versionNumber === previous.versionNumber) {
      return { deployment: current, stable: true };
    }
    previous = current;
  }
  return { deployment: previous, stable: false };
}

export interface RollbackOptions {
  scriptId: string;
  /** 省略時は、バージョン付きデプロイがちょうど1つある場合に限り自動で特定する。 */
  deploymentId?: string;
  /** 省略時は現在のバージョンの1つ前。 */
  versionNumber?: number;
  dryRun: boolean;
  /** 省略時は戻し元・戻り先のバージョンを含む既定の説明。 */
  description?: string;
  /** 読み取り安定化の待機。テストから差し替えるためだけの入口。 */
  sleep?: (milliseconds: number) => Promise<void>;
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
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  // 一覧は「どのデプロイを対象にするか」の特定にのみ使う。デプロイが @HEAD かどうかや
  // その ID は反映遅延で入れ替わらないので、一覧の鮮度は問題にならない。
  const deployments = await client.listDeployments(options.scriptId);
  const resolved = resolveTargetDeployment(deployments, options.deploymentId);

  // 現在のバージョンは一覧ではなく単体取得から確定させる。一覧は書き込み後に
  // 複数のレプリカ状態を行き来する（実測）。
  const { deployment: target, stable } = await getDeploymentStable(
    client,
    options.scriptId,
    resolved.deploymentId,
    sleep,
  );

  // 読み取りが安定しないまま「1つ前」を計算すると、意図より古いバージョンへ戻りうる。
  // 戻り先が明示されている場合は影響が無害な範囲（無操作判定とロールフォワード判定）に
  // 留まるので、警告して続行する。
  if (!stable && options.versionNumber === undefined) {
    throw new GasDeployError('デプロイの現在のバージョンを確定できませんでした（読み取りが安定していません）', {
      nextSteps: [
        'デプロイの直後は、Apps Script API がしばらく古い値を返すことがあります',
        'version-number 入力で戻り先のバージョンを明示してください（明示すればこの問題の影響を受けません）',
        '数十秒待ってから再実行しても解消します',
      ],
    });
  }

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

  if (!stable) {
    // ここに来るのは version-number が明示されている場合のみ（未指定なら上で失敗する）。
    warnings.push(
      `デプロイの現在のバージョンの読み取りが安定していません。戻り先の v${options.versionNumber} は指定どおりですが、現在のバージョンとして表示している v${fromVersion} は実際と異なる可能性があります`,
    );
  }

  if (toVersion === fromVersion) {
    // 「すでにそうなっている」を成功として黙って返すと、ロールバックが効いたのか
    // 元から同じだったのか区別できない。書き込みは行わず、その旨を警告として残す。
    warnings.push(`デプロイはすでに v${toVersion} を指しています。変更は行いませんでした`);
    return { rolledBack: false, deploymentId: resolved.deploymentId, fromVersion, toVersion, warnings };
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
    deploymentId: resolved.deploymentId,
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
  const updated = await client.updateDeployment(options.scriptId, resolved.deploymentId, toVersion, description);

  result.rolledBack = true;
  if (updated.webAppUrl !== undefined) result.webAppUrl = updated.webAppUrl;
  return result;
}
