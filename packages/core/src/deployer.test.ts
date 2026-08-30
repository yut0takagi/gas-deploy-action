import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEPLOYMENT_COUNT_WARN_THRESHOLD, deploy } from './deployer.js';
import { GasDeployError } from './errors.js';
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
    // 既存デプロイは更新前 v6 を指しており、この実行で v7 に上がる想定。
    getDeployment: vi.fn(async (): Promise<Deployment> => ({ deploymentId: 'dep-1', versionNumber: 6 })),
    updateDeployment: vi.fn(async () => deployment),
    createDeployment: vi.fn(async () => deployment),
    listDeployments: vi.fn(async (): Promise<Deployment[]> => [deployment]),
    ...overrides,
  };
  return client as unknown as AppsScriptClient & typeof client;
}

/**
 * ローカルは makeProject() の2件（appsscript + Code）。リモートに3件を足すことで
 * 5件中3件（60%）が削除される、事故の規模の差分を作る。
 */
function massDeletionRemote(): ScriptFile[] {
  return [
    { name: 'appsscript', type: 'JSON', source: MANIFEST },
    { name: 'Code', type: 'SERVER_JS', source: 'function main() {}' },
    { name: 'Gone1', type: 'SERVER_JS', source: 'a' },
    { name: 'Gone2', type: 'SERVER_JS', source: 'b' },
    { name: 'Gone3', type: 'SERVER_JS', source: 'c' },
  ];
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
    const client = fakeClient({ getContent: vi.fn(async () => massDeletionRemote()) });

    const result = await deploy(client, { ...baseOptions(rootDir), dryRun: true });

    expect(result.diff.deleted).toEqual(['Gone1', 'Gone2', 'Gone3']);
    expect(result.warnings.join('\n')).toContain('削除されます');
  });

  // 事故（root-dir の誤指定・ビルド失敗）で稼働中のスクリプトが消えるのを防ぐのが目的。
  // 判定そのものは dry-run のテストで確認済みなので、ここでは「書かずに止まるか」を見る。
  it('refuses to write when most of the remote files would be deleted', async () => {
    const rootDir = await makeProject();
    const client = fakeClient({ getContent: vi.fn(async () => massDeletionRemote()) });

    await expect(deploy(client, baseOptions(rootDir))).rejects.toThrowError(GasDeployError);
    expect(client.updateContent).not.toHaveBeenCalled();
    expect(client.createVersion).not.toHaveBeenCalled();
  });

  it('names the files that would be deleted so the cause is identifiable', async () => {
    const rootDir = await makeProject();
    const client = fakeClient({ getContent: vi.fn(async () => massDeletionRemote()) });

    const error = await deploy(client, baseOptions(rootDir)).then(
      () => undefined,
      (e: unknown) => e as GasDeployError,
    );
    expect(error).toBeInstanceOf(GasDeployError);
    expect(error!.nextSteps.join('\n')).toContain('Gone1');
    expect(error!.nextSteps.join('\n')).toContain('root-dir');
    expect(error!.nextSteps.join('\n')).toContain('allow-delete');
  });

  it('proceeds when allowDelete opts in to the deletion', async () => {
    const rootDir = await makeProject();
    const client = fakeClient({ getContent: vi.fn(async () => massDeletionRemote()) });

    const result = await deploy(client, { ...baseOptions(rootDir), allowDelete: true });

    expect(result.changed).toBe(true);
    expect(client.updateContent).toHaveBeenCalled();
  });

  // dry-run は「実際に走らせたらどうなるか」を見るためのもの。ここで失敗させると、
  // 削除内容を確認してから allow-delete を判断する手順が踏めなくなる。
  it('still reports the diff under dry-run instead of refusing', async () => {
    const rootDir = await makeProject();
    const client = fakeClient({ getContent: vi.fn(async () => massDeletionRemote()) });

    const result = await deploy(client, { ...baseOptions(rootDir), dryRun: true });

    expect(result.diff.deleted).toEqual(['Gone1', 'Gone2', 'Gone3']);
    expect(client.updateContent).not.toHaveBeenCalled();
  });

  // 通常の削除まで止めると、ファイルを消すたびに allow-delete が要る。やがて恒久的に
  // true で置きっぱなしにされ、本当に止めたい事故のときにも素通りするようになる。
  it('does not block a small number of deletions', async () => {
    const rootDir = await makeProject();
    const keepNames = Array.from({ length: 8 }, (_, i) => `Keep${i}`);
    for (const name of keepNames) {
      await writeFile(join(rootDir, `${name}.js`), 'x', 'utf8');
    }
    const client = fakeClient({
      getContent: vi.fn(async () => [
        { name: 'appsscript', type: 'JSON' as const, source: MANIFEST },
        { name: 'Code', type: 'SERVER_JS' as const, source: 'function main() {}' },
        ...keepNames.map((name) => ({ name, type: 'SERVER_JS' as const, source: 'x' })),
        { name: 'Gone1', type: 'SERVER_JS' as const, source: 'y' },
        { name: 'Gone2', type: 'SERVER_JS' as const, source: 'z' },
      ]),
    });

    const result = await deploy(client, baseOptions(rootDir));

    expect(result.diff.deleted).toEqual(['Gone1', 'Gone2']);
    expect(client.updateContent).toHaveBeenCalled();
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

describe('deploy の previousVersionNumber', () => {
  it('deploymentId 指定時、更新前に指していたバージョンを返す', async () => {
    const rootDir = await makeProject();
    const client = fakeClient();

    const result = await deploy(client, { ...baseOptions(rootDir), deploymentId: 'dep-1' });

    expect(result.previousVersionNumber).toBe(6);
    expect(result.versionNumber).toBe(7);
  });

  it('書き込みを始める前に読む（更新後に読むと古い値を掴む）', async () => {
    // Apps Script API のデプロイ読み取りは書き込み直後の一貫性を保証しないため、
    // 読む順序そのものが正しさの条件になる。
    const rootDir = await makeProject();
    const order: string[] = [];
    const client = fakeClient({
      getDeployment: vi.fn(async (): Promise<Deployment> => {
        order.push('getDeployment');
        return { deploymentId: 'dep-1', versionNumber: 6 };
      }),
      updateContent: vi.fn(async () => {
        order.push('updateContent');
      }),
      updateDeployment: vi.fn(async () => {
        order.push('updateDeployment');
        return { deploymentId: 'dep-1', versionNumber: 7 };
      }),
    });

    await deploy(client, { ...baseOptions(rootDir), deploymentId: 'dep-1' });

    expect(order.indexOf('getDeployment')).toBeLessThan(order.indexOf('updateContent'));
    expect(order.indexOf('getDeployment')).toBeLessThan(order.indexOf('updateDeployment'));
  });

  it('deploymentId 未指定なら読まない（新規デプロイには「更新前」が無い）', async () => {
    const rootDir = await makeProject();
    const client = fakeClient();

    const result = await deploy(client, baseOptions(rootDir));

    expect(client.getDeployment).not.toHaveBeenCalled();
    expect(result.previousVersionNumber).toBeUndefined();
  });

  it('createVersion が false なら読まない（デプロイを更新しないため）', async () => {
    const rootDir = await makeProject();
    const client = fakeClient();

    await deploy(client, { ...baseOptions(rootDir), deploymentId: 'dep-1', createVersion: false });

    expect(client.getDeployment).not.toHaveBeenCalled();
  });

  it('dry-run では読まない（書き込まないので更新前も何も無い）', async () => {
    const rootDir = await makeProject();
    const client = fakeClient();

    await deploy(client, { ...baseOptions(rootDir), deploymentId: 'dep-1', dryRun: true });

    expect(client.getDeployment).not.toHaveBeenCalled();
  });
});
