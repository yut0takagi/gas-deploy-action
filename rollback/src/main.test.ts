import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GasDeployError } from '@gas-deploy/core';
import { describe, expect, it } from 'vitest';
import { parseVersionNumberInput, readConfigFile, resolveConfigTarget } from './main.js';

const CONFIG = `
version: 1
projects:
  web-app:
    rootDir: apps/web-app/dist
    type: webapp
    environments:
      dev:
        scriptId: dev-script
      prod:
        scriptId: \${PROD_SCRIPT_ID}
        deploymentId: prod-deployment
  sheet-tools:
    rootDir: apps/sheet-tools/dist
    environments:
      prod:
        scriptId: sheet-script
`;

describe('parseVersionNumberInput', () => {
  it('空文字列は「1つ前に戻す」を意味する undefined になる', () => {
    expect(parseVersionNumberInput('')).toBeUndefined();
    expect(parseVersionNumberInput('   ')).toBeUndefined();
  });

  it('整数の文字列をそのまま数値にする', () => {
    expect(parseVersionNumberInput('42')).toBe(42);
    expect(parseVersionNumberInput(' 42 ')).toBe(42);
    expect(parseVersionNumberInput('1')).toBe(1);
  });

  // Number() 任せにすると通ってしまい、意図しないバージョンに戻る値を明示的に弾く。
  it.each(['1.5', '1e3', '-1', '0', '0x10', 'abc', '4 2', '+3', '１２'])('%s を拒否する', (value) => {
    expect(() => parseVersionNumberInput(value)).toThrow(GasDeployError);
  });

  it('安全な整数の範囲を超える値を拒否する', () => {
    expect(() => parseVersionNumberInput('9007199254740993')).toThrow(GasDeployError);
  });
});

describe('readConfigFile', () => {
  it('存在しない場合、script-id を使う経路も案内して失敗する', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gas-rollback-'));

    try {
      await readConfigFile(join(dir, 'missing.yml'));
      throw new Error('expected readConfigFile to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(GasDeployError);
      expect((error as GasDeployError).format()).toContain('script-id');
    }
  });

  it('存在すれば内容を返す', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gas-rollback-'));
    const path = join(dir, 'gasdeploy.yml');
    await writeFile(path, CONFIG, 'utf8');

    expect(await readConfigFile(path)).toBe(CONFIG);
  });
});

describe('resolveConfigTarget', () => {
  it('プロジェクトと environment から scriptId と deploymentId を解決する', () => {
    const target = resolveConfigTarget(CONFIG, 'prod', 'web-app', { PROD_SCRIPT_ID: 'prod-script' });

    expect(target).toEqual({ scriptId: 'prod-script', deploymentId: 'prod-deployment' });
  });

  it('deploymentId が設定されていない場合は省略する', () => {
    const target = resolveConfigTarget(CONFIG, 'prod', 'sheet-tools', {});

    expect(target).toEqual({ scriptId: 'sheet-script' });
  });

  it('指定したプロジェクトがその environment を持たない場合は失敗する', () => {
    // 名指ししたプロジェクトに環境が無いのはタイプミスなので、静かに何もしないのではなく失敗する。
    expect(() => resolveConfigTarget(CONFIG, 'dev', 'sheet-tools', {})).toThrow(GasDeployError);
  });

  it('存在しないプロジェクト名を指定した場合は失敗する', () => {
    expect(() => resolveConfigTarget(CONFIG, 'prod', 'no-such-project', {})).toThrow(GasDeployError);
  });

  it('参照している環境変数が未設定の場合は失敗する', () => {
    expect(() => resolveConfigTarget(CONFIG, 'prod', 'web-app', {})).toThrow(GasDeployError);
  });

  it('"all" を明示的に拒否する（一度に1プロジェクトのみ）', () => {
    // resolveTargets は projects: ['all'] を「全プロジェクト」として解釈するため、ここで
    // 弾かないと全対象の先頭1件だけが静かにロールバックされる。環境変数を揃えて、
    // 「変数未設定でたまたま失敗した」のではなく "all" 自体を理由に失敗することを確かめる。
    expect(() => resolveConfigTarget(CONFIG, 'prod', 'all', { PROD_SCRIPT_ID: 'prod-script' })).toThrow(
      /"all" は指定できません/,
    );
  });
});
