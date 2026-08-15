import { describe, expect, it, vi } from 'vitest';
import type { AppsScriptClient } from './api-client.js';
import { GasDeployError, classifyApiError } from './errors.js';
import { getDeploymentStatus } from './status.js';

const SHA = '6251c8c9f2a1b3d4e5f6a7b8c9d0e1f2a3b4c5d6';

/** 必要なメソッドだけを持つ偽クライアント。実クライアントは HTTP を張るため使えない。 */
function fakeClient(overrides: Record<string, unknown>): AppsScriptClient {
  return {
    getDeployment: vi.fn(),
    listDeployments: vi.fn(async () => []),
    getVersion: vi.fn(),
    ...overrides,
  } as unknown as AppsScriptClient;
}

/** 例外を型付きで捕まえる。`.catch()` は成功値との union になり型が付かない。 */
async function capture(promise: Promise<unknown>): Promise<GasDeployError> {
  try {
    await promise;
    throw new Error('失敗しませんでした');
  } catch (error) {
    return error as GasDeployError;
  }
}

describe('getDeploymentStatus', () => {
  it('resolves the provenance of the version the deployment points at', async () => {
    const client = fakeClient({
      getDeployment: vi.fn(async () => ({ deploymentId: 'dep-1', versionNumber: 38, webAppUrl: 'https://x' })),
      getVersion: vi.fn(async () => ({
        versionNumber: 38,
        description: `ci sha=${SHA} run=99 pr=7 by=someone`,
        createTime: '2026-08-14T00:00:00Z',
      })),
    });

    const status = await getDeploymentStatus(client, { scriptId: 's-1', deploymentId: 'dep-1' });
    expect(status.versionNumber).toBe(38);
    expect(status.createdAt).toBe('2026-08-14T00:00:00Z');
    expect(status.webAppUrl).toBe('https://x');
    expect(status.provenance).toEqual({ sha: SHA, runId: '99', pr: 7, actor: 'someone' });
  });

  it('reports no provenance when the description was not written by this action', async () => {
    const client = fakeClient({
      getDeployment: vi.fn(async () => ({ deploymentId: 'dep-1', versionNumber: 3 })),
      getVersion: vi.fn(async () => ({ versionNumber: 3, description: 'hand written' })),
    });

    const status = await getDeploymentStatus(client, { scriptId: 's-1', deploymentId: 'dep-1' });
    expect(status.versionNumber).toBe(3);
    expect(status.provenance).toBeUndefined();
  });

  it('reports no provenance for a version that has no description', async () => {
    const client = fakeClient({
      getDeployment: vi.fn(async () => ({ deploymentId: 'dep-1', versionNumber: 5 })),
      getVersion: vi.fn(async () => ({ versionNumber: 5 })),
    });

    const status = await getDeploymentStatus(client, { scriptId: 's-1', deploymentId: 'dep-1' });
    expect(status.versionNumber).toBe(5);
    expect(status.description).toBeUndefined();
    expect(status.provenance).toBeUndefined();
  });

  it('does not fetch a version for an @HEAD deployment', async () => {
    const getVersion = vi.fn();
    const client = fakeClient({
      getDeployment: vi.fn(async () => ({ deploymentId: 'head-1' })),
      getVersion,
    });

    const status = await getDeploymentStatus(client, { scriptId: 's-1', deploymentId: 'head-1' });
    expect(status.versionNumber).toBeUndefined();
    expect(status.provenance).toBeUndefined();
    expect(getVersion).not.toHaveBeenCalled();
  });

  it('auto-detects the target when exactly one versioned deployment exists', async () => {
    const client = fakeClient({
      listDeployments: vi.fn(async () => [
        { deploymentId: 'head-1' },
        { deploymentId: 'dep-1', versionNumber: 12 },
      ]),
      getVersion: vi.fn(async () => ({ versionNumber: 12, description: `ci sha=${SHA}` })),
    });

    const status = await getDeploymentStatus(client, { scriptId: 's-1' });
    expect(status.deploymentId).toBe('dep-1');
  });

  it('lists the candidates instead of guessing when several versioned deployments exist', async () => {
    const client = fakeClient({
      listDeployments: vi.fn(async () => [
        { deploymentId: 'dep-1', versionNumber: 1 },
        { deploymentId: 'dep-2', versionNumber: 2 },
      ]),
    });

    const error = await capture(getDeploymentStatus(client, { scriptId: 's-1' }));
    expect(error).toBeInstanceOf(GasDeployError);
    expect(error.nextSteps.join('\n')).toContain('dep-2');
  });

  // @HEAD しか無いのは異常ではない。読み取りなので報告して終わる。
  it('reports the only @HEAD deployment rather than failing', async () => {
    const client = fakeClient({
      listDeployments: vi.fn(async () => [{ deploymentId: 'head-1' }]),
    });

    const status = await getDeploymentStatus(client, { scriptId: 's-1' });
    expect(status.deploymentId).toBe('head-1');
    expect(status.versionNumber).toBeUndefined();
  });

  it('lists the candidates when only several @HEAD deployments exist', async () => {
    const client = fakeClient({
      listDeployments: vi.fn(async () => [{ deploymentId: 'head-1' }, { deploymentId: 'head-2' }]),
    });

    const error = await capture(getDeploymentStatus(client, { scriptId: 's-1' }));
    expect(error.nextSteps.join('\n')).toContain('head-2');
  });

  // scriptId 違いか未デプロイかを区別できない「由来なし」を返さない。
  it('fails when the script has no deployments at all', async () => {
    const client = fakeClient({ listDeployments: vi.fn(async () => []) });
    const error = await capture(getDeploymentStatus(client, { scriptId: 's-1' }));
    expect(error).toBeInstanceOf(GasDeployError);
    expect(error.nextSteps.join('\n')).toContain('scriptId が正しいか確認してください');
    expect(error.nextSteps.join('\n')).toContain('デプロイしていない場合は');
  });

  it('explains a wrong deployment-id with the available candidates', async () => {
    const client = fakeClient({
      getDeployment: vi.fn(async () => {
        throw classifyApiError(404, '{}');
      }),
      listDeployments: vi.fn(async () => [{ deploymentId: 'dep-1', versionNumber: 5 }]),
    });

    const error = await capture(getDeploymentStatus(client, { scriptId: 's-1', deploymentId: 'wrong' }));
    expect(error.nextSteps.join('\n')).toContain('dep-1');
  });

  // 成功時に余分な API を叩かないため、一覧の取得は失敗経路に限る。
  it('does not list deployments when an explicit deployment-id resolves', async () => {
    const listDeployments = vi.fn(async () => []);
    const client = fakeClient({
      getDeployment: vi.fn(async () => ({ deploymentId: 'dep-1', versionNumber: 1 })),
      getVersion: vi.fn(async () => ({ versionNumber: 1 })),
      listDeployments,
    });

    await getDeploymentStatus(client, { scriptId: 's-1', deploymentId: 'dep-1' });
    expect(listDeployments).not.toHaveBeenCalled();
  });

  it('rethrows a non-404 API failure untouched', async () => {
    const original = classifyApiError(403, 'denied');
    const client = fakeClient({
      getDeployment: vi.fn(async () => {
        throw original;
      }),
    });

    const error = await capture(getDeploymentStatus(client, { scriptId: 's-1', deploymentId: 'dep-1' }));
    expect(error).toBe(original);
  });

  // classifyApiError が既に次の手順を持たせているので、ここで包み直すと案内が失われる。
  it('rethrows a version fetch failure untouched', async () => {
    const original = classifyApiError(403, 'denied');
    const client = fakeClient({
      getDeployment: vi.fn(async () => ({ deploymentId: 'dep-1', versionNumber: 5 })),
      getVersion: vi.fn(async () => {
        throw original;
      }),
    });

    const error = await capture(getDeploymentStatus(client, { scriptId: 's-1', deploymentId: 'dep-1' }));
    expect(error).toBe(original);
  });
});
