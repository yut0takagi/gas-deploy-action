import { describe, expect, it, vi } from 'vitest';
import type { AppsScriptClient } from './api-client.js';
import type { DeployOptions, DeployResult } from './deployer.js';
import { GasDeployError } from './errors.js';
import { type DeployTarget, deployAll } from './multi-deployer.js';

const EMPTY_DIFF = { added: [], modified: [], deleted: [] };

function target(overrides: Partial<DeployTarget> = {}): DeployTarget {
  return {
    project: 'proj',
    environment: 'prod',
    scriptId: 'script-id',
    rootDir: 'dist',
    ignore: [],
    dryRun: false,
    createVersion: true,
    description: 'ci-test',
    ...overrides,
  };
}

function okResult(overrides: Partial<DeployResult> = {}): DeployResult {
  return { changed: false, diff: EMPTY_DIFF, warnings: [], ...overrides };
}

// テストでは AppsScriptClient を実際には使わない（deployImpl を注入して差し替えるため）。
const fakeClient = {} as AppsScriptClient;

describe('deployAll', () => {
  it('deploys every target in order when all succeed', async () => {
    const targets = [target({ project: 'a' }), target({ project: 'b' }), target({ project: 'c' })];
    const deployImpl = vi.fn(async (_client: AppsScriptClient, options: DeployOptions) =>
      okResult({ changed: options.scriptId === 'script-id' }),
    );

    const result = await deployAll(fakeClient, targets, deployImpl);

    expect(deployImpl).toHaveBeenCalledTimes(3);
    expect(result.completed.map((c) => c.project)).toEqual(['a', 'b', 'c']);
    expect(result.failed).toBeUndefined();
  });

  it('stops at the second failure and never attempts the third', async () => {
    const targets = [target({ project: 'a' }), target({ project: 'b' }), target({ project: 'c' })];
    const failure = new GasDeployError('b が失敗しました');
    let call = 0;
    const deployImpl = vi.fn(async (_client: AppsScriptClient, _options: DeployOptions): Promise<DeployResult> => {
      call += 1;
      if (call === 1) return okResult();
      if (call === 2) throw failure;
      throw new Error('should not be called a third time');
    });

    const result = await deployAll(fakeClient, targets, deployImpl);

    expect(deployImpl).toHaveBeenCalledTimes(2);
    expect(result.completed.map((c) => c.project)).toEqual(['a']);
    expect(result.failed).toEqual({ project: 'b', environment: 'prod', error: failure });
  });

  it('aggregates changed across completed projects', async () => {
    const targets = [target({ project: 'a' }), target({ project: 'b' })];
    let call = 0;
    const deployImpl = vi.fn(async (): Promise<DeployResult> => {
      call += 1;
      return okResult({ changed: call === 2 });
    });

    const result = await deployAll(fakeClient, targets, deployImpl);

    expect(result.changed).toBe(true);
    expect(result.completed.map((c) => c.result.changed)).toEqual([false, true]);
  });

  it('reports changed=false when nothing changed', async () => {
    const targets = [target({ project: 'a' }), target({ project: 'b' })];
    const deployImpl = vi.fn(async (): Promise<DeployResult> => okResult({ changed: false }));

    const result = await deployAll(fakeClient, targets, deployImpl);

    expect(result.changed).toBe(false);
  });

  it('behaves sanely for a single target', async () => {
    const targets = [target({ project: 'solo' })];
    const deployImpl = vi.fn(async (): Promise<DeployResult> => okResult({ changed: true, versionNumber: 3 }));

    const result = await deployAll(fakeClient, targets, deployImpl);

    expect(result.completed).toHaveLength(1);
    expect(result.completed[0]?.project).toBe('solo');
    expect(result.changed).toBe(true);
    expect(result.failed).toBeUndefined();
  });

  it('wraps a non-GasDeployError thrown by deployImpl', async () => {
    const targets = [target({ project: 'a' })];
    const deployImpl = vi.fn(async (): Promise<DeployResult> => {
      throw new Error('boom');
    });

    const result = await deployAll(fakeClient, targets, deployImpl);

    expect(result.failed?.error).toBeInstanceOf(GasDeployError);
    expect(result.failed?.error.message).toContain('boom');
  });

  it('returns normally instead of throwing on failure', async () => {
    const targets = [target({ project: 'a' })];
    const deployImpl = vi.fn(async (): Promise<DeployResult> => {
      throw new GasDeployError('fail');
    });

    await expect(deployAll(fakeClient, targets, deployImpl)).resolves.toBeDefined();
  });
});
