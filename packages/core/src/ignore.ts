import picomatch from 'picomatch';

/** `.claspignore` が無い場合に使う既定の除外パターン。 */
export const DEFAULT_IGNORE = [
  'node_modules/**',
  '.git/**',
  '**/*.test.*',
  '**/*.spec.*',
];

/**
 * clasp のセマンティクスで除外判定を行う関数を返す。
 * パターンは除外を意味し、`!` 始まりは再包含。最後にマッチしたパターンが勝つ。
 *
 * @returns 与えられた相対パスを除外すべきなら true
 */
export function createIgnoreFilter(patterns: string[]): (relativePath: string) => boolean {
  const matchers = patterns.map((pattern) => {
    const negated = pattern.startsWith('!');
    const body = negated ? pattern.slice(1) : pattern;
    return { negated, isMatch: picomatch(body, { dot: true }) };
  });

  return (relativePath: string): boolean => {
    let ignored = false;
    for (const matcher of matchers) {
      if (matcher.isMatch(relativePath)) {
        ignored = !matcher.negated;
      }
    }
    return ignored;
  };
}

/** `.claspignore` の内容をパターン配列に変換する。 */
export function parseClaspIgnore(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}
