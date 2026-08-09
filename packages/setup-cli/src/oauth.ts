import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { GasDeployError, REQUESTED_SCOPES } from '@gas-deploy/core';
import type { Credentials } from '@gas-deploy/core';

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const CONNECTIVITY_NEXT_STEPS = [
  'ランナーからインターネットに到達できるか確認してください',
  'プロキシやファイアウォールで oauth2.googleapis.com が遮断されていないか確認してください',
  '一時的な障害の可能性があります。しばらく待って再実行してください',
];

const PARSE_FAILURE_NEXT_STEPS = [
  'プロキシやファイアウォールが応答を書き換えていないか確認してください',
  '一時的な障害の可能性があります。しばらく待って再実行してください',
];

const EXCHANGE_FAILURE_NEXT_STEPS = [
  '認可コードは一度しか使えず、有効期限も短いため、失効している可能性があります。最初からやり直してください',
  'redirect_uri が認可リクエスト時と交換リクエスト時で一致しているか確認してください',
  'しばらく待って再実行してください',
];

const MISSING_REFRESH_TOKEN_NEXT_STEPS = [
  'このクライアントに対して既に一度認可済みだと、Google は2回目以降 refresh_token を返さないことがあります',
  'https://myaccount.google.com/permissions を開き、このアプリへのアクセスを取り消してから、もう一度やり直してください',
  '取り消し後、Google 側の反映まで数分かかる場合があります',
];

const RETRY_NEXT_STEPS = ['もう一度コマンドを実行し、表示された URL をブラウザで開いて認可をやり直してください'];

const TIMEOUT_NEXT_STEPS = [
  'もう一度コマンドを実行してください',
  '表示された URL をブラウザで開いたら、なるべく早く認可を完了させてください',
];

const DENIED_NEXT_STEPS = [
  'もう一度コマンドを実行し、Google の同意画面で「許可」を選択してください',
  '意図的にアクセスを拒否した場合、このツールは利用できません',
];

/**
 * PKCE code_verifier を生成する（RFC 7636 §4.1）。
 * 32 バイトの乱数を base64url エンコードすると 43 文字になり、RFC が要求する
 * 43〜128 文字・[A-Za-z0-9-._~] の範囲を満たす。
 */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/** code_verifier から S256 の code_challenge を導出する（RFC 7636 §4.2）。 */
export function deriveCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

/** CSRF 対策の state を生成する。認可リクエストとループバック応答の両方で同一の値を検証する。 */
export function generateState(): string {
  return randomBytes(16).toString('base64url');
}

export interface AuthorizationUrlParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

/**
 * Google の認可 URL を組み立てる。
 * scope は `@gas-deploy/core` の REQUESTED_SCOPES をそのまま使う
 * （この2スコープに絞り込むことが本パッケージの存在理由）。
 * access_type=offline と prompt=consent の両方が必要: 片方でも欠けると、
 * ユーザーが既に同意済みの場合に Google が refresh_token を返さないことがある。
 */
export function buildAuthorizationUrl(params: AuthorizationUrlParams): string {
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', REQUESTED_SCOPES);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

function htmlPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><title>${title}</title></head>
<body><p>${message}</p></body>
</html>`;
}

const SUCCESS_HTML = htmlPage('認証完了', '認証が完了しました。このタブを閉じて、ターミナルに戻ってください。');
const DENIED_HTML = htmlPage(
  '認証がキャンセルされました',
  '認証がキャンセルされました。このタブを閉じて、ターミナルに戻ってください。',
);
const INVALID_CALLBACK_HTML = htmlPage(
  '認証エラー',
  '認証情報を確認できませんでした。このタブを閉じて、ターミナルに戻ってください。',
);

export interface WaitForAuthorizationCodeOptions {
  /** 認可リクエスト時に送った state。ループバック応答の state と照合する。 */
  state: string;
  /** タイムアウト（ミリ秒）。既定は5分。 */
  timeoutMs?: number;
  /**
   * サーバーがポートの割り当てを終えた直後に呼ばれる。
   *
   * redirect_uri はサーバーが実際に待ち受けるポートに一致していなければならないが、
   * そのポートは `listen(0, ...)` が完了するまで分からない。一方 `waitForAuthorizationCode`
   * 自体は Google からのリダイレクトが来るまで解決しない Promise を返す。
   * そこでポート確定のタイミングだけをこのコールバックで同期的に呼び出し、呼び出し側が
   * 「ポートを受け取って認可 URL を組み立て、ブラウザを開く」処理を、コード到着を待たずに
   * 行えるようにしている。
   */
  onListening?: (port: number) => void;
}

/**
 * ループバック HTTP サーバーを起動し、Google からのリダイレクトを待って認可コードを返す。
 * 127.0.0.1 に明示的にバインドする — `localhost` は `::1` に解決されることがあり登録した
 * redirect_uri と食い違う可能性があり、`0.0.0.0` はコールバックをネットワークに晒してしまう。
 */
export function waitForAuthorizationCode(options: WaitForAuthorizationCodeOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const server = createServer((req, res) => {
      handleRequest(req, res);
    });

    const cleanup = () => {
      clearTimeout(timer);
      server.close();
    };

    const settleResolve = (code: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(code);
    };

    const settleReject = (error: GasDeployError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    function handleRequest(req: IncomingMessage, res: ServerResponse): void {
      if (settled) {
        res.writeHead(404).end();
        return;
      }

      const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);
      const oauthError = url.searchParams.get('error');
      if (oauthError) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(DENIED_HTML);
        settleReject(
          new GasDeployError(`Google の認可画面でアクセスが拒否されました (${oauthError})`, {
            nextSteps: DENIED_NEXT_STEPS,
          }),
        );
        return;
      }

      const returnedState = url.searchParams.get('state');
      if (returnedState !== options.state) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(INVALID_CALLBACK_HTML);
        settleReject(
          new GasDeployError('state が一致しませんでした。CSRF の可能性があるため認可コードは破棄しました', {
            nextSteps: RETRY_NEXT_STEPS,
          }),
        );
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(INVALID_CALLBACK_HTML);
        settleReject(
          new GasDeployError('Google からの応答に認可コードが含まれていません', {
            nextSteps: RETRY_NEXT_STEPS,
          }),
        );
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(SUCCESS_HTML);
      settleResolve(code);
    }

    server.on('error', (cause) => {
      settleReject(
        new GasDeployError('ローカルサーバーの起動に失敗しました', {
          cause,
          nextSteps: RETRY_NEXT_STEPS,
        }),
      );
    });

    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : undefined;
      if (port === undefined) {
        settleReject(
          new GasDeployError('ローカルサーバーのポート取得に失敗しました', { nextSteps: RETRY_NEXT_STEPS }),
        );
        return;
      }
      options.onListening?.(port);
    });

    timer = setTimeout(() => {
      settleReject(
        new GasDeployError('ブラウザでの認可がタイムアウトしました', {
          nextSteps: TIMEOUT_NEXT_STEPS,
        }),
      );
    }, timeoutMs);
  });
}

export interface ExchangeCodeForRefreshTokenParams {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

/**
 * 認可コードをトークンエンドポイントで refresh token に交換する。
 *
 * 応答本文は成功時に refresh_token そのものを含み、不完全な応答（access_token のみなど）でも
 * 機密情報を含みうるため、失敗時の GasDeployError の `cause` には本文を一切載せない
 * （`packages/core/src/auth.ts` の getAccessToken が失敗応答本文を cause に載せるのとは異なる扱い）。
 */
export async function exchangeCodeForRefreshToken(
  params: ExchangeCodeForRefreshTokenParams,
  fetchImpl: typeof fetch = fetch,
): Promise<Credentials> {
  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code: params.code,
    code_verifier: params.codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: params.redirectUri,
  });

  let response: Response;
  try {
    response = await fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (cause) {
    // ネットワーク層の失敗。応答本文は存在しないため cause に例外を保持してよい。
    throw new GasDeployError('トークンエンドポイントに接続できませんでした', {
      cause,
      nextSteps: CONNECTIVITY_NEXT_STEPS,
    });
  }

  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    // 応答本文の読み取り中に接続が切れた場合。本文は取得できていないため cause に例外を保持してよい。
    throw new GasDeployError('トークンエンドポイントの応答を読み取れませんでした', {
      cause,
      nextSteps: CONNECTIVITY_NEXT_STEPS,
    });
  }

  if (!response.ok) {
    // 本文には診断に有用な情報が含まれるが、断片的なトークン素材を含む可能性を排除できないため
    // cause には載せない。
    throw new GasDeployError(`トークンの交換に失敗しました (${response.status})`, {
      nextSteps: EXCHANGE_FAILURE_NEXT_STEPS,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // SyntaxError のメッセージは応答本文の断片を含む。成功応答には refresh_token が入りうるため
    // cause には載せない。
    throw new GasDeployError('トークンエンドポイントの応答を解析できませんでした', {
      nextSteps: PARSE_FAILURE_NEXT_STEPS,
    });
  }

  const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  const refreshToken = record?.['refresh_token'];

  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    // 200 応答でも refresh_token を含まないことがある（既に一度認可済みのクライアントなど）。
    // 応答自体に access_token など他の機密情報が含まれうるため cause には載せない。
    throw new GasDeployError('トークンエンドポイントの応答に refresh_token が含まれていません', {
      nextSteps: MISSING_REFRESH_TOKEN_NEXT_STEPS,
    });
  }

  return {
    clientId: params.clientId,
    clientSecret: params.clientSecret,
    refreshToken,
  };
}
