import { GasDeployError } from '@gas-deploy/core';
import type { MultiDeployResult, ResolvedTarget } from '@gas-deploy/core';
import { describe, expect, it } from 'vitest';
import { renderMultiSummary, renderSummary } from './summary.js';

describe('renderSummary', () => {
  it('reports that nothing changed', () => {
    const text = renderSummary({
      changed: false,
      diff: { added: [], modified: [], deleted: [] },
      warnings: [],
    });
    expect(text).toContain('変更はありません');
  });

  it('lists added, modified and deleted files', () => {
    const text = renderSummary({
      changed: true,
      diff: { added: ['New'], modified: ['Code'], deleted: ['Old'] },
      warnings: [],
    });
    expect(text).toContain('追加 (1)');
    expect(text).toContain('New');
    expect(text).toContain('変更 (1)');
    expect(text).toContain('Code');
    expect(text).toContain('削除 (1)');
    expect(text).toContain('Old');
  });

  // 削除は復旧にバージョン履歴を遡る必要があり、他の変更と同じ重みで並べると見落とす。
  // 独立した警告ブロックとして、追加・変更より前に出す。
  it('calls out deletions in a warning block ahead of the other sections', () => {
    const text = renderSummary({
      changed: true,
      diff: { added: ['New'], modified: ['Code'], deleted: ['Legacy', 'Helper'] },
      warnings: [],
    });
    expect(text).toContain('[!WARNING]');
    expect(text).toContain('2 ファイルがリモートから削除されます');
    expect(text.indexOf('リモートから削除されます')).toBeLessThan(text.indexOf('追加 (1)'));
  });

  it('shows the added / modified / deleted counts together', () => {
    const text = renderSummary({
      changed: true,
      diff: { added: ['New'], modified: ['A', 'B'], deleted: ['X', 'Y', 'Z'] },
      warnings: [],
    });
    expect(text).toContain('追加: 1 / 変更: 2 / 削除: 3');
  });

  // 削除が無い実行にまで警告ブロックを出すと、本当に危険な実行の警告が埋もれる。
  it('shows no warning block when nothing is deleted', () => {
    const text = renderSummary({
      changed: true,
      diff: { added: ['New'], modified: ['Code'], deleted: [] },
      warnings: [],
    });
    expect(text).not.toContain('[!WARNING]');
  });

  it('includes the version, deployment id and web app url', () => {
    const text = renderSummary({
      changed: true,
      diff: { added: ['New'], modified: [], deleted: [] },
      warnings: [],
      versionNumber: 7,
      deploymentId: 'dep-1',
      webAppUrl: 'https://example.com/exec',
    });
    expect(text).toContain('7');
    expect(text).toContain('dep-1');
    expect(text).toContain('https://example.com/exec');
  });

  it('renders warnings', () => {
    const text = renderSummary({
      changed: true,
      diff: { added: ['New'], modified: [], deleted: [] },
      warnings: ['気をつけて'],
    });
    expect(text).toContain('気をつけて');
  });
});

function makeTarget(overrides: Partial<ResolvedTarget> = {}): ResolvedTarget {
  return {
    project: 'proj',
    environment: 'prod',
    scriptId: 'script-id',
    rootDir: 'dist',
    ignore: [],
    ...overrides,
  };
}

const EMPTY_DIFF = { added: [], modified: [], deleted: [] };

describe('renderMultiSummary', () => {
  // 10プロジェクトの実行では、どのプロジェクトで何が消えるかが分からないと
  // レビューのしようがない。プロジェクトごとに削除を明示する。
  it('calls out deletions per project', () => {
    const result: MultiDeployResult = {
      changed: true,
      completed: [
        {
          project: 'web-app',
          environment: 'prod',
          scriptId: 'script-1',
          result: {
            changed: true,
            diff: { added: [], modified: [], deleted: ['Legacy'] },
            warnings: [],
          },
        },
      ],
    };

    const text = renderMultiSummary(result, [makeTarget({ project: 'web-app' })]);

    expect(text).toContain('[!WARNING]');
    expect(text).toContain('Legacy');
  });

  it('lists every completed project with its facts', () => {
    const result: MultiDeployResult = {
      changed: true,
      completed: [
        {
          project: 'web-app',
          environment: 'prod',
          scriptId: 'script-1',
          result: {
            changed: true,
            diff: EMPTY_DIFF,
            warnings: [],
            versionNumber: 5,
            deploymentId: 'dep-1',
            webAppUrl: 'https://example.com/exec',
          },
        },
        {
          project: 'sheet-tools',
          environment: 'prod',
          scriptId: 'script-2',
          result: { changed: false, diff: EMPTY_DIFF, warnings: [] },
        },
      ],
    };
    const targets = [makeTarget({ project: 'web-app' }), makeTarget({ project: 'sheet-tools' })];

    const text = renderMultiSummary(result, targets);

    expect(text).toContain('web-app');
    expect(text).toContain('sheet-tools');
    expect(text).toContain('5');
    expect(text).toContain('dep-1');
    expect(text).toContain('https://example.com/exec');
    expect(text).toContain('差分がないため、変更はありません。');
    expect(text).not.toContain('失敗');
  });

  it('includes per-project warnings', () => {
    const result: MultiDeployResult = {
      changed: true,
      completed: [
        {
          project: 'web-app',
          environment: 'prod',
          scriptId: 'script-1',
          result: { changed: true, diff: EMPTY_DIFF, warnings: ['URL が変わります'] },
        },
      ],
    };

    const text = renderMultiSummary(result, [makeTarget({ project: 'web-app' })]);

    expect(text).toContain('URL が変わります');
  });

  it('states which projects completed, which failed, and which were never attempted', () => {
    const failure = new GasDeployError('scriptId が不正です', { nextSteps: ['scriptId を確認してください'] });
    const result: MultiDeployResult = {
      changed: false,
      completed: [
        {
          project: 'a',
          environment: 'prod',
          scriptId: 'script-a',
          result: { changed: false, diff: EMPTY_DIFF, warnings: [] },
        },
      ],
      failed: { project: 'b', environment: 'prod', error: failure },
    };
    const targets = [makeTarget({ project: 'a' }), makeTarget({ project: 'b' }), makeTarget({ project: 'c' })];

    const text = renderMultiSummary(result, targets);

    expect(text).toContain('失敗');
    expect(text).toContain('scriptId が不正です');
    expect(text).toContain('scriptId を確認してください');
    expect(text).toMatch(/完了済み.*a/);
    expect(text).toMatch(/失敗.*b/);
    expect(text).toMatch(/未実行.*c/);
    expect(text).not.toContain('未実行: a');
    expect(text).not.toContain('未実行: b');
  });

  it('reports "なし" for completed when the very first project fails', () => {
    const failure = new GasDeployError('failed');
    const result: MultiDeployResult = {
      changed: false,
      completed: [],
      failed: { project: 'a', environment: 'prod', error: failure },
    };
    const targets = [makeTarget({ project: 'a' }), makeTarget({ project: 'b' })];

    const text = renderMultiSummary(result, targets);

    expect(text).toContain('完了済み: なし');
    expect(text).toMatch(/未実行.*b/);
  });
});
