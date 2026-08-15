import type { DeploymentStatus } from '@gas-deploy/core';
import { GasDeployError } from '@gas-deploy/core';
import { describe, expect, it } from 'vitest';
import { parseProjectsInput, resolveStatusTargets, toTargetResult } from './main.js';

const SHA = '6251c8c9f2a1b3d4e5f6a7b8c9d0e1f2a3b4c5d6';

const CONFIG = `
version: 1
projects:
  web-app:
    rootDir: apps/web-app/dist
    environments:
      prod:
        scriptId: web-script
        deploymentId: web-deployment
  sheet-tools:
    rootDir: apps/sheet-tools/dist
    environments:
      prod:
        scriptId: sheet-script
`;

describe('parseProjectsInput', () => {
  it('treats all as the whole set', () => {
    expect(parseProjectsInput('all')).toEqual(['all']);
  });

  it('splits a comma separated list and trims each name', () => {
    expect(parseProjectsInput(' web-app , sheet-tools ')).toEqual(['web-app', 'sheet-tools']);
  });

  it('drops empty entries produced by a trailing comma', () => {
    expect(parseProjectsInput('web-app,')).toEqual(['web-app']);
  });
});

describe('toTargetResult', () => {
  const target = { project: 'web-app', environment: 'prod', scriptId: 's-1' };

  it('flattens a resolved provenance into the result', () => {
    const status: DeploymentStatus = {
      deploymentId: 'dep-1',
      versionNumber: 38,
      createdAt: '2026-08-14T00:00:00Z',
      webAppUrl: 'https://x',
      provenance: { sha: SHA, runId: '99', pr: 7, actor: 'someone' },
    };
    expect(toTargetResult(target, { status })).toEqual({
      project: 'web-app',
      environment: 'prod',
      scriptId: 's-1',
      deploymentId: 'dep-1',
      versionNumber: 38,
      createdAt: '2026-08-14T00:00:00Z',
      webAppUrl: 'https://x',
      managed: true,
      sha: SHA,
      runId: '99',
      pr: 7,
      actor: 'someone',
    });
  });

  it('marks a version without provenance as unmanaged', () => {
    const result = toTargetResult(target, { status: { deploymentId: 'dep-1', versionNumber: 3 } });
    expect(result.managed).toBe(false);
    expect(result.sha).toBeUndefined();
  });

  it('marks an @HEAD deployment as unmanaged with no version', () => {
    const result = toTargetResult(target, { status: { deploymentId: 'head-1' } });
    expect(result.managed).toBe(false);
    expect(result.versionNumber).toBeUndefined();
  });

  // cause には API の生レスポンスが入りうる。出力とサマリに載せてはならない。
  it('records only the error message, never the cause', () => {
    const error = new GasDeployError('拒否されました (403)', { cause: 'raw body with a token' });
    const result = toTargetResult(target, { error });
    expect(result.error).toBe('拒否されました (403)');
    expect(JSON.stringify(result)).not.toContain('raw body');
  });

  it('stringifies a non-GasDeployError failure', () => {
    const result = toTargetResult(target, { error: new TypeError('boom') });
    expect(result.error).toBe('boom');
  });

  it('omits project and environment in single-target mode', () => {
    const result = toTargetResult({ scriptId: 's-1' }, { status: { deploymentId: 'dep-1' } });
    expect(result.project).toBeUndefined();
    expect(result.environment).toBeUndefined();
  });
});

describe('resolveStatusTargets', () => {
  it('uses the config deploymentId when no deployment-id input is given', () => {
    const targets = resolveStatusTargets(CONFIG, {
      environment: 'prod',
      projects: ['web-app'],
      deploymentIdInput: '',
      env: {},
    });
    expect(targets).toEqual([
      { project: 'web-app', environment: 'prod', scriptId: 'web-script', deploymentId: 'web-deployment' },
    ]);
  });

  it('lets the deployment-id input override the config value for a single target', () => {
    const targets = resolveStatusTargets(CONFIG, {
      environment: 'prod',
      projects: ['web-app'],
      deploymentIdInput: 'override-dep',
      env: {},
    });
    expect(targets).toEqual([
      { project: 'web-app', environment: 'prod', scriptId: 'web-script', deploymentId: 'override-dep' },
    ]);
  });

  // deployment-id はスクリプト単位の ID。"all" で複数プロジェクトに同じ値を当てはめると
  // 対象外のプロジェクトが軒並み 404 になるため、複数解決された場合は拒否する。
  it('rejects deployment-id when it would apply to more than one target', () => {
    expect(() =>
      resolveStatusTargets(CONFIG, {
        environment: 'prod',
        projects: ['all'],
        deploymentIdInput: 'shared-dep',
        env: {},
      }),
    ).toThrow(GasDeployError);
  });

  it('allows deployment-id across "all" when exactly one target actually resolves', () => {
    // dev を持つのは web-app だけの設定を使い、"all" でも解決結果が1件になる境界ケースを確かめる。
    const singleEnvConfig = `
version: 1
projects:
  web-app:
    rootDir: apps/web-app/dist
    environments:
      dev:
        scriptId: web-script
  sheet-tools:
    rootDir: apps/sheet-tools/dist
    environments:
      prod:
        scriptId: sheet-script
`;
    const targets = resolveStatusTargets(singleEnvConfig, {
      environment: 'dev',
      projects: ['all'],
      deploymentIdInput: 'dep-1',
      env: {},
    });
    expect(targets).toEqual([{ project: 'web-app', environment: 'dev', scriptId: 'web-script', deploymentId: 'dep-1' }]);
  });
});
