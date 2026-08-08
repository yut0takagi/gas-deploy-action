import { GasDeployError } from './errors.js';
import type { Credentials } from './types.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

const EXPIRY_NEXT_STEPS = [
  'OAuth 同意画面が「テスト」状態の場合、refresh token は7日で失効します。「本番」（個人アカウント）または「内部」（Workspace）に変更してください',
  'Google Workspace の再認証ポリシーが有効な場合、`invalid_rapt` エラーとともに定期的に失効します。無人実行には再認証を要求されない専用アカウントを使ってください',
  'refresh token は6ヶ月間未使用でも失効します',
  'デプロイに使うアカウントのパスワードが変更されていないか確認してください',
  '認証情報を再発行し、GitHub Secrets を更新してください',
];

const CONNECTIVITY_NEXT_STEPS = [
  'ランナーからインターネットに到達できるか確認してください',
  'プロキシやファイアウォールで oauth2.googleapis.com が遮断されていないか確認してください',
  '一時的な障害の可能性があります。しばらく待って再実行してください',
];

const PARSE_FAILURE_NEXT_STEPS = [
  'プロキシやファイアウォールが応答を書き換えていないか確認してください',
  '一時的な障害の可能性があります。しばらく待って再実行してください',
];

/**
 * 要求するスコープ。リフレッシュ交換時に明示的に指定して絞り込む。
 *
 * 指定しないと、リフレッシュトークンに元々付与された全スコープがそのまま返る
 * （RFC 6749 §6）。clasp の認証情報は cloud-platform を含む13スコープを持つため、
 * 指定を省略すると本 Action が扱うトークンの権限が不必要に広くなる。
 * この2つで getContent / updateContent / versions.create / deployments.create の
 * すべてが動作することは実測で確認済み。
 */
export const REQUESTED_SCOPES = [
  'https://www.googleapis.com/auth/script.projects',
  'https://www.googleapis.com/auth/script.deployments',
].join(' ');

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
    scope: REQUESTED_SCOPES,
  });

  let response: Response;
  try {
    response = await fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (cause) {
    // ネットワーク層の失敗。送信した credentials は含まれないため cause を保持してよい。
    throw new GasDeployError('トークンエンドポイントに接続できませんでした', {
      cause,
      nextSteps: CONNECTIVITY_NEXT_STEPS,
    });
  }

  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    // 応答本文の読み取り中に接続が切れた場合。本文は取得できていないため cause を保持してよい。
    throw new GasDeployError('トークンエンドポイントの応答を読み取れませんでした', {
      cause,
      nextSteps: CONNECTIVITY_NEXT_STEPS,
    });
  }

  if (!response.ok) {
    // Google のトークンエンドポイントのエラー応答は RFC 6749 準拠の
    // { "error": "...", "error_description": "..." } 形式で、送信した
    // client_secret や refresh_token をエコーバックしない。診断に有用なので cause に残す。
    throw new GasDeployError(`アクセストークンの取得に失敗しました (${response.status})`, {
      cause: text,
      nextSteps: EXPIRY_NEXT_STEPS,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // SyntaxError のメッセージは解析対象の断片を含む。成功時の応答には有効な access token が
    // 入るため、cause には載せない。
    throw new GasDeployError('トークンエンドポイントの応答を解析できませんでした', {
      nextSteps: PARSE_FAILURE_NEXT_STEPS,
    });
  }

  const accessToken =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { access_token?: unknown }).access_token
      : undefined;

  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    // 200 応答でも id_token など他のトークン素材を含みうるため、cause には載せない。
    throw new GasDeployError('トークンエンドポイントの応答に access_token が含まれていません', {
      nextSteps: EXPIRY_NEXT_STEPS,
    });
  }

  return accessToken;
}
