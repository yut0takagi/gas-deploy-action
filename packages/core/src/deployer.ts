import type { AppsScriptClient } from './api-client.js';
import { diffFiles, hasChanges } from './differ.js';
import { GasDeployError } from './errors.js';
import { collectFiles } from './file-collector.js';
import type { Deployment, FileDiff, ProjectType, ScriptFile } from './types.js';

/** バージョン付きデプロイの上限。実測で確定（21個目で FAILED_PRECONDITION）。 */
export const DEPLOYMENT_LIMIT = 20;

/** 上限に達する手前で警告する。 */
export const DEPLOYMENT_COUNT_WARN_THRESHOLD = 18;

/**
 * 削除がこの割合以上を占める場合に、事故とみなして停止する。
 * root-dir の指定ミスやビルド失敗で、稼働中のスクリプトが空になるのを防ぐ。
 */
export const MASS_DELETION_RATIO = 0.5;

/** 1〜2 件の通常の削除で止めないための下限。 */
export const MASS_DELETION_MIN_FILES = 2;

/**
 * 削除が事故の規模かどうか。
 *
 * 「1件でも削除なら止める」にはしていない。ファイルを1つ消すたびに入力の追加を
 * 求めることになり、やがて allow-delete を恒久的に true にして置きっぱなしにする。
 * そうなると、本当に止めたい事故のときにも素通りする。止める対象を事故の規模だけに
 * 絞ることで、フラグを立てる行為そのものに意味を残す。
 */
export function isMassDeletion(deletedCount: number, remoteCount: number): boolean {
  return deletedCount >= MASS_DELETION_MIN_FILES && deletedCount >= Math.ceil(remoteCount * MASS_DELETION_RATIO);
}

export interface DeployOptions {
  scriptId: string;
  rootDir: string;
  ignore: readonly string[];
  deploymentId?: string;
  projectType?: ProjectType;
  dryRun: boolean;
  createVersion: boolean;
  description: string;
  /**
   * 事故の規模の削除を許可する。既定は false で、その場合は書き込まずに失敗する。
   * 意図的な大量削除（レイアウト変更、旧ファイルの一括整理）のときだけ true にする。
   */
  allowDelete?: boolean;
}

export interface DeployResult {
  changed: boolean;
  diff: FileDiff;
  warnings: string[];
  versionNumber?: number;
  deploymentId?: string;
  webAppUrl?: string;
  /**
   * このデプロイが書き換わる前に指していたバージョン番号。ロールバック先として使える。
   * `deploymentId` を指定して実際にデプロイを更新した場合のみ設定される。
   */
  previousVersionNumber?: number;
  /**
   * ファイルの差分は無かったが、HEAD がデプロイに反映されていなかったため、バージョンの
   * 作成とデプロイの更新だけを行った（dry-run では、行う予定である）。true のときだけ設定される。
   */
  resumed?: true;
}

const URL_CHANGE_WARNING =
  'deployment-id が指定されていません。新しいデプロイが作成され、Web アプリの URL が変わります。既存の URL を維持するには deployment-id を指定してください';

/**
 * HEAD とデプロイが指すバージョンの関係。
 *
 * - `in-sync`: HEAD の内容がデプロイに反映されている
 * - `behind`: 反映されておらず、デプロイを最後に指し直したのもこの Action である。
 *   前回の実行が updateContent の後、バージョンの作成かデプロイの更新の手前で止まった状態
 * - `pinned`: 反映されていないが、デプロイは rollback や手動の操作で指し直されている
 */
type DeploymentState = 'in-sync' | 'behind' | 'pinned';

/**
 * 差分ゼロのときに、HEAD がデプロイに反映されているかを確かめる。
 *
 * 差分は HEAD と比べて取るので、HEAD だけ更新されてバージョンの作成やデプロイの更新が
 * 失敗した実行のあとでは、再実行しても差分ゼロになり何も直らない。そこで、デプロイが指す
 * バージョンの内容まで見に行く。
 *
 * ずれていても、それが前回の失敗とは限らない。rollback でデプロイを戻した直後は、HEAD に
 * 問題のコードが残っているので必ずずれる。ここで HEAD を出し直すと、README だけの push で
 * ロールバックが静かに巻き戻る。両者は「デプロイを最後に指し直したのは誰か」で分ける。
 * この Action はバージョンとデプロイに同じ説明を付ける。rollback は既定で
 * `rollback to v<N> (was v<M>)` を付けるので一致しない。説明の無いデプロイも、
 * この Action が作ったものではないので `pinned` に倒す。
 */
async function compareHeadWithDeployment(
  client: AppsScriptClient,
  scriptId: string,
  deployment: Deployment,
  head: ScriptFile[],
): Promise<DeploymentState> {
  // @HEAD のデプロイは常に HEAD を指すので、遅れようがない。
  if (deployment.versionNumber === undefined) {
    return 'in-sync';
  }

  const deployed = await client.getContent(scriptId, deployment.versionNumber);
  if (!hasChanges(diffFiles(head, deployed))) {
    return 'in-sync';
  }

  const version = await client.getVersion(scriptId, deployment.versionNumber);
  return deployment.description !== undefined && deployment.description === version.description
    ? 'behind'
    : 'pinned';
}

interface PublishContext {
  diff: FileDiff;
  warnings: string[];
  previousVersionNumber?: number;
  resumed?: true;
}

/** バージョンを作り、デプロイをそれに向ける。updateContent の後段で、通常の経路とやり直しの経路が共有する。 */
async function publish(
  client: AppsScriptClient,
  options: DeployOptions,
  context: PublishContext,
): Promise<DeployResult> {
  const { diff, warnings } = context;
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
  if (context.previousVersionNumber !== undefined) {
    result.previousVersionNumber = context.previousVersionNumber;
  }
  if (context.resumed) {
    result.resumed = true;
  }
  return result;
}

/**
 * 差分ゼロのときの処理。HEAD がデプロイに反映されていなければ、前回の実行の続きを行う。
 *
 * 確かめるのは deployment-id がありバージョンを作る設定のときだけ。deployment-id が無いと
 * 毎回新しいデプロイを作るので、比べる相手が決まらない。
 */
async function deployUnchangedHead(
  client: AppsScriptClient,
  options: DeployOptions,
  head: ScriptFile[],
  diff: FileDiff,
): Promise<DeployResult> {
  const warnings: string[] = [];
  if (!options.createVersion || options.deploymentId === undefined) {
    return { changed: false, diff, warnings };
  }

  // 書き込みの直後は getDeployment が古い値を返しうる（実測）。数秒おきに続けて実行すると
  // ずれていると誤認し、同じ内容のバージョンをもう1つ作ることがある。害はバージョンが
  // 1つ増えるだけで、デプロイが指す内容は変わらない。
  const deployment = await client.getDeployment(options.scriptId, options.deploymentId);
  const state = await compareHeadWithDeployment(client, options.scriptId, deployment, head);

  if (state === 'in-sync') {
    return { changed: false, diff, warnings };
  }

  if (state === 'pinned') {
    warnings.push(
      `デプロイ ${options.deploymentId} が指す v${deployment.versionNumber} は HEAD と内容が異なりますが、rollback などで意図的に指し直された状態とみなし、変更しませんでした。` +
        'HEAD を反映するには、ファイルを変更してからデプロイするか、rollback アクションの version-number で反映先のバージョンを指定してください',
    );
    return { changed: false, diff, warnings };
  }

  warnings.push(
    `ファイルの差分はありませんが、HEAD がデプロイ ${options.deploymentId}（v${deployment.versionNumber}）に反映されていません。` +
      '前回の実行がバージョンの作成かデプロイの更新の手前で失敗したとみなし、その2つだけを行います',
  );

  if (options.dryRun) {
    return { changed: true, diff, warnings, resumed: true };
  }

  const context: PublishContext = { diff, warnings, resumed: true };
  // behind はバージョン付きのデプロイでしか起きない（@HEAD は in-sync になる）。
  if (deployment.versionNumber !== undefined) {
    context.previousVersionNumber = deployment.versionNumber;
  }
  return publish(client, options, context);
}

export async function deploy(client: AppsScriptClient, options: DeployOptions): Promise<DeployResult> {
  const warnings: string[] = [];

  const local = await collectFiles(options.rootDir, options.ignore);
  const remote = await client.getContent(options.scriptId);
  const diff = diffFiles(local, remote);

  if (!hasChanges(diff)) {
    return deployUnchangedHead(client, options, remote, diff);
  }

  // 差分がある場合にのみ警告する。何もしない実行で毎回警告すると、本当に危険な実行の
  // 警告が埋もれる。dry-run では「実際に走らせたらどうなるか」を示す必要があるため出す。
  const needsStableUrl = options.projectType === 'webapp' || options.projectType === 'addon';
  if (needsStableUrl && !options.deploymentId) {
    warnings.push(URL_CHANGE_WARNING);
  }

  const massDeletion = isMassDeletion(diff.deleted.length, remote.length);
  if (massDeletion) {
    warnings.push(
      `リモートの ${remote.length} 件のうち ${diff.deleted.length} 件が削除されます: ${diff.deleted.join(', ')}`,
    );
  }

  // dry-run は「実際に走らせたらどうなるか」を見るためのもの。ここで失敗させると、
  // 削除の内容を確認してから allow-delete を判断する、という手順が踏めなくなる。
  // 警告は上で出しているので、消えるファイルは dry-run でも読める。
  if (options.dryRun) {
    return { changed: true, diff, warnings };
  }

  // 書き込みの直前で止める。collectFiles と getContent は済んでいるが、どちらも読み取り
  // であり、リモートには何も起きていない。
  if (massDeletion && options.allowDelete !== true) {
    throw new GasDeployError(
      `リモートの ${remote.length} 件のうち ${diff.deleted.length} 件が削除されるため、デプロイを中止しました`,
      {
        nextSteps: [
          `削除されるファイル: ${diff.deleted.join(', ')}`,
          'root-dir の指定が正しいか確認してください（誤ったディレクトリを指すと、リモートのファイルがほぼすべて削除されます）',
          'ビルドを伴う構成では、ビルドが成功して出力が揃っているか確認してください',
          '.claspignore で意図せず除外されているファイルが無いか確認してください',
          'この削除が意図したものであれば allow-delete: true を指定してください',
          'dry-run: true で実行すると、書き込まずに削除内容だけを確認できます',
        ],
      },
    );
  }

  // 参照先を書き換える前に、いま指しているバージョンを記録する。
  //
  // ここで読むことが重要。Apps Script API のデプロイ読み取りは書き込み直後の一貫性を
  // 保証せず、実測では deployments.list が30秒以上古い値を返し続けた。更新後に読むと
  // 「ロールバック先」として誤った番号を渡すことになる。この時点ならまだ何も書いて
  // いないため、その問題に巻き込まれない。
  //
  // 読めなければデプロイ全体を失敗させる。deployment-id が誤っていれば後段の
  // updateDeployment でどのみち失敗するが、そこはファイル内容を書いた後になる。
  // 手前で落とす方が、リモートを中途半端な状態にしない。
  const context: PublishContext = { diff, warnings };
  if (options.createVersion && options.deploymentId !== undefined) {
    const previousVersionNumber = (await client.getDeployment(options.scriptId, options.deploymentId)).versionNumber;
    if (previousVersionNumber !== undefined) {
      context.previousVersionNumber = previousVersionNumber;
    }
  }

  await client.updateContent(options.scriptId, local);

  if (!options.createVersion) {
    return { changed: true, diff, warnings };
  }

  return publish(client, options, context);
}
