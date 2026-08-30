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

/**
 * Workspace の再認証ポリシーによる失効。
 *
 * `EXPIRY_NEXT_STEPS` と分けているのが要点である。汎用の案内は「同意画面を本番にする」を
 * 先頭に置くが、この失効は同意画面のステータスと無関係に起きるため、それを試した利用者は
 * 直らない対処に時間を使うことになる。原因が確定しているときは、確定した対処だけを出す。
 */
const REAUTH_NEXT_STEPS = [
  'ローカルで `clasp login` をやり直し、シークレットを更新してください: gh secret set CLASPRC_JSON < ~/.clasprc.json',
  'この失効は OAuth 同意画面のステータス（テスト / 本番 / 内部）とは無関係に発生します。同意画面の変更では解決しません',
  '恒久的に回避するには、Workspace アカウントではなく個人 Google アカウントの認証情報を使ってください',
  'Workspace で運用を続ける場合は、管理コンソールの再認証ポリシーの対象から外れたアカウントを使ってください',
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

const SCOPE_NEXT_STEPS = [
  '認証情報に script.projects と script.deployments の両方が付与されているか確認してください',
  'リフレッシュトークンは元々付与されたスコープの範囲内でしか絞り込めません。不足している場合は認証をやり直す必要があります',
  'clasp login で発行した認証情報にはこの2つが含まれます',
  '自前の OAuth クライアントを使う場合は、同意画面にこの2つのスコープを追加してください',
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
export const REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/script.projects',
  'https://www.googleapis.com/auth/script.deployments',
] as const;

export const REQUESTED_SCOPES = REQUIRED_SCOPES.join(' ');

export interface TokenExchange {
  accessToken: string;
  /**
   * 実際に付与されたスコープ。
   *
   * 要求どおりに絞り込まれた保証は無い。リフレッシュトークンに元々含まれていない
   * スコープは要求しても付かず、その場合でもトークン交換自体は 200 で成功する
   * （不足に気づくのは API を叩いた後の 403 になる）。応答に `scope` が無いことも
   * ありうるため、空配列は「付与されていない」ではなく「判定できない」を意味する。
   */
  grantedScopes: string[];
}

/**
 * refresh token を access token に交換する。
 * credentials に access token が含まれていても使わず、常に新規取得する。
 */
export async function exchangeToken(
  credentials: Credentials,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenExchange> {
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
      code: 'connectivity',
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
      code: 'connectivity',
      nextSteps: CONNECTIVITY_NEXT_STEPS,
    });
  }

  if (!response.ok) {
    // Google のトークンエンドポイントのエラー応答は RFC 6749 準拠の
    // { "error": "...", "error_description": "..." } 形式で、送信した
    // client_secret や refresh_token をエコーバックしない。診断に有用なので cause に残す。
    let oauthError: string | undefined;
    let oauthErrorDescription: string | undefined;
    try {
      const parsedError = JSON.parse(text) as { error?: unknown; error_description?: unknown };
      if (typeof parsedError.error === 'string') {
        oauthError = parsedError.error;
      }
      if (typeof parsedError.error_description === 'string') {
        oauthErrorDescription = parsedError.error_description;
      }
    } catch {
      // 本文が JSON でない場合は判別を諦め、既定の案内にフォールバックする。
    }

    if (oauthError === 'invalid_scope') {
      throw new GasDeployError(`要求したスコープが認証情報に付与されていません (${response.status})`, {
        cause: text,
        code: 'insufficient-scope',
        nextSteps: SCOPE_NEXT_STEPS,
      });
    }

    // Google は再認証ポリシーによる失効を `invalid_grant` + error_description の
    // `invalid_rapt` で返す。`invalid_grant` は失効・取り消し・クロックずれのいずれでも
    // 返るため、error だけでは区別できず、description まで見て初めて原因が確定する。
    // 確定したものは確定したものとして、汎用の案内から切り離して報告する。
    if (oauthError === 'invalid_grant' && oauthErrorDescription?.includes('invalid_rapt')) {
      throw new GasDeployError(
        `認証情報が失効しています（Google Workspace の再認証ポリシー） (${response.status})`,
        {
          cause: text,
          code: 'reauth-required',
          nextSteps: REAUTH_NEXT_STEPS,
        },
      );
    }

    throw new GasDeployError(`アクセストークンの取得に失敗しました (${response.status})`, {
      cause: text,
      code: 'token-invalid',
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
      code: 'response-invalid',
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
      code: 'response-invalid',
      nextSteps: EXPIRY_NEXT_STEPS,
    });
  }

  // scope はスペース区切りの文字列で返る（RFC 6749 §5.1）。省略されることもあるため、
  // 無い場合は空配列にする。判定側が「無い＝不足」と読まないよう注意すること。
  const rawScope = (parsed as { scope?: unknown }).scope;
  const grantedScopes = typeof rawScope === 'string' ? rawScope.split(' ').filter((s) => s.length > 0) : [];

  return { accessToken, grantedScopes };
}

/** 付与スコープを必要としない呼び出し向けの薄いラッパ。 */
export async function getAccessToken(
  credentials: Credentials,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  return (await exchangeToken(credentials, fetchImpl)).accessToken;
}
