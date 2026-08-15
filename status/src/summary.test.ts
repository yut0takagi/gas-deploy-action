import { describe, expect, it } from 'vitest';
import type { StatusTargetResult } from './main.js';
import { renderStatusSummary } from './summary.js';

/**
 * GFM が実際に行う走査を模して、構造上の（エスケープされていない）`|` を数える。
 *
 * 正規表現の後読み `(?<!\\)` では「直前がバックスラッシュならエスケープ済み」と
 * 見なしてしまい、`\\|`（エスケープされたバックスラッシュ＋構造上の `|`）を
 * 取り違える。実装と同じ盲点を持つ検証は、実装の誤りをそのまま通す。
 */
function countStructuralPipes(row: string): number {
  let count = 0;
  for (let i = 0; i < row.length; i += 1) {
    if (row[i] === '\\') {
      i += 1;
      continue;
    }
    if (row[i] === '|') count += 1;
  }
  return count;
}

const BASE: StatusTargetResult = {
  scriptId: 's-1',
  managed: true,
  deploymentId: 'dep-1',
  versionNumber: 38,
  sha: '6251c8c9f2a1b3d4e5f6a7b8c9d0e1f2a3b4c5d6',
  runId: '99',
  pr: 7,
  actor: 'someone',
  createdAt: '2026-08-14T00:00:00Z',
};

describe('renderStatusSummary', () => {
  it('shows the abbreviated sha with the pull request and actor', () => {
    const summary = renderStatusSummary([BASE]);
    expect(summary).toContain('6251c8c');
    expect(summary).toContain('#7');
    expect(summary).toContain('someone');
    expect(summary).toContain('v38');
  });

  // 空欄にすると「調べたが分からなかった」のか「表示漏れ」なのか区別できない。
  it('states that a version was not created by this action', () => {
    const summary = renderStatusSummary([{ scriptId: 's-1', managed: false, versionNumber: 3 }]);
    expect(summary).toContain('CI 管理外');
  });

  it('states that an @HEAD deployment has no version', () => {
    const summary = renderStatusSummary([{ scriptId: 's-1', managed: false, deploymentId: 'head-1' }]);
    expect(summary).toContain('@HEAD');
  });

  it('shows the failure for a target that could not be read', () => {
    const summary = renderStatusSummary([{ scriptId: 's-1', managed: false, error: '403 で拒否されました' }]);
    expect(summary).toContain('取得失敗');
    expect(summary).toContain('403 で拒否されました');
  });

  it('lists every target with its project and environment', () => {
    const summary = renderStatusSummary([
      { ...BASE, project: 'web-app', environment: 'prod' },
      { ...BASE, project: 'sheet-tools', environment: 'prod', versionNumber: 12 },
    ]);
    expect(summary).toContain('web-app');
    expect(summary).toContain('sheet-tools');
    expect(summary).toContain('v12');
  });

  it('counts the targets it could not read', () => {
    const summary = renderStatusSummary([BASE, { scriptId: 's-2', managed: false, error: 'boom' }]);
    expect(summary).toContain('1 件');
  });

  // deployment-id など利用者入力由来の文字列が API のエラーメッセージ経由でセルに
  // 流れ込みうる。エスケープしないと `|` が列を増やし、以降の表全体が崩れる。
  //
  // 行は7要素（前後の空セル + 実質5列）を " | " で連結するため、常に6個の構造上の
  // `|`（区切り）を持つはず。utility の countStructuralPipes でその数を数える。
  function dataRow(summary: string): string {
    // データ行は必ず " | " で始まる（ヘッダ行は "|" で始まり、フッタの注記行は "**" で
    // 始まるため区別できる）。
    const row = summary.split('\n').find((line) => line.startsWith(' | '));
    if (row === undefined) throw new Error('data row not found');
    return row;
  }

  it('escapes a pipe in an error message so the row keeps five columns', () => {
    const summary = renderStatusSummary([{ scriptId: 's-1', managed: false, error: '403 | 拒否されました' }]);
    const row = dataRow(summary);
    expect(countStructuralPipes(row)).toBe(6);
    expect(row).toContain('403 \\| 拒否されました');
  });

  // 利用者の入力にたまたま含まれていたバックスラッシュを先にエスケープしておかないと、
  // それが後続の「列を区切るために自分で入れた `|` 用のエスケープ」を横取りしてしまう。
  it('escapes a pre-existing single backslash immediately before a pipe', () => {
    const summary = renderStatusSummary([{ scriptId: 's-1', managed: false, error: 'C:\\|evil' }]);
    const row = dataRow(summary);
    expect(countStructuralPipes(row)).toBe(6);
  });

  it('escapes a pre-existing odd run of backslashes before a pipe', () => {
    // 3本（奇数）のバックスラッシュ + `|`。バックスラッシュを先に倍化しないと、
    // 奇数本という性質そのものが失われる。
    const summary = renderStatusSummary([{ scriptId: 's-1', managed: false, error: `abc${'\\'.repeat(3)}|def` }]);
    const row = dataRow(summary);
    expect(countStructuralPipes(row)).toBe(6);
  });

  it('handles a value ending in a bare backslash without corrupting the row', () => {
    const summary = renderStatusSummary([{ scriptId: 's-1', managed: false, error: 'trailing\\' }]);
    const row = dataRow(summary);
    expect(countStructuralPipes(row)).toBe(6);
  });

  it('collapses a multi-line error message onto a single table row', () => {
    const summary = renderStatusSummary([{ scriptId: 's-1', managed: false, error: 'line1\nline2\r\nline3' }]);
    const rows = summary.split('\n').filter((line) => line.startsWith(' | '));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('line1 line2 line3');
  });

  it('states that no targets matched instead of rendering an empty table', () => {
    const summary = renderStatusSummary([]);
    expect(summary).toContain('0 件');
    expect(summary).not.toContain('|---|');
  });
});
