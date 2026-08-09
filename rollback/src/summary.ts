import type { RollbackResult } from '@gas-deploy/core';

/**
 * ロールバック結果を Markdown で描画する。
 *
 * 「何が起きたか」より先に「何が起きていないか」が伝わることを重視する。ロールバックは
 * 本番だけを直して HEAD を残すので、実行後に安心して終わられるのが最悪の結末になる。
 */
export function renderRollbackSummary(result: RollbackResult): string {
  const lines: string[] = ['## GAS ロールバック結果', ''];

  if (result.rolledBack) {
    lines.push(`デプロイ \`${result.deploymentId}\` を **v${result.fromVersion} → v${result.toVersion}** に戻しました。`, '');
  } else if (result.fromVersion === result.toVersion) {
    lines.push(`デプロイ \`${result.deploymentId}\` はすでに **v${result.toVersion}** を指しています。変更はありません。`, '');
  } else {
    lines.push(
      `**dry-run**: デプロイ \`${result.deploymentId}\` を **v${result.fromVersion} → v${result.toVersion}** に戻します。実際の変更は行っていません。`,
      '',
    );
  }

  const facts: string[] = [];
  if (result.toVersionDescription !== undefined) {
    facts.push(`- 戻り先バージョンの説明: ${result.toVersionDescription}`);
  }
  if (result.toVersionCreateTime !== undefined) {
    facts.push(`- 戻り先バージョンの作成日時: ${result.toVersionCreateTime}`);
  }
  if (result.webAppUrl !== undefined) {
    facts.push(`- Web アプリ URL: ${result.webAppUrl}（ロールバックでは変わりません）`);
  }
  if (facts.length > 0) lines.push(...facts, '');

  if (result.warnings.length > 0) {
    lines.push('### ⚠️ 警告', '', ...result.warnings.map((warning) => `- ${warning}`), '');
  }

  return lines.join('\n');
}
