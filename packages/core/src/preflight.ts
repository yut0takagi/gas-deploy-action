import { AppsScriptClient } from './api-client.js';
import { REQUIRED_SCOPES, exchangeToken } from './auth.js';
import { GasDeployError } from './errors.js';
import type { Credentials } from './types.js';

/**
 * デプロイ前の事前確認。
 *
 * `updateContent` は root-dir の内容でリモートを丸ごと置き換える。その手前で認証や権限の
 * 不備に気づけないと、複数プロジェクトでは「1件目と2件目は置き換わったが、3件目で権限が
 * 無くて停止した」という中途半端な状態が残る。ここで確認するのは、その状態を作らずに
 * 止められるものだけ。
 *
 * 何も書き込まない。トークンの交換と `projects.get` しか行わない。
 */
export interface PreflightOptions {
  credentials: Credentials;
  /**
   * 読み取り権限を確認する scriptId。重複は呼び出し側で除去してから渡すこと
   * （同じプロジェクトに複数の environment が向いている構成がありうる）。
   */
  scriptIds: readonly string[];
}

export interface PreflightResult {
  /** 後続のデプロイでそのまま使えるアクセストークン。交換を二度行わないために返す。 */
  accessToken: string;
  /** 権限を確認できた scriptId。`scriptIds` と同一件数になる（1件でも欠ければ例外）。 */
  checkedScriptIds: string[];
  warnings: string[];
}

export interface PreflightDeps {
  exchange: (credentials: Credentials) => Promise<{ accessToken: string; grantedScopes: string[] }>;
  readProject: (accessToken: string, scriptId: string) => Promise<void>;
}

const DEFAULT_DEPS: PreflightDeps = {
  exchange: (credentials) => exchangeToken(credentials),
  readProject: async (accessToken, scriptId) => {
    await new AppsScriptClient(accessToken).getProject(scriptId);
  },
};

/**
 * 付与スコープを検証する。
 *
 * 不足していても例外にはせず警告に留める。トークンエンドポイントは `scope` を省略する
 * ことがあり、また実際には権限があるのに応答へ現れない場合もありうる。ここで落とすと、
 * 動いていた構成が応答形式の違いだけで止まる。確実に判定できるのは後続の
 * `projects.get` であり、スコープ検証はその前に理由を言うためのもの。
 */
export function verifyScopes(grantedScopes: readonly string[]): string[] {
  if (grantedScopes.length === 0) {
    return [];
  }

  const missing = REQUIRED_SCOPES.filter((required) => !grantedScopes.includes(required));
  if (missing.length === 0) {
    return [];
  }

  return [
    `認証情報に必要なスコープが付与されていない可能性があります（不足: ${missing.join(', ')}）。` +
      'デプロイが 403 で失敗する場合は、clasp login をやり直して認証情報を再発行してください',
  ];
}

export async function preflight(
  options: PreflightOptions,
  deps: Partial<PreflightDeps> = {},
): Promise<PreflightResult> {
  const { exchange, readProject } = { ...DEFAULT_DEPS, ...deps };

  // 交換の失敗は auth.ts が原因別に分類済みの GasDeployError を投げる。ここで包み直すと
  // invalid_rapt のような確定した原因の案内が「プリフライトに失敗しました」に潰れるため、
  // そのまま通す。
  const { accessToken, grantedScopes } = await exchange(options.credentials);

  const warnings = verifyScopes(grantedScopes);

  const checkedScriptIds: string[] = [];
  for (const scriptId of options.scriptIds) {
    try {
      await readProject(accessToken, scriptId);
    } catch (cause) {
      // classifyApiError が付けた 401 / 403 / 404 の案内をそのまま活かす。ただし
      // どの scriptId で落ちたかは元のエラーに入らないため、そこだけ補って投げ直す。
      // 複数プロジェクトでは「どれが原因か」が分からないと調べようがない。
      const detail = cause instanceof GasDeployError ? cause : undefined;
      throw new GasDeployError(
        `デプロイ前の確認に失敗しました（scriptId: ${scriptId}）: ${
          detail?.message ?? (cause instanceof Error ? cause.message : String(cause))
        }`,
        {
          cause,
          ...(detail?.code !== undefined ? { code: detail.code } : {}),
          ...(detail?.status !== undefined ? { status: detail.status } : {}),
          nextSteps: [
            ...(detail?.nextSteps ?? []),
            'この確認は読み取りのみで、リモートのファイルはまだ書き換えられていません',
          ],
        },
      );
    }
    checkedScriptIds.push(scriptId);
  }

  return { accessToken, checkedScriptIds, warnings };
}
