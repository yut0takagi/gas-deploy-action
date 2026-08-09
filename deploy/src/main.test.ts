import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GasDeployError } from '@gas-deploy/core';
import type { ResolvedTarget } from '@gas-deploy/core';
import { describe, expect, it } from 'vitest';
import {
  buildDeployTargets,
  parseProjectsInput,
  parseProjectType,
  readConfigFile,
  resolveIgnorePatterns,
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
