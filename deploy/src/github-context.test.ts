import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePrCommentContext, resolveProvenanceSource } from './github-context.js';

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'gas-deploy-main-'));
}

describe('resolvePrCommentContext', () => {
  async function writeEvent(payload: unknown): Promise<string> {
    const dir = await makeTempDir();
    const path = join(dir, 'event.json');
    await writeFile(path, JSON.stringify(payload), 'utf8');
    return path;
  }

  it('pull_request イベントから owner / repo / PR 番号を解決する', async () => {
    const eventPath = await writeEvent({ pull_request: { number: 12 } });

    const context = await resolvePrCommentContext({
      GITHUB_REPOSITORY: 'octo/gas',
      GITHUB_EVENT_PATH: eventPath,
    });

    expect(context).toEqual({ owner: 'octo', repo: 'gas', prNumber: 12 });
  });

  it('PR 以外のイベントでは undefined を返す（失敗させない）', async () => {
    const eventPath = await writeEvent({ ref: 'refs/heads/main' });

    const context = await resolvePrCommentContext({
      GITHUB_REPOSITORY: 'octo/gas',
      GITHUB_EVENT_PATH: eventPath,
    });

    expect(context).toBeUndefined();
  });

  it('イベントファイルが読めない場合も undefined を返す', async () => {
    const dir = await makeTempDir();

    const context = await resolvePrCommentContext({
      GITHUB_REPOSITORY: 'octo/gas',
      GITHUB_EVENT_PATH: join(dir, 'missing.json'),
    });

    expect(context).toBeUndefined();
  });

  it('イベントファイルが壊れている場合も undefined を返す', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'event.json');
    await writeFile(path, '{ not json', 'utf8');

    const context = await resolvePrCommentContext({ GITHUB_REPOSITORY: 'octo/gas', GITHUB_EVENT_PATH: path });

    expect(context).toBeUndefined();
  });

  it('環境変数が欠けている場合は undefined を返す', async () => {
    const eventPath = await writeEvent({ pull_request: { number: 12 } });

    expect(await resolvePrCommentContext({ GITHUB_EVENT_PATH: eventPath })).toBeUndefined();
    expect(await resolvePrCommentContext({ GITHUB_REPOSITORY: 'octo/gas' })).toBeUndefined();
  });

  it('GITHUB_REPOSITORY が owner/repo 形式でない場合は undefined を返す', async () => {
    const eventPath = await writeEvent({ pull_request: { number: 12 } });

    const context = await resolvePrCommentContext({ GITHUB_REPOSITORY: 'noslash', GITHUB_EVENT_PATH: eventPath });

    expect(context).toBeUndefined();
  });
});

describe('resolveProvenanceSource', () => {
  it('collects the CI context from the environment', async () => {
    const source = await resolveProvenanceSource({
      GITHUB_SHA: '6251c8c9f2a1b3d4e5f6a7b8c9d0e1f2a3b4c5d6',
      GITHUB_RUN_ID: '31344375660',
      GITHUB_ACTOR: 'yut0takagi',
    });
    expect(source).toEqual({
      sha: '6251c8c9f2a1b3d4e5f6a7b8c9d0e1f2a3b4c5d6',
      runId: '31344375660',
      actor: 'yut0takagi',
    });
  });

  it('returns an empty source outside of Actions', async () => {
    expect(await resolveProvenanceSource({})).toEqual({});
  });

  it('reads the pull request number from the event payload', async () => {
    const dir = await makeTempDir();
    const eventPath = join(dir, 'event.json');
    await writeFile(eventPath, JSON.stringify({ pull_request: { number: 42 } }), 'utf8');

    const source = await resolveProvenanceSource({
      GITHUB_SHA: '6251c8c',
      GITHUB_EVENT_PATH: eventPath,
    });
    expect(source.pr).toBe(42);
  });

  // push で走らせた場合。ペイロードは読めるが PR が無いのが通常の状態で、
  // 実運用では最も頻度の高い経路である。
  it('collects no pull request number for an event payload without one', async () => {
    const dir = await makeTempDir();
    const eventPath = join(dir, 'event.json');
    await writeFile(eventPath, JSON.stringify({ ref: 'refs/heads/main' }), 'utf8');

    const source = await resolveProvenanceSource({
      GITHUB_SHA: '6251c8c',
      GITHUB_EVENT_PATH: eventPath,
    });
    expect(source).toEqual({ sha: '6251c8c' });
  });

  // ペイロードが読めないのは、由来情報の他の要素を捨てる理由にはならない。
  it('keeps the rest of the context when the event payload is unreadable', async () => {
    const source = await resolveProvenanceSource({
      GITHUB_SHA: '6251c8c',
      GITHUB_EVENT_PATH: '/nonexistent/event.json',
    });
    expect(source).toEqual({ sha: '6251c8c' });
  });
});
