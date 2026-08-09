import { GasDeployError, REQUESTED_SCOPES, getAccessToken } from '@gas-deploy/core';
import type { Credentials } from '@gas-deploy/core';

const TOKENINFO_ENDPOINT = 'https://oauth2.googleapis.com/tokeninfo';

const REQUESTED_SCOPE_LIST = REQUESTED_SCOPES.split(' ');

const CONNECTIVITY_NEXT_STEPS = [
  'ネットワークから oauth2.googleapis.com に到達できるか確認してください',
  'プロキシやファイアウォールで oauth2.googleapis.com が遮断されていないか確認してください',
  '一時的な障害の可能性があります。しばらく待って再実行してください',
];

const TOKENINFO_FAILURE_NEXT_STEPS = [
  '発行されたアクセストークンが既に失効していないか確認してください',
  '一時的な障害の可能性があります。しばらく待って再実行してください',
];

const PARSE_FAILURE_NEXT_STEPS = [
  'プロキシやファイアウォールが応答を書き換えていないか確認してください',
  '一時的な障害の可能性があります。しばらく待って再実行してください',
];

export interface VerificationResult {
  grantedScopes: string[];
  isMinimal: boolean;
  unexpectedScopes: string[];
}

/**
 * 発行された refresh token の「グラント自体」が要求した2スコープに絞り込まれているかを検証する。
 *
 * access token を取得し直すだけでは不十分: `getAccessToken` は narrowing scope を明示的に
 * 指定するため、access token 自体は常に絞り込まれて見える。ここで確認したいのはそれとは別に、
 * refresh token の背後にあるグラント自体が広すぎないか（clasp の13スコープのように）であり、
 * tokeninfo が返す scope はそのグラント全体を反映する。
 */
export async function verifyCredentials(
  credentials: Credentials,
  fetchImpl: typeof fetch = fetch,
): Promise<VerificationResult> {
  // getAccessToken 自体が堅牢なエラーハンドリングと next steps を持つため、ここでは包み直さず
  // そのまま伝播させる。
  const accessToken = await getAccessToken(credentials, fetchImpl);

  const url = new URL(TOKENINFO_ENDPOINT);
  url.searchParams.set('access_token', accessToken);

  let response: Response;
  try {
    response = await fetchImpl(url.toString());
  } catch (cause) {
    // ネットワーク層の失敗。例外オブジェクト自体はアクセストークンを含まないため cause を保持してよい。
    throw new GasDeployError('付与されたスコープの確認用エンドポイントに接続できませんでした', {
      cause,
      nextSteps: CONNECTIVITY_NEXT_STEPS,
    });
  }

  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    // 応答本文の読み取り中に接続が切れた場合。本文は取得できていないため cause を保持してよい。
    throw new GasDeployError('スコープ確認の応答を読み取れませんでした', {
      cause,
      nextSteps: CONNECTIVITY_NEXT_STEPS,
    });
  }

  if (!response.ok) {
    // tokeninfo はリクエストの query string にアクセストークンを含み、エラー応答本文は
    // そのトークンについての説明（invalid token 等）そのものであるため、cause には一切載せない。
    throw new GasDeployError(`付与されたスコープを確認できませんでした (${response.status})`, {
      nextSteps: TOKENINFO_FAILURE_NEXT_STEPS,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // SyntaxError のメッセージは応答本文の断片を含みうる。理由は上と同様（本文がトークンの
    // 説明そのもの）のため cause には載せない。
    throw new GasDeployError('スコープ確認の応答を解析できませんでした', {
      nextSteps: PARSE_FAILURE_NEXT_STEPS,
    });
  }

  const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  const scopeField = record?.['scope'];

  if (typeof scopeField !== 'string' || scopeField.length === 0) {
    throw new GasDeployError('スコープ確認の応答に scope が含まれていません', {
      nextSteps: PARSE_FAILURE_NEXT_STEPS,
    });
  }

  const grantedScopes = scopeField.split(' ').filter((scope) => scope.length > 0);
  const grantedSet = new Set(grantedScopes);
  const requestedSet = new Set(REQUESTED_SCOPE_LIST);

  const unexpectedScopes = grantedScopes.filter((scope) => !requestedSet.has(scope));
  const missingScopes = REQUESTED_SCOPE_LIST.filter((scope) => !grantedSet.has(scope));

  // isMinimal は「要求した2スコープと完全に一致する」場合のみ true。
  // 超過（unexpectedScopes）はもちろん、不足（missingScopes）があっても最小とは呼べない。
  const isMinimal = unexpectedScopes.length === 0 && missingScopes.length === 0;

  return { grantedScopes, isMinimal, unexpectedScopes };
}
