import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectFiles, MAX_FILE_BYTES } from './file-collector.js';
import { GasDeployError } from './errors.js';

const MANIFEST = JSON.stringify({ timeZone: 'Asia/Tokyo', exceptionLogging: 'STACKDRIVER' });

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gas-collect-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const full = join(root, relativePath);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  return root;
}

describe('collectFiles', () => {
  it('maps extensions to Apps Script file types and strips the extension from the name', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'Code.js': 'function main() {}',
      'Legacy.gs': 'function legacy() {}',
      'Page.html': '<p>hi</p>',
    });

    const files = await collectFiles(root, []);

    expect(files).toEqual([
      { name: 'Code', type: 'SERVER_JS', source: 'function main() {}' },
      { name: 'Legacy', type: 'SERVER_JS', source: 'function legacy() {}' },
      { name: 'Page', type: 'HTML', source: '<p>hi</p>' },
      { name: 'appsscript', type: 'JSON', source: MANIFEST },
    ]);
  });

  it('represents subdirectories with posix separators in the name', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'ui/Sidebar.html': '<div></div>',
    });

    const files = await collectFiles(root, []);

    expect(files.map((f) => f.name)).toContain('ui/Sidebar');
  });

  it('skips files excluded by the ignore patterns', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'Code.js': 'function main() {}',
      'Code.test.js': 'test stuff',
    });

    const files = await collectFiles(root, ['**/*.test.*']);

    expect(files.map((f) => f.name)).toEqual(['Code', 'appsscript']);
  });

  it('skips files with unsupported extensions', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'Code.js': 'function main() {}',
      'README.md': '# docs',
      'data.csv': 'a,b',
    });

    const files = await collectFiles(root, []);

    expect(files.map((f) => f.name)).toEqual(['Code', 'appsscript']);
  });

  it('skips json files other than the manifest, which Apps Script cannot hold', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'config.json': '{"a":1}',
    });

    const files = await collectFiles(root, []);

    expect(files.map((f) => f.name)).toEqual(['appsscript']);
  });

  it('returns files sorted by name for deterministic output', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'Zebra.js': '',
      'Alpha.js': '',
    });

    const files = await collectFiles(root, []);

    expect(files.map((f) => f.name)).toEqual(['Alpha', 'Zebra', 'appsscript']);
  });

  it('fails before any API call when appsscript.json is missing', async () => {
    const root = await makeProject({ 'Code.js': 'function main() {}' });

    await expect(collectFiles(root, [])).rejects.toThrowError(GasDeployError);
  });

  it('strips only the final extension, so app.js.html becomes an HTML file named app.js', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'app.js.html': '<script></script>',
    });

    const files = await collectFiles(root, []);

    expect(files).toContainEqual({ name: 'app.js', type: 'HTML', source: '<script></script>' });
  });

  it('collects a symlink pointing at a file, as clasp does', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'Code.js': 'function main() {}',
    });
    await symlink('Code.js', join(root, 'Linked.js'));

    const files = await collectFiles(root, []);

    expect(files).toContainEqual({ name: 'Linked', type: 'SERVER_JS', source: 'function main() {}' });
  });

  it('does not traverse a symlink pointing at a directory, as clasp does', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'ui/Sidebar.html': '<div></div>',
    });
    await symlink('ui', join(root, 'LinkedDir'));

    const files = await collectFiles(root, []);

    expect(files.map((f) => f.name)).toEqual(['appsscript', 'ui/Sidebar']);
  });

  it('skips a broken symlink instead of throwing', async () => {
    const root = await makeProject({ 'appsscript.json': MANIFEST });
    await symlink('does-not-exist.js', join(root, 'Broken.js'));

    await expect(collectFiles(root, [])).resolves.toHaveLength(1);
  });

  it('fails with a guided error when a file exceeds the size limit', async () => {
    const root = await makeProject({ 'appsscript.json': MANIFEST });
    await writeFile(join(root, 'Huge.js'), 'x'.repeat(MAX_FILE_BYTES + 1), 'utf8');

    const err = await collectFiles(root, []).catch((e: GasDeployError) => e);

    expect(err).toBeInstanceOf(GasDeployError);
    expect((err as GasDeployError).nextSteps.length).toBeGreaterThan(0);
  });

  it('skips extension-less files and dotfiles', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'Code.js': 'function main() {}',
      Makefile: 'all:',
      '.eslintrc': '{}',
    });

    const files = await collectFiles(root, []);

    expect(files.map((f) => f.name)).toEqual(['Code', 'appsscript']);
  });

  it('reports a guided error when rootDir does not exist', async () => {
    const err = await collectFiles(join(tmpdir(), 'gas-does-not-exist-12345'), []).catch(
      (e: GasDeployError) => e,
    );

    expect(err).toBeInstanceOf(GasDeployError);
    expect((err as GasDeployError).nextSteps.length).toBeGreaterThan(0);
  });

  it('refuses to collect two files that would become the same Apps Script file', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'Code.js': 'function fromJs() {}',
      'Code.gs': 'function fromGs() {}',
    });

    const err = await collectFiles(root, []).catch((e: GasDeployError) => e);

    expect(err).toBeInstanceOf(GasDeployError);
    expect((err as GasDeployError).message).toContain('Code.js');
    expect((err as GasDeployError).message).toContain('Code.gs');
  });
});
