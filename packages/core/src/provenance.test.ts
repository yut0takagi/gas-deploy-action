import { describe, expect, it } from 'vitest';
import { MAX_DESCRIPTION_LENGTH, buildVersionDescription, parseVersionDescription } from './provenance.js';

const SHA = '6251c8c9f2a1b3d4e5f6a7b8c9d0e1f2a3b4c5d6';

describe('buildVersionDescription', () => {
  it('formats every field in a fixed key order', () => {
    const { description } = buildVersionDescription({
      sha: SHA,
      runId: '31344375660',
      pr: 42,
      actor: 'yut0takagi',
    });
    expect(description).toBe(`ci sha=${SHA} run=31344375660 pr=42 by=yut0takagi`);
  });

  it('omits keys that are not available rather than emitting empty values', () => {
    const { description } = buildVersionDescription({ sha: SHA, runId: '1' });
    expect(description).toBe(`ci sha=${SHA} run=1`);
    expect(description).not.toContain('pr=');
    expect(description).not.toContain('by=');
  });

  // 由来を無条件に残すのが目的なので、指定値で置き換えて追跡を失う設計にはしない。
  it('keeps a user-supplied description after the provenance', () => {
    const { description } = buildVersionDescription({ sha: SHA }, 'hotfix for incident 123');
    expect(description).toBe(`ci sha=${SHA} | hotfix for incident 123`);
  });

  it('falls back to the user description when there is no CI context', () => {
    const { description } = buildVersionDescription({}, 'manual deploy');
    expect(description).toBe('manual deploy');
  });

  it('falls back to a fixed label when there is neither CI context nor a description', () => {
    expect(buildVersionDescription({}).description).toBe('manual');
  });

  it('truncates the user description to stay within the length budget', () => {
    const long = 'x'.repeat(400);
    const { description, warnings } = buildVersionDescription({ sha: SHA }, long);
    expect(description.length).toBe(MAX_DESCRIPTION_LENGTH);
    expect(description.endsWith('…')).toBe(true);
    expect(warnings).toHaveLength(1);
  });

  // 現実の GitHub の値（run ID は約11桁）ではこの分岐に到達しない。予算が負になる
  // 病的な入力でも `slice` に負の値を渡さないことを確かめるための防御的な分岐である。
  // 由来情報の側は設計上決して切り詰めないので、結果が上限を超えることは許容する。
  it('drops the user description entirely when almost no budget remains', () => {
    const source = { sha: SHA, runId: '9'.repeat(200), actor: 'a'.repeat(39) };
    const { description, warnings } = buildVersionDescription(source, 'note');
    expect(description).not.toContain('|');
    expect(warnings).toHaveLength(1);
  });

  it('trims surrounding whitespace in the user description', () => {
    const { description } = buildVersionDescription({ sha: SHA }, '  spaced  ');
    expect(description).toBe(`ci sha=${SHA} | spaced`);
  });

  // 書き込み側がこれを素通しさせると、復元側の厳格さが無意味になる。
  it('prevents a provenance-shaped user description from being read back as authentic', () => {
    const forged = `ci sha=${SHA} run=1 by=someone`;
    const { description, warnings } = buildVersionDescription({}, forged);
    expect(parseVersionDescription(description)).toBeUndefined();
    expect(description).toContain(forged);
    expect(warnings).toHaveLength(1);
  });

  it('keeps the provenance intact when the user description is truncated', () => {
    const { description } = buildVersionDescription({ sha: SHA }, 'y'.repeat(400));
    expect(description.startsWith(`ci sha=${SHA} | `)).toBe(true);
  });
});

describe('parseVersionDescription', () => {
  it('round-trips everything that buildVersionDescription writes', () => {
    const source = { sha: SHA, runId: '31344375660', pr: 42, actor: 'yut0takagi' };
    const { description } = buildVersionDescription(source, 'hotfix');
    expect(parseVersionDescription(description)).toEqual({
      sha: SHA,
      runId: '31344375660',
      pr: 42,
      actor: 'yut0takagi',
      description: 'hotfix',
    });
  });

  it('restores a provenance that has no optional fields', () => {
    expect(parseVersionDescription(`ci sha=${SHA}`)).toEqual({ sha: SHA });
  });

  it('accepts an abbreviated sha', () => {
    expect(parseVersionDescription('ci sha=6251c8c')).toEqual({ sha: '6251c8c' });
  });

  it('restores a multi-line user description', () => {
    const parsed = parseVersionDescription(`ci sha=${SHA} | line1\nline2`);
    expect(parsed?.description).toBe('line1\nline2');
  });

  // 部分一致から情報を拾わない。手動作成のバージョンを CI 製と取り違える方が有害である。
  it('rejects the old ci-<sha7>-<run_number> format', () => {
    expect(parseVersionDescription('ci-6251c8c-42')).toBeUndefined();
  });

  it('rejects a hand-written description', () => {
    expect(parseVersionDescription('release 2026-08-14')).toBeUndefined();
  });

  it('rejects anything before the expected shape', () => {
    expect(parseVersionDescription(`prefix ci sha=${SHA}`)).toBeUndefined();
  });

  it('rejects anything after the expected shape', () => {
    expect(parseVersionDescription(`ci sha=${SHA} trailing`)).toBeUndefined();
  });

  it('rejects an uppercase sha', () => {
    expect(parseVersionDescription('ci sha=6251C8C')).toBeUndefined();
  });

  it('rejects keys in an unexpected order', () => {
    expect(parseVersionDescription(`ci sha=${SHA} by=someone run=1`)).toBeUndefined();
  });

  it('rejects a sha outside the accepted length range', () => {
    expect(parseVersionDescription('ci sha=6251c8')).toBeUndefined();
    expect(parseVersionDescription(`ci sha=${SHA}f`)).toBeUndefined();
  });
});
