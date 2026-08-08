import { describe, expect, it } from 'vitest';
import { renderSummary } from './summary.js';

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
