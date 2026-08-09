import type { RollbackResult } from '@gas-deploy/core';
import { HEAD_NOT_REVERTED_WARNING } from '@gas-deploy/core';
import { describe, expect, it } from 'vitest';
import { renderRollbackSummary } from './summary.js';

function baseResult(overrides: Partial<RollbackResult> = {}): RollbackResult {
  return {
    rolledBack: true,
    deploymentId: 'dep-live',
    fromVersion: 42,
    toVersion: 41,
    warnings: [HEAD_NOT_REVERTED_WARNING],
    ...overrides,
  };
}

describe('renderRollbackSummary', () => {
  it('実行時は戻し元と戻り先のバージョンを示す', () => {
    const summary = renderRollbackSummary(baseResult());

    expect(summary).toContain('v42 → v41');
    expect(summary).toContain('dep-live');
    expect(summary).not.toContain('dry-run');
  });

  it('dry-run では実際の変更を行っていないことを明示する', () => {
    const summary = renderRollbackSummary(baseResult({ rolledBack: false }));

    expect(summary).toContain('dry-run');
    expect(summary).toContain('行っていません');
  });

  it('すでに戻り先を指している場合は dry-run と混同されない', () => {
    // rolledBack が false という一点だけでは dry-run と区別できない。
    // fromVersion === toVersion のときは専用の文面にする。
    const summary = renderRollbackSummary(baseResult({ rolledBack: false, fromVersion: 41, toVersion: 41 }));

    expect(summary).toContain('すでに');
    expect(summary).not.toContain('dry-run');
  });

  it('HEAD が戻らない警告を必ず出す', () => {
    const summary = renderRollbackSummary(baseResult());

    expect(summary).toContain(HEAD_NOT_REVERTED_WARNING);
  });

  it('戻り先バージョンの説明と作成日時を出す', () => {
    const summary = renderRollbackSummary(
      baseResult({ toVersionDescription: '安定版', toVersionCreateTime: '2026-08-01T00:00:00Z' }),
    );

    expect(summary).toContain('安定版');
    expect(summary).toContain('2026-08-01T00:00:00Z');
  });

  it('Web アプリ URL には変わらない旨を添える', () => {
    const summary = renderRollbackSummary(baseResult({ webAppUrl: 'https://example.com/exec' }));

    expect(summary).toContain('https://example.com/exec');
    expect(summary).toContain('変わりません');
  });
});
