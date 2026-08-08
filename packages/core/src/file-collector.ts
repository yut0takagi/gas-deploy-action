import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { GasDeployError } from './errors.js';
import { createIgnoreFilter } from './ignore.js';
import type { FileType, ScriptFile } from './types.js';

const MANIFEST_NAME = 'appsscript';

const EXTENSION_TO_TYPE: Record<string, FileType> = {
  '.js': 'SERVER_JS',
  '.gs': 'SERVER_JS',
  '.html': 'HTML',
  '.json': 'JSON',
};

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, root, out);
    } else if (entry.isFile()) {
      out.push(toPosix(relative(root, full)));
    }
  }
}

/**
 * rootDir 配下を走査し、Apps Script API の files に渡せる形へ変換する。
 * 拡張子は name から取り除かれ、サブディレクトリは "/" 区切りで保持される。
 */
export async function collectFiles(rootDir: string, ignorePatterns: readonly string[]): Promise<ScriptFile[]> {
  const relativePaths: string[] = [];
  await walk(rootDir, rootDir, relativePaths);

  const isIgnored = createIgnoreFilter(ignorePatterns);
  const files: ScriptFile[] = [];

  for (const relativePath of relativePaths) {
    if (isIgnored(relativePath)) continue;

    const extension = extname(relativePath).toLowerCase();
    const type = EXTENSION_TO_TYPE[extension];
    if (!type) continue;

    const name = relativePath.slice(0, relativePath.length - extension.length);

    // Apps Script が保持できる JSON はマニフェストのみ。
    if (type === 'JSON' && name !== MANIFEST_NAME) continue;

    const source = await readFile(join(rootDir, relativePath), 'utf8');
    files.push({ name, type, source });
  }

  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const hasManifest = files.some((file) => file.name === MANIFEST_NAME && file.type === 'JSON');
  if (!hasManifest) {
    throw new GasDeployError(`${rootDir} に appsscript.json が見つかりません`, {
      nextSteps: [
        'root-dir が正しいディレクトリを指しているか確認してください',
        'ビルド出力に appsscript.json をコピーする手順が抜けていないか確認してください',
        'appsscript.json が .claspignore や ignore 設定で除外されていないか確認してください',
      ],
    });
  }

  return files;
}
