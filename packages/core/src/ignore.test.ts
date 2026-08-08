import { describe, expect, it } from 'vitest';
import { DEFAULT_IGNORE, createIgnoreFilter, parseClaspIgnore } from './ignore.js';

describe('createIgnoreFilter', () => {
  it('ignores nothing when there are no patterns', () => {
    const isIgnored = createIgnoreFilter([]);
    expect(isIgnored('Code.js')).toBe(false);
  });

  it('ignores paths matching a pattern', () => {
    const isIgnored = createIgnoreFilter(['node_modules/**']);
    expect(isIgnored('node_modules/lib/index.js')).toBe(true);
    expect(isIgnored('Code.js')).toBe(false);
  });

  it('re-includes paths with a negated pattern, last match winning', () => {
    const isIgnored = createIgnoreFilter(['**/*.js', '!Code.js']);
    expect(isIgnored('other.js')).toBe(true);
    expect(isIgnored('Code.js')).toBe(false);
  });

  it('lets a later ignore pattern override an earlier negation', () => {
    const isIgnored = createIgnoreFilter(['!Code.js', '**/*.js']);
    expect(isIgnored('Code.js')).toBe(true);
  });

  it('matches dotfiles', () => {
    const isIgnored = createIgnoreFilter(['**/.*']);
    expect(isIgnored('.env')).toBe(true);
  });

  it('ignores test files and node_modules by default', () => {
    const isIgnored = createIgnoreFilter(DEFAULT_IGNORE);
    expect(isIgnored('node_modules/x/index.js')).toBe(true);
    expect(isIgnored('Code.test.js')).toBe(true);
    expect(isIgnored('Code.js')).toBe(false);
  });

  it('matches the file selection real clasp produced for the reference fixture', () => {
    const isIgnored = createIgnoreFilter(parseClaspIgnore('**/*.test.js\nignored.txt\n'));

    // clasp が push したファイル
    expect(isIgnored('app.js.html')).toBe(false);
    expect(isIgnored('appsscript.json')).toBe(false);
    expect(isIgnored('Code.js')).toBe(false);
    expect(isIgnored('Legacy.gs')).toBe(false);
    expect(isIgnored('ui/Sidebar.html')).toBe(false);

    // clasp が push しなかったファイル
    expect(isIgnored('Code.test.js')).toBe(true);
    expect(isIgnored('ignored.txt')).toBe(true);
  });

  // 以下は実際の clasp v3.3.0 の挙動を実測して固定したもの。
  // clasp は glob マッチであって gitignore セマンティクスではないため、
  // 利用者の直感に反する挙動が含まれる。ここを「直す」と clasp 互換が壊れる。

  it('replicates clasp: a leading-slash pattern matches nothing', () => {
    const isIgnored = createIgnoreFilter(['/Code.js']);
    expect(isIgnored('Code.js')).toBe(false);
    expect(isIgnored('sub/Code.js')).toBe(false);
  });

  it('replicates clasp: a trailing-slash directory pattern matches nothing', () => {
    const isIgnored = createIgnoreFilter(['build/']);
    expect(isIgnored('build/out.js')).toBe(false);
  });

  it('replicates clasp: a bare filename matches at the root but not in a subdirectory', () => {
    const isIgnored = createIgnoreFilter(['secrets.js']);
    expect(isIgnored('secrets.js')).toBe(true);
    expect(isIgnored('nested/secrets.js')).toBe(false);
  });

  it('replicates clasp: a **/ prefix matches at any depth', () => {
    const isIgnored = createIgnoreFilter(['**/secrets.js']);
    expect(isIgnored('secrets.js')).toBe(true);
    expect(isIgnored('nested/secrets.js')).toBe(true);
  });
});

describe('parseClaspIgnore', () => {
  it('drops blank lines and comments and trims whitespace', () => {
    const content = ['# comment', '', '  node_modules/**  ', '!Code.js', '   ', '# trailing'].join('\n');
    expect(parseClaspIgnore(content)).toEqual(['node_modules/**', '!Code.js']);
  });
});
