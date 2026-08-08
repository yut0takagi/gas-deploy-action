import { GasDeployError } from './errors.js';
import type { Credentials } from './types.js';

const MAX_NESTING_DEPTH = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `{ client_id, client_secret, refresh_token }` 形式。最小形式と clasp v3 のネスト内側の両方に該当する。 */
function extractSnakeCase(value: unknown): Credentials | undefined {
  if (!isRecord(value)) return undefined;
  const clientId = asString(value['client_id']);
  const clientSecret = asString(value['client_secret']);
  const refreshToken = asString(value['refresh_token']);
  if (!clientId || !clientSecret || !refreshToken) return undefined;
  return { clientId, clientSecret, refreshToken };
}

/** clasp v2 の `.clasprc.json` 形式。 */
function extractClaspV2(value: unknown): Credentials | undefined {
  if (!isRecord(value)) return undefined;
  const token = value['token'];
  const settings = value['oauth2ClientSettings'];
  if (!isRecord(token) || !isRecord(settings)) return undefined;
  const clientId = asString(settings['clientId']);
  const clientSecret = asString(settings['clientSecret']);
  const refreshToken = asString(token['refresh_token']);
  if (!clientId || !clientSecret || !refreshToken) return undefined;
  return { clientId, clientSecret, refreshToken };
}

function extract(value: unknown, depth: number): Credentials | undefined {
  const direct = extractSnakeCase(value) ?? extractClaspV2(value);
  if (direct) return direct;
  if (depth >= MAX_NESTING_DEPTH || !isRecord(value)) return undefined;
  for (const child of Object.values(value)) {
    const found = extract(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

const UNSUPPORTED_SHAPE_STEPS = [
  'clasp v2 の .clasprc.json（token / oauth2ClientSettings を持つ形式）',
  'clasp v3 の .clasprc.json（ユーザー名でネストされた authorized_user 形式）',
  '最小形式: {"client_id": "...", "client_secret": "...", "refresh_token": "..."}',
  '上記のいずれでもない場合は、認証情報を再発行してください',
];

export function parseCredentials(raw: string): Credentials {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // SyntaxError のメッセージは入力の先頭断片をそのまま含む。credentials は秘密情報そのものなので
    // cause には載せない。診断に必要な情報は nextSteps で伝える。
    throw new GasDeployError('credentials の JSON を解析できませんでした', {
      nextSteps: [
        'GitHub Secrets に登録した値が JSON 全体になっているか確認してください',
        'ファイルの内容を貼り付ける際に前後の空白や改行が混入していないか確認してください',
      ],
    });
  }

  const credentials = extract(json, 0);
  if (!credentials) {
    throw new GasDeployError('credentials の形式を認識できませんでした', {
      nextSteps: ['対応している形式は次の通りです:', ...UNSUPPORTED_SHAPE_STEPS],
    });
  }
  return credentials;
}
