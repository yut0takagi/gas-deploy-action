import { GasDeployError } from '@gas-deploy/core';

const API_BASE = 'https://api.github.com';

/** GitHub のコメント本文の上限。超えると 422 で投稿そのものが失敗する。 */
export const COMMENT_BODY_LIMIT = 65536;

const PAGE_SIZE = 100;

/** ページネーションの暴走を止める上限。コメント2000件までは追える。 */
const MAX_PAGES = 20;

const TRUNCATION_NOTICE =
  '\n\n> **以降は長さの制限により省略しました。** 全文はワークフローのジョブサマリを参照してください。\n';

const CONNECTIVITY_NEXT_STEPS = [
  'ランナーから api.github.com に到達できるか確認してください',
  '一時的な障害の可能性があります。しばらく待って再実行してください',
];

/**
 * コメントを識別する隠しマーカー。実行のたびに新しいコメントを積み上げず、
 * 同じコメントを更新し続けるために使う。
 *
 * キーで分けるのは、1つのワークフローで環境ごとに複数回実行される場合に、
 * それぞれが互いのコメントを上書きしないようにするため。
 *
 * scriptId や deploymentId をキーに含めてはならない。公開リポジトリの PR では
 * このマーカーがそのまま HTML ソースに残る。
 */
export function buildMarker(key: string): string {
  return `<!-- gas-deploy-action:${key} -->`;
}

/**
 * イベントペイロードから PR 番号を取り出す。PR と無関係な実行では undefined。
 *
 * push で走らせているワークフローに comment-on-pr を付けたまま放置しても
 * 失敗しないよう、「PR ではない」を異常ではなく通常の状態として扱う。
 */
export function resolvePullRequestNumber(payload: unknown): number | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;

  const pullRequest = record['pull_request'];
  if (typeof pullRequest === 'object' && pullRequest !== null) {
    const number = (pullRequest as Record<string, unknown>)['number'];
    if (typeof number === 'number') {
      return number;
    }
  }

  // issue_comment イベントは PR にも issue にも発火する。pull_request キーの
  // 有無だけが両者を区別する手がかりで、これが無ければ相手は issue。
  const issue = record['issue'];
  if (typeof issue === 'object' && issue !== null) {
    const issueRecord = issue as Record<string, unknown>;
    const number = issueRecord['number'];
    if (issueRecord['pull_request'] !== undefined && typeof number === 'number') {
      return number;
    }
  }

  return undefined;
}

/**
 * 本文を GitHub の上限に収める。
 *
 * マーカーは本文の先頭に置く前提で、末尾から削る。マーカーごと消すと次回の実行が
 * 既存コメントを見つけられず、実行のたびに新しいコメントが積み上がる。
 */
export function truncateBody(body: string, marker: string): string {
  if (body.length <= COMMENT_BODY_LIMIT) {
    return body;
  }
  const budget = COMMENT_BODY_LIMIT - TRUNCATION_NOTICE.length;
  if (budget < marker.length) {
    // 現実には起こらないが、ここで marker を失うと復帰不能になるため明示的に守る。
    return marker + TRUNCATION_NOTICE;
  }
  return body.slice(0, budget) + TRUNCATION_NOTICE;
}

export interface CommentContext {
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  fetchImpl?: typeof fetch;
}

export interface UpsertResult {
  action: 'created' | 'updated';
  id: number;
}

interface IssueComment {
  id?: number;
  body?: string;
}

function classifyCommentError(status: number, body: string): GasDeployError {
  if (status === 403) {
    return new GasDeployError('PR にコメントする権限がありません (403)', {
      cause: body,
      nextSteps: [
        'ワークフローに `permissions: pull-requests: write` を追加してください',
        'フォークからの pull_request イベントでは、既定の GITHUB_TOKEN は読み取り専用になります。この場合コメントは投稿できません',
        'github-token 入力に別のトークンを渡している場合、そのトークンの権限を確認してください',
      ],
    });
  }
  if (status === 401) {
    return new GasDeployError('GitHub API の認証に失敗しました (401)', {
      cause: body,
      nextSteps: ['github-token 入力に有効なトークンが渡っているか確認してください'],
    });
  }
  if (status === 404) {
    return new GasDeployError('対象の PR が見つかりません (404)', {
      cause: body,
      nextSteps: [
        'トークンにこのリポジトリへのアクセス権があるか確認してください',
        '権限が不足している場合、GitHub は 403 ではなく 404 を返すことがあります',
      ],
    });
  }
  return new GasDeployError(`GitHub API がエラーを返しました (${status})`, {
    cause: body,
    nextSteps: ['しばらく待って再実行してください', 'GitHub のステータスページで障害情報を確認してください'],
  });
}

async function request(ctx: CommentContext, method: string, path: string, payload?: unknown): Promise<unknown> {
  const fetchImpl = ctx.fetchImpl ?? fetch;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${ctx.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    // GitHub API は User-Agent を必須としており、無いと 403 を返す。
    'User-Agent': 'gas-deploy-action',
  };
  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetchImpl(`${API_BASE}${path}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  } catch (cause) {
    throw new GasDeployError('GitHub API に接続できませんでした', { cause, nextSteps: CONNECTIVITY_NEXT_STEPS });
  }

  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    throw new GasDeployError('GitHub API の応答を読み取れませんでした', { cause, nextSteps: CONNECTIVITY_NEXT_STEPS });
  }

  if (!response.ok) {
    throw classifyCommentError(response.status, text);
  }

  if (text.length === 0) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GasDeployError('GitHub API の応答を解析できませんでした', {
      nextSteps: ['一時的な障害の可能性があります。しばらく待って再実行してください'],
    });
  }
}

/** マーカーを持つ既存コメントを探す。見つからなければ undefined。 */
async function findExistingComment(ctx: CommentContext, marker: string): Promise<number | undefined> {
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = (await request(
      ctx,
      'GET',
      `/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.prNumber}/comments?per_page=${PAGE_SIZE}&page=${page}`,
    )) as IssueComment[];

    if (!Array.isArray(result)) {
      return undefined;
    }

    const found = result.find((comment) => comment.body?.includes(marker) === true);
    if (found?.id !== undefined) {
      return found.id;
    }

    // 返ってきた件数がページサイズ未満なら最終ページ。
    if (result.length < PAGE_SIZE) {
      return undefined;
    }
  }
  return undefined;
}

/**
 * PR コメントを作成、または既存のものを更新する。
 *
 * `content` にマーカーは含めない。この関数が先頭に付与する。
 */
export async function upsertComment(ctx: CommentContext, key: string, content: string): Promise<UpsertResult> {
  const marker = buildMarker(key);
  const body = truncateBody(`${marker}\n${content}`, marker);

  const existingId = await findExistingComment(ctx, marker);

  if (existingId !== undefined) {
    await request(ctx, 'PATCH', `/repos/${ctx.owner}/${ctx.repo}/issues/comments/${existingId}`, { body });
    return { action: 'updated', id: existingId };
  }

  const created = (await request(ctx, 'POST', `/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.prNumber}/comments`, {
    body,
  })) as IssueComment;

  return { action: 'created', id: created.id ?? 0 };
}
