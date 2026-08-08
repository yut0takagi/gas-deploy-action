import type { DeployResult } from '@gas-deploy/core';

function section(title: string, items: string[]): string[] {
  if (items.length === 0) return [];
  return [`### ${title} (${items.length})`, '', ...items.map((item) => `- \`${item}\``), ''];
}

export function renderSummary(result: DeployResult): string {
  const lines: string[] = ['## GAS デプロイ結果', ''];

  if (!result.changed) {
    lines.push('差分がないため、変更はありません。', '');
  } else {
    lines.push(
      ...section('追加', result.diff.added),
      ...section('変更', result.diff.modified),
      ...section('削除', result.diff.deleted),
    );
  }

  const facts: string[] = [];
  if (result.versionNumber !== undefined) facts.push(`- バージョン: \`${result.versionNumber}\``);
  if (result.deploymentId !== undefined) facts.push(`- デプロイ ID: \`${result.deploymentId}\``);
  if (result.webAppUrl !== undefined) facts.push(`- Web アプリ URL: ${result.webAppUrl}`);
  if (facts.length > 0) lines.push(...facts, '');

  if (result.warnings.length > 0) {
    lines.push('### ⚠️ 警告', '', ...result.warnings.map((warning) => `- ${warning}`), '');
  }

  return lines.join('\n');
}
