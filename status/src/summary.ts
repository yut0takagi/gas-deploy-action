import type { StatusTargetResult } from './main.js';

/**
 * 表のセルに入れる値を無害化する。
 *
 * `|` がそのまま入ると列が増えて、その行以降の表全体が崩れる。改行も同様に行を割る。
 * 値には利用者の入力（deployment-id 等）由来の文字列が API のエラーメッセージ経由で
 * 流れ込むため、描画側で必ず処理する。
 *
 * 順序が重要: 必ずバックスラッシュを先にエスケープしてから `|` をエスケープする。
 * 値に既存のバックスラッシュが含まれる場合（例: `C:\|evil`）、先に `|` を
 * エスケープすると `\|` の直前にもう1本バックスラッシュが付くだけで、結果は
 * 「2本のバックスラッシュ + `|`」= 偶数本のバックスラッシュ（＝エスケープされた
 * バックスラッシュ1個）に続く未エスケープの `|` になってしまう。GFM 上はこれが
 * 構造上の区切りとして解釈され、表が崩れる。先にバックスラッシュを倍化しておけば、
 * 既存のバックスラッシュが後から付けるエスケープを横取りすることがない。
 */
function cell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, ' ');
}

/** 由来情報の欄。空欄を作らない。「分からなかった」ことを必ず言葉にする。 */
function renderCommit(result: StatusTargetResult): string {
  if (result.error !== undefined) {
    return `取得失敗: ${result.error}`;
  }
  if (result.managed && result.sha !== undefined) {
    const extras: string[] = [];
    if (result.pr !== undefined) extras.push(`PR #${result.pr}`);
    if (result.actor !== undefined) extras.push(`by ${result.actor}`);
    const suffix = extras.length > 0 ? `（${extras.join(', ')}）` : '';
    return `\`${result.sha.slice(0, 7)}\`${suffix}`;
  }
  if (result.versionNumber === undefined) {
    return '@HEAD（バージョン未固定のため由来なし）';
  }
  return 'CI 管理外（このアクション以外で作られたバージョン）';
}

function renderVersion(result: StatusTargetResult): string {
  if (result.error !== undefined) return '—';
  return result.versionNumber === undefined ? '@HEAD' : `v${result.versionNumber}`;
}

/**
 * 照会結果を Markdown の表で描画する。
 *
 * 単一対象でも表を使う。対象が1つか複数かで書式が変わると、読む側が2つの形式を
 * 覚える必要が生じるだけで、得るものがない。
 */
export function renderStatusSummary(results: readonly StatusTargetResult[]): string {
  if (results.length === 0) {
    // 表を空のまま出すと「描画が壊れている」ように見える。今日のコード上は config
    // モードが必ず1件以上の対象を返すため到達しないはずだが、将来の変更で到達しうる
    // 曖昧さを残さないため、明示的に「0件だった」と言葉にする。
    return ['## GAS デプロイ状況', '', '対象が0 件でした。projects や environment の指定を確認してください。', ''].join(
      '\n',
    );
  }

  const lines: string[] = [
    '## GAS デプロイ状況',
    '',
    '| プロジェクト | 環境 | バージョン | コミット | 作成日時 |',
    '|---|---|---|---|---|',
  ];

  for (const result of results) {
    lines.push(
      [
        '',
        cell(result.project ?? '—'),
        cell(result.environment ?? '—'),
        cell(renderVersion(result)),
        cell(renderCommit(result)),
        cell(result.createdAt ?? '—'),
        '',
      ].join(' | '),
    );
  }

  lines.push('');

  const failed = results.filter((result) => result.error !== undefined);
  if (failed.length > 0) {
    lines.push(`**${failed.length} 件の対象で状況を取得できませんでした。** 上の表の「取得失敗」を確認してください。`, '');
  }

  return lines.join('\n');
}
