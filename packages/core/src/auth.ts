import { GasDeployError } from './errors.js';
import type { Credentials } from './types.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

const EXPIRY_NEXT_STEPS = [
  'OAuth 同意画面が「テスト」状態の場合、refresh token は7日で失効します。「本番」（個人アカウント）または「内部」（Workspace）に変更してください',
  'refresh token は6ヶ月間未使用でも失効します',
  'デプロイに使うアカウントのパスワードが変更されていないか確認してください',
  '認証情報を再発行し、GitHub Secrets を更新してください',
];

/**
 * refresh token を access token に交換する。
 * credentials に access token が含まれていても使わず、常に新規取得する。
 */
export async function getAccessToken(
  credentials: Credentials,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken,
    grant_type: 'refresh_token',
  });

  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await response.text();

  if (!response.ok) {
    // Google のトークンエンドポイントのエラー応答は RFC 6749 準拠の
    // { "error": "...", "error_description": "..." } 形式で、送信した
    // client_secret や refresh_token をエコーバックしない。診断に有用なので cause に残す。
    throw new GasDeployError(`アクセストークンの取得に失敗しました (${response.status})`, {
      cause: text,
      nextSteps: EXPIRY_NEXT_STEPS,
    });
  }

  let parsed: { access_token?: string };
  try {
    parsed = JSON.parse(text) as { access_token?: string };
  } catch {
    // SyntaxError のメッセージは解析対象の文字列の断片をそのまま含む。ここでの解析対象は
    // 成功応答（アクセストークンを含みうる）なので、cause には載せない。
    throw new GasDeployError('トークンエンドポイントの応答を解析できませんでした');
  }

  if (!parsed.access_token) {
    // 200 応答本文には access_token 以外のトークン material（id_token 等）が
    // 含まれている可能性があるため、cause には載せない。
    throw new GasDeployError('トークンエンドポイントの応答に access_token が含まれていません', {
      nextSteps: EXPIRY_NEXT_STEPS,
    });
  }

  return parsed.access_token;
}
