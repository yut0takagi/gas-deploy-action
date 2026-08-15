import type { TokenHealth } from '@gas-deploy/core';

/**
 * 死活監視の結果を Markdown で描画する。
 *
 * 「今デプロイしたら落ちるのか」と「判定できなかったのか」が一目で分かることを最優先にする。
 * この2つが混ざると、受け取った人が不要にトークンを再発行し、その手間が数回続いた時点で
 * 監視そのものを見なくなる。
 */
export function renderTokenHealthSummary(health: TokenHealth): string {
  const lines: string[] = ['## GAS 認証情報の死活監視', ''];

  if (health.status === 'valid') {
    lines.push(
      health.projectChecked
        ? '**refresh token は有効です。** トークンの交換と、対象プロジェクトの読み取りの両方を確認しました。'
        : '**refresh token は有効です。** 確認したのはトークンの交換のみで、対象プロジェクトの読み取りは確認していません（`script-id` を指定すると確認します）。',
      '',
    );
    return lines.join('\n');
  }

  if (health.status === 'invalid') {
    lines.push(
      `**認証情報が使えません。この状態のままではデプロイは失敗します。**（理由: \`${health.reason}\`）`,
      '',
      health.message,
      '',
    );
  } else {
    lines.push(
      `**有効かどうかを判定できませんでした。**（理由: \`${health.reason}\`）`,
      '',
      'トークンが失効したとは限りません。到達性や一時的な障害の可能性があるため、再発行の前に再実行してください。',
      '',
      health.message,
      '',
    );
  }

  if (health.nextSteps.length > 0) {
    lines.push('### 次の手順', '', ...health.nextSteps.map((step, i) => `${i + 1}. ${step}`), '');
  }

  return lines.join('\n');
}
