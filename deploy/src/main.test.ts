import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GasDeployError } from '@gas-deploy/core';
import { describe, expect, it } from 'vitest';
import { parseProjectType, resolveIgnorePatterns } from './main.js';

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
