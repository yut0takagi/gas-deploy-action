# gas-deploy-actions v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apps Script API を直接叩いて GAS プロジェクトをデプロイする GitHub Action（単一プロジェクト・軽量モード）を、clasp の `.clasprc.json` をそのまま受理する形で動作させる。

**Architecture:** `packages/core` に GitHub Actions 非依存の純ロジック（認証情報パース・トークン取得・ファイル収集・差分計算・API クライアント・オーケストレーション）を置き、`deploy/` に薄い GHA アダプタを置く。HTTP は Node 22 のネイティブ `fetch` のみを使い、`googleapis` SDK は使わない（バンドルサイズと依存の削減のため。使うエンドポイントは6個だけ）。

**Tech Stack:** TypeScript 5.6 / Node 22 / npm workspaces / Vitest 2 / esbuild / picomatch / @actions/core

**Source spec:** [`docs/superpowers/specs/2026-08-09-gas-deploy-actions-design.md`](../specs/2026-08-09-gas-deploy-actions-design.md)

**Out of scope for v0.1（v1.0 に送る）:** `gasdeploy.yml` によるマルチプロジェクト・複数環境、`setup-cli`、`refresh-token` 死活監視アクション、実 GAS への E2E テスト。

---

## File Structure

| パス | 責務 |
|---|---|
| `package.json` | npm workspaces ルート。スクリプトと devDependencies |
| `tsconfig.json` | プロジェクト参照のみを持つソリューションファイル |
| `tsconfig.base.json` | 共通 TS 設定 |
| `vitest.config.ts` | テスト対象の指定 |
| `scripts/build.mjs` | esbuild で `deploy/dist/index.js` を生成 |
| `scripts/spike-verify.ts` | 未確定事項を実 API で検証する使い捨てスクリプト |
| `packages/core/src/types.ts` | 共有型定義のみ。ロジックを持たない |
| `packages/core/src/errors.ts` | エラー型と HTTP ステータスの分類 |
| `packages/core/src/credentials.ts` | 3形式の認証情報を正規化 |
| `packages/core/src/auth.ts` | refresh token → access token |
| `packages/core/src/ignore.ts` | `.claspignore` 互換の除外判定 |
| `packages/core/src/file-collector.ts` | ディレクトリ走査 → `ScriptFile[]` |
| `packages/core/src/differ.ts` | 正規化と差分計算 |
| `packages/core/src/api-client.ts` | Apps Script API クライアント（リトライ込み） |
| `packages/core/src/deployer.ts` | デプロイ手順のオーケストレーション |
| `packages/core/src/index.ts` | 公開 API の再エクスポート |
| `deploy/action.yml` | Action のメタデータ |
| `deploy/src/main.ts` | GHA アダプタ（inputs/outputs/summary） |
| `deploy/dist/index.js` | バンドル済み（コミット対象） |
| `.github/workflows/ci.yml` | typecheck / test / dist 同期チェック |
| `tests/fixtures/sample-project/` | clasp 互換ゴールデンテスト用の入力 |
| `tests/fixtures/sample-project.expected.json` | clasp が生成する `File[]` の記録 |

**分割の意図:** `differ` と `file-collector` を `deployer` から独立させることで、dry-run・PR コメント（v2.0）・「差分ゼロならスキップ」が同一部品で実現される。`api-client` にリトライを閉じ込めることで、`deployer` はリトライを知らずに済む。

---

## Task 1: プロジェクト基盤

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`
- Create: `packages/core/src/index.test.ts`

- [ ] **Step 1: ルートの `package.json` を作成**

```json
{
  "name": "gas-deploy-actions",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --build",
    "build": "node scripts/build.mjs"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "esbuild": "^0.24.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: `tsconfig.base.json` を作成**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "skipLibCheck": true,
    "declaration": true,
    "composite": true,
    "verbatimModuleSyntax": true
  }
}
```

- [ ] **Step 3: ルートの `tsconfig.json` を作成**

`npm run typecheck` は `tsc --build` を使うため、参照だけを持つソリューションファイルが必要になる。`deploy` は Task 11 で作成するので、この時点では `packages/core` のみを参照する。

```json
{
  "files": [],
  "references": [{ "path": "./packages/core" }]
}
```

- [ ] **Step 4: `vitest.config.ts` を作成**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'deploy/src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 5: `.gitignore` を作成**

`deploy/dist` は**意図的に除外しない**（Action の実行に必要なのでコミットする）。一方 TypeScript のビルド成果物は除外する。

```
node_modules/
*.tsbuildinfo
coverage/
.env
.DS_Store
packages/core/dist/
deploy/build/
```

- [ ] **Step 6: `packages/core/package.json` を作成**

```json
{
  "name": "@gas-deploy/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "picomatch": "^4.0.2"
  },
  "devDependencies": {
    "@types/picomatch": "^3.0.1"
  }
}
```

- [ ] **Step 7: `packages/core/tsconfig.json` を作成**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 8: 疎通確認用の最小のエクスポートとテストを作成**

`packages/core/src/index.ts`:

```typescript
export const VERSION = '0.1.0';
```

`packages/core/src/index.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { VERSION } from './index.js';

describe('core package', () => {
  it('exposes a version string', () => {
    expect(VERSION).toBe('0.1.0');
  });
});
```

- [ ] **Step 9: 依存をインストールしてテストを実行**

Run: `npm install && npm test`
Expected: `1 passed` と表示され、終了コード 0

- [ ] **Step 10: 型チェックを実行**

Run: `npm run typecheck`
Expected: エラーなしで終了

- [ ] **Step 11: コミット**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.base.json vitest.config.ts .gitignore packages/
git commit -m "chore: npm workspaces + TypeScript + Vitest の基盤を構築"
```

---

## Task 2: 型定義とエラー階層

エラーは「何が起きたか」ではなく**「次に何をすべきか」**を出力する。これが既存 clasp 運用の最大の不満（cryptic errors）への回答である。

**Files:**
- Create: `packages/core/src/types.ts`
- Create: `packages/core/src/errors.ts`
- Create: `packages/core/src/errors.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: `types.ts` を作成（ロジックを持たない型のみ）**

```typescript
export type FileType = 'SERVER_JS' | 'HTML' | 'JSON';

export interface ScriptFile {
  name: string;
  type: FileType;
  source: string;
}

export interface Credentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface FileDiff {
  added: string[];
  modified: string[];
  deleted: string[];
}

export type ProjectType = 'webapp' | 'addon' | 'bound' | 'standalone';

export interface Deployment {
  deploymentId: string;
  versionNumber?: number;
  description?: string;
  webAppUrl?: string;
}
```

- [ ] **Step 2: 失敗するテストを書く**

`packages/core/src/errors.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { GasDeployError, classifyApiError } from './errors.js';

describe('GasDeployError', () => {
  it('formats the message with numbered next steps', () => {
    const err = new GasDeployError('失敗しました', { nextSteps: ['A を確認', 'B を確認'] });
    expect(err.format()).toBe('失敗しました\n\n次の手順を確認してください:\n  1. A を確認\n  2. B を確認');
  });

  it('formats to the bare message when there are no next steps', () => {
    const err = new GasDeployError('失敗しました');
    expect(err.format()).toBe('失敗しました');
  });
});

describe('classifyApiError', () => {
  it('points 401 at refresh token expiry with the 7-day testing-status cause', () => {
    const err = classifyApiError(401, '{"error":"invalid_grant"}');
    expect(err.message).toContain('401');
    expect(err.nextSteps.join('\n')).toContain('テスト');
  });

  it('points a disabled-API 403 at the user settings page', () => {
    const err = classifyApiError(403, 'Apps Script API has not been used in project 12345 before');
    expect(err.nextSteps.join('\n')).toContain('script.google.com/home/usersettings');
  });

  it('points a permission 403 at account access rather than the settings page', () => {
    const err = classifyApiError(403, '{"error":{"message":"The caller does not have permission"}}');
    expect(err.nextSteps.join('\n')).not.toContain('usersettings');
    expect(err.nextSteps.join('\n')).toContain('権限');
  });

  it('points 404 at a wrong scriptId or missing access', () => {
    const err = classifyApiError(404, '{}');
    expect(err.nextSteps.join('\n')).toContain('scriptId');
  });

  it('falls back to a generic message for unexpected statuses', () => {
    const err = classifyApiError(500, 'boom');
    expect(err.message).toContain('500');
  });
});
```

- [ ] **Step 3: テストを実行して失敗を確認**

Run: `npx vitest run packages/core/src/errors.test.ts`
Expected: FAIL — `Failed to resolve import "./errors.js"`

- [ ] **Step 4: `errors.ts` を実装**

```typescript
export interface ErrorDetails {
  nextSteps?: string[];
  cause?: unknown;
}

export class GasDeployError extends Error {
  readonly nextSteps: string[];

  constructor(message: string, details: ErrorDetails = {}) {
    super(message, { cause: details.cause });
    this.name = 'GasDeployError';
    this.nextSteps = details.nextSteps ?? [];
  }

  format(): string {
    if (this.nextSteps.length === 0) {
      return this.message;
    }
    const steps = this.nextSteps.map((step, i) => `  ${i + 1}. ${step}`);
    return [this.message, '', '次の手順を確認してください:', ...steps].join('\n');
  }
}

const API_DISABLED_MARKERS = ['Apps Script API has not been used', 'accessNotConfigured', 'SERVICE_DISABLED'];

export function classifyApiError(status: number, body: string): GasDeployError {
  if (status === 401) {
    return new GasDeployError('Apps Script API の認証に失敗しました (401)', {
      cause: body,
      nextSteps: [
        'refresh token が失効している可能性があります。OAuth 同意画面が「テスト」状態の場合、refresh token は7日で失効します。「本番」または「内部」に変更してください',
        'デプロイに使う Google アカウントのパスワードが変更されていないか確認してください',
        '認証情報を再発行し、GitHub Secrets を更新してください',
      ],
    });
  }

  if (status === 403) {
    const isApiDisabled = API_DISABLED_MARKERS.some((marker) => body.includes(marker));
    if (isApiDisabled) {
      return new GasDeployError('Apps Script API が有効化されていません (403)', {
        cause: body,
        nextSteps: [
          'https://script.google.com/home/usersettings を開き「Google Apps Script API」をオンにしてください',
          'GCP プロジェクト側でも Apps Script API を有効化してください',
          '設定の反映に数分かかる場合があります',
        ],
      });
    }
    return new GasDeployError('Apps Script プロジェクトへのアクセスが拒否されました (403)', {
      cause: body,
      nextSteps: [
        '認証に使ったアカウントに、対象スクリプトの編集権限があるか確認してください',
        '要求スコープに script.projects と script.deployments が含まれているか確認してください',
      ],
    });
  }

  if (status === 404) {
    return new GasDeployError('Apps Script プロジェクトが見つかりません (404)', {
      cause: body,
      nextSteps: [
        'scriptId が正しいか確認してください（スクリプトエディタの「プロジェクトの設定」で確認できます）',
        '認証に使ったアカウントに、対象スクリプトの閲覧権限があるか確認してください',
      ],
    });
  }

  return new GasDeployError(`Apps Script API がエラーを返しました (${status})`, {
    cause: body,
    nextSteps: ['しばらく待って再実行してください', 'Google Workspace のステータスダッシュボードで障害情報を確認してください'],
  });
}
```

- [ ] **Step 5: テストを実行して成功を確認**

Run: `npx vitest run packages/core/src/errors.test.ts`
Expected: `7 passed`

- [ ] **Step 6: `index.ts` から再エクスポート**

`packages/core/src/index.ts` を以下の内容で置き換える:

```typescript
export const VERSION = '0.1.0';

export * from './types.js';
export * from './errors.js';
```

- [ ] **Step 7: 全テストと型チェックを実行**

Run: `npm test && npm run typecheck`
Expected: 全テスト PASS、型エラーなし

- [ ] **Step 8: コミット**

```bash
git add packages/core/src/types.ts packages/core/src/errors.ts packages/core/src/errors.test.ts packages/core/src/index.ts
git commit -m "feat(core): 次の手順を提示するエラー型と API エラー分類を追加"
```

---

## Task 3: 認証情報パーサ

スペックの未確定 #1（clasp v3 の `.clasprc.json` スキーマ）を**設計で無効化する**タスク。想定される3形式すべてを受理し、どれにも当たらなければ対応形式を列挙して失敗する。これにより v3 の実物を確認しなくても実装を進められる。

**Files:**
- Create: `packages/core/src/credentials.ts`
- Create: `packages/core/src/credentials.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: 失敗するテストを書く**

`packages/core/src/credentials.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { parseCredentials } from './credentials.js';
import { GasDeployError } from './errors.js';

const EXPECTED = {
  clientId: 'cid.apps.googleusercontent.com',
  clientSecret: 'secret-value',
  refreshToken: 'refresh-value',
};

describe('parseCredentials', () => {
  it('accepts the minimal snake_case format', () => {
    const raw = JSON.stringify({
      client_id: 'cid.apps.googleusercontent.com',
      client_secret: 'secret-value',
      refresh_token: 'refresh-value',
    });
    expect(parseCredentials(raw)).toEqual(EXPECTED);
  });

  it('accepts the clasp v2 .clasprc.json format', () => {
    const raw = JSON.stringify({
      token: {
        access_token: 'ignored-access-token',
        refresh_token: 'refresh-value',
        expiry_date: 1234567890,
      },
      oauth2ClientSettings: {
        clientId: 'cid.apps.googleusercontent.com',
        clientSecret: 'secret-value',
        redirectUri: 'http://localhost',
      },
      isLocalCreds: false,
    });
    expect(parseCredentials(raw)).toEqual(EXPECTED);
  });

  it('accepts a nested per-user format such as clasp v3 uses', () => {
    const raw = JSON.stringify({
      tokens: {
        default: {
          type: 'authorized_user',
          client_id: 'cid.apps.googleusercontent.com',
          client_secret: 'secret-value',
          refresh_token: 'refresh-value',
        },
      },
    });
    expect(parseCredentials(raw)).toEqual(EXPECTED);
  });

  it('never returns the access token even when one is present', () => {
    const raw = JSON.stringify({
      token: { access_token: 'ignored-access-token', refresh_token: 'refresh-value' },
      oauth2ClientSettings: { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'secret-value' },
    });
    expect(JSON.stringify(parseCredentials(raw))).not.toContain('ignored-access-token');
  });

  it('throws a guided error on malformed JSON', () => {
    expect(() => parseCredentials('not json')).toThrowError(GasDeployError);
  });

  it('lists the supported shapes when nothing matches', () => {
    const err = (() => {
      try {
        parseCredentials(JSON.stringify({ unrelated: true }));
        return undefined;
      } catch (e) {
        return e as GasDeployError;
      }
    })();
    expect(err).toBeInstanceOf(GasDeployError);
    expect(err!.nextSteps.join('\n')).toContain('.clasprc.json');
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run packages/core/src/credentials.test.ts`
Expected: FAIL — `Failed to resolve import "./credentials.js"`

- [ ] **Step 3: `credentials.ts` を実装**

```typescript
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
  } catch (cause) {
    throw new GasDeployError('credentials の JSON を解析できませんでした', {
      cause,
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
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx vitest run packages/core/src/credentials.test.ts`
Expected: `6 passed`

- [ ] **Step 5: `index.ts` に再エクスポートを追加**

`packages/core/src/index.ts` の末尾に追記:

```typescript
export * from './credentials.js';
```

- [ ] **Step 6: コミット**

```bash
git add packages/core/src/credentials.ts packages/core/src/credentials.test.ts packages/core/src/index.ts
git commit -m "feat(core): clasp v2/v3 と最小形式の認証情報を受理するパーサを追加"
```

---

## Task 4: アクセストークン取得

**Files:**
- Create: `packages/core/src/auth.ts`
- Create: `packages/core/src/auth.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: 失敗するテストを書く**

`packages/core/src/auth.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { getAccessToken } from './auth.js';
import { GasDeployError } from './errors.js';

const CREDENTIALS = {
  clientId: 'cid.apps.googleusercontent.com',
  clientSecret: 'secret-value',
  refreshToken: 'refresh-value',
};

function stubFetch(status: number, body: string) {
  return vi.fn(async () => new Response(body, { status }));
}

describe('getAccessToken', () => {
  it('exchanges the refresh token for an access token', async () => {
    const fetchImpl = stubFetch(200, JSON.stringify({ access_token: 'at-123', expires_in: 3599 }));
    const token = await getAccessToken(CREDENTIALS, fetchImpl as unknown as typeof fetch);
    expect(token).toBe('at-123');
  });

  it('posts the grant_type and credentials as form-encoded data', async () => {
    const fetchImpl = stubFetch(200, JSON.stringify({ access_token: 'at-123' }));
    await getAccessToken(CREDENTIALS, fetchImpl as unknown as typeof fetch);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.method).toBe('POST');
    const params = init.body as URLSearchParams;
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('refresh-value');
    expect(params.get('client_id')).toBe('cid.apps.googleusercontent.com');
  });

  it('explains the 7-day testing-status expiry when the exchange fails', async () => {
    const fetchImpl = stubFetch(400, JSON.stringify({ error: 'invalid_grant' }));
    await expect(getAccessToken(CREDENTIALS, fetchImpl as unknown as typeof fetch)).rejects.toThrowError(GasDeployError);

    const err = await getAccessToken(CREDENTIALS, fetchImpl as unknown as typeof fetch).catch((e: GasDeployError) => e);
    expect(err.nextSteps.join('\n')).toContain('テスト');
  });

  it('fails when the response has no access_token', async () => {
    const fetchImpl = stubFetch(200, JSON.stringify({ token_type: 'Bearer' }));
    await expect(getAccessToken(CREDENTIALS, fetchImpl as unknown as typeof fetch)).rejects.toThrowError(GasDeployError);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run packages/core/src/auth.test.ts`
Expected: FAIL — `Failed to resolve import "./auth.js"`

- [ ] **Step 3: `auth.ts` を実装**

```typescript
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
    throw new GasDeployError(`アクセストークンの取得に失敗しました (${response.status})`, {
      cause: text,
      nextSteps: EXPIRY_NEXT_STEPS,
    });
  }

  let parsed: { access_token?: string };
  try {
    parsed = JSON.parse(text) as { access_token?: string };
  } catch (cause) {
    throw new GasDeployError('トークンエンドポイントの応答を解析できませんでした', { cause });
  }

  if (!parsed.access_token) {
    throw new GasDeployError('トークンエンドポイントの応答に access_token が含まれていません', {
      cause: text,
      nextSteps: EXPIRY_NEXT_STEPS,
    });
  }

  return parsed.access_token;
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx vitest run packages/core/src/auth.test.ts`
Expected: `4 passed`

- [ ] **Step 5: `index.ts` に再エクスポートを追加**

`packages/core/src/index.ts` の末尾に追記:

```typescript
export * from './auth.js';
```

- [ ] **Step 6: コミット**

```bash
git add packages/core/src/auth.ts packages/core/src/auth.test.ts packages/core/src/index.ts
git commit -m "feat(core): refresh token からアクセストークンを取得する処理を追加"
```

---

## Task 5: 未確定事項の検証スパイク（手動実行）

> **⚠️ このタスクは実行者（人間）が自分の Google アカウントで実施する必要がある。** 実 API を叩くため自動化できない。以降のタスクはこの結果を待たずに進めてよい（設計はすべての結果に対応できるようになっている）。

スペック §10 の未確定事項 #2 #3 #4 #5 をここで確定させる。

**Files:**
- Create: `scripts/spike-verify.ts`
- Create: `docs/superpowers/notes/2026-08-09-api-verification.md`

- [ ] **Step 1: 検証スクリプトを作成**

`scripts/spike-verify.ts`:

```typescript
/**
 * 未確定事項の検証用スクリプト（使い捨て）。
 *
 * 実行方法:
 *   export GAS_CREDENTIALS="$(cat ~/.clasprc.json)"
 *   export GAS_SCRIPT_ID="<検証用スクリプトの scriptId>"
 *   node --experimental-strip-types scripts/spike-verify.ts
 */
import { parseCredentials } from '../packages/core/src/credentials.ts';
import { getAccessToken } from '../packages/core/src/auth.ts';

const rawCredentials = process.env['GAS_CREDENTIALS'];
const scriptId = process.env['GAS_SCRIPT_ID'];

if (!rawCredentials || !scriptId) {
  console.error('GAS_CREDENTIALS と GAS_SCRIPT_ID を環境変数に設定してください');
  process.exit(1);
}

const credentials = parseCredentials(rawCredentials);
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
```

- [ ] **Step 2: 検証用の GAS プロジェクトを用意する**

スクリプトエディタで新規スタンドアロンプロジェクトを作成し、`Code.gs` に加えて**サブディレクトリを持つファイル**（clasp で `ui/Sidebar.html` を push したもの）を含める。scriptId は「プロジェクトの設定」から取得する。

- [ ] **Step 3: スクリプトを実行**

```bash
export GAS_CREDENTIALS="$(cat ~/.clasprc.json)"
export GAS_SCRIPT_ID="<scriptId>"
node --experimental-strip-types scripts/spike-verify.ts
```

Expected: `[1]` から `[6]` まですべて出力される

- [ ] **Step 4: OAuth 同意画面の状態を確認（未確定 #3）**

Google Cloud Console の「OAuth 同意画面」を開き、次を記録する:

1. 公開ステータス（テスト / 本番）
2. `script.projects` および `script.deployments` が「機密性の高いスコープ」または「制限付きスコープ」として表示されるか
3. 「本番」に切り替える際に確認（verification）が要求されるか

- [ ] **Step 5: 結果を記録**

`docs/superpowers/notes/2026-08-09-api-verification.md` を作成し、以下のテンプレートに実測値を埋める:

```markdown
# Apps Script API 検証結果

実施日: <YYYY-MM-DD>
検証環境: <Workspace / 個人 Gmail>

## #2 script.webapp.deploy スコープの要否

付与されていたスコープ一覧:
（spike-verify.ts の [3] の出力を貼り付け）

判定: <必要 / 不要>

## #3 script.projects の審査対象該否

OAuth 同意画面の公開ステータス: <テスト / 本番>
機密性の高いスコープとして表示されたか: <はい / いいえ>
「本番」への切り替えに確認が要求されたか: <はい / いいえ>

判定: <審査必要 / 不要>
README への影響: <記述>

## #4 デプロイ数上限

現在のデプロイ数: <n>
上限に到達した際のエラー: <未検証 / 内容>

判定: <上限値>

## #5 サブディレクトリの name 表現

getContent が返した name 一覧:
（spike-verify.ts の [4] の出力を貼り付け）

判定: <"/" 区切りで表現できる / できない>
```

- [ ] **Step 6: 結果に応じてスペックを更新**

`docs/superpowers/specs/2026-08-09-gas-deploy-actions-design.md` の §10 の表の該当行を「確定」に書き換え、判定内容を反映する。

- [ ] **Step 7: コミット**

```bash
git add scripts/spike-verify.ts docs/superpowers/notes/ docs/superpowers/specs/
git commit -m "docs: Apps Script API の未確定事項を実測して確定"
```

---

## Task 6: `.claspignore` 互換の除外判定

clasp のセマンティクスに合わせる。パターンは**除外**を意味し、`!` 始まりは再包含。同じパスに複数マッチした場合は**最後にマッチしたものが勝つ**。

**Files:**
- Create: `packages/core/src/ignore.ts`
- Create: `packages/core/src/ignore.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: 失敗するテストを書く**

`packages/core/src/ignore.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { DEFAULT_IGNORE, createIgnoreFilter, parseClaspIgnore } from './ignore.js';

describe('createIgnoreFilter', () => {
  it('ignores nothing when there are no patterns', () => {
    const isIgnored = createIgnoreFilter([]);
    expect(isIgnored('Code.js')).toBe(false);
  });

  it('ignores paths matching a pattern', () => {
    const isIgnored = createIgnoreFilter(['node_modules/**']);
    expect(isIgnored('node_modules/lib/index.js')).toBe(true);
    expect(isIgnored('Code.js')).toBe(false);
  });

  it('re-includes paths with a negated pattern, last match winning', () => {
    const isIgnored = createIgnoreFilter(['**/*.js', '!Code.js']);
    expect(isIgnored('other.js')).toBe(true);
    expect(isIgnored('Code.js')).toBe(false);
  });

  it('lets a later ignore pattern override an earlier negation', () => {
    const isIgnored = createIgnoreFilter(['!Code.js', '**/*.js']);
    expect(isIgnored('Code.js')).toBe(true);
  });

  it('matches dotfiles', () => {
    const isIgnored = createIgnoreFilter(['**/.*']);
    expect(isIgnored('.env')).toBe(true);
  });

  it('ignores test files and node_modules by default', () => {
    const isIgnored = createIgnoreFilter(DEFAULT_IGNORE);
    expect(isIgnored('node_modules/x/index.js')).toBe(true);
    expect(isIgnored('Code.test.js')).toBe(true);
    expect(isIgnored('Code.js')).toBe(false);
  });
});

describe('parseClaspIgnore', () => {
  it('drops blank lines and comments and trims whitespace', () => {
    const content = ['# comment', '', '  node_modules/**  ', '!Code.js', '   ', '# trailing'].join('\n');
    expect(parseClaspIgnore(content)).toEqual(['node_modules/**', '!Code.js']);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run packages/core/src/ignore.test.ts`
Expected: FAIL — `Failed to resolve import "./ignore.js"`

- [ ] **Step 3: `ignore.ts` を実装**

```typescript
import picomatch from 'picomatch';

/** `.claspignore` が無い場合に使う既定の除外パターン。 */
export const DEFAULT_IGNORE = [
  'node_modules/**',
  '.git/**',
  '**/*.test.*',
  '**/*.spec.*',
];

/**
 * clasp のセマンティクスで除外判定を行う関数を返す。
 * パターンは除外を意味し、`!` 始まりは再包含。最後にマッチしたパターンが勝つ。
 *
 * @returns 与えられた相対パスを除外すべきなら true
 */
export function createIgnoreFilter(patterns: string[]): (relativePath: string) => boolean {
  const matchers = patterns.map((pattern) => {
    const negated = pattern.startsWith('!');
    const body = negated ? pattern.slice(1) : pattern;
    return { negated, isMatch: picomatch(body, { dot: true }) };
  });

  return (relativePath: string): boolean => {
    let ignored = false;
    for (const matcher of matchers) {
      if (matcher.isMatch(relativePath)) {
        ignored = !matcher.negated;
      }
    }
    return ignored;
  };
}

/** `.claspignore` の内容をパターン配列に変換する。 */
export function parseClaspIgnore(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx vitest run packages/core/src/ignore.test.ts`
Expected: `7 passed`

- [ ] **Step 5: `index.ts` に再エクスポートを追加**

`packages/core/src/index.ts` の末尾に追記:

```typescript
export * from './ignore.js';
```

- [ ] **Step 6: コミット**

```bash
git add packages/core/src/ignore.ts packages/core/src/ignore.test.ts packages/core/src/index.ts
git commit -m "feat(core): .claspignore 互換の除外判定を追加"
```

---

## Task 7: file-collector

**Files:**
- Create: `packages/core/src/file-collector.ts`
- Create: `packages/core/src/file-collector.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: 失敗するテストを書く**

`packages/core/src/file-collector.test.ts`:

```typescript
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectFiles } from './file-collector.js';
import { GasDeployError } from './errors.js';

const MANIFEST = JSON.stringify({ timeZone: 'Asia/Tokyo', exceptionLogging: 'STACKDRIVER' });

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gas-collect-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const full = join(root, relativePath);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  return root;
}

describe('collectFiles', () => {
  it('maps extensions to Apps Script file types and strips the extension from the name', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'Code.js': 'function main() {}',
      'Legacy.gs': 'function legacy() {}',
      'Page.html': '<p>hi</p>',
    });

    const files = await collectFiles(root, []);

    expect(files).toEqual([
      { name: 'Code', type: 'SERVER_JS', source: 'function main() {}' },
      { name: 'Legacy', type: 'SERVER_JS', source: 'function legacy() {}' },
      { name: 'Page', type: 'HTML', source: '<p>hi</p>' },
      { name: 'appsscript', type: 'JSON', source: MANIFEST },
    ]);
  });

  it('represents subdirectories with posix separators in the name', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'ui/Sidebar.html': '<div></div>',
    });

    const files = await collectFiles(root, []);

    expect(files.map((f) => f.name)).toContain('ui/Sidebar');
  });

  it('skips files excluded by the ignore patterns', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'Code.js': 'function main() {}',
      'Code.test.js': 'test stuff',
    });

    const files = await collectFiles(root, ['**/*.test.*']);

    expect(files.map((f) => f.name)).toEqual(['Code', 'appsscript']);
  });

  it('skips files with unsupported extensions', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'Code.js': 'function main() {}',
      'README.md': '# docs',
      'data.csv': 'a,b',
    });

    const files = await collectFiles(root, []);

    expect(files.map((f) => f.name)).toEqual(['Code', 'appsscript']);
  });

  it('skips json files other than the manifest, which Apps Script cannot hold', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'config.json': '{"a":1}',
    });

    const files = await collectFiles(root, []);

    expect(files.map((f) => f.name)).toEqual(['appsscript']);
  });

  it('returns files sorted by name for deterministic output', async () => {
    const root = await makeProject({
      'appsscript.json': MANIFEST,
      'Zebra.js': '',
      'Alpha.js': '',
    });

    const files = await collectFiles(root, []);

    expect(files.map((f) => f.name)).toEqual(['Alpha', 'Zebra', 'appsscript']);
  });

  it('fails before any API call when appsscript.json is missing', async () => {
    const root = await makeProject({ 'Code.js': 'function main() {}' });

    await expect(collectFiles(root, [])).rejects.toThrowError(GasDeployError);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run packages/core/src/file-collector.test.ts`
Expected: FAIL — `Failed to resolve import "./file-collector.js"`

- [ ] **Step 3: `file-collector.ts` を実装**

```typescript
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { GasDeployError } from './errors.js';
import { createIgnoreFilter } from './ignore.js';
import type { FileType, ScriptFile } from './types.js';

const MANIFEST_NAME = 'appsscript';

const EXTENSION_TO_TYPE: Record<string, FileType> = {
  '.js': 'SERVER_JS',
  '.gs': 'SERVER_JS',
  '.html': 'HTML',
  '.json': 'JSON',
};

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, root, out);
    } else if (entry.isFile()) {
      out.push(toPosix(relative(root, full)));
    }
  }
}

/**
 * rootDir 配下を走査し、Apps Script API の files に渡せる形へ変換する。
 * 拡張子は name から取り除かれ、サブディレクトリは "/" 区切りで保持される。
 */
export async function collectFiles(rootDir: string, ignorePatterns: string[]): Promise<ScriptFile[]> {
  const relativePaths: string[] = [];
  await walk(rootDir, rootDir, relativePaths);

  const isIgnored = createIgnoreFilter(ignorePatterns);
  const files: ScriptFile[] = [];

  for (const relativePath of relativePaths) {
    if (isIgnored(relativePath)) continue;

    const extension = extname(relativePath).toLowerCase();
    const type = EXTENSION_TO_TYPE[extension];
    if (!type) continue;

    const name = relativePath.slice(0, relativePath.length - extension.length);

    // Apps Script が保持できる JSON はマニフェストのみ。
    if (type === 'JSON' && name !== MANIFEST_NAME) continue;

    const source = await readFile(join(rootDir, relativePath), 'utf8');
    files.push({ name, type, source });
  }

  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const hasManifest = files.some((file) => file.name === MANIFEST_NAME && file.type === 'JSON');
  if (!hasManifest) {
    throw new GasDeployError(`${rootDir} に appsscript.json が見つかりません`, {
      nextSteps: [
        'root-dir が正しいディレクトリを指しているか確認してください',
        'ビルド出力に appsscript.json をコピーする手順が抜けていないか確認してください',
        'appsscript.json が .claspignore や ignore 設定で除外されていないか確認してください',
      ],
    });
  }

  return files;
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx vitest run packages/core/src/file-collector.test.ts`
Expected: `7 passed`

- [ ] **Step 5: `index.ts` に再エクスポートを追加**

`packages/core/src/index.ts` の末尾に追記:

```typescript
export * from './file-collector.js';
```

- [ ] **Step 6: コミット**

```bash
git add packages/core/src/file-collector.ts packages/core/src/file-collector.test.ts packages/core/src/index.ts
git commit -m "feat(core): rootDir を走査して ScriptFile[] に変換する収集処理を追加"
```

---

## Task 8: differ

改行コードの差異で偽差分が出ると、バージョン番号とデプロイ数という有限資源を無駄に消費する。正規化はそのための処理である。

**Files:**
- Create: `packages/core/src/differ.ts`
- Create: `packages/core/src/differ.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: 失敗するテストを書く**

`packages/core/src/differ.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { diffFiles, hasChanges, normalizeSource } from './differ.js';
import type { ScriptFile } from './types.js';

const file = (name: string, source: string): ScriptFile => ({ name, type: 'SERVER_JS', source });

describe('normalizeSource', () => {
  it('converts CRLF to LF', () => {
    expect(normalizeSource('a\r\nb')).toBe('a\nb\n');
  });

  it('collapses trailing newlines to exactly one', () => {
    expect(normalizeSource('a\n\n\n')).toBe('a\n');
    expect(normalizeSource('a')).toBe('a\n');
  });
});

describe('diffFiles', () => {
  it('reports no changes when contents match', () => {
    const local = [file('Code', 'x')];
    const remote = [file('Code', 'x')];
    expect(diffFiles(local, remote)).toEqual({ added: [], modified: [], deleted: [] });
  });

  it('treats a CRLF-only difference as no change', () => {
    const local = [file('Code', 'a\r\nb')];
    const remote = [file('Code', 'a\nb\n')];
    expect(hasChanges(diffFiles(local, remote))).toBe(false);
  });

  it('reports added, modified and deleted files', () => {
    const local = [file('Code', 'new'), file('Fresh', 'x')];
    const remote = [file('Code', 'old'), file('Gone', 'x')];

    expect(diffFiles(local, remote)).toEqual({
      added: ['Fresh'],
      modified: ['Code'],
      deleted: ['Gone'],
    });
  });

  it('treats a type change on the same name as add plus delete', () => {
    const local: ScriptFile[] = [{ name: 'Page', type: 'HTML', source: 'x' }];
    const remote: ScriptFile[] = [{ name: 'Page', type: 'SERVER_JS', source: 'x' }];

    expect(diffFiles(local, remote)).toEqual({
      added: ['Page'],
      modified: [],
      deleted: ['Page'],
    });
  });

  it('sorts each list for stable output', () => {
    const local = [file('Zebra', 'x'), file('Alpha', 'x')];
    const remote: ScriptFile[] = [];
    expect(diffFiles(local, remote).added).toEqual(['Alpha', 'Zebra']);
  });
});

describe('hasChanges', () => {
  it('is false only when every list is empty', () => {
    expect(hasChanges({ added: [], modified: [], deleted: [] })).toBe(false);
    expect(hasChanges({ added: ['a'], modified: [], deleted: [] })).toBe(true);
    expect(hasChanges({ added: [], modified: ['a'], deleted: [] })).toBe(true);
    expect(hasChanges({ added: [], modified: [], deleted: ['a'] })).toBe(true);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run packages/core/src/differ.test.ts`
Expected: FAIL — `Failed to resolve import "./differ.js"`

- [ ] **Step 3: `differ.ts` を実装**

```typescript
import type { FileDiff, ScriptFile } from './types.js';

// ファイル名に現れ得ない文字を区切りに使う。空白だと "My File" のような名前で壊れる。
const KEY_SEPARATOR = '\u0000';

/** 改行コードの差異による偽差分を防ぐ。 */
export function normalizeSource(source: string): string {
  return source.replace(/\r\n/g, '\n').replace(/\n+$/, '') + '\n';
}

function keyOf(file: ScriptFile): string {
  return `${file.name}${KEY_SEPARATOR}${file.type}`;
}

function nameOf(key: string): string {
  return key.split(KEY_SEPARATOR)[0] ?? '';
}

function toMap(files: ScriptFile[]): Map<string, string> {
  return new Map(files.map((file) => [keyOf(file), normalizeSource(file.source)]));
}

/** name + type をキーに差分を求める。type が変わった場合は追加＋削除として扱う。 */
export function diffFiles(local: ScriptFile[], remote: ScriptFile[]): FileDiff {
  const localMap = toMap(local);
  const remoteMap = toMap(remote);

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const [key, source] of localMap) {
    const remoteSource = remoteMap.get(key);
    if (remoteSource === undefined) {
      added.push(nameOf(key));
    } else if (remoteSource !== source) {
      modified.push(nameOf(key));
    }
  }

  for (const key of remoteMap.keys()) {
    if (!localMap.has(key)) {
      deleted.push(nameOf(key));
    }
  }

  const sort = (list: string[]): string[] => list.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return { added: sort(added), modified: sort(modified), deleted: sort(deleted) };
}

export function hasChanges(diff: FileDiff): boolean {
  return diff.added.length + diff.modified.length + diff.deleted.length > 0;
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx vitest run packages/core/src/differ.test.ts`
Expected: `8 passed`

- [ ] **Step 5: `index.ts` に再エクスポートを追加**

`packages/core/src/index.ts` の末尾に追記:

```typescript
export * from './differ.js';
```

- [ ] **Step 6: コミット**

```bash
git add packages/core/src/differ.ts packages/core/src/differ.test.ts packages/core/src/index.ts
git commit -m "feat(core): 改行正規化つきの差分計算を追加"
```

---

## Task 9: Apps Script API クライアント

リトライをここに閉じ込めることで、`deployer` はリトライを知らずに済む。

> **スペックからの意図的な逸脱:** スペック §8 では MSW を使うと記述したが、`fetch` を引数で差し替える設計にしたため、スタブ関数で同等の検証ができる。依存を1つ減らすため MSW は導入しない。

**Files:**
- Create: `packages/core/src/api-client.ts`
- Create: `packages/core/src/api-client.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: 失敗するテストを書く**

`packages/core/src/api-client.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { AppsScriptClient } from './api-client.js';
import { GasDeployError } from './errors.js';

const SCRIPT_ID = 'script-abc';

function clientWith(responses: Array<{ status: number; body: string }>) {
  let index = 0;
  const fetchImpl = vi.fn(async () => {
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return new Response(response.body, { status: response.status });
  });
  const sleep = vi.fn(async () => undefined);
  const client = new AppsScriptClient('at-123', { fetch: fetchImpl as unknown as typeof fetch, sleep });
  return { client, fetchImpl, sleep };
}

describe('AppsScriptClient.getContent', () => {
  it('returns the files array', async () => {
    const { client } = clientWith([
      { status: 200, body: JSON.stringify({ files: [{ name: 'Code', type: 'SERVER_JS', source: 'x' }] }) },
    ]);

    await expect(client.getContent(SCRIPT_ID)).resolves.toEqual([
      { name: 'Code', type: 'SERVER_JS', source: 'x' },
    ]);
  });

  it('returns an empty array when the project has no files', async () => {
    const { client } = clientWith([{ status: 200, body: '{}' }]);
    await expect(client.getContent(SCRIPT_ID)).resolves.toEqual([]);
  });

  it('sends the bearer token', async () => {
    const { client, fetchImpl } = clientWith([{ status: 200, body: '{}' }]);
    await client.getContent(SCRIPT_ID);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://script.googleapis.com/v1/projects/script-abc/content');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer at-123');
  });
});

describe('AppsScriptClient retry behaviour', () => {
  it('retries on 429 and succeeds', async () => {
    const { client, fetchImpl } = clientWith([
      { status: 429, body: 'rate limited' },
      { status: 200, body: JSON.stringify({ files: [] }) },
    ]);

    await expect(client.getContent(SCRIPT_ID)).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries on 500 with exponential backoff delays', async () => {
    const { client, sleep } = clientWith([
      { status: 500, body: 'boom' },
      { status: 500, body: 'boom' },
      { status: 200, body: '{}' },
    ]);

    await client.getContent(SCRIPT_ID);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
  });

  it('gives up after the retry budget and throws the classified error', async () => {
    const { client, fetchImpl } = clientWith([{ status: 500, body: 'boom' }]);

    await expect(client.getContent(SCRIPT_ID)).rejects.toThrowError(GasDeployError);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('does not retry on 403', async () => {
    const { client, fetchImpl } = clientWith([{ status: 403, body: 'The caller does not have permission' }]);

    await expect(client.getContent(SCRIPT_ID)).rejects.toThrowError(GasDeployError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('AppsScriptClient write methods', () => {
  it('PUTs the files to the content endpoint', async () => {
    const { client, fetchImpl } = clientWith([{ status: 200, body: '{}' }]);
    await client.updateContent(SCRIPT_ID, [{ name: 'Code', type: 'SERVER_JS', source: 'x' }]);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://script.googleapis.com/v1/projects/script-abc/content');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      files: [{ name: 'Code', type: 'SERVER_JS', source: 'x' }],
    });
  });

  it('returns the version number from createVersion', async () => {
    const { client } = clientWith([{ status: 200, body: JSON.stringify({ versionNumber: 7 }) }]);
    await expect(client.createVersion(SCRIPT_ID, 'ci-abc1234-5')).resolves.toBe(7);
  });

  it('fails when createVersion returns no version number', async () => {
    const { client } = clientWith([{ status: 200, body: '{}' }]);
    await expect(client.createVersion(SCRIPT_ID, 'desc')).rejects.toThrowError(GasDeployError);
  });

  it('extracts the web app url from deployment entry points', async () => {
    const { client } = clientWith([
      {
        status: 200,
        body: JSON.stringify({
          deploymentId: 'dep-1',
          deploymentConfig: { versionNumber: 7, description: 'desc' },
          entryPoints: [{ entryPointType: 'WEB_APP', webApp: { url: 'https://script.google.com/macros/s/dep-1/exec' } }],
        }),
      },
    ]);

    await expect(client.updateDeployment(SCRIPT_ID, 'dep-1', 7, 'desc')).resolves.toEqual({
      deploymentId: 'dep-1',
      versionNumber: 7,
      description: 'desc',
      webAppUrl: 'https://script.google.com/macros/s/dep-1/exec',
    });
  });

  it('sends manifestFileName appsscript when updating a deployment', async () => {
    const { client, fetchImpl } = clientWith([{ status: 200, body: JSON.stringify({ deploymentId: 'dep-1' }) }]);
    await client.updateDeployment(SCRIPT_ID, 'dep-1', 7, 'desc');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://script.googleapis.com/v1/projects/script-abc/deployments/dep-1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      deploymentConfig: {
        scriptId: SCRIPT_ID,
        versionNumber: 7,
        manifestFileName: 'appsscript',
        description: 'desc',
      },
    });
  });

  it('lists deployments', async () => {
    const { client } = clientWith([
      { status: 200, body: JSON.stringify({ deployments: [{ deploymentId: 'a' }, { deploymentId: 'b' }] }) },
    ]);
    await expect(client.listDeployments(SCRIPT_ID)).resolves.toHaveLength(2);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run packages/core/src/api-client.test.ts`
Expected: FAIL — `Failed to resolve import "./api-client.js"`

- [ ] **Step 3: `api-client.ts` を実装**

```typescript
import { GasDeployError, classifyApiError } from './errors.js';
import type { Deployment, ScriptFile } from './types.js';

const BASE_URL = 'https://script.googleapis.com/v1';
const MANIFEST_FILE_NAME = 'appsscript';
const DEFAULT_MAX_RETRIES = 3;

export interface ClientOptions {
  fetch?: typeof fetch;
  maxRetries?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface RawDeployment {
  deploymentId?: string;
  deploymentConfig?: { versionNumber?: number; description?: string };
  entryPoints?: Array<{ entryPointType?: string; webApp?: { url?: string } }>;
}

function toDeployment(raw: RawDeployment): Deployment {
  const webAppUrl = raw.entryPoints?.find((entry) => entry.entryPointType === 'WEB_APP')?.webApp?.url;
  const deployment: Deployment = { deploymentId: raw.deploymentId ?? '' };
  if (raw.deploymentConfig?.versionNumber !== undefined) {
    deployment.versionNumber = raw.deploymentConfig.versionNumber;
  }
  if (raw.deploymentConfig?.description !== undefined) {
    deployment.description = raw.deploymentConfig.description;
  }
  if (webAppUrl !== undefined) {
    deployment.webAppUrl = webAppUrl;
  }
  return deployment;
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export class AppsScriptClient {
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly accessToken: string,
    options: ClientOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    let lastError: GasDeployError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const response = await this.fetchImpl(`${BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      const text = await response.text();

      if (response.ok) {
        return text.length > 0 ? JSON.parse(text) : {};
      }

      lastError = classifyApiError(response.status, text);
      if (!isRetryable(response.status)) {
        throw lastError;
      }
      if (attempt < this.maxRetries) {
        await this.sleep(2 ** attempt * 1000);
      }
    }

    throw lastError ?? new GasDeployError('Apps Script API へのリクエストが失敗しました');
  }

  async getContent(scriptId: string): Promise<ScriptFile[]> {
    const result = (await this.request('GET', `/projects/${scriptId}/content`)) as { files?: ScriptFile[] };
    return result.files ?? [];
  }

  async updateContent(scriptId: string, files: ScriptFile[]): Promise<void> {
    await this.request('PUT', `/projects/${scriptId}/content`, { files });
  }

  async createVersion(scriptId: string, description: string): Promise<number> {
    const result = (await this.request('POST', `/projects/${scriptId}/versions`, { description })) as {
      versionNumber?: number;
    };
    if (result.versionNumber === undefined) {
      throw new GasDeployError('バージョン作成の応答に versionNumber が含まれていません', {
        nextSteps: ['しばらく待って再実行してください'],
      });
    }
    return result.versionNumber;
  }

  async listDeployments(scriptId: string): Promise<Deployment[]> {
    const result = (await this.request('GET', `/projects/${scriptId}/deployments`)) as {
      deployments?: RawDeployment[];
    };
    return (result.deployments ?? []).map(toDeployment);
  }

  async updateDeployment(
    scriptId: string,
    deploymentId: string,
    versionNumber: number,
    description: string,
  ): Promise<Deployment> {
    const result = await this.request('PUT', `/projects/${scriptId}/deployments/${deploymentId}`, {
      deploymentConfig: {
        scriptId,
        versionNumber,
        manifestFileName: MANIFEST_FILE_NAME,
        description,
      },
    });
    return toDeployment(result as RawDeployment);
  }

  async createDeployment(scriptId: string, versionNumber: number, description: string): Promise<Deployment> {
    const result = await this.request('POST', `/projects/${scriptId}/deployments`, {
      versionNumber,
      manifestFileName: MANIFEST_FILE_NAME,
      description,
    });
    return toDeployment(result as RawDeployment);
  }
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx vitest run packages/core/src/api-client.test.ts`
Expected: `12 passed`

- [ ] **Step 5: `index.ts` に再エクスポートを追加**

`packages/core/src/index.ts` の末尾に追記:

```typescript
export * from './api-client.js';
```

- [ ] **Step 6: コミット**

```bash
git add packages/core/src/api-client.ts packages/core/src/api-client.test.ts packages/core/src/index.ts
git commit -m "feat(core): リトライ込みの Apps Script API クライアントを追加"
```

---

## Task 10: deployer オーケストレーション

`deploymentId` 未指定時の警告が、本番事故（Web アプリの URL 変化）を防ぐ唯一の防波堤である。

**Files:**
- Create: `packages/core/src/deployer.ts`
- Create: `packages/core/src/deployer.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: 失敗するテストを書く**

`packages/core/src/deployer.test.ts`:

```typescript
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEPLOYMENT_COUNT_WARN_THRESHOLD, deploy } from './deployer.js';
import type { AppsScriptClient } from './api-client.js';
import type { Deployment, ScriptFile } from './types.js';

const MANIFEST = JSON.stringify({ timeZone: 'Asia/Tokyo' });

async function makeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gas-deploy-'));
  await writeFile(join(root, 'appsscript.json'), MANIFEST, 'utf8');
  await writeFile(join(root, 'Code.js'), 'function main() {}', 'utf8');
  return root;
}

function fakeClient(overrides: Partial<Record<keyof AppsScriptClient, unknown>> = {}) {
  const deployment: Deployment = { deploymentId: 'dep-1', versionNumber: 7, webAppUrl: 'https://example.com/exec' };
  const client = {
    getContent: vi.fn(async (): Promise<ScriptFile[]> => []),
    updateContent: vi.fn(async () => undefined),
    createVersion: vi.fn(async () => 7),
    updateDeployment: vi.fn(async () => deployment),
    createDeployment: vi.fn(async () => deployment),
    listDeployments: vi.fn(async () => [deployment]),
    ...overrides,
  };
  return client as unknown as AppsScriptClient & typeof client;
}

function baseOptions(rootDir: string) {
  return {
    scriptId: 'script-abc',
    rootDir,
    ignore: [],
    dryRun: false,
    createVersion: true,
    description: 'ci-abc1234-5',
  };
}

describe('deploy', () => {
  it('skips every write when there is no difference', async () => {
    const rootDir = await makeProject();
    const client = fakeClient({
      getContent: vi.fn(async () => [
        { name: 'Code', type: 'SERVER_JS', source: 'function main() {}' },
        { name: 'appsscript', type: 'JSON', source: MANIFEST },
      ]),
    });

    const result = await deploy(client, baseOptions(rootDir));

    expect(result.changed).toBe(false);
    expect(client.updateContent).not.toHaveBeenCalled();
    expect(client.createVersion).not.toHaveBeenCalled();
  });

  it('stops after computing the diff when dryRun is set', async () => {
    const rootDir = await makeProject();
    const client = fakeClient();

    const result = await deploy(client, { ...baseOptions(rootDir), dryRun: true });

    expect(result.changed).toBe(true);
    expect(result.diff.added).toEqual(['Code', 'appsscript']);
    expect(client.updateContent).not.toHaveBeenCalled();
  });

  it('updates the existing deployment when deploymentId is given', async () => {
    const rootDir = await makeProject();
    const client = fakeClient();

    const result = await deploy(client, { ...baseOptions(rootDir), deploymentId: 'dep-1' });

    expect(client.updateDeployment).toHaveBeenCalledWith('script-abc', 'dep-1', 7, 'ci-abc1234-5');
    expect(client.createDeployment).not.toHaveBeenCalled();
    expect(result.webAppUrl).toBe('https://example.com/exec');
    expect(result.versionNumber).toBe(7);
  });

  it('creates a new deployment when deploymentId is absent', async () => {
    const rootDir = await makeProject();
    const client = fakeClient();

    await deploy(client, baseOptions(rootDir));

    expect(client.createDeployment).toHaveBeenCalledWith('script-abc', 7, 'ci-abc1234-5');
    expect(client.updateDeployment).not.toHaveBeenCalled();
  });

  it('warns that the web app url will change when a webapp has no deploymentId', async () => {
    const rootDir = await makeProject();
    const client = fakeClient();

    const result = await deploy(client, { ...baseOptions(rootDir), projectType: 'webapp' });

    expect(result.warnings.join('\n')).toContain('URL');
  });

  it('does not warn about the url for a standalone project', async () => {
    const rootDir = await makeProject();
    const client = fakeClient();

    const result = await deploy(client, { ...baseOptions(rootDir), projectType: 'standalone' });

    expect(result.warnings.join('\n')).not.toContain('URL');
  });

  it('stops after updateContent when createVersion is false', async () => {
    const rootDir = await makeProject();
    const client = fakeClient();

    const result = await deploy(client, { ...baseOptions(rootDir), createVersion: false });

    expect(client.updateContent).toHaveBeenCalled();
    expect(client.createVersion).not.toHaveBeenCalled();
    expect(result.versionNumber).toBeUndefined();
  });

  it('warns when the deployment count reaches the threshold', async () => {
    const rootDir = await makeProject();
    const many = Array.from({ length: DEPLOYMENT_COUNT_WARN_THRESHOLD }, (_, i) => ({ deploymentId: `dep-${i}` }));
    const client = fakeClient({ listDeployments: vi.fn(async () => many) });

    const result = await deploy(client, baseOptions(rootDir));

    expect(result.warnings.join('\n')).toContain('デプロイ数');
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `npx vitest run packages/core/src/deployer.test.ts`
Expected: FAIL — `Failed to resolve import "./deployer.js"`

- [ ] **Step 3: `deployer.ts` を実装**

```typescript
import type { AppsScriptClient } from './api-client.js';
import { diffFiles, hasChanges } from './differ.js';
import { collectFiles } from './file-collector.js';
import type { FileDiff, ProjectType } from './types.js';

/**
 * 「アクティブなデプロイは20個まで」はコミュニティ報告ベースで公式ドキュメントに記載がない。
 * 上限に達する前に気づけるよう、少し手前で警告する。
 */
export const DEPLOYMENT_COUNT_WARN_THRESHOLD = 18;

export interface DeployOptions {
  scriptId: string;
  rootDir: string;
  ignore: string[];
  deploymentId?: string;
  projectType?: ProjectType;
  dryRun: boolean;
  createVersion: boolean;
  description: string;
}

export interface DeployResult {
  changed: boolean;
  diff: FileDiff;
  warnings: string[];
  versionNumber?: number;
  deploymentId?: string;
  webAppUrl?: string;
}

const URL_CHANGE_WARNING =
  'deployment-id が指定されていません。新しいデプロイが作成され、Web アプリの URL が変わります。既存の URL を維持するには deployment-id を指定してください';

export async function deploy(client: AppsScriptClient, options: DeployOptions): Promise<DeployResult> {
  const warnings: string[] = [];

  const needsStableUrl = options.projectType === 'webapp' || options.projectType === 'addon';
  if (needsStableUrl && !options.deploymentId) {
    warnings.push(URL_CHANGE_WARNING);
  }

  const local = await collectFiles(options.rootDir, options.ignore);
  const remote = await client.getContent(options.scriptId);
  const diff = diffFiles(local, remote);

  if (!hasChanges(diff)) {
    return { changed: false, diff, warnings };
  }

  if (options.dryRun) {
    return { changed: true, diff, warnings };
  }

  await client.updateContent(options.scriptId, local);

  if (!options.createVersion) {
    return { changed: true, diff, warnings };
  }

  const versionNumber = await client.createVersion(options.scriptId, options.description);

  const deployment = options.deploymentId
    ? await client.updateDeployment(options.scriptId, options.deploymentId, versionNumber, options.description)
    : await client.createDeployment(options.scriptId, versionNumber, options.description);

  const deployments = await client.listDeployments(options.scriptId);
  if (deployments.length >= DEPLOYMENT_COUNT_WARN_THRESHOLD) {
    warnings.push(
      `デプロイ数が ${deployments.length} 件に達しています。Apps Script にはデプロイ数の上限があるため、不要なデプロイを削除してください`,
    );
  }

  const result: DeployResult = { changed: true, diff, warnings, versionNumber, deploymentId: deployment.deploymentId };
  if (deployment.webAppUrl !== undefined) {
    result.webAppUrl = deployment.webAppUrl;
  }
  return result;
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `npx vitest run packages/core/src/deployer.test.ts`
Expected: `8 passed`

- [ ] **Step 5: `index.ts` に再エクスポートを追加**

`packages/core/src/index.ts` の末尾に追記:

```typescript
export * from './deployer.js';
```

- [ ] **Step 6: 全テストと型チェックを実行**

Run: `npm test && npm run typecheck`
Expected: 全テスト PASS、型エラーなし

- [ ] **Step 7: コミット**

```bash
git add packages/core/src/deployer.ts packages/core/src/deployer.test.ts packages/core/src/index.ts
git commit -m "feat(core): デプロイ手順のオーケストレーションを追加"
```

---

## Task 11: GitHub Actions アダプタ

**Files:**
- Create: `deploy/package.json`
- Create: `deploy/tsconfig.json`
- Create: `deploy/action.yml`
- Create: `deploy/src/summary.ts`
- Create: `deploy/src/summary.test.ts`
- Create: `deploy/src/main.ts`
- Create: `scripts/build.mjs`
- Modify: `package.json`（workspaces に `deploy` を追加）

- [ ] **Step 1: workspaces に `deploy` を追加**

ルート `package.json` の `workspaces` を次のように変更する:

```json
  "workspaces": ["packages/*", "deploy"],
```

- [ ] **Step 2: `deploy/package.json` を作成**

```json
{
  "name": "@gas-deploy/action",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@actions/core": "^1.11.1",
    "@gas-deploy/core": "0.1.0"
  }
}
```

- [ ] **Step 3: `deploy/tsconfig.json` を作成**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./build"
  },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../packages/core" }]
}
```

- [ ] **Step 4: ルートの `tsconfig.json` に `deploy` への参照を追加**

`tsc --build` が `deploy` を対象に含めるようにする。ファイル全体を次の内容で置き換える:

```json
{
  "files": [],
  "references": [{ "path": "./packages/core" }, { "path": "./deploy" }]
}
```

- [ ] **Step 5: サマリ生成の失敗するテストを書く**

`deploy/src/summary.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { renderSummary } from './summary.js';

describe('renderSummary', () => {
  it('reports that nothing changed', () => {
    const text = renderSummary({
      changed: false,
      diff: { added: [], modified: [], deleted: [] },
      warnings: [],
    });
    expect(text).toContain('変更はありません');
  });

  it('lists added, modified and deleted files', () => {
    const text = renderSummary({
      changed: true,
      diff: { added: ['New'], modified: ['Code'], deleted: ['Old'] },
      warnings: [],
    });
    expect(text).toContain('追加 (1)');
    expect(text).toContain('New');
    expect(text).toContain('変更 (1)');
    expect(text).toContain('Code');
    expect(text).toContain('削除 (1)');
    expect(text).toContain('Old');
  });

  it('includes the version, deployment id and web app url', () => {
    const text = renderSummary({
      changed: true,
      diff: { added: ['New'], modified: [], deleted: [] },
      warnings: [],
      versionNumber: 7,
      deploymentId: 'dep-1',
      webAppUrl: 'https://example.com/exec',
    });
    expect(text).toContain('7');
    expect(text).toContain('dep-1');
    expect(text).toContain('https://example.com/exec');
  });

  it('renders warnings', () => {
    const text = renderSummary({
      changed: true,
      diff: { added: ['New'], modified: [], deleted: [] },
      warnings: ['気をつけて'],
    });
    expect(text).toContain('気をつけて');
  });
});
```

- [ ] **Step 6: テストを実行して失敗を確認**

Run: `npx vitest run deploy/src/summary.test.ts`
Expected: FAIL — `Failed to resolve import "./summary.js"`

- [ ] **Step 7: `deploy/src/summary.ts` を実装**

```typescript
import type { DeployResult } from '@gas-deploy/core';

function section(title: string, items: string[]): string[] {
  if (items.length === 0) return [];
  return [`### ${title} (${items.length})`, '', ...items.map((item) => `- \`${item}\``), ''];
}

export function renderSummary(result: DeployResult): string {
  const lines: string[] = ['## GAS デプロイ結果', ''];

  if (!result.changed) {
    lines.push('差分がないため、変更はありません。', '');
  } else {
    lines.push(
      ...section('追加', result.diff.added),
      ...section('変更', result.diff.modified),
      ...section('削除', result.diff.deleted),
    );
  }

  const facts: string[] = [];
  if (result.versionNumber !== undefined) facts.push(`- バージョン: \`${result.versionNumber}\``);
  if (result.deploymentId !== undefined) facts.push(`- デプロイ ID: \`${result.deploymentId}\``);
  if (result.webAppUrl !== undefined) facts.push(`- Web アプリ URL: ${result.webAppUrl}`);
  if (facts.length > 0) lines.push(...facts, '');

  if (result.warnings.length > 0) {
    lines.push('### ⚠️ 警告', '', ...result.warnings.map((warning) => `- ${warning}`), '');
  }

  return lines.join('\n');
}
```

- [ ] **Step 8: テストを実行して成功を確認**

Run: `npx vitest run deploy/src/summary.test.ts`
Expected: `4 passed`

- [ ] **Step 9: `deploy/action.yml` を作成**

```yaml
name: 'Deploy Google Apps Script'
description: 'Apps Script API を直接呼び出して Google Apps Script プロジェクトをデプロイします'
branding:
  icon: 'upload-cloud'
  color: 'yellow'

inputs:
  credentials:
    description: 'clasp の .clasprc.json、または {client_id, client_secret, refresh_token} の JSON'
    required: true
  script-id:
    description: 'デプロイ先の scriptId'
    required: true
  root-dir:
    description: 'アップロードするファイルのルートディレクトリ'
    required: false
    default: '.'
  deployment-id:
    description: '更新する既存デプロイの ID。省略すると新規デプロイが作成され Web アプリの URL が変わります'
    required: false
  project-type:
    description: 'webapp | addon | bound | standalone'
    required: false
    default: 'standalone'
  ignore:
    description: '除外パターン（改行区切り）。省略時は .claspignore、それも無ければ既定値を使います'
    required: false
  dry-run:
    description: '差分の表示のみ行い、書き込みを行いません'
    required: false
    default: 'false'
  create-version:
    description: 'バージョン作成とデプロイを行うかどうか'
    required: false
    default: 'true'
  description:
    description: 'バージョンの説明。省略時は ci-<sha7>-<run_number>'
    required: false

outputs:
  changed:
    description: '差分があったかどうか（true / false）'
  version-number:
    description: '作成されたバージョン番号'
  deployment-id:
    description: '更新または作成されたデプロイ ID'
  web-app-url:
    description: 'Web アプリの URL（該当する場合）'
  summary:
    description: '人間可読のサマリ（Markdown）'

runs:
  using: 'node24'
  main: 'dist/index.js'
```

- [ ] **Step 10: `deploy/src/main.ts` を実装**

```typescript
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as core from '@actions/core';
import {
  AppsScriptClient,
  DEFAULT_IGNORE,
  GasDeployError,
  deploy,
  getAccessToken,
  parseClaspIgnore,
  parseCredentials,
  type ProjectType,
} from '@gas-deploy/core';
import { renderSummary } from './summary.js';

const PROJECT_TYPES: ProjectType[] = ['webapp', 'addon', 'bound', 'standalone'];

function parseProjectType(raw: string): ProjectType {
  if ((PROJECT_TYPES as string[]).includes(raw)) {
    return raw as ProjectType;
  }
  throw new GasDeployError(`project-type の値が不正です: ${raw}`, {
    nextSteps: [`次のいずれかを指定してください: ${PROJECT_TYPES.join(' | ')}`],
  });
}

function defaultDescription(): string {
  const sha = (process.env['GITHUB_SHA'] ?? 'local').slice(0, 7);
  const runNumber = process.env['GITHUB_RUN_NUMBER'] ?? '0';
  return `ci-${sha}-${runNumber}`;
}

async function resolveIgnorePatterns(rootDir: string, rawInput: string): Promise<string[]> {
  const fromInput = parseClaspIgnore(rawInput);
  if (fromInput.length > 0) {
    return fromInput;
  }
  try {
    const content = await readFile(join(rootDir, '.claspignore'), 'utf8');
    return parseClaspIgnore(content);
  } catch {
    return DEFAULT_IGNORE;
  }
}

async function run(): Promise<void> {
  const credentials = parseCredentials(core.getInput('credentials', { required: true }));
  core.setSecret(credentials.clientSecret);
  core.setSecret(credentials.refreshToken);

  const accessToken = await getAccessToken(credentials);
  core.setSecret(accessToken);

  const rootDir = core.getInput('root-dir') || '.';
  const deploymentId = core.getInput('deployment-id');
  const descriptionInput = core.getInput('description');

  const result = await deploy(new AppsScriptClient(accessToken), {
    scriptId: core.getInput('script-id', { required: true }),
    rootDir,
    ignore: await resolveIgnorePatterns(rootDir, core.getInput('ignore')),
    ...(deploymentId ? { deploymentId } : {}),
    projectType: parseProjectType(core.getInput('project-type') || 'standalone'),
    dryRun: core.getBooleanInput('dry-run'),
    createVersion: core.getBooleanInput('create-version'),
    description: descriptionInput || defaultDescription(),
  });

  for (const warning of result.warnings) {
    core.warning(warning);
  }

  const summary = renderSummary(result);
  core.setOutput('changed', String(result.changed));
  core.setOutput('version-number', result.versionNumber ?? '');
  core.setOutput('deployment-id', result.deploymentId ?? '');
  core.setOutput('web-app-url', result.webAppUrl ?? '');
  core.setOutput('summary', summary);

  await core.summary.addRaw(summary).write();
}

// esbuild の cjs 出力はトップレベル await を扱えないため、必ず関数の中で await する。
void run().catch((error: unknown) => {
  if (error instanceof GasDeployError) {
    core.setFailed(error.format());
  } else {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
});
```

- [ ] **Step 11: `scripts/build.mjs` を作成**

```javascript
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['deploy/src/main.ts'],
  outfile: 'deploy/dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  legalComments: 'none',
});

console.log('built deploy/dist/index.js');
```

- [ ] **Step 12: 依存をインストールしてビルド**

Run: `npm install && npm run build`
Expected: `built deploy/dist/index.js` と表示され、`deploy/dist/index.js` が生成される

- [ ] **Step 13: 全テストと型チェックを実行**

Run: `npm test && npm run typecheck`
Expected: 全テスト PASS、型エラーなし

- [ ] **Step 14: コミット**

```bash
git add package.json package-lock.json deploy/ scripts/build.mjs
git commit -m "feat(action): deploy アクションの GHA アダプタとバンドル設定を追加"
```

---

## Task 12: CI ワークフロー

`dist/` をコミットする方式の定番の事故は「ソースだけ直して dist を忘れる」である。これを CI で機械的に落とす。

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: ワークフローを作成**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Test
        run: npm test

      - name: Build
        run: npm run build

      - name: Verify dist is in sync
        run: |
          if ! git diff --exit-code -- deploy/dist; then
            echo "::error::deploy/dist がソースと同期していません。'npm run build' を実行してコミットしてください"
            exit 1
          fi
```

- [ ] **Step 2: ローカルで同じ検証を再現**

Run: `npm ci && npm run typecheck && npm test && npm run build && git diff --exit-code -- deploy/dist`
Expected: すべて成功し、`git diff` が差分なしで終了

- [ ] **Step 3: `runs.using` の値が有効かを確認**

`deploy/action.yml` の `using: 'node24'` が実行環境で受理されない場合、GitHub Actions は `Unexpected value 'node24'` というエラーを出す。この確認は Task 14 の手動デプロイ検証で行う。**エラーが出た場合は `node20` に変更し、`scripts/build.mjs` の `target` はそのまま `node20` を維持する。**

- [ ] **Step 4: コミット**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: typecheck / test / dist 同期チェックのワークフローを追加"
```

---

## Task 13: clasp 互換ゴールデンテスト

案 A（API 直叩き）の最大のリスクは「clasp 互換を自前で保証する責任」である。ここで固定する。

clasp を実行するには認証とネットワークが必要なため、**clasp の出力を一度だけ記録した fixture** と照合する方式にする。fixture の再生成手順を併せて残すことで、clasp 側の変更に追従できるようにする。

**Files:**
- Create: `tests/fixtures/sample-project/appsscript.json`
- Create: `tests/fixtures/sample-project/Code.js`
- Create: `tests/fixtures/sample-project/Legacy.gs`
- Create: `tests/fixtures/sample-project/ui/Sidebar.html`
- Create: `tests/fixtures/sample-project/.claspignore`
- Create: `tests/fixtures/sample-project/ignored.txt`
- Create: `tests/fixtures/sample-project/Code.test.js`
- Create: `tests/fixtures/sample-project.expected.json`
- Create: `tests/clasp-compat.test.ts`
- Create: `tests/fixtures/README.md`

- [ ] **Step 1: fixture プロジェクトを作成**

`tests/fixtures/sample-project/appsscript.json`:

```json
{
  "timeZone": "Asia/Tokyo",
  "dependencies": {},
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8"
}
```

`tests/fixtures/sample-project/Code.js`:

```javascript
function main() {
  Logger.log('hello');
}
```

`tests/fixtures/sample-project/Legacy.gs`:

```javascript
function legacy() {
  Logger.log('legacy');
}
```

`tests/fixtures/sample-project/ui/Sidebar.html`:

```html
<div class="sidebar">Sidebar</div>
```

`tests/fixtures/sample-project/.claspignore`:

```
**/*.test.js
ignored.txt
```

`tests/fixtures/sample-project/ignored.txt`:

```
this file must never be pushed
```

`tests/fixtures/sample-project/Code.test.js`:

```javascript
// この単体テストは push されてはならない
```

- [ ] **Step 2: 期待値 fixture を作成**

`tests/fixtures/sample-project.expected.json`:

```json
[
  {
    "name": "Code",
    "type": "SERVER_JS"
  },
  {
    "name": "Legacy",
    "type": "SERVER_JS"
  },
  {
    "name": "appsscript",
    "type": "JSON"
  },
  {
    "name": "ui/Sidebar",
    "type": "HTML"
  }
]
```

- [ ] **Step 3: 失敗するテストを書く**

`tests/clasp-compat.test.ts`:

```typescript
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectFiles, parseClaspIgnore } from '../packages/core/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = join(here, 'fixtures', 'sample-project');

describe('clasp compatibility', () => {
  it('produces the same name/type set that clasp produces for the fixture project', async () => {
    const claspIgnore = await readFile(join(projectDir, '.claspignore'), 'utf8');
    const files = await collectFiles(projectDir, parseClaspIgnore(claspIgnore));

    const actual = files
      .map((file) => ({ name: file.name, type: file.type }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));

    const expected = JSON.parse(
      await readFile(join(here, 'fixtures', 'sample-project.expected.json'), 'utf8'),
    ) as Array<{ name: string; type: string }>;

    expect(actual).toEqual(expected.sort((a, b) => (a.name < b.name ? -1 : 1)));
  });

  it('never includes files excluded by .claspignore', async () => {
    const claspIgnore = await readFile(join(projectDir, '.claspignore'), 'utf8');
    const files = await collectFiles(projectDir, parseClaspIgnore(claspIgnore));
    const names = files.map((file) => file.name);

    expect(names).not.toContain('ignored');
    expect(names).not.toContain('Code.test');
  });
});
```

- [ ] **Step 4: テストを実行して確認**

Run: `npx vitest run tests/clasp-compat.test.ts`
Expected: `2 passed`

（`collectFiles` は Task 7 で実装済みのため、このテストは実装済み機能に対する互換性の固定である。失敗する場合は Task 7 の実装に互換性の欠陥があることを意味するので、テストではなく実装を直す。）

- [ ] **Step 5: fixture 再生成手順を記録**

`tests/fixtures/README.md`:

```markdown
# clasp 互換 fixture

`sample-project.expected.json` は、clasp が `sample-project/` をプッシュした際に
Apps Script API へ送る `files` の name / type を記録したものである。

## 再生成手順

clasp と認証済みの Google アカウント、および使い捨ての GAS プロジェクトが必要になる。

1. 使い捨てのスタンドアロン GAS プロジェクトを作成し、scriptId を控える
2. `sample-project/` に `.clasp.json` を置く

   ```json
   { "scriptId": "<使い捨てプロジェクトの scriptId>", "rootDir": "." }
   ```

3. clasp でプッシュする

   ```bash
   cd sample-project
   npx @google/clasp push -f
   ```

4. Apps Script API で実際に格納された内容を取得する

   ```bash
   export GAS_CREDENTIALS="$(cat ~/.clasprc.json)"
   export GAS_SCRIPT_ID="<使い捨てプロジェクトの scriptId>"
   node --experimental-strip-types ../../scripts/spike-verify.ts
   ```

5. `[4] getContent` の出力の name / type を `sample-project.expected.json` に反映する
6. `.clasp.json` を削除してからコミットする（scriptId をリポジトリに含めない）

## いつ再生成するか

- clasp のメジャーバージョンが上がったとき
- `.claspignore` の解釈やファイル種別の判定に関する不具合報告を受けたとき
```

- [ ] **Step 6: コミット**

```bash
git add tests/
git commit -m "test: clasp 互換のゴールデンテストと fixture を追加"
```

---

## Task 14: README と実地確認

**Files:**
- Create: `README.md`
- Create: `.github/workflows/example-deploy.yml.disabled`

- [ ] **Step 1: `README.md` を作成**

````markdown
# gas-deploy-actions

Google Apps Script を GitHub Actions からデプロイする Action です。clasp CLI をラップせず、Apps Script API を直接呼び出します。

## 特徴

- **clasp の認証情報をそのまま使えます** — `~/.clasprc.json` を Secrets に入れるだけで移行できます
- **dry-run と差分表示** — 何が変わるかを確認してからデプロイできます
- **差分がなければ何もしません** — バージョン番号とデプロイ数の無駄な消費を防ぎます
- **既存デプロイを更新します** — `deployment-id` を指定すれば Web アプリの URL が変わりません
- **最小権限** — `script.projects` と `script.deployments` のみを要求します

## 使い方

```yaml
name: Deploy GAS

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: <owner>/gas-deploy-actions/deploy@v0.1.0
        with:
          credentials: ${{ secrets.CLASPRC_JSON }}
          script-id: ${{ secrets.SCRIPT_ID }}
          root-dir: dist
          deployment-id: ${{ secrets.DEPLOYMENT_ID }}
          project-type: webapp
```

## 事前準備

1. `clasp login` をローカルで実行します
2. https://script.google.com/home/usersettings を開き「Google Apps Script API」をオンにします
3. `~/.clasprc.json` の中身をリポジトリの Secret `CLASPRC_JSON` に登録します

> **重要:** OAuth 同意画面が「テスト」状態の場合、refresh token は **7日で失効します**。
> Google Workspace なら「内部」、個人アカウントなら「本番」に変更してください。

## 入力

| 名前 | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `credentials` | ○ | — | `.clasprc.json` または `{client_id, client_secret, refresh_token}` |
| `script-id` | ○ | — | デプロイ先の scriptId |
| `root-dir` | | `.` | アップロード対象のルートディレクトリ |
| `deployment-id` | | — | 更新する既存デプロイ ID。**省略すると Web アプリの URL が変わります** |
| `project-type` | | `standalone` | `webapp` / `addon` / `bound` / `standalone` |
| `ignore` | | — | 除外パターン（改行区切り）。省略時は `.claspignore` |
| `dry-run` | | `false` | 差分表示のみ行います |
| `create-version` | | `true` | バージョン作成とデプロイを行います |
| `description` | | `ci-<sha7>-<run_number>` | バージョンの説明 |

## 出力

| 名前 | 説明 |
|---|---|
| `changed` | 差分があったかどうか |
| `version-number` | 作成されたバージョン番号 |
| `deployment-id` | 更新または作成されたデプロイ ID |
| `web-app-url` | Web アプリの URL |
| `summary` | Markdown のサマリ |

## 制限事項

- **TypeScript のトランスパイルは行いません。** `root-dir` にビルド済みの `.js` を置いてください。esbuild や rollup での事前ビルドを想定しています
- **サービスアカウントは使えません。** Apps Script API が Google 側の仕様として受け付けないためで、この Action の制限ではありません
- v0.1 では単一プロジェクトのみ対応です。複数プロジェクトの一括デプロイは v1.0 で対応します
````

- [ ] **Step 2: 実地確認用のワークフロー雛形を作成**

`.github/workflows/example-deploy.yml.disabled`（拡張子を変えて自動実行を防ぐ）:

```yaml
# 実地確認用。動作確認の際に example-deploy.yml へリネームして使う。
name: Example Deploy

on:
  workflow_dispatch:
    inputs:
      dry-run:
        description: 'dry-run で実行する'
        type: boolean
        default: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: ./deploy
        with:
          credentials: ${{ secrets.CLASPRC_JSON }}
          script-id: ${{ secrets.TEST_SCRIPT_ID }}
          root-dir: tests/fixtures/sample-project
          dry-run: ${{ inputs.dry-run }}
```

- [ ] **Step 3: 実地確認（手動）**

> **⚠️ このステップは実行者（人間）が実施する。**

1. GitHub にリポジトリを作成して push する
2. Secrets に `CLASPRC_JSON` と `TEST_SCRIPT_ID`（Task 5 で用意した検証用プロジェクト）を登録する
3. `example-deploy.yml.disabled` を `example-deploy.yml` にリネームして push する
4. Actions タブから `dry-run: true` で実行する

Expected: ジョブが成功し、Job Summary に「GAS デプロイ結果」と差分の一覧が表示される

5. `dry-run: false` で再実行する

Expected: ジョブが成功し、Summary にバージョン番号とデプロイ ID が表示される。スクリプトエディタで内容が更新されていることを確認する

- [ ] **Step 4: `runs.using` の値を確定させる**

Step 3 で `Unexpected value 'node24'` が出た場合、`deploy/action.yml` の `using` を `node20` に変更し、再度 Step 3 を実行する。

- [ ] **Step 5: コミット**

```bash
git add README.md .github/workflows/example-deploy.yml.disabled deploy/action.yml
git commit -m "docs: v0.1 の README と実地確認用ワークフローを追加"
```

- [ ] **Step 6: タグを打つ**

```bash
git tag v0.1.0
```

---

## Self-Review Notes

このプランを書いた後にスペックと突き合わせた結果を記録する。

**スペック v0.1 スコープの網羅性:**

| スペックの要求 | 対応タスク |
|---|---|
| `deploy` アクション（単一プロジェクト） | Task 11 |
| Apps Script API 直叩き | Task 9 |
| differ + dry-run | Task 8, Task 10 |
| 既存 `deploymentId` 更新 | Task 10 |
| エラーメッセージ整備 | Task 2 |
| `.clasprc.json` 互換 | Task 3 |
| ログ安全性（`setSecret`） | Task 11 |
| テストレベル1（core 単体） | Task 2〜Task 10 |
| テストレベル2（API モック） | Task 9 |
| テストレベル3（clasp 互換ゴールデン） | Task 13 |
| テストレベル5（dist 同期） | Task 12 |
| 未確定事項の検証 | Task 5 |

**意図的にスペックから逸脱した点:**

1. **MSW を使わない**（Task 9）— `fetch` を引数で差し替える設計にしたため、スタブ関数で同等の検証ができる。依存を1つ減らした
2. **ゴールデンテストで clasp を実行しない**（Task 13）— clasp の実行には認証とネットワークが必要。一度記録した fixture と照合する方式にし、再生成手順を残した。テストがオフラインで完結する利点の方が大きいと判断した

**セルフレビューで発見して修正した不具合:**

1. **ルート `tsconfig.json` が存在しなかった** — `npm run typecheck` は `tsc --build` を使うため、参照だけを持つソリューションファイルが必須。無ければ Task 1 Step 10 の時点で必ず失敗していた。Task 1 に作成ステップを、Task 11 に `deploy` 参照の追加ステップを足した
2. **`differ.ts` のキー区切りが空白だった** — `name` と `type` を空白で連結してキーにしていたため、`My File.js` のような**空白を含むファイル名で `nameOf()` が名前を途中で切ってしまう**。差分の表示が壊れる。`' '` に変更した
3. **`main.ts` がトップレベル `await` を使っていた** — esbuild は cjs 出力でトップレベル await を変換できず、Task 11 のビルドが失敗する。`void run().catch(...)` に変更した
4. **`deploy/tsconfig.json` が `composite: false` だった** — プロジェクト参照の対象になれず `tsc --build` が失敗する。`composite` を継承させ、`packages/core` への参照を追加した

（他に、差分テストの期待件数の誤記と Task 11 のステップ番号の重複も修正した）

**未解決のまま残す点:**

- `runs.using` を `node24` にするか `node20` にするかは、実行環境でしか確定できない。Task 12 Step 3 と Task 14 Step 4 で分岐を明示した
