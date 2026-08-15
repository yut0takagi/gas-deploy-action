/**
 * バージョン説明の最大長。
 *
 * ⚠️ Apps Script の実際の上限は未実測。保守的な暫定値である。
 * 実測が上限をこれより短いと示した場合は、由来情報から by → pr → run の順に落とす。
 * sha は最後まで残す。
 */
export const MAX_DESCRIPTION_LENGTH = 250;

const SEPARATOR = ' | ';

/** 指定値に割ける残余がこれ未満なら付けない。切れ端は情報価値がない。 */
const MIN_USER_BUDGET = 8;

export interface ProvenanceSource {
  sha?: string;
  runId?: string;
  pr?: number;
  actor?: string;
}

export interface Provenance {
  sha: string;
  runId?: string;
  pr?: number;
  actor?: string;
  /** ` | ` 以降のユーザー指定分。 */
  description?: string;
}

export interface VersionDescription {
  description: string;
  warnings: string[];
}

/**
 * 由来情報の復元パターン。
 *
 * 完全一致のみを受け付ける。部分一致から拾おうとすると、手動作成のバージョンや
 * GAS の UI で説明を書き換えられたバージョンを CI 製と取り違える。ユーザー指定分は
 * 改行を含みうるので `[\s\S]` を使う（`.` は改行に一致しない）。
 */
const PROVENANCE_PATTERN =
  /^ci sha=([0-9a-f]{7,40})(?: run=(\d+))?(?: pr=(\d+))?(?: by=([^\s|]+))?(?: \| ([\s\S]*))?$/;

/** 説明文から由来情報を復元する。完全一致しなければ undefined（= CI 管理外）。 */
export function parseVersionDescription(description: string): Provenance | undefined {
  const match = PROVENANCE_PATTERN.exec(description);
  if (match === null) {
    return undefined;
  }

  const [, sha, runId, pr, actor, rest] = match;
  if (sha === undefined) {
    // 先頭のキャプチャは必須なのでここには到達しないが、noUncheckedIndexedAccess のため明示する。
    return undefined;
  }

  const provenance: Provenance = { sha };
  if (runId !== undefined) provenance.runId = runId;
  if (pr !== undefined) provenance.pr = Number(pr);
  if (actor !== undefined) provenance.actor = actor;
  if (rest !== undefined && rest !== '') provenance.description = rest;
  return provenance;
}

/**
 * バージョン説明を組み立てる。
 *
 * 由来情報を先に置き、`description` 入力は後置する。指定値で置き換えると
 * 「どのコミットが本番にいるか」を追えなくなり、本機能の目的と矛盾する。
 */
export function buildVersionDescription(
  source: ProvenanceSource,
  userDescription?: string,
): VersionDescription {
  const user = userDescription?.trim() ?? '';

  // GITHUB_SHA が無い = Actions 外での実行。由来情報を作れないので指定値をそのまま使う。
  if (!source.sha) {
    if (user === '') {
      return { description: 'manual', warnings: [] };
    }
    // 指定値がたまたま由来情報の形をしていると、後から本物の由来として復元されてしまう。
    // 「CI 管理外を CI 製と取り違えない」という復元側の保証は、書き込み側が同じ形の
    // 文字列を素通しさせない限り成立しない。接頭辞を付けて形を崩す（`ci sha=` で
    // 始まらなくなるため復元されない）。
    if (parseVersionDescription(user) !== undefined) {
      return {
        description: `manual${SEPARATOR}${user}`,
        warnings: ['description が由来情報の形をしていたため、CI 管理外であることを示す接頭辞を付けました'],
      };
    }
    return { description: user, warnings: [] };
  }

  const parts = [`ci sha=${source.sha}`];
  if (source.runId) parts.push(`run=${source.runId}`);
  if (source.pr !== undefined) parts.push(`pr=${source.pr}`);
  if (source.actor) parts.push(`by=${source.actor}`);
  const provenance = parts.join(' ');

  if (user === '') {
    return { description: provenance, warnings: [] };
  }

  const budget = MAX_DESCRIPTION_LENGTH - provenance.length - SEPARATOR.length;
  if (budget < MIN_USER_BUDGET) {
    return {
      description: provenance,
      warnings: ['由来情報が長いため、description をバージョン説明から省略しました（由来の記録を優先します）'],
    };
  }
  if (user.length <= budget) {
    return { description: `${provenance}${SEPARATOR}${user}`, warnings: [] };
  }

  // 「…」も上限に含める。付けた結果 251 文字になってはならない。
  const truncated = `${user.slice(0, budget - 1)}…`;
  return {
    description: `${provenance}${SEPARATOR}${truncated}`,
    warnings: [`description が長いため ${budget} 文字に切り詰めました`],
  };
}
