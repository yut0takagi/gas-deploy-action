/**
 * 未確定事項の検証用スクリプト（使い捨て）。
 *
 * 実行方法:
 *   export GAS_CREDENTIALS="$(cat ~/.clasprc.json)"
 *   export GAS_SCRIPT_ID="<検証用スクリプトの scriptId>"
 *   npm run spike
 *
 * 補足: `node --experimental-strip-types scripts/spike-verify.ts` は使えない。
 * Node の type stripping は import 指定子を書き換えないため、credentials.ts が
 * 内部で import する './errors.js'（実体は errors.ts）が解決できず
 * ERR_MODULE_NOT_FOUND になる（Node v24.13.1 で確認済み）。そのため `npm run spike`
 * は esbuild で一旦バンドルしてから実行する（package.json の "spike" スクリプト）。
 *
 * 安全性についての注意:
 *   このスクリプトはアクセストークン・リフレッシュトークン・クライアントシークレット・
 *   ファイルの source 本文を一切 console.log しない。[7] は .clasprc.json の構造を
 *   調べるためにキー名と値の「型」のみを出力し、値そのもの（文字列・数値）は出力しない。
 *   さらに [7] は "@" を含むキー名（アカウントのメールアドレスである可能性が高い）を
 *   `<メールアドレス>` に置き換えてから出力する（maskKeyName）。ただしこれはヒューリスティック
 *   であり、メールアドレス以外の形式の個人識別子までは伏せられない。この出力は将来
 *   公開リポジトリにコミットされる想定のため、貼り付ける前に必ず人間が目視で確認すること。
 */
import { parseCredentials } from '../packages/core/src/credentials.ts';
import { getAccessToken } from '../packages/core/src/auth.ts';
import { GasDeployError } from '../packages/core/src/errors.ts';

const rawCredentials = process.env['GAS_CREDENTIALS'];
const scriptId = process.env['GAS_SCRIPT_ID'];

if (!rawCredentials || !scriptId) {
  console.error('GAS_CREDENTIALS と GAS_SCRIPT_ID を環境変数に設定してください');
  process.exit(1);
}

async function main(): Promise<void> {
  const credentials = parseCredentials(rawCredentials!);
  console.log('[1] credentials のパース: OK');

  const accessToken = await getAccessToken(credentials);
  console.log('[2] アクセストークン取得: OK');

  const tokenInfoResponse = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
  );
  const tokenInfo = (await tokenInfoResponse.json()) as { scope?: string };
  console.log('[3] 付与されているスコープ:');
  for (const scope of (tokenInfo.scope ?? '').split(' ')) {
    console.log(`      ${scope}`);
  }

  const contentResponse = await fetch(`https://script.googleapis.com/v1/projects/${scriptId}/content`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const content = (await contentResponse.json()) as { files?: Array<{ name: string; type: string }> };
  console.log(`[4] getContent: ${contentResponse.status}`);
  for (const file of content.files ?? []) {
    console.log(`      ${file.type.padEnd(10)} ${file.name}`);
  }
  const hasSlash = (content.files ?? []).some((f) => f.name.includes('/'));
  console.log(`[5] name に "/" を含むファイルの有無: ${hasSlash ? 'あり' : 'なし'}`);

  const deploymentsResponse = await fetch(`https://script.googleapis.com/v1/projects/${scriptId}/deployments`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const deployments = (await deploymentsResponse.json()) as { deployments?: unknown[] };
  console.log(`[6] 現在のデプロイ数: ${(deployments.deployments ?? []).length}`);

  console.log('[7] credentials のトップレベル構造（キー名のみ）:');
  try {
    // parseCredentials が返すのは抽出後の Credentials であり、元の JSON 構造（複数ユーザーを
    // 保持しうるかどうか）を失っている。#6 の検証には元の生 JSON の形を見る必要があるため、
    // ここでもう一度 JSON.parse するが、パース結果の値は一切出力しない。
    const rawParsed: unknown = JSON.parse(rawCredentials!);
    printKeyNamesOnly(rawParsed, '      ', 1);
  } catch {
    console.log('      (JSON として再解析できませんでした)');
  }
}

/**
 * 値の「型」だけを表す文字列を返す。値そのもの（文字列の中身や数値）は絶対に含めない。
 * - null      -> "null"
 * - 配列      -> "array(length=N)"（要素数はキー名同様に秘密ではないため表示してよい）
 * - オブジェクト -> "object"
 * - それ以外   -> typeof の結果（"string" | "number" | "boolean" | ...）
 */
function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(length=${value.length})`;
  return typeof value;
}

/**
 * キー名がアカウントを識別しうる場合（"@" を含む＝メールアドレスらしい場合）に伏せる。
 * clasp v3 の .clasprc.json はユーザーのメールアドレスをキーにしてトークンをネストしうるため、
 * このキー名をそのまま出力すると個人情報が漏れる。それ以外のキー名はそのまま返す
 * （これはヒューリスティックであり、メールアドレス以外の識別子までは検出できない）。
 */
function maskKeyName(key: string): string {
  return key.includes('@') ? '<メールアドレス>' : key;
}

/**
 * オブジェクトのキー名と、各値の型のみを出力する。値そのものは一切 console.log しない。
 * キー名は maskKeyName でメールアドレスらしきものを伏せてから出力する。
 * maxDepth で再帰の深さを制限する（トップレベルと、その1階層下まで）。
 */
function printKeyNamesOnly(value: unknown, indent: string, remainingDepth: number): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    console.log(`${indent}${maskKeyName(key)}: ${describeType(child)}`);
    if (remainingDepth > 0 && typeof child === 'object' && child !== null && !Array.isArray(child)) {
      printKeyNamesOnly(child, `${indent}  `, remainingDepth - 1);
    }
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof GasDeployError) {
    console.error(error.format());
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
}
