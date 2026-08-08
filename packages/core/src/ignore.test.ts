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
});

describe('parseClaspIgnore', () => {
  it('drops blank lines and comments and trims whitespace', () => {
    const content = ['# comment', '', '  node_modules/**  ', '!Code.js', '   ', '# trailing'].join('\n');
    expect(parseClaspIgnore(content)).toEqual(['node_modules/**', '!Code.js']);
  });
});
