import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GasDeployError } from '@gas-deploy/core';
import type { MultiDeployResult, ResolvedTarget } from '@gas-deploy/core';
import { describe, expect, it } from 'vitest';
import {
  buildDeployTargets,
  buildDeploymentsOutput,
  parseProjectsInput,
  parseProjectType,
  readConfigFile,
  resolveIgnorePatterns,
  resolvePrCommentContext,
  resolveTargetIgnore,
} from './main.js';

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'gas-deploy-main-'));
}

describe('parseProjectType', () => {
  it.each(['webapp', 'addon', 'bound', 'standalone'] as const)('accepts %s', (value) => {
    expect(parseProjectType(value)).toBe(value);
  });

  it('throws a GasDeployError for an unrecognized value', () => {
    expect(() => parseProjectType('not-a-type')).toThrow(GasDeployError);
  });
});

describe('resolveIgnorePatterns', () => {
  it('prefers the ignore input when it is non-empty', async () => {
    const root = await makeTempDir();
    await writeFile(join(root, '.claspignore'), 'from-file/**\n', 'utf8');

    const patterns = await resolveIgnorePatterns(root, 'from-input/**');

    expect(patterns).toEqual(['from-input/**']);
  });

  it('reads .claspignore when the ignore input is empty', async () => {
    const root = await makeTempDir();
    await writeFile(join(root, '.claspignore'), 'from-file/**\n', 'utf8');

    const patterns = await resolveIgnorePatterns(root, '');

    expect(patterns).toEqual(['from-file/**']);
  });

  it('returns DEFAULT_IGNORE when .claspignore is absent', async () => {
    const root = await makeTempDir();

    const patterns = await resolveIgnorePatterns(root, '');

    expect(patterns).toContain('node_modules/**');
  });

  it('throws a GasDeployError when .claspignore exists but cannot be read (EISDIR)', async () => {
    const root = await makeTempDir();
    // .claspignore をディレクトリにすることで EISDIR を再現する（ENOENT とは区別する必要がある）。
    await mkdir(join(root, '.claspignore'));

    await expect(resolveIgnorePatterns(root, '')).rejects.toThrow(GasDeployError);
  });
});

describe('parseProjectsInput', () => {
  it('treats an empty string as "all" (undefined)', () => {
    expect(parseProjectsInput('')).toBeUndefined();
  });

  it('treats "all" as undefined', () => {
    expect(parseProjectsInput('all')).toBeUndefined();
  });

  it('splits a comma-separated list and trims whitespace', () => {
    expect(parseProjectsInput('web-app, sheet-tools ,other')).toEqual(['web-app', 'sheet-tools', 'other']);
  });

  it('drops empty entries caused by stray commas', () => {
    expect(parseProjectsInput('web-app,,sheet-tools,')).toEqual(['web-app', 'sheet-tools']);
  });
});

describe('readConfigFile', () => {
  it('returns the file contents when it exists', async () => {
    const root = await makeTempDir();
    const path = join(root, 'gasdeploy.yml');
    await writeFile(path, 'version: 1\n', 'utf8');

    await expect(readConfigFile(path)).resolves.toBe('version: 1\n');
  });

  it('throws a GasDeployError naming the path when the file is missing', async () => {
    const root = await makeTempDir();
    const path = join(root, 'missing.yml');

    let error: unknown;
    try {
      await readConfigFile(path);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(GasDeployError);
    expect((error as GasDeployError).message).toContain(path);
    expect((error as GasDeployError).message).toContain('見つかりません');
  });

  it('throws a GasDeployError when the path exists but cannot be read (EISDIR)', async () => {
    const root = await makeTempDir();
    const path = join(root, 'gasdeploy.yml');
    await mkdir(path);

    await expect(readConfigFile(path)).rejects.toThrow(GasDeployError);
  });
});

describe('resolveTargetIgnore', () => {
  it('uses the target ignore when non-empty, without touching .claspignore', async () => {
    const root = await makeTempDir();
    await writeFile(join(root, '.claspignore'), 'from-file/**\n', 'utf8');

    const patterns = await resolveTargetIgnore({ ignore: ['from-config/**'], rootDir: root }, '');

    expect(patterns).toEqual(['from-config/**']);
  });

  it('falls back to the ignore input when the target ignore is empty', async () => {
    const root = await makeTempDir();

    const patterns = await resolveTargetIgnore({ ignore: [], rootDir: root }, 'from-input/**');

    expect(patterns).toEqual(['from-input/**']);
  });

  it('falls back to .claspignore when both target ignore and the ignore input are empty', async () => {
    const root = await makeTempDir();
    await writeFile(join(root, '.claspignore'), 'from-file/**\n', 'utf8');

    const patterns = await resolveTargetIgnore({ ignore: [], rootDir: root }, '');

    expect(patterns).toEqual(['from-file/**']);
  });

  it('falls back to DEFAULT_IGNORE when nothing else is set', async () => {
    const root = await makeTempDir();

    const patterns = await resolveTargetIgnore({ ignore: [], rootDir: root }, '');

    expect(patterns).toContain('node_modules/**');
  });
});

describe('buildDeployTargets', () => {
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

  it('applies the ignore fallback and the shared global options to every target', async () => {
    const root = await makeTempDir();
    const targets = [
      makeTarget({ project: 'a', rootDir: root, ignore: ['from-config/**'] }),
      makeTarget({ project: 'b', rootDir: root, ignore: [] }),
    ];

    const result = await buildDeployTargets(targets, {
      ignoreInput: 'from-input/**',
      dryRun: true,
      createVersion: false,
      description: 'ci-test',
    });

    expect(result).toEqual([
      { ...targets[0], ignore: ['from-config/**'], dryRun: true, createVersion: false, description: 'ci-test' },
      { ...targets[1], ignore: ['from-input/**'], dryRun: true, createVersion: false, description: 'ci-test' },
    ]);
  });

  it('preserves optional fields such as deploymentId and projectType', async () => {
    const targets = [makeTarget({ deploymentId: 'dep-1', projectType: 'webapp', ignore: ['x/**'] })];

    const result = await buildDeployTargets(targets, {
      ignoreInput: '',
      dryRun: false,
      createVersion: true,
      description: 'ci-test',
    });

    expect(result[0]?.deploymentId).toBe('dep-1');
    expect(result[0]?.projectType).toBe('webapp');
  });
});

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

describe('resolvePrCommentContext', () => {
  async function writeEvent(payload: unknown): Promise<string> {
    const dir = await makeTempDir();
    const path = join(dir, 'event.json');
    await writeFile(path, JSON.stringify(payload), 'utf8');
    return path;
  }

  it('pull_request イベントから owner / repo / PR 番号を解決する', async () => {
    const eventPath = await writeEvent({ pull_request: { number: 12 } });

    const context = await resolvePrCommentContext({
      GITHUB_REPOSITORY: 'octo/gas',
      GITHUB_EVENT_PATH: eventPath,
    });

    expect(context).toEqual({ owner: 'octo', repo: 'gas', prNumber: 12 });
  });

  it('PR 以外のイベントでは undefined を返す（失敗させない）', async () => {
    const eventPath = await writeEvent({ ref: 'refs/heads/main' });

    const context = await resolvePrCommentContext({
      GITHUB_REPOSITORY: 'octo/gas',
      GITHUB_EVENT_PATH: eventPath,
    });

    expect(context).toBeUndefined();
  });

  it('イベントファイルが読めない場合も undefined を返す', async () => {
    const dir = await makeTempDir();

    const context = await resolvePrCommentContext({
      GITHUB_REPOSITORY: 'octo/gas',
      GITHUB_EVENT_PATH: join(dir, 'missing.json'),
    });

    expect(context).toBeUndefined();
  });

  it('イベントファイルが壊れている場合も undefined を返す', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'event.json');
    await writeFile(path, '{ not json', 'utf8');

    const context = await resolvePrCommentContext({ GITHUB_REPOSITORY: 'octo/gas', GITHUB_EVENT_PATH: path });

    expect(context).toBeUndefined();
  });

  it('環境変数が欠けている場合は undefined を返す', async () => {
    const eventPath = await writeEvent({ pull_request: { number: 12 } });

    expect(await resolvePrCommentContext({ GITHUB_EVENT_PATH: eventPath })).toBeUndefined();
    expect(await resolvePrCommentContext({ GITHUB_REPOSITORY: 'octo/gas' })).toBeUndefined();
  });

  it('GITHUB_REPOSITORY が owner/repo 形式でない場合は undefined を返す', async () => {
    const eventPath = await writeEvent({ pull_request: { number: 12 } });

    const context = await resolvePrCommentContext({ GITHUB_REPOSITORY: 'noslash', GITHUB_EVENT_PATH: eventPath });

    expect(context).toBeUndefined();
  });
});
