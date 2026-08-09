import { GasDeployError } from '@gas-deploy/core';
import { describe, expect, it, vi } from 'vitest';
import {
  COMMENT_BODY_LIMIT,
  buildMarker,
  resolvePullRequestNumber,
  truncateBody,
  upsertComment,
} from './comment.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function context(fetchImpl: typeof fetch) {
  return { token: 'ghs-token', owner: 'octo', repo: 'gas', prNumber: 7, fetchImpl };
}

describe('buildMarker', () => {
  it('キーを含む HTML コメントを返す', () => {
    const marker = buildMarker('prod');

    expect(marker.startsWith('<!--')).toBe(true);
    expect(marker.endsWith('-->')).toBe(true);
    expect(marker).toContain('prod');
  });

  it('キーが違えば別のマーカーになる', () => {
    expect(buildMarker('prod')).not.toBe(buildMarker('dev'));
  });
});

describe('resolvePullRequestNumber', () => {
  it('pull_request イベントから番号を取る', () => {
    expect(resolvePullRequestNumber({ pull_request: { number: 12 } })).toBe(12);
  });

  it('PR 上の issue_comment イベントから番号を取る', () => {
    expect(resolvePullRequestNumber({ issue: { number: 34, pull_request: { url: 'https://…' } } })).toBe(34);
  });

  it('PR ではない issue の issue_comment では番号を返さない', () => {
    expect(resolvePullRequestNumber({ issue: { number: 34 } })).toBeUndefined();
  });

  it('push イベントなど PR と無関係なペイロードでは番号を返さない', () => {
    expect(resolvePullRequestNumber({ ref: 'refs/heads/main' })).toBeUndefined();
    expect(resolvePullRequestNumber(null)).toBeUndefined();
    expect(resolvePullRequestNumber(undefined)).toBeUndefined();
  });

  it('number が数値でない場合は番号を返さない', () => {
    expect(resolvePullRequestNumber({ pull_request: { number: '12' } })).toBeUndefined();
  });
});

describe('truncateBody', () => {
  const marker = buildMarker('prod');

  it('制限内の本文はそのまま返す', () => {
    const body = `${marker}\n短いサマリ`;

    expect(truncateBody(body, marker)).toBe(body);
  });

  it('制限を超える本文を制限内に収める', () => {
    const body = `${marker}\n${'あ'.repeat(COMMENT_BODY_LIMIT)}`;

    const truncated = truncateBody(body, marker);

    expect(truncated.length).toBeLessThanOrEqual(COMMENT_BODY_LIMIT);
  });

  it('切り詰めてもマーカーは必ず残る', () => {
    // マーカーが消えると次回の実行が既存コメントを見つけられず、実行のたびに
    // 新しいコメントが積み上がる。
    const body = `${marker}\n${'あ'.repeat(COMMENT_BODY_LIMIT)}`;

    expect(truncateBody(body, marker)).toContain(marker);
  });

  it('切り詰めたことを本文に明記する', () => {
    const body = `${marker}\n${'あ'.repeat(COMMENT_BODY_LIMIT)}`;

    expect(truncateBody(body, marker)).toContain('省略');
  });
});

describe('upsertComment', () => {
  it('マーカー付きのコメントが無ければ新規作成する', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === undefined || init.method === 'GET') return jsonResponse([]);
      return jsonResponse({ id: 99, html_url: `${url}#99` }, 201);
    }) as unknown as typeof fetch;

    const result = await upsertComment(context(fetchImpl), 'prod', '本文');

    expect(result.action).toBe('created');
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const post = calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'POST');
    expect(post).toBeDefined();
    expect(String(post?.[0])).toContain('/issues/7/comments');
  });

  it('マーカー付きのコメントがあれば更新する（新しいコメントを作らない）', async () => {
    const marker = buildMarker('prod');
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === undefined || init.method === 'GET') {
        return jsonResponse([{ id: 5, body: `${marker}\n古い内容` }]);
      }
      return jsonResponse({ id: 5 });
    }) as unknown as typeof fetch;

    const result = await upsertComment(context(fetchImpl), 'prod', '本文');

    expect(result.action).toBe('updated');
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((call) => (call[1] as RequestInit | undefined)?.method === 'POST')).toBe(false);
    const patch = calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'PATCH');
    expect(String(patch?.[0])).toContain('/issues/comments/5');
  });

  it('別のキーのコメントは自分のものとして扱わない', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === undefined || init.method === 'GET') {
        return jsonResponse([{ id: 5, body: `${buildMarker('dev')}\n別環境の内容` }]);
      }
      return jsonResponse({ id: 99 }, 201);
    }) as unknown as typeof fetch;

    const result = await upsertComment(context(fetchImpl), 'prod', '本文');

    expect(result.action).toBe('created');
  });

  it('コメントが1ページに収まらない場合もマーカーを見つける', async () => {
    // per_page を指定しても、コメントの多い PR では複数ページになる。1ページ目しか
    // 見ないと毎回「見つからない」と判断して新しいコメントを作り続ける。
    const marker = buildMarker('prod');
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === undefined || init.method === 'GET') {
        if (url.includes('page=2')) return jsonResponse([{ id: 42, body: `${marker}\n古い内容` }]);
        // ページサイズと同数を返して「まだ続きがある」ことを示す。
        return jsonResponse(Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: '無関係' })));
      }
      return jsonResponse({ id: 42 });
    }) as unknown as typeof fetch;

    const result = await upsertComment(context(fetchImpl), 'prod', '本文');

    expect(result.action).toBe('updated');
    expect(result.id).toBe(42);
  });

  it('権限不足（403）では pull-requests: write を案内する', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: 'Resource not accessible by integration' }, 403));

    try {
      await upsertComment(context(fetchImpl as unknown as typeof fetch), 'prod', '本文');
      throw new Error('expected upsertComment to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(GasDeployError);
      expect((error as GasDeployError).format()).toContain('pull-requests: write');
    }
  });

  it('その他のエラーも GasDeployError にする', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: 'boom' }, 500));

    await expect(upsertComment(context(fetchImpl as unknown as typeof fetch), 'prod', '本文')).rejects.toBeInstanceOf(
      GasDeployError,
    );
  });

  it('トークンを本文やエラーに含めない', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: 'boom' }, 500));

    try {
      await upsertComment(context(fetchImpl as unknown as typeof fetch), 'prod', '本文');
    } catch (error) {
      expect((error as GasDeployError).format()).not.toContain('ghs-token');
    }
  });

  it('Authorization ヘッダーでトークンを送る', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === undefined || init.method === 'GET') return jsonResponse([]);
      return jsonResponse({ id: 1 }, 201);
    }) as unknown as typeof fetch;

    await upsertComment(context(fetchImpl), 'prod', '本文');

    const headers = ((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer ghs-token');
  });
});
