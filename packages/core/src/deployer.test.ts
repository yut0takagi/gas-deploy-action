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

  it('warns when most of the remote files would be deleted', async () => {
    const rootDir = await makeProject();
    const client = fakeClient({
      getContent: vi.fn(async () => [
        { name: 'appsscript', type: 'JSON', source: MANIFEST },
        { name: 'Code', type: 'SERVER_JS', source: 'function main() {}' },
        { name: 'Gone1', type: 'SERVER_JS', source: 'a' },
        { name: 'Gone2', type: 'SERVER_JS', source: 'b' },
        { name: 'Gone3', type: 'SERVER_JS', source: 'c' },
      ]),
    });

    const result = await deploy(client, { ...baseOptions(rootDir), dryRun: true });

    expect(result.diff.deleted).toEqual(['Gone1', 'Gone2', 'Gone3']);
    expect(result.warnings.join('\n')).toContain('削除されます');
  });

  it('does not warn when only a small share of files is deleted', async () => {
    const rootDir = await makeProject();
    // makeProject() only creates appsscript.json + Code.js locally, so to genuinely exercise a
    // "small share deleted" case (rather than tripping the mass-deletion rule via the fixture
    // itself) we add 8 more local files that the remote side mirrors exactly, plus 2 files that
    // only exist remotely. That gives 12 remote files with only 2 deleted (~17%), comfortably
    // under MASS_DELETION_RATIO (50%) even though it clears MASS_DELETION_MIN_FILES (2).
    const keepNames = Array.from({ length: 8 }, (_, i) => `Keep${i}`);
    for (const name of keepNames) {
      await writeFile(join(rootDir, `${name}.js`), 'x', 'utf8');
    }
    const remote = [
      { name: 'appsscript', type: 'JSON' as const, source: MANIFEST },
      { name: 'Code', type: 'SERVER_JS' as const, source: 'function main() {}' },
      ...keepNames.map((name) => ({ name, type: 'SERVER_JS' as const, source: 'x' })),
      { name: 'Gone1', type: 'SERVER_JS' as const, source: 'y' },
      { name: 'Gone2', type: 'SERVER_JS' as const, source: 'z' },
    ];
    const client = fakeClient({ getContent: vi.fn(async () => remote) });

    const result = await deploy(client, { ...baseOptions(rootDir), dryRun: true });

    expect(result.diff.deleted).toEqual(['Gone1', 'Gone2']);
    expect(result.warnings.join('\n')).not.toContain('削除されます');
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
