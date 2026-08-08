import { describe, expect, it } from 'vitest';
import { diffFiles, hasChanges, normalizeSource } from './differ.js';
import type { ScriptFile } from './types.js';

const file = (name: string, source: string): ScriptFile => ({ name, type: 'SERVER_JS', source });

describe('normalizeSource', () => {
  it('converts CRLF to LF', () => {
    expect(normalizeSource('a\r\nb')).toBe('a\nb\n');
  });

  it('collapses trailing newlines to exactly one', () => {
    expect(normalizeSource('a\n\n\n')).toBe('a\n');
    expect(normalizeSource('a')).toBe('a\n');
  });
});

describe('diffFiles', () => {
  it('reports no changes when contents match', () => {
    const local = [file('Code', 'x')];
    const remote = [file('Code', 'x')];
    expect(diffFiles(local, remote)).toEqual({ added: [], modified: [], deleted: [] });
  });

  it('treats a CRLF-only difference as no change', () => {
    const local = [file('Code', 'a\r\nb')];
    const remote = [file('Code', 'a\nb\n')];
    expect(hasChanges(diffFiles(local, remote))).toBe(false);
  });

  it('reports added, modified and deleted files', () => {
    const local = [file('Code', 'new'), file('Fresh', 'x')];
    const remote = [file('Code', 'old'), file('Gone', 'x')];

    expect(diffFiles(local, remote)).toEqual({
      added: ['Fresh'],
      modified: ['Code'],
      deleted: ['Gone'],
    });
  });

  it('treats a type change on the same name as add plus delete', () => {
    const local: ScriptFile[] = [{ name: 'Page', type: 'HTML', source: 'x' }];
    const remote: ScriptFile[] = [{ name: 'Page', type: 'SERVER_JS', source: 'x' }];

    expect(diffFiles(local, remote)).toEqual({
      added: ['Page'],
      modified: [],
      deleted: ['Page'],
    });
  });

  it('sorts each list for stable output', () => {
    const local = [file('Zebra', 'x'), file('Alpha', 'x')];
    const remote: ScriptFile[] = [];
    expect(diffFiles(local, remote).added).toEqual(['Alpha', 'Zebra']);
  });

  it('handles names containing spaces without truncating them', () => {
    const local: ScriptFile[] = [{ name: 'My File', type: 'SERVER_JS', source: 'x' }];
    const remote: ScriptFile[] = [];

    expect(diffFiles(local, remote).added).toEqual(['My File']);
  });
});

describe('hasChanges', () => {
  it('is false only when every list is empty', () => {
    expect(hasChanges({ added: [], modified: [], deleted: [] })).toBe(false);
    expect(hasChanges({ added: ['a'], modified: [], deleted: [] })).toBe(true);
    expect(hasChanges({ added: [], modified: ['a'], deleted: [] })).toBe(true);
    expect(hasChanges({ added: [], modified: [], deleted: ['a'] })).toBe(true);
  });
});
