import type { FileDiff, ScriptFile } from './types.js';

// ファイル名に現れ得ない文字を区切りに使う。空白だと "My File" のような名前で壊れる。
// name 自体が U+0000 を含む場合は nameOf が切り詰めるが、Apps Script のファイル名に
// 制御文字は現れないため実害はない。
const KEY_SEPARATOR = '\0';

/**
 * 改行コードの差異による偽差分を防ぐ。CRLF を LF に揃え、末尾の改行をちょうど1つにする。
 *
 * 正規化するのはこの2点のみ。単独の `\r`（旧 Mac 形式）、BOM、Unicode 正規化形は
 * 変換しない。実 API との往復ではこの範囲で差分ゼロになることを実測で確認済み。
 */
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

/**
 * name + type をキーに差分を求める。type が変わった場合は追加＋削除として扱う。
 *
 * 前提: `local` / `remote` それぞれの中で name + type は一意であること。重複がある場合は
 * 後勝ちで黙って1件に潰れる。通常の経路では `collectFiles` が重複を検出して失敗させるため
 * ここには到達しない。
 */
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

  // コードユニット順で並べる。localeCompare は Node のビルドに同梱される ICU に依存し、
  // 環境によって並び順が変わる。この結果は machine-readable な output として公開するため
  // 環境非依存であることを優先する。
  const sort = (list: string[]): string[] => list.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return { added: sort(added), modified: sort(modified), deleted: sort(deleted) };
}

export function hasChanges(diff: FileDiff): boolean {
  return diff.added.length + diff.modified.length + diff.deleted.length > 0;
}
