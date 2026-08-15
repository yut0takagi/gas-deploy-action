import { AppsScriptClient } from './api-client.js';
import { GasDeployError, type GasErrorCode } from './errors.js';
import { getAccessToken } from './auth.js';
import type { Credentials } from './types.js';

/**
 * 死活監視の判定。
 *
 * `invalid` と `unknown` を分けているのが要点である。ランナーが Google に到達できなかった
 * だけで「トークンが失効した」と報告すると、Issue を起票しても調べるものが無く、
 * 数回繰り返された時点で監視そのものが無視されるようになる。判定できなかったことは
 * 判定できなかったと言う。
 */
export type TokenHealthStatus = 'valid' | 'invalid' | 'unknown';

/** 判定の理由。`ok` 以外は失敗の種別で、`unclassified` は分類できなかったことを表す。 */
export type TokenHealthReason = 'ok' | GasErrorCode | 'unclassified';

export interface TokenHealth {
  status: TokenHealthStatus;
  reason: TokenHealthReason;
  /** 人間向けの1行。`GasDeployError.format()` ではなく `message` のみを使う。 */
  message: string;
  nextSteps: string[];
  /** scriptId が指定され、実際にプロジェクトの読み取りまで確認できたか。 */
  projectChecked: boolean;
}

export interface TokenHealthOptions {
  credentials: Credentials;
  /**
   * 指定すると、トークン交換に加えて実際にこのプロジェクトを読めるかまで確認する。
   * 「トークンは生きているが API が無効化された」「対象スクリプトの権限を外された」を
   * 交換だけでは検知できないため。
   */
  scriptId?: string;
}

export interface TokenHealthDeps {
  exchangeToken: (credentials: Credentials) => Promise<string>;
  readProject: (accessToken: string, scriptId: string) => Promise<void>;
}

/**
 * 失敗の種別を判定に写す。
 *
 * `invalid` は「今デプロイしたら確実に失敗する」もの、`unknown` は「本当に壊れているのか
 * 分からない」もの。分類できないものは `unknown` に倒す（壊れていないものを壊れたと
 * 報告する方が、監視の信頼を早く損なうため）。
 */
function toStatus(code: GasErrorCode | undefined): { status: TokenHealthStatus; reason: TokenHealthReason } {
  switch (code) {
    case 'token-invalid':
    case 'insufficient-scope':
    case 'unauthorized':
    case 'api-disabled':
    case 'access-denied':
    case 'not-found':
      return { status: 'invalid', reason: code };
    case 'connectivity':
    case 'response-invalid':
    case 'api-error':
      return { status: 'unknown', reason: code };
    default:
      return { status: 'unknown', reason: 'unclassified' };
  }
}

const DEFAULT_DEPS: TokenHealthDeps = {
  exchangeToken: (credentials) => getAccessToken(credentials),
  readProject: async (accessToken, scriptId) => {
    await new AppsScriptClient(accessToken).getContent(scriptId);
  },
};

/**
 * refresh token が今も使えるかを確認する。
 *
 * 何も書き換えない。仕様どおり「更新」ではなく「死活監視」であり、refresh token は
 * 失効しない限り不変なので、更新する対象がそもそも存在しない。
 */
export async function checkTokenHealth(
  options: TokenHealthOptions,
  deps: Partial<TokenHealthDeps> = {},
): Promise<TokenHealth> {
  const { exchangeToken, readProject } = { ...DEFAULT_DEPS, ...deps };

  // 失敗を1箇所で写すため、例外は種別だけを取り出して畳む。cause は API の生レスポンスを
  // 含みうるので、結果には決して載せない（結果はジョブサマリと出力に出る）。
  const fail = (error: unknown, projectChecked: boolean): TokenHealth => {
    const gasError = error instanceof GasDeployError ? error : undefined;
    const { status, reason } = toStatus(gasError?.code);
    return {
      status,
      reason,
      message: gasError?.message ?? '死活監視の実行中に想定外のエラーが発生しました',
      nextSteps: gasError?.nextSteps ?? [],
      projectChecked,
    };
  };

  let accessToken: string;
  try {
    accessToken = await exchangeToken(options.credentials);
  } catch (error) {
    // 交換が失敗した時点でプロジェクトの読み取りには進まない。使えるトークンが無いので
    // 続けても得られる情報が無く、無関係な 401 で理由が上書きされるだけになる。
    return fail(error, false);
  }

  if (options.scriptId === undefined) {
    return { status: 'valid', reason: 'ok', message: 'refresh token は有効です', nextSteps: [], projectChecked: false };
  }

  try {
    await readProject(accessToken, options.scriptId);
  } catch (error) {
    return fail(error, false);
  }

  return {
    status: 'valid',
    reason: 'ok',
    message: 'refresh token は有効で、対象プロジェクトを読み取れます',
    nextSteps: [],
    projectChecked: true,
  };
}
