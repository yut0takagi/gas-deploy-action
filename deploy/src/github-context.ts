import { readFile } from 'node:fs/promises';
import type { ProvenanceSource } from '@gas-deploy/core';
import { resolvePullRequestNumber } from './comment.js';

/**
 * イベントペイロードを読む。読めない・壊れている場合は undefined を返す。
 *
 * 由来情報と PR コメントの両方が同じファイルを必要とし、以前はそれぞれが readFile と
 * JSON.parse と catch を個別に持っていた。片方だけを直したときに catch の範囲がずれる
 * （実際にずれていた）ため1箇所にまとめる。JSON.parse は成功時に undefined を返さない
 * ので、undefined は「取得できなかった」ことだけを意味する。
 * cause は付けない（ペイロードには非公開のリポジトリ情報が含まれうる）。
 */
async function readEventPayload(eventPath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(eventPath, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * 由来情報の材料を GHA の環境変数とイベントペイロードから集める。
 *
 * 各項目は独立に読む。揃っていることは前提にしない（Actions 外では全て欠けるが、
 * それを保証するのは実行環境であってこの関数ではない）。「sha が無ければ由来情報を
 * 作らない」という判断は buildVersionDescription 側が持つ。
 */
export async function resolveProvenanceSource(
  env: Record<string, string | undefined>,
): Promise<ProvenanceSource> {
  const source: ProvenanceSource = {};

  const sha = env['GITHUB_SHA'];
  if (sha) source.sha = sha;
  const runId = env['GITHUB_RUN_ID'];
  if (runId) source.runId = runId;
  const actor = env['GITHUB_ACTOR'];
  if (actor) source.actor = actor;

  const eventPath = env['GITHUB_EVENT_PATH'];
  if (eventPath) {
    const payload = await readEventPayload(eventPath);
    if (payload !== undefined) {
      const pr = resolvePullRequestNumber(payload);
      if (pr !== undefined) source.pr = pr;
    }
  }

  return source;
}

export interface PrCommentContext {
  owner: string;
  repo: string;
  prNumber: number;
}

/**
 * PR コメントの宛先を GHA の環境変数から決める。PR の実行でなければ undefined。
 *
 * push で走らせているワークフローに comment-on-pr が付いたままでも失敗させない。
 * 「PR ではない」は異常ではなく通常の状態として扱う。
 */
export async function resolvePrCommentContext(
  env: Record<string, string | undefined>,
): Promise<PrCommentContext | undefined> {
  const repository = env['GITHUB_REPOSITORY'];
  const eventPath = env['GITHUB_EVENT_PATH'];
  if (!repository || !eventPath) {
    return undefined;
  }

  const [owner, repo] = repository.split('/');
  if (!owner || !repo) {
    return undefined;
  }

  // ペイロードが読めない・壊れているのはコメントを諦めるに足る理由だが、
  // デプロイを止める理由にはならない。
  const payload = await readEventPayload(eventPath);
  if (payload === undefined) {
    return undefined;
  }

  const prNumber = resolvePullRequestNumber(payload);
  if (prNumber === undefined) {
    return undefined;
  }
  return { owner, repo, prNumber };
}
