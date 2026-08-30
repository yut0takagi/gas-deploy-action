import type { DeployResult, MultiDeployResult, ResolvedTarget } from '@gas-deploy/core';

function section(title: string, items: string[]): string[] {
  if (items.length === 0) return [];
  return [`### ${title} (${items.length})`, '', ...items.map((item) => `- \`${item}\``), ''];
}

/**
 * 削除を独立した警告ブロックとして先頭に出す。
 *
 * 「追加 / 変更 / 削除」を同じ見出しで並べると、消えるファイルが他の変更に埋もれる。
 * 削除だけは復旧に Apps Script のバージョン履歴を遡る必要があり、レビューで見落とすと
 * 影響が大きい。PR コメントでも同じ関数を通るため、レビュー時に目に入る。
 */
function deletionNotice(deleted: string[]): string[] {
  if (deleted.length === 0) return [];
  return [
    `> [!WARNING]`,
    `> **以下の ${deleted.length} ファイルがリモートから削除されます**`,
    '>',
    ...deleted.map((name) => `> - \`${name}\``),
    '',
  ];
}

export function renderSummary(result: DeployResult): string {
  const lines: string[] = ['## GAS デプロイ結果', ''];

  if (!result.changed) {
    lines.push('差分がないため、変更はありません。', '');
  } else {
    lines.push(
      ...deletionNotice(result.diff.deleted),
      ...section('追加', result.diff.added),
      ...section('変更', result.diff.modified),
      ...section('削除', result.diff.deleted),
      `追加: ${result.diff.added.length} / 変更: ${result.diff.modified.length} / 削除: ${result.diff.deleted.length}`,
      '',
    );
  }

  const facts: string[] = [];
  if (result.versionNumber !== undefined) facts.push(`- バージョン: \`${result.versionNumber}\``);
  if (result.previousVersionNumber !== undefined) {
    facts.push(`- 更新前のバージョン: \`${result.previousVersionNumber}\`（ロールバック先）`);
  }
  if (result.deploymentId !== undefined) facts.push(`- デプロイ ID: \`${result.deploymentId}\``);
  if (result.webAppUrl !== undefined) facts.push(`- Web アプリ URL: ${result.webAppUrl}`);
  if (facts.length > 0) lines.push(...facts, '');

  if (result.warnings.length > 0) {
    lines.push('### ⚠️ 警告', '', ...result.warnings.map((warning) => `- ${warning}`), '');
  }

  return lines.join('\n');
}

/**
 * 複数プロジェクトモード用のサマリを描画する。
 *
 * `targets` は `resolveTargets` が返した対象一覧（宣言順）で、`result.completed` /
 * `result.failed` と突き合わせて「未実行のまま終わったプロジェクト」を導出するために使う。
 * 赤い実行結果だけを見て、どのプロジェクトが実際にデプロイ済みでどれが手つかずかを
 * 読み取れることが目的なので、失敗時はその状況を明示するセクションを必ず出す。
 */
export function renderMultiSummary(result: MultiDeployResult, targets: readonly ResolvedTarget[]): string {
  const lines: string[] = ['## GAS デプロイ結果（複数プロジェクト）', ''];

  for (const entry of result.completed) {
    lines.push(`### ${entry.project} (${entry.environment})`, '');
    lines.push(entry.result.changed ? '変更あり' : '差分がないため、変更はありません。', '');
    if (entry.result.changed) {
      lines.push(...deletionNotice(entry.result.diff.deleted));
    }

    const facts: string[] = [];
    if (entry.result.versionNumber !== undefined) facts.push(`- バージョン: \`${entry.result.versionNumber}\``);
    if (entry.result.previousVersionNumber !== undefined) {
      facts.push(`- 更新前のバージョン: \`${entry.result.previousVersionNumber}\`（ロールバック先）`);
    }
    if (entry.result.deploymentId !== undefined) facts.push(`- デプロイ ID: \`${entry.result.deploymentId}\``);
    if (entry.result.webAppUrl !== undefined) facts.push(`- Web アプリ URL: ${entry.result.webAppUrl}`);
    if (facts.length > 0) lines.push(...facts, '');

    if (entry.result.warnings.length > 0) {
      lines.push('#### ⚠️ 警告', '', ...entry.result.warnings.map((warning) => `- ${warning}`), '');
    }
  }

  if (result.failed) {
    const attempted = new Set(result.completed.map((entry) => entry.project));
    attempted.add(result.failed.project);
    const neverAttempted = targets.filter((target) => !attempted.has(target.project));

    lines.push(
      '### ❌ 失敗',
      '',
      `**${result.failed.project}** (${result.failed.environment}) のデプロイに失敗しました。以降のプロジェクトは実行されていません。`,
      '',
      result.failed.error.format(),
      '',
    );

    lines.push(
      '### デプロイ状況',
      '',
      `- 完了済み: ${result.completed.length > 0 ? result.completed.map((entry) => entry.project).join(', ') : 'なし'}`,
      `- 失敗: ${result.failed.project}`,
      `- 未実行: ${neverAttempted.length > 0 ? neverAttempted.map((target) => target.project).join(', ') : 'なし'}`,
      '',
    );
  }

  return lines.join('\n');
}
