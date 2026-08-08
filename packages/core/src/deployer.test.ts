import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEPLOYMENT_COUNT_WARN_THRESHOLD, deploy } from './deployer.js';
import type { AppsScriptClient } from './api-client.js';
import type { Deployment, ScriptFile } from './types.js';

const MANIFEST = JSON.stringify({ timeZone: 'Asia/Tokyo' });

async function makeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gas-deploy-'));
  await writeFile(join(root, 'appsscript.json'), MANIFEST, 'utf8');
  await writeFile(join(root, 'Code.js'), 'function main() {}', 'utf8');
  return root;
}

function fakeClient(overrides: Record<string, unknown> = {}) {
  const deployment: Deployment = { deploymentId: 'dep-1', versionNumber: 7, webAppUrl: 'https://example.com/exec' };
  const client = {
    getContent: vi.fn(async (): Promise<ScriptFile[]> => []),
    updateContent: vi.fn(async () => undefined),
    createVersion: vi.fn(async () => 7),
    updateDeployment: vi.fn(async () => deployment),
    createDeployment: vi.fn(async () => deployment),
    listDeployments: vi.fn(async (): Promise<Deployment[]> => [deployment]),
    ...overrides,
  };
  return client as unknown as AppsScriptClient & typeof client;
}

function baseOptions(rootDir: string) {
  return {
    scriptId: 'script-abc',
    rootDir,
    ignore: [],
    dryRun: false,
    createVersion: true,
    description: 'ci-abc1234-5',
  };
}

describe('deploy', () => {
  it('skips every write when there is no difference', async () => {
    const rootDir = await makeProject();
    const client = fakeClient({
      getContent: vi.fn(async () => [
        { name: 'Code', type: 'SERVER_JS', source: 'function main() {}' },
        { name: 'appsscript', type: 'JSON', source: MANIFEST },
      ]),
    });

    const result = await deploy(client, baseOptions(rootDir));

    expect(result.changed).toBe(false);
    expect(client.updateContent).not.toHaveBeenCalled();
    expect(client.createVersion).not.toHaveBeenCalled();
  });

  it('stops after computing the diff when dryRun is set', async () => {
    const rootDir = await makeProject();
    const client = fakeClient();

    const result = await deploy(client, { ...baseOptions(rootDir), dryRun: true });

    expect(result.changed).toBe(true);
    expect(result.diff.added).toEqual(['Code', 'appsscript']);
    expect(client.updateContent).not.toHaveBeenCalled();
  });

  it('updates the existing deployment when deploymentId is given', async () => {
    const rootDir = await makeProject();
    const client = fakeClient();

    const result = await deploy(client, { ...baseOptions(rootDir), deploymentId: 'dep-1' });

    expect(client.updateDeployment).toHaveBeenCalledWith('script-abc', 'dep-1', 7, 'ci-abc1234-5');
    expect(client.createDeployment).not.toHaveBeenCalled();
    expect(result.webAppUrl).toBe('https://example.com/exec');
    expect(result.versionNumber).toBe(7);
  });

  it('creates a new deployment when deploymentId is absent', async () => {
    const rootDir = await makeProject();
    const client = fakeClient();

    await deploy(client, baseOptions(rootDir));

    expect(client.createDeployment).toHaveBeenCalledWith('script-abc', 7, 'ci-abc1234-5');
    expect(client.updateDeployment).not.toHaveBeenCalled();
  });

  it('warns that the web app url will change when a webapp has no deploymentId', async () => {
    const rootDir = await makeProject();
    const client = fakeClient();

    const result = await deploy(client, { ...baseOptions(rootDir), projectType: 'webapp' });

    expect(result.warnings.join('\n')).toContain('URL');
  });

  it('does not warn about the url for a standalone project', async () => {
    const rootDir = await makeProject();
    const client = fakeClient();

    const result = await deploy(client, { ...baseOptions(rootDir), projectType: 'standalone' });

    expect(result.warnings.join('\n')).not.toContain('URL');
  });

  it('does not warn about the url when there is nothing to deploy', async () => {
    const rootDir = await makeProject();
    const client = fakeClient({
      getContent: vi.fn(async () => [
        { name: 'Code', type: 'SERVER_JS', source: 'function main() {}' },
        { name: 'appsscript', type: 'JSON', source: MANIFEST },
      ]),
    });

    const result = await deploy(client, { ...baseOptions(rootDir), projectType: 'webapp' });

    expect(result.changed).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('still warns about the url during a dry run, since a dry run previews consequences', async () => {
    const rootDir = await makeProject();
    const client = fakeClient();

    const result = await deploy(client, { ...baseOptions(rootDir), projectType: 'webapp', dryRun: true });

    expect(result.warnings.join('\n')).toContain('URL');
  });

  it('stops after updateContent when createVersion is false', async () => {
    const rootDir = await makeProject();
    const client = fakeClient();

    const result = await deploy(client, { ...baseOptions(rootDir), createVersion: false });

    expect(client.updateContent).toHaveBeenCalled();
    expect(client.createVersion).not.toHaveBeenCalled();
    expect(result.versionNumber).toBeUndefined();
  });

  it('warns when the versioned deployment count reaches the threshold', async () => {
    const rootDir = await makeProject();
    const many: Deployment[] = Array.from({ length: DEPLOYMENT_COUNT_WARN_THRESHOLD }, (_, i) => ({
      deploymentId: `dep-${i}`,
      versionNumber: i + 1,
    }));
    const client = fakeClient({ listDeployments: vi.fn(async () => many) });

    const result = await deploy(client, baseOptions(rootDir));

    expect(result.warnings.join('\n')).toContain('デプロイ');
  });

  it('does not count the HEAD deployment, which has no version number', async () => {
    const rootDir = await makeProject();
    const justBelow: Deployment[] = [
      { deploymentId: 'head' },
      ...Array.from({ length: DEPLOYMENT_COUNT_WARN_THRESHOLD - 1 }, (_, i) => ({
        deploymentId: `dep-${i}`,
        versionNumber: i + 1,
      })),
    ];
    const client = fakeClient({ listDeployments: vi.fn(async () => justBelow) });

    const result = await deploy(client, baseOptions(rootDir));

    expect(result.warnings.join('\n')).not.toContain('デプロイ数');
  });
});
