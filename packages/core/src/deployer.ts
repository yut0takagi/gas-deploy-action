import type { AppsScriptClient } from './api-client.js';
import { diffFiles, hasChanges } from './differ.js';
import { GasDeployError } from './errors.js';
import { collectFiles } from './file-collector.js';
import type { FileDiff, ProjectType } from './types.js';

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
  // updateDeployment でどのみち失敗するが、そこはファイル内容を書いた後であり、
  // 再実行しても差分ゼロと判定されて救済されない位置。手前で落とす方が安全。
  let previousVersionNumber: number | undefined;
  if (options.createVersion && options.deploymentId !== undefined) {
    previousVersionNumber = (await client.getDeployment(options.scriptId, options.deploymentId)).versionNumber;
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
  if (previousVersionNumber !== undefined) {
    result.previousVersionNumber = previousVersionNumber;
  }
  return result;
}
