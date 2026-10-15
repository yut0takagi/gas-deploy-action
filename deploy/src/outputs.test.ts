import { GasDeployError } from '@gas-deploy/core';
import type { MultiDeployResult, ResolvedTarget } from '@gas-deploy/core';
import { describe, expect, it } from 'vitest';
import { buildDeploymentsOutput } from './outputs.js';

describe('buildDeploymentsOutput', () => {
  function makeTarget(overrides: Partial<ResolvedTarget> = {}): ResolvedTarget {
    return {
      project: 'proj',
      environment: 'prod',
      scriptId: 'script-id',
      rootDir: '.',
      ignore: [],
      ...overrides,
    };
  }

  const EMPTY_DIFF = { added: [], modified: [], deleted: [] };

  it('includes every target with a deployed/unchanged status on full success', () => {
    const targets = [
      makeTarget({ project: 'a', scriptId: 'script-a' }),
      makeTarget({ project: 'b', scriptId: 'script-b' }),
      makeTarget({ project: 'c', scriptId: 'script-c' }),
    ];
    const multiResult: MultiDeployResult = {
      changed: true,
      completed: [
        {
          project: 'a',
          environment: 'prod',
          scriptId: 'script-a',
          result: {
            changed: true,
            diff: EMPTY_DIFF,
            warnings: [],
            versionNumber: 4,
            deploymentId: 'dep-a',
            webAppUrl: 'https://example.com/a',
          },
        },
        {
          project: 'b',
          environment: 'prod',
          scriptId: 'script-b',
          result: { changed: false, diff: EMPTY_DIFF, warnings: [] },
        },
        {
          project: 'c',
          environment: 'prod',
          scriptId: 'script-c',
          result: { changed: true, diff: EMPTY_DIFF, warnings: [], versionNumber: 1 },
        },
      ],
    };

    const output = buildDeploymentsOutput(targets, multiResult);

    expect(output).toHaveLength(3);
    expect(output.map((entry) => entry.status)).toEqual(['deployed', 'unchanged', 'deployed']);
    expect(output[0]).toMatchObject({
      project: 'a',
      environment: 'prod',
      scriptId: 'script-a',
      status: 'deployed',
      versionNumber: 4,
      deploymentId: 'dep-a',
      webAppUrl: 'https://example.com/a',
    });
    expect(output[1]).toEqual({ project: 'b', environment: 'prod', scriptId: 'script-b', status: 'unchanged' });
    expect(output[0]?.error).toBeUndefined();
  });

  it('marks the failed project and every later target as skipped, none missing', () => {
    const targets = [
      makeTarget({ project: 'a', scriptId: 'script-a' }),
      makeTarget({ project: 'b', scriptId: 'script-b' }),
      makeTarget({ project: 'c', scriptId: 'script-c' }),
    ];
    const failure = new GasDeployError('scriptId が見つかりません (404)', {
      cause: 'RESPONSE_BODY_WITH_SECRET_DETAIL',
      nextSteps: ['scriptId が正しいか確認してください', 'アカウントの権限を確認してください'],
    });
    const multiResult: MultiDeployResult = {
      changed: true,
      completed: [
        {
          project: 'a',
          environment: 'prod',
          scriptId: 'script-a',
          result: { changed: true, diff: EMPTY_DIFF, warnings: [], versionNumber: 2 },
        },
      ],
      failed: { project: 'b', environment: 'prod', error: failure },
    };

    const output = buildDeploymentsOutput(targets, multiResult);

    expect(output).toHaveLength(3);
    expect(output[0]).toMatchObject({ project: 'a', status: 'deployed' });
    expect(output[1]).toMatchObject({ project: 'b', environment: 'prod', scriptId: 'script-b', status: 'failed' });
    expect(output[2]).toEqual({ project: 'c', environment: 'prod', scriptId: 'script-c', status: 'skipped' });

    // The failed entry's error must carry only the message — never the human-oriented
    // nextSteps text, and never anything from cause (which can hold raw API response
    // bodies). This is the property that keeps this machine-readable output safe to log
    // or forward without leaking response internals.
    const failedEntry = output[1];
    expect(failedEntry?.error).toBe('scriptId が見つかりません (404)');
    expect(failedEntry?.error).not.toContain('scriptId が正しいか確認してください');
    expect(failedEntry?.error).not.toContain('アカウントの権限を確認してください');
    expect(failedEntry?.error).not.toContain('RESPONSE_BODY_WITH_SECRET_DETAIL');
    expect(JSON.stringify(output)).not.toContain('RESPONSE_BODY_WITH_SECRET_DETAIL');
    expect(JSON.stringify(output)).not.toContain('次の手順を確認してください');
  });
});
