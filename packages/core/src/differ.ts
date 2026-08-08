import type { FileDiff, ScriptFile } from './types.js';

// ファイル名に現れ得ない文字を区切りに使う。空白だと "My File" のような名前で壊れる。
const KEY_SEPARATOR = '\0';

/** 改行コードの差異による偽差分を防ぐ。 */
export function normalizeSource(source: string): string {
  return source.replace(/\r\n/g, '\n').replace(/\n+$/, '') + '\n';
}

function keyOf(file: ScriptFile): string {
  return `${file.name}${KEY_SEPARATOR}${file.type}`;
}

function nameOf(key: string): string {
  return key.split(KEY_SEPARATOR)[0] ?? '';
}

function toMap(files: ScriptFile[]): Map<string, string> {
  return new Map(files.map((file) => [keyOf(file), normalizeSource(file.source)]));
}

/** name + type をキーに差分を求める。type が変わった場合は追加＋削除として扱う。 */
export function diffFiles(local: ScriptFile[], remote: ScriptFile[]): FileDiff {
  const localMap = toMap(local);
  const remoteMap = toMap(remote);

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const [key, source] of localMap) {
    const remoteSource = remoteMap.get(key);
    if (remoteSource === undefined) {
      added.push(nameOf(key));
    } else if (remoteSource !== source) {
      modified.push(nameOf(key));
    }
  }

  for (const key of remoteMap.keys()) {
    if (!localMap.has(key)) {
      deleted.push(nameOf(key));
    }
  }

  const sort = (list: string[]): string[] => list.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return { added: sort(added), modified: sort(modified), deleted: sort(deleted) };
}

export function hasChanges(diff: FileDiff): boolean {
  return diff.added.length + diff.modified.length + diff.deleted.length > 0;
}
