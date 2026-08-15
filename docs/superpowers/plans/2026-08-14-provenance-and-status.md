# 由来情報と status アクション 実装計画（計画1）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** デプロイしたバージョンにコミット情報を埋め込み、「いま本番で動いているのはどのコミットか」を `status` アクションで照会できるようにする。

**Architecture:** 由来情報の整形と復元は `packages/core/src/provenance.ts`（純粋関数）に置く。デプロイが指すバージョンから由来情報を引く処理は `packages/core/src/status.ts` に置き、GitHub Actions の文脈（環境変数・イベントペイロード）の読み取りはアダプタ側に閉じ込める。`status` は `deploy` / `rollback` / `token-check` と同じ薄いアダプタ構成の4つ目のアクションになる。

**Tech Stack:** TypeScript 5.6 / Node 22 / npm workspaces / Vitest 2 / esbuild / @actions/core

**Source spec:** [`docs/superpowers/specs/2026-08-14-provenance-and-changed-only-design.md`](../specs/2026-08-14-provenance-and-changed-only-design.md) の §4・§5

**Out of scope（計画2で行う）:** `only-changed`、`gasdeploy.yml` の `watch` スキーマ、`git` の実行。

> **コミットについて:** 各タスクの最後にコミット手順を置いているが、このリポジトリでは利用者の指示があるまでコミットしない運用になっている。実行時に確認すること。

---

## File Structure

| パス | 責務 |
|---|---|
| `packages/core/src/provenance.ts` | 由来情報の整形と復元。純粋関数のみ |
| `packages/core/src/provenance.test.ts` | 上記の単体テスト |
| `packages/core/src/status.ts` | デプロイ → バージョン → 由来情報の取得 |
| `packages/core/src/status.test.ts` | 上記の単体テスト（偽クライアント使用） |
| `status/action.yml` | アクションのメタデータ |
| `status/package.json` | ワークスペースの定義 |
| `status/tsconfig.json` | プロジェクト参照 |
| `status/src/index.ts` | エントリ。エラーを `setFailed` に変換するだけ |
| `status/src/main.ts` | 入力の解釈、対象の解決、出力の設定 |
| `status/src/main.test.ts` | 純粋ヘルパの単体テスト |
| `status/src/summary.ts` | サマリの Markdown 描画 |
| `status/src/summary.test.ts` | 上記の単体テスト |

**変更するファイル:** `packages/core/src/index.ts`、`deploy/src/main.ts`、`vitest.config.ts`、`tsconfig.json`、`package.json`、`scripts/build.mjs`、`.github/workflows/ci.yml`、`.gitignore`、`README.md`、`docs/index.html`

---

## Task 1: 由来情報を組み立てる

**Files:**
- Create: `packages/core/src/provenance.ts`
- Test: `packages/core/src/provenance.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`packages/core/src/provenance.test.ts` を作成する。

```ts
import { describe, expect, it } from 'vitest';
import { MAX_DESCRIPTION_LENGTH, buildVersionDescription } from './provenance.js';

const SHA = '6251c8c9f2a1b3d4e5f6a7b8c9d0e1f2a3b4c5d6';

describe('buildVersionDescription', () => {
  it('formats every field in a fixed key order', () => {
    const { description } = buildVersionDescription({
      sha: SHA,
      runId: '31344375660',
      pr: 42,
      actor: 'yut0takagi',
    });
    expect(description).toBe(`ci sha=${SHA} run=31344375660 pr=42 by=yut0takagi`);
  });

  it('omits keys that are not available rather than emitting empty values', () => {
    const { description } = buildVersionDescription({ sha: SHA, runId: '1' });
    expect(description).toBe(`ci sha=${SHA} run=1`);
    expect(description).not.toContain('pr=');
    expect(description).not.toContain('by=');
  });

  // 由来を無条件に残すのが目的なので、指定値で置き換えて追跡を失う設計にはしない。
  it('keeps a user-supplied description after the provenance', () => {
    const { description } = buildVersionDescription({ sha: SHA }, 'hotfix for incident 123');
    expect(description).toBe(`ci sha=${SHA} | hotfix for incident 123`);
  });

  it('falls back to the user description when there is no CI context', () => {
    const { description } = buildVersionDescription({}, 'manual deploy');
    expect(description).toBe('manual deploy');
  });

  it('falls back to a fixed label when there is neither CI context nor a description', () => {
    expect(buildVersionDescription({}).description).toBe('manual');
  });

  it('truncates the user description to stay within the length budget', () => {
    const long = 'x'.repeat(400);
    const { description, warnings } = buildVersionDescription({ sha: SHA }, long);
    expect(description.length).toBe(MAX_DESCRIPTION_LENGTH);
    expect(description.endsWith('…')).toBe(true);
    expect(warnings).toHaveLength(1);
  });

  // 現実の GitHub の値（run ID は約11桁）ではこの分岐に到達しない。予算が負になる
  // 病的な入力でも `slice` に負の値を渡さないことを確かめるための防御的な分岐である。
  // 由来情報の側は設計上決して切り詰めないので、結果が上限を超えることは許容する。
  it('drops the user description entirely when almost no budget remains', () => {
    const source = { sha: SHA, runId: '9'.repeat(200), actor: 'a'.repeat(39) };
    const { description, warnings } = buildVersionDescription(source, 'note');
    expect(description).not.toContain('|');
    expect(warnings).toHaveLength(1);
  });

  it('trims surrounding whitespace in the user description', () => {
    const { description } = buildVersionDescription({ sha: SHA }, '  spaced  ');
    expect(description).toBe(`ci sha=${SHA} | spaced`);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx vitest run packages/core/src/provenance.test.ts`
Expected: FAIL — `Failed to load url ./provenance.js`

- [ ] **Step 3: 最小の実装を書く**

`packages/core/src/provenance.ts` を作成する。

```ts
/**
 * バージョン説明の最大長。
 *
 * ⚠️ Apps Script の実際の上限は未実測（仕様書 §10 #1）。保守的な暫定値である。
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

export interface VersionDescription {
  description: string;
  warnings: string[];
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
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx vitest run packages/core/src/provenance.test.ts`
Expected: PASS（8 tests）

- [ ] **Step 5: コミット**

```bash
git add packages/core/src/provenance.ts packages/core/src/provenance.test.ts
git commit -m "feat(core): バージョン説明に由来情報を埋め込む整形処理を追加"
```

---

## Task 2: 由来情報を復元する

**Files:**
- Modify: `packages/core/src/provenance.ts`
- Test: `packages/core/src/provenance.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`packages/core/src/provenance.test.ts` の末尾（最後の `});` の後）に追記する。インポート行も併せて更新する。

```ts
import { MAX_DESCRIPTION_LENGTH, buildVersionDescription, parseVersionDescription } from './provenance.js';
```

```ts
describe('parseVersionDescription', () => {
  it('round-trips everything that buildVersionDescription writes', () => {
    const source = { sha: SHA, runId: '31344375660', pr: 42, actor: 'yut0takagi' };
    const { description } = buildVersionDescription(source, 'hotfix');
    expect(parseVersionDescription(description)).toEqual({
      sha: SHA,
      runId: '31344375660',
      pr: 42,
      actor: 'yut0takagi',
      description: 'hotfix',
    });
  });

  it('restores a provenance that has no optional fields', () => {
    expect(parseVersionDescription(`ci sha=${SHA}`)).toEqual({ sha: SHA });
  });

  it('accepts an abbreviated sha', () => {
    expect(parseVersionDescription('ci sha=6251c8c')).toEqual({ sha: '6251c8c' });
  });

  it('restores a multi-line user description', () => {
    const parsed = parseVersionDescription(`ci sha=${SHA} | line1\nline2`);
    expect(parsed?.description).toBe('line1\nline2');
  });

  // 部分一致から情報を拾わない。手動作成のバージョンを CI 製と取り違える方が有害である。
  it('rejects the old ci-<sha7>-<run_number> format', () => {
    expect(parseVersionDescription('ci-6251c8c-42')).toBeUndefined();
  });

  it('rejects a hand-written description', () => {
    expect(parseVersionDescription('release 2026-08-14')).toBeUndefined();
  });

  it('rejects anything before or after the expected shape', () => {
    expect(parseVersionDescription(`prefix ci sha=${SHA}`)).toBeUndefined();
    expect(parseVersionDescription(`ci sha=${SHA} trailing`)).toBeUndefined();
  });

  it('rejects an uppercase sha', () => {
    expect(parseVersionDescription('ci sha=6251C8C')).toBeUndefined();
  });

  it('rejects keys in an unexpected order', () => {
    expect(parseVersionDescription(`ci sha=${SHA} by=someone run=1`)).toBeUndefined();
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx vitest run packages/core/src/provenance.test.ts`
Expected: FAIL — `parseVersionDescription is not a function`

- [ ] **Step 3: 最小の実装を書く**

`packages/core/src/provenance.ts` の先頭付近（`MAX_DESCRIPTION_LENGTH` の後）に型を追加する。

```ts
export interface Provenance {
  sha: string;
  runId?: string;
  pr?: number;
  actor?: string;
  /** ` | ` 以降のユーザー指定分。 */
  description?: string;
}
```

ファイル末尾に追記する。

```ts
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
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx vitest run packages/core/src/provenance.test.ts`
Expected: PASS（17 tests）

- [ ] **Step 5: コミット**

```bash
git add packages/core/src/provenance.ts packages/core/src/provenance.test.ts
git commit -m "feat(core): バージョン説明から由来情報を復元する処理を追加"
```

---

## Task 3: core の公開 API に追加する

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: 再エクスポートを追加する**

`packages/core/src/index.ts` の `export * from './token-health.js';` の後に追記する。

```ts
export * from './provenance.js';
```

- [ ] **Step 2: 型検査で確認する**

Run: `npm run typecheck`
Expected: エラーなしで終了

- [ ] **Step 3: コミット**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): provenance を公開 API に追加"
```

---

## Task 4: deploy が由来情報を埋め込む

**Files:**
- Modify: `deploy/src/main.ts`（`defaultDescription` の削除、`resolveProvenanceSource` の追加、2箇所の呼び出し差し替え）
- Test: `deploy/src/main.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`deploy/src/main.test.ts` の末尾に追記する。既存のインポート行に `resolveProvenanceSource` を加える。

```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

（既存のインポートに含まれていれば重複させない）

```ts
describe('resolveProvenanceSource', () => {
  it('collects the CI context from the environment', async () => {
    const source = await resolveProvenanceSource({
      GITHUB_SHA: '6251c8c9f2a1b3d4e5f6a7b8c9d0e1f2a3b4c5d6',
      GITHUB_RUN_ID: '31344375660',
      GITHUB_ACTOR: 'yut0takagi',
    });
    expect(source).toEqual({
      sha: '6251c8c9f2a1b3d4e5f6a7b8c9d0e1f2a3b4c5d6',
      runId: '31344375660',
      actor: 'yut0takagi',
    });
  });

  it('returns an empty source outside of Actions', async () => {
    expect(await resolveProvenanceSource({})).toEqual({});
  });

  it('reads the pull request number from the event payload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gas-prov-'));
    const eventPath = join(dir, 'event.json');
    await writeFile(eventPath, JSON.stringify({ pull_request: { number: 42 } }), 'utf8');

    const source = await resolveProvenanceSource({
      GITHUB_SHA: '6251c8c',
      GITHUB_EVENT_PATH: eventPath,
    });
    expect(source.pr).toBe(42);
  });

  // ペイロードが読めないのは、由来情報の他の要素を捨てる理由にはならない。
  it('keeps the rest of the context when the event payload is unreadable', async () => {
    const source = await resolveProvenanceSource({
      GITHUB_SHA: '6251c8c',
      GITHUB_EVENT_PATH: '/nonexistent/event.json',
    });
    expect(source).toEqual({ sha: '6251c8c' });
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx vitest run deploy/src/main.test.ts`
Expected: FAIL — `resolveProvenanceSource is not a function`

- [ ] **Step 3: `resolveProvenanceSource` を実装する**

`deploy/src/main.ts` の `defaultDescription` 関数（現在の34〜38行目）を、次の実装で置き換える。

```ts
/**
 * 由来情報の材料を GHA の環境変数とイベントペイロードから集める。
 *
 * 各項目は独立に読む。揃っていることは前提にしない（Actions 外では全て欠けるが、
 * それを保証するのは実行環境であってこの関数ではない）。「sha が無ければ由来情報を
 * 作らない」という判断は buildVersionDescription 側が持つ。
 */
export async function resolveProvenanceSource(
  env: Record<string, string | undefined>,
): Promise<ProvenanceSource> {
  const source: ProvenanceSource = {};

  const sha = env['GITHUB_SHA'];
  if (sha) source.sha = sha;
  const runId = env['GITHUB_RUN_ID'];
  if (runId) source.runId = runId;
  const actor = env['GITHUB_ACTOR'];
  if (actor) source.actor = actor;

  const eventPath = env['GITHUB_EVENT_PATH'];
  if (eventPath) {
    try {
      const payload: unknown = JSON.parse(await readFile(eventPath, 'utf8'));
      const pr = resolvePullRequestNumber(payload);
      if (pr !== undefined) source.pr = pr;
    } catch {
      // PR 番号は sha から GitHub 側で引ける。ここで失敗してもデプロイを止める理由にはならない。
      // cause は付けない（イベントペイロードには非公開のリポジトリ情報が含まれうる）。
    }
  }

  return source;
}
```

インポートに追加する（既存の `@gas-deploy/core` からのインポート一覧に加える）。

```ts
  type ProvenanceSource,
  buildVersionDescription,
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx vitest run deploy/src/main.test.ts`
Expected: PASS

- [ ] **Step 5: 単一プロジェクトモードの呼び出しを差し替える**

`deploy/src/main.ts` の `runSingleProject` 内で、`deploy(...)` の呼び出し前に由来情報を組み立てる。

```ts
  const provenanceSource = await resolveProvenanceSource(process.env);
  const versionDescription = buildVersionDescription(provenanceSource, descriptionInput);
  for (const warning of versionDescription.warnings) {
    core.warning(warning);
  }
```

`deploy(...)` の引数を差し替える。

```ts
    description: versionDescription.description,
```

（差し替え前: `description: descriptionInput || defaultDescription(),`）

- [ ] **Step 6: 複数プロジェクトモードの呼び出しを差し替える**

`deploy/src/main.ts` の `runMultiProject` 内で、`buildDeployTargets(...)` の呼び出し前に同じものを組み立てる。

```ts
  const provenanceSource = await resolveProvenanceSource(process.env);
  const versionDescription = buildVersionDescription(provenanceSource, descriptionInput);
  for (const warning of versionDescription.warnings) {
    core.warning(warning);
  }
```

`buildDeployTargets(...)` の引数を差し替える。

```ts
    description: versionDescription.description,
```

（差し替え前: `description: descriptionInput || defaultDescription(),`）

- [ ] **Step 7: 全テストと型検査を実行する**

Run: `npm test && npm run typecheck`
Expected: 全テスト PASS、型エラーなし。`defaultDescription` への参照が残っていれば型エラーになる

- [ ] **Step 8: コミット**

```bash
git add deploy/src/main.ts deploy/src/main.test.ts
git commit -m "feat(deploy): バージョン説明にコミット情報を埋め込む"
```

---

## Task 5: デプロイの現況を取得する

**Files:**
- Create: `packages/core/src/status.ts`
- Test: `packages/core/src/status.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`packages/core/src/status.test.ts` を作成する。

```ts
import { describe, expect, it, vi } from 'vitest';
import type { AppsScriptClient } from './api-client.js';
import { GasDeployError } from './errors.js';
import { getDeploymentStatus } from './status.js';

const SHA = '6251c8c9f2a1b3d4e5f6a7b8c9d0e1f2a3b4c5d6';

/** 必要なメソッドだけを持つ偽クライアント。実クライアントは HTTP を張るため使えない。 */
function fakeClient(overrides: Partial<Record<string, unknown>>): AppsScriptClient {
  return {
    getDeployment: vi.fn(),
    listDeployments: vi.fn(async () => []),
    getVersion: vi.fn(),
    ...overrides,
  } as unknown as AppsScriptClient;
}

describe('getDeploymentStatus', () => {
  it('resolves the provenance of the version the deployment points at', async () => {
    const client = fakeClient({
      getDeployment: vi.fn(async () => ({ deploymentId: 'dep-1', versionNumber: 38, webAppUrl: 'https://x' })),
      getVersion: vi.fn(async () => ({
        versionNumber: 38,
        description: `ci sha=${SHA} run=99 pr=7 by=someone`,
        createTime: '2026-08-14T00:00:00Z',
      })),
    });

    const status = await getDeploymentStatus(client, { scriptId: 's-1', deploymentId: 'dep-1' });
    expect(status.versionNumber).toBe(38);
    expect(status.createdAt).toBe('2026-08-14T00:00:00Z');
    expect(status.webAppUrl).toBe('https://x');
    expect(status.provenance).toEqual({ sha: SHA, runId: '99', pr: 7, actor: 'someone' });
  });

  it('reports no provenance when the description was not written by this action', async () => {
    const client = fakeClient({
      getDeployment: vi.fn(async () => ({ deploymentId: 'dep-1', versionNumber: 3 })),
      getVersion: vi.fn(async () => ({ versionNumber: 3, description: 'hand written' })),
    });

    const status = await getDeploymentStatus(client, { scriptId: 's-1', deploymentId: 'dep-1' });
    expect(status.versionNumber).toBe(3);
    expect(status.provenance).toBeUndefined();
  });

  it('does not fetch a version for an @HEAD deployment', async () => {
    const getVersion = vi.fn();
    const client = fakeClient({
      getDeployment: vi.fn(async () => ({ deploymentId: 'head-1' })),
      getVersion,
    });

    const status = await getDeploymentStatus(client, { scriptId: 's-1', deploymentId: 'head-1' });
    expect(status.versionNumber).toBeUndefined();
    expect(status.provenance).toBeUndefined();
    expect(getVersion).not.toHaveBeenCalled();
  });

  it('auto-detects the target when exactly one versioned deployment exists', async () => {
    const client = fakeClient({
      listDeployments: vi.fn(async () => [
        { deploymentId: 'head-1' },
        { deploymentId: 'dep-1', versionNumber: 12 },
      ]),
      getVersion: vi.fn(async () => ({ versionNumber: 12, description: `ci sha=${SHA}` })),
    });

    const status = await getDeploymentStatus(client, { scriptId: 's-1' });
    expect(status.deploymentId).toBe('dep-1');
  });

  it('lists the candidates instead of guessing when several versioned deployments exist', async () => {
    const client = fakeClient({
      listDeployments: vi.fn(async () => [
        { deploymentId: 'dep-1', versionNumber: 1 },
        { deploymentId: 'dep-2', versionNumber: 2 },
      ]),
    });

    await expect(getDeploymentStatus(client, { scriptId: 's-1' })).rejects.toThrowError(GasDeployError);
  });

  // @HEAD しか無いのは異常ではない。読み取りなので報告して終わる。
  it('reports the only @HEAD deployment rather than failing', async () => {
    const client = fakeClient({
      listDeployments: vi.fn(async () => [{ deploymentId: 'head-1' }]),
    });

    const status = await getDeploymentStatus(client, { scriptId: 's-1' });
    expect(status.deploymentId).toBe('head-1');
    expect(status.versionNumber).toBeUndefined();
  });

  // scriptId 違いか未デプロイかを区別できない「由来なし」を返さない。
  it('fails when the script has no deployments at all', async () => {
    const client = fakeClient({ listDeployments: vi.fn(async () => []) });
    await expect(getDeploymentStatus(client, { scriptId: 's-1' })).rejects.toThrowError(GasDeployError);
  });

  it('explains a wrong deployment-id with the available candidates', async () => {
    const notFound = new GasDeployError('見つかりません', { code: 'not-found' });
    const client = fakeClient({
      getDeployment: vi.fn(async () => {
        throw notFound;
      }),
      listDeployments: vi.fn(async () => [{ deploymentId: 'dep-1', versionNumber: 5 }]),
    });

    const error = await getDeploymentStatus(client, { scriptId: 's-1', deploymentId: 'wrong' }).catch(
      (e: unknown) => e as GasDeployError,
    );
    expect(error.nextSteps.join('\n')).toContain('dep-1');
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx vitest run packages/core/src/status.test.ts`
Expected: FAIL — `Failed to load url ./status.js`

- [ ] **Step 3: 最小の実装を書く**

`packages/core/src/status.ts` を作成する。

```ts
import type { AppsScriptClient } from './api-client.js';
import { GasDeployError } from './errors.js';
import { type Provenance, parseVersionDescription } from './provenance.js';
import type { Deployment } from './types.js';

export interface DeploymentStatus {
  deploymentId: string;
  /** `@HEAD` デプロイの場合は undefined。 */
  versionNumber?: number;
  /** バージョン説明の生の値。 */
  description?: string;
  createdAt?: string;
  webAppUrl?: string;
  /** 由来情報を復元できた場合のみ設定される。 */
  provenance?: Provenance;
}

export interface StatusOptions {
  scriptId: string;
  /** 省略時は、バージョン付きデプロイがちょうど1つ、または全体で1つの場合に自動特定する。 */
  deploymentId?: string;
}

function describeDeployment(deployment: Deployment): string {
  const version = deployment.versionNumber === undefined ? '@HEAD' : `v${deployment.versionNumber}`;
  return `${deployment.deploymentId} (${version})`;
}

/**
 * 対象のデプロイを特定する。
 *
 * `rollback` と同じ「バージョン付きがちょうど1つなら自動特定」の規則を採るが、
 * 実装は共有しない。`rollback` の分岐は `@HEAD` を書き換え不能として失敗させ、
 * 文言もロールバック前提になっている。読み取りである `status` では `@HEAD` は
 * 正常な報告対象であり、同じコードに両方の意味を持たせると読めなくなる。
 */
async function resolveTargetDeployment(
  client: AppsScriptClient,
  scriptId: string,
): Promise<Deployment> {
  const deployments = await client.listDeployments(scriptId);

  if (deployments.length === 0) {
    throw new GasDeployError('このスクリプトにはデプロイがありません', {
      nextSteps: [
        'scriptId が正しいか確認してください（スクリプトエディタの「プロジェクトの設定」で確認できます）',
        'まだ一度もデプロイしていない場合は、先に deploy アクションを実行してください',
      ],
    });
  }

  const versioned = deployments.filter((entry) => entry.versionNumber !== undefined);

  if (versioned.length === 1) {
    return versioned[0] as Deployment;
  }
  if (versioned.length > 1) {
    throw new GasDeployError(`バージョン付きデプロイが ${versioned.length} 件あるため、対象を自動で特定できません`, {
      nextSteps: [
        'deployment-id 入力で対象を明示してください',
        `候補: ${versioned.map(describeDeployment).join(' / ')}`,
      ],
    });
  }

  // ここに来るのはバージョン付きが0件の場合。@HEAD しか無いのは異常ではない。
  if (deployments.length > 1) {
    throw new GasDeployError(`バージョンを固定したデプロイがなく、@HEAD デプロイが ${deployments.length} 件あります`, {
      nextSteps: [
        'deployment-id 入力で対象を明示してください',
        `候補: ${deployments.map(describeDeployment).join(' / ')}`,
      ],
    });
  }
  return deployments[0] as Deployment;
}

/**
 * デプロイが指すバージョンと、そこに埋め込まれた由来情報を取得する。
 *
 * 書き込みは一切しない。直前に書き込みが無いため、読み取り一貫性の待機も行わない。
 */
export async function getDeploymentStatus(
  client: AppsScriptClient,
  options: StatusOptions,
): Promise<DeploymentStatus> {
  let deployment: Deployment;
  if (options.deploymentId === undefined) {
    deployment = await resolveTargetDeployment(client, options.scriptId);
  } else {
    try {
      deployment = await client.getDeployment(options.scriptId, options.deploymentId);
    } catch (error) {
      // 404 のときだけ一覧を取って候補を示す。成功時に余分な API を叩かないため、
      // 一覧の取得は失敗経路に限る。
      if (error instanceof GasDeployError && error.code === 'not-found') {
        const deployments = await client.listDeployments(options.scriptId);
        throw new GasDeployError(`デプロイ ${options.deploymentId} が見つかりません`, {
          nextSteps: [
            'deployment-id が正しいか確認してください（スクリプトエディタの [デプロイ] → [デプロイを管理] で確認できます）',
            deployments.length > 0
              ? `このスクリプトのデプロイ: ${deployments.map(describeDeployment).join(' / ')}`
              : 'このスクリプトにはデプロイがありません',
          ],
        });
      }
      throw error;
    }
  }

  const status: DeploymentStatus = { deploymentId: deployment.deploymentId };
  if (deployment.webAppUrl !== undefined) status.webAppUrl = deployment.webAppUrl;

  if (deployment.versionNumber === undefined) {
    // @HEAD は常に最新のソースを指し、バージョンを持たない。由来情報も存在しない。
    return status;
  }

  status.versionNumber = deployment.versionNumber;
  const version = await client.getVersion(options.scriptId, deployment.versionNumber);
  if (version.createTime !== undefined) status.createdAt = version.createTime;
  if (version.description !== undefined) {
    status.description = version.description;
    const provenance = parseVersionDescription(version.description);
    if (provenance !== undefined) status.provenance = provenance;
  }
  return status;
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx vitest run packages/core/src/status.test.ts`
Expected: PASS（8 tests）

- [ ] **Step 5: 公開 API に追加する**

`packages/core/src/index.ts` に追記する。

```ts
export * from './status.js';
```

- [ ] **Step 6: 型検査を実行する**

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 7: コミット**

```bash
git add packages/core/src/status.ts packages/core/src/status.test.ts packages/core/src/index.ts
git commit -m "feat(core): デプロイの現況と由来情報を取得する処理を追加"
```

---

## Task 6: status アクションの骨格を作り、ビルドに登録する

**Files:**
- Create: `status/action.yml`、`status/package.json`、`status/tsconfig.json`、`status/src/index.ts`
- Modify: `package.json`、`tsconfig.json`、`vitest.config.ts`、`scripts/build.mjs`、`.github/workflows/ci.yml`、`.gitignore`

設定ファイルが中心のためテストは書かない（型検査・ビルド・バンドル起動で検証する）。

- [ ] **Step 1: `status/action.yml` を作成する**

```yaml
name: 'Show what is deployed to Google Apps Script'
description: 'デプロイが指すバージョンと、そこに埋め込まれたコミット情報を表示します（何も書き換えません）'
branding:
  icon: 'search'
  color: 'yellow'

inputs:
  credentials:
    description: 'clasp の .clasprc.json、または {client_id, client_secret, refresh_token} の JSON'
    required: true
  script-id:
    description: '対象の scriptId。指定すると config は読み込まれません'
    required: false
  deployment-id:
    description: >-
      対象のデプロイ ID。省略した場合、バージョン付きデプロイがちょうど1つのときだけ
      自動で特定します。複数ある場合は候補を表示して失敗します。
    required: false
  config:
    description: 'script-id が未指定のときに読み込む設定ファイルのパス'
    required: false
    default: 'gasdeploy.yml'
  environment:
    description: 'config モードで対象とする environment 名。config モードでは必須です'
    required: false
  projects:
    description: 'config モードで対象とするプロジェクト名（カンマ区切り）。all で全プロジェクト'
    required: false
    default: 'all'

outputs:
  managed:
    description: >-
      由来情報を復元できたか（true / false）。false は「このアクション以外で作られた
      バージョン」または「@HEAD デプロイ」を意味します。単一対象モードのみ。
  version-number:
    description: 'デプロイが指すバージョン番号（単一対象モードのみ）'
  sha:
    description: 'デプロイされているコミットの SHA（復元できた場合、単一対象モードのみ）'
  run-id:
    description: 'デプロイしたワークフロー実行の ID（同上）'
  pr:
    description: 'デプロイ元の PR 番号（同上）'
  actor:
    description: 'デプロイを実行したアカウント（同上）'
  created-at:
    description: 'バージョンの作成日時（単一対象モードのみ）'
  deployment-id:
    description: '対象となったデプロイの ID（単一対象モードのみ）'
  web-app-url:
    description: 'Web アプリの URL（該当する場合、単一対象モードのみ）'
  summary:
    description: '人間可読のサマリ（Markdown）'
  targets:
    description: >-
      config モードでの各対象の結果（JSON 配列）。全対象を試行してから返すため、
      一部が失敗しても他の結果が失われることはありません。各要素は project,
      environment, scriptId, managed を必ず持ち、該当する場合のみ deploymentId,
      versionNumber, sha, runId, pr, actor, createdAt, webAppUrl, error を含みます。

runs:
  using: 'node24'
  # .cjs であること。status/package.json の "type": "module" により、
  # .js だと Node が ESM として解釈して CJS バンドルが動かない。
  main: 'dist/index.cjs'
```

- [ ] **Step 2: `status/package.json` を作成する**

```json
{
  "name": "@gas-deploy/status-action",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@actions/core": "^1.11.1",
    "@gas-deploy/core": "0.1.0"
  }
}
```

- [ ] **Step 3: `status/tsconfig.json` を作成する**

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

- [ ] **Step 4: `status/src/index.ts` を作成する**

```ts
import * as core from '@actions/core';
import { GasDeployError } from '@gas-deploy/core';
import { run } from './main.js';

// esbuild の cjs 出力はトップレベル await を扱えないため、必ず関数の中で await する。
void run().catch((error: unknown) => {
  if (error instanceof GasDeployError) {
    core.setFailed(error.format());
  } else {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
});
```

- [ ] **Step 5: ワークスペースとビルドに登録する**

`package.json`:

```json
  "workspaces": ["packages/*", "deploy", "rollback", "token-check", "status"],
```

`tsconfig.json` の `references` に追記する（`./token-check` の後）:

```json
    { "path": "./status" },
```

`vitest.config.ts` の `include` に追記する（`token-check` の後）:

```ts
      'status/src/**/*.test.ts',
```

`scripts/build.mjs` の `ACTIONS` に追記する:

```js
  { entry: 'status/src/index.ts', outfile: 'status/dist/index.cjs' },
```

`.gitignore` に追記する（`token-check/build/` の後）:

```
status/build/
```

`.github/workflows/ci.yml` の2箇所を差し替える:

```yaml
          if [ -n "$(git status --porcelain -- deploy/dist rollback/dist token-check/dist status/dist)" ]; then
            echo "::error::dist がソースと同期していません。'npm run build' を実行してコミットしてください"
            git status --porcelain -- deploy/dist rollback/dist token-check/dist status/dist
            exit 1
          fi
```

```yaml
          for BUNDLE in deploy/dist/index.cjs rollback/dist/index.cjs token-check/dist/index.cjs status/dist/index.cjs; do
```

- [ ] **Step 6: ワークスペースをリンクする**

Run: `npm install`
Expected: `status` が workspace として認識される（この時点では `main.ts` が無いためビルドは通らない）

- [ ] **Step 7: コミット**

```bash
git add status/action.yml status/package.json status/tsconfig.json status/src/index.ts \
  package.json package-lock.json tsconfig.json vitest.config.ts scripts/build.mjs \
  .gitignore .github/workflows/ci.yml
git commit -m "feat(status): デプロイ状況を照会するアクションの骨格を追加"
```

---

## Task 7: サマリを描画する

**Files:**
- Create: `status/src/summary.ts`
- Test: `status/src/summary.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`status/src/summary.test.ts` を作成する。

```ts
import { describe, expect, it } from 'vitest';
import type { StatusTargetResult } from './main.js';
import { renderStatusSummary } from './summary.js';

const BASE: StatusTargetResult = {
  scriptId: 's-1',
  managed: true,
  deploymentId: 'dep-1',
  versionNumber: 38,
  sha: '6251c8c9f2a1b3d4e5f6a7b8c9d0e1f2a3b4c5d6',
  runId: '99',
  pr: 7,
  actor: 'someone',
  createdAt: '2026-08-14T00:00:00Z',
};

describe('renderStatusSummary', () => {
  it('shows the abbreviated sha with the pull request and actor', () => {
    const summary = renderStatusSummary([BASE]);
    expect(summary).toContain('6251c8c');
    expect(summary).toContain('#7');
    expect(summary).toContain('someone');
    expect(summary).toContain('v38');
  });

  // 空欄にすると「調べたが分からなかった」のか「表示漏れ」なのか区別できない。
  it('states that a version was not created by this action', () => {
    const summary = renderStatusSummary([{ scriptId: 's-1', managed: false, versionNumber: 3 }]);
    expect(summary).toContain('CI 管理外');
  });

  it('states that an @HEAD deployment has no version', () => {
    const summary = renderStatusSummary([{ scriptId: 's-1', managed: false, deploymentId: 'head-1' }]);
    expect(summary).toContain('@HEAD');
  });

  it('shows the failure for a target that could not be read', () => {
    const summary = renderStatusSummary([{ scriptId: 's-1', managed: false, error: '403 で拒否されました' }]);
    expect(summary).toContain('取得失敗');
    expect(summary).toContain('403 で拒否されました');
  });

  it('lists every target with its project and environment', () => {
    const summary = renderStatusSummary([
      { ...BASE, project: 'web-app', environment: 'prod' },
      { ...BASE, project: 'sheet-tools', environment: 'prod', versionNumber: 12 },
    ]);
    expect(summary).toContain('web-app');
    expect(summary).toContain('sheet-tools');
    expect(summary).toContain('v12');
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx vitest run status/src/summary.test.ts`
Expected: FAIL — `Failed to load url ./summary.js`

- [ ] **Step 3: 最小の実装を書く**

`status/src/summary.ts` を作成する。

```ts
import type { StatusTargetResult } from './main.js';

/** 由来情報の欄。空欄を作らない。「分からなかった」ことを必ず言葉にする。 */
function renderCommit(result: StatusTargetResult): string {
  if (result.error !== undefined) {
    return `取得失敗: ${result.error}`;
  }
  if (result.managed && result.sha !== undefined) {
    const extras: string[] = [];
    if (result.pr !== undefined) extras.push(`PR #${result.pr}`);
    if (result.actor !== undefined) extras.push(`by ${result.actor}`);
    const suffix = extras.length > 0 ? `（${extras.join(', ')}）` : '';
    return `\`${result.sha.slice(0, 7)}\`${suffix}`;
  }
  if (result.versionNumber === undefined) {
    return '@HEAD（バージョン未固定のため由来なし）';
  }
  return 'CI 管理外（このアクション以外で作られたバージョン）';
}

function renderVersion(result: StatusTargetResult): string {
  if (result.error !== undefined) return '—';
  return result.versionNumber === undefined ? '@HEAD' : `v${result.versionNumber}`;
}

/**
 * 照会結果を Markdown の表で描画する。
 *
 * 単一対象でも表を使う。対象が1つか複数かで書式が変わると、読む側が2つの形式を
 * 覚える必要が生じるだけで、得るものがない。
 */
export function renderStatusSummary(results: readonly StatusTargetResult[]): string {
  const lines: string[] = [
    '## GAS デプロイ状況',
    '',
    '| プロジェクト | 環境 | バージョン | コミット | 作成日時 |',
    '|---|---|---|---|---|',
  ];

  for (const result of results) {
    lines.push(
      [
        '',
        result.project ?? '—',
        result.environment ?? '—',
        renderVersion(result),
        renderCommit(result),
        result.createdAt ?? '—',
        '',
      ].join(' | '),
    );
  }

  lines.push('');

  const failed = results.filter((result) => result.error !== undefined);
  if (failed.length > 0) {
    lines.push(`**${failed.length} 件の対象で状況を取得できませんでした。** 上の表の「取得失敗」を確認してください。`, '');
  }

  return lines.join('\n');
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx vitest run status/src/summary.test.ts`
Expected: FAIL — `StatusTargetResult` が `./main.js` に無いため型解決に失敗する。Task 8 で `main.ts` を作った後に PASS する

> この順序で構わない。`StatusTargetResult` は `main.ts` の公開インターフェースであり、Task 8 で定義する。Task 8 の Step 4 で両方のテストが通ることを確認する。

---

## Task 8: 対象を解決して出力する

**Files:**
- Create: `status/src/main.ts`
- Test: `status/src/main.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`status/src/main.test.ts` を作成する。

```ts
import type { DeploymentStatus } from '@gas-deploy/core';
import { GasDeployError } from '@gas-deploy/core';
import { describe, expect, it } from 'vitest';
import { parseProjectsInput, toTargetResult } from './main.js';

const SHA = '6251c8c9f2a1b3d4e5f6a7b8c9d0e1f2a3b4c5d6';

describe('parseProjectsInput', () => {
  it('treats all as the whole set', () => {
    expect(parseProjectsInput('all')).toEqual(['all']);
  });

  it('splits a comma separated list and trims each name', () => {
    expect(parseProjectsInput(' web-app , sheet-tools ')).toEqual(['web-app', 'sheet-tools']);
  });

  it('drops empty entries produced by a trailing comma', () => {
    expect(parseProjectsInput('web-app,')).toEqual(['web-app']);
  });
});

describe('toTargetResult', () => {
  const target = { project: 'web-app', environment: 'prod', scriptId: 's-1' };

  it('flattens a resolved provenance into the result', () => {
    const status: DeploymentStatus = {
      deploymentId: 'dep-1',
      versionNumber: 38,
      createdAt: '2026-08-14T00:00:00Z',
      webAppUrl: 'https://x',
      provenance: { sha: SHA, runId: '99', pr: 7, actor: 'someone' },
    };
    expect(toTargetResult(target, { status })).toEqual({
      project: 'web-app',
      environment: 'prod',
      scriptId: 's-1',
      deploymentId: 'dep-1',
      versionNumber: 38,
      createdAt: '2026-08-14T00:00:00Z',
      webAppUrl: 'https://x',
      managed: true,
      sha: SHA,
      runId: '99',
      pr: 7,
      actor: 'someone',
    });
  });

  it('marks a version without provenance as unmanaged', () => {
    const result = toTargetResult(target, { status: { deploymentId: 'dep-1', versionNumber: 3 } });
    expect(result.managed).toBe(false);
    expect(result.sha).toBeUndefined();
  });

  it('marks an @HEAD deployment as unmanaged with no version', () => {
    const result = toTargetResult(target, { status: { deploymentId: 'head-1' } });
    expect(result.managed).toBe(false);
    expect(result.versionNumber).toBeUndefined();
  });

  // cause には API の生レスポンスが入りうる。出力とサマリに載せてはならない。
  it('records only the error message, never the cause', () => {
    const error = new GasDeployError('拒否されました (403)', { cause: 'raw body with a token' });
    const result = toTargetResult(target, { error });
    expect(result.error).toBe('拒否されました (403)');
    expect(JSON.stringify(result)).not.toContain('raw body');
  });

  it('stringifies a non-GasDeployError failure', () => {
    const result = toTargetResult(target, { error: new TypeError('boom') });
    expect(result.error).toBe('boom');
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx vitest run status/src/main.test.ts`
Expected: FAIL — `Failed to load url ./main.js`

- [ ] **Step 3: 最小の実装を書く**

`status/src/main.ts` を作成する。

```ts
import { readFile } from 'node:fs/promises';
import * as core from '@actions/core';
import {
  AppsScriptClient,
  type DeploymentStatus,
  GasDeployError,
  getAccessToken,
  getDeploymentStatus,
  parseConfig,
  parseCredentials,
  resolveTargets,
} from '@gas-deploy/core';
import { renderStatusSummary } from './summary.js';

export interface StatusTargetResult {
  /** config モードのみ。単一対象モードでは設定しない。 */
  project?: string;
  environment?: string;
  scriptId: string;
  deploymentId?: string;
  versionNumber?: number;
  /** 由来情報を復元できたか。 */
  managed: boolean;
  sha?: string;
  runId?: string;
  pr?: number;
  actor?: string;
  createdAt?: string;
  webAppUrl?: string;
  /** 読み取りに失敗した場合のメッセージ。 */
  error?: string;
}

export function parseProjectsInput(raw: string): string[] {
  return raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * config モードの設定ファイルを読み込む。
 *
 * deploy / rollback にも同名の関数があるが、案内する次の手順が異なる（status は
 * 書き込みを行わず、projects に all を許す）ため共通化せず個別に持つ。
 */
export async function readConfigFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new GasDeployError(`設定ファイルが見つかりません: ${path}`, {
        cause: error,
        nextSteps: [
          'scriptId を直接指定する場合は script-id 入力を使ってください',
          `gasdeploy.yml を使う場合は ${path} に設定ファイルを作成してください`,
          'config 入力で別のパスを指定している場合は、そのパスが正しいか確認してください',
        ],
      });
    }
    throw new GasDeployError(`設定ファイルを読み取れませんでした: ${path}`, {
      cause: error,
      nextSteps: [
        '設定ファイルのパーミッションを確認してください',
        'config パスがディレクトリになっていないか確認してください',
      ],
    });
  }
}

/**
 * 取得結果を出力用の形に平坦化する。
 *
 * `error` にはメッセージだけを入れる。`cause` には API の生レスポンスが入りうるため、
 * 出力とサマリには絶対に載せない。
 */
export function toTargetResult(
  target: { project?: string; environment?: string; scriptId: string },
  outcome: { status?: DeploymentStatus; error?: unknown },
): StatusTargetResult {
  const result: StatusTargetResult = { scriptId: target.scriptId, managed: false };
  if (target.project !== undefined) result.project = target.project;
  if (target.environment !== undefined) result.environment = target.environment;

  if (outcome.error !== undefined) {
    const error = outcome.error;
    result.error =
      error instanceof GasDeployError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    return result;
  }

  const status = outcome.status;
  if (status === undefined) {
    result.error = '状況を取得できませんでした';
    return result;
  }

  result.deploymentId = status.deploymentId;
  if (status.versionNumber !== undefined) result.versionNumber = status.versionNumber;
  if (status.createdAt !== undefined) result.createdAt = status.createdAt;
  if (status.webAppUrl !== undefined) result.webAppUrl = status.webAppUrl;

  const provenance = status.provenance;
  if (provenance !== undefined) {
    result.managed = true;
    result.sha = provenance.sha;
    if (provenance.runId !== undefined) result.runId = provenance.runId;
    if (provenance.pr !== undefined) result.pr = provenance.pr;
    if (provenance.actor !== undefined) result.actor = provenance.actor;
  }
  return result;
}

export async function run(): Promise<void> {
  // ネットワーク呼び出しの前に、ローカルで判定できる入力を読み切る。
  const scriptIdInput = core.getInput('script-id');
  const deploymentIdInput = core.getInput('deployment-id');

  interface Target {
    project?: string;
    environment?: string;
    scriptId: string;
    deploymentId?: string;
  }
  let targets: Target[];

  if (scriptIdInput) {
    targets = [
      { scriptId: scriptIdInput, ...(deploymentIdInput ? { deploymentId: deploymentIdInput } : {}) },
    ];
  } else {
    const environment = core.getInput('environment');
    if (!environment) {
      throw new GasDeployError('environment の指定が必要です（config モードでは必須です）', {
        nextSteps: [
          'environment 入力に gasdeploy.yml で定義した環境名（例: prod）を指定してください',
          'gasdeploy.yml を使わない場合は script-id 入力で直接指定してください',
        ],
      });
    }
    const configPath = core.getInput('config') || 'gasdeploy.yml';
    const projects = parseProjectsInput(core.getInput('projects') || 'all');
    const config = parseConfig(await readConfigFile(configPath));
    targets = resolveTargets(config, { environment, projects, env: process.env }).map((target) => ({
      project: target.project,
      environment: target.environment,
      scriptId: target.scriptId,
      // deployment-id 入力は config の値より優先する。障害対応で config を書き換えずに
      // 特定のデプロイを名指ししたい場面があるため。
      ...(deploymentIdInput
        ? { deploymentId: deploymentIdInput }
        : target.deploymentId
          ? { deploymentId: target.deploymentId }
          : {}),
    }));
  }

  const credentials = parseCredentials(core.getInput('credentials', { required: true }));
  core.setSecret(credentials.clientSecret);
  core.setSecret(credentials.refreshToken);

  const accessToken = await getAccessToken(credentials);
  core.setSecret(accessToken);
  const client = new AppsScriptClient(accessToken);

  // 全対象を試行してから返す。読み取りなので途中で止めると「調べたかったのに一部しか
  // 分からない」という最も困る結果になる。
  const results: StatusTargetResult[] = [];
  for (const target of targets) {
    try {
      const status = await getDeploymentStatus(client, {
        scriptId: target.scriptId,
        ...(target.deploymentId ? { deploymentId: target.deploymentId } : {}),
      });
      results.push(toTargetResult(target, { status }));
    } catch (error) {
      results.push(toTargetResult(target, { error }));
    }
  }

  const summary = renderStatusSummary(results);
  core.setOutput('summary', summary);

  if (scriptIdInput) {
    const only = results[0];
    if (only === undefined) {
      throw new GasDeployError('対象の解決に失敗しました');
    }
    core.setOutput('managed', String(only.managed));
    core.setOutput('version-number', only.versionNumber ?? '');
    core.setOutput('sha', only.sha ?? '');
    core.setOutput('run-id', only.runId ?? '');
    core.setOutput('pr', only.pr ?? '');
    core.setOutput('actor', only.actor ?? '');
    core.setOutput('created-at', only.createdAt ?? '');
    core.setOutput('deployment-id', only.deploymentId ?? '');
    core.setOutput('web-app-url', only.webAppUrl ?? '');
  } else {
    core.setOutput('targets', JSON.stringify(results));
  }

  await core.summary.addRaw(summary).write();

  const failed = results.filter((result) => result.error !== undefined);
  if (failed.length > 0) {
    core.setFailed(`${failed.length} 件の対象で状況を取得できませんでした`);
  }
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx vitest run status`
Expected: PASS（`main.test.ts` 8 tests、`summary.test.ts` 5 tests）

- [ ] **Step 5: 型検査・ビルド・バンドル起動を確認する**

Run: `npm run typecheck && npm run build && node status/dist/index.cjs`
Expected: 型エラーなし、`built status/dist/index.cjs` が出力され、起動時は `::error::` を含む出力で終了する（`SyntaxError` や `Cannot find module` が出ないこと）

- [ ] **Step 6: 全テストを実行する**

Run: `npm test`
Expected: 全テスト PASS

- [ ] **Step 7: コミット**

```bash
git add status/src/main.ts status/src/main.test.ts status/src/summary.ts status/src/summary.test.ts status/dist
git commit -m "feat(status): デプロイ中のコミットを照会するアクションを追加"
```

---

## Task 9: ドキュメントを更新する

**Files:**
- Modify: `README.md`、`docs/index.html`

- [ ] **Step 1: README に節を追加する**

`README.md` の「認証情報の失効を監視する」節の直前に、次の節を挿入する。

````markdown
## 本番で動いているコミットを知る

GAS には「このスクリプトはどのコミットから作られたか」を記録する場所がない。本 Action はバージョン説明にコミット情報を埋め込み、`status` アクションでそれを引けるようにする。

```yaml
- id: status
  uses: yut0takagi/gas-deploy-action/status@v0
  with:
    credentials: ${{ secrets.CLASPRC_JSON }}
    script-id: ${{ secrets.GAS_SCRIPT_ID }}
    deployment-id: ${{ secrets.GAS_DEPLOYMENT_ID }}

- run: echo "本番は ${{ steps.status.outputs.sha }} (PR #${{ steps.status.outputs.pr }})"
```

`gasdeploy.yml` を使っている場合は `environment` を指定すると、`projects: all` で全プロジェクトの現況を一覧できる。ロールバックと違い読み取りしか行わないため、`all` を許している。

### バージョン説明の形式

```
ci sha=6251c8c9f2a1b3d4e5f6a7b8c9d0e1f2a3b4c5d6 run=31344375660 pr=42 by=yut0takagi
```

`description` 入力を指定した場合は、この後ろに ` | <指定値>` として保持される。**指定値で置き換えない。** 由来を無条件に残すことがこの機能の目的である。

**この形式に完全一致しないバージョンは「CI 管理外」として報告される。** 手動で作成したバージョンや、v0.1.1 以前の `ci-<sha7>-<run_number>` 形式のバージョンが該当する。部分一致から情報を拾うと、人が手で作ったバージョンを CI 製と取り違えるため、意図的に厳格にしている。

### 出力

| 出力 | 説明 |
|---|---|
| `managed` | 由来情報を復元できたか。`false` は CI 管理外または `@HEAD` |
| `version-number` | デプロイが指すバージョン番号 |
| `sha` / `run-id` / `pr` / `actor` | 復元できた由来情報 |
| `created-at` | バージョンの作成日時 |
| `deployment-id` / `web-app-url` | 対象のデプロイ |
| `summary` | 人間可読のサマリ（Markdown） |
| `targets` | config モードでの全対象の結果（JSON 配列） |

config モードでは全対象を試行してから返す。一部が失敗しても他の結果は失われない（1件以上失敗した場合はジョブを失敗させる）。
````

- [ ] **Step 2: README の未リリース注記を追加する**

Step 1 で挿入した節の最初の段落の後に、`token-check` と同じ注記を入れる。

```markdown
> ⚠️ このアクションは**まだリリースされていない**。`v0.1.1` および `v0` タグには含まれていないため、下記の例は次のリリース以降で動作する。それまでは `@main` を指定すること。
```

- [ ] **Step 3: docs/index.html を更新する**

次の3点を反映する。

1. `packages/core` のモジュール構成表（表1）に2行追加する

```html
          <tr><td><code>provenance.ts</code></td><td>由来情報の整形と復元</td><td>完全一致しない説明は「CI 管理外」とし、部分一致から拾わない</td></tr>
          <tr><td><code>status.ts</code></td><td>デプロイ中のバージョンと由来の取得</td><td>読み取りのみ。@HEAD は正常な報告対象として扱う</td></tr>
```

2. エグゼクティブサマリの KPI「提供するアクション」を `3` から `4` に変更する

3. 10節の完成度マトリクスの v2.0 列を `2 / 4` から `3 / 4` に変更し、実装済みに「バージョン↔コミットの対応」を加える

- [ ] **Step 4: コミット**

```bash
git add README.md docs/index.html
git commit -m "docs: status アクションと由来情報の形式を文書化"
```

---

## Task 10: 最終検証

- [ ] **Step 1: CI の5ゲート相当をローカルで再現する**

Run:

```bash
npm run typecheck && npm test && npm run build && git status --porcelain -- deploy/dist rollback/dist token-check/dist status/dist
```

Expected: 型エラーなし、全テスト PASS、4バンドルがビルドされ、`git status` の出力は（コミット済みなら）空

- [ ] **Step 2: 4つのバンドルすべてが起動することを確認する**

Run:

```bash
for BUNDLE in deploy/dist/index.cjs rollback/dist/index.cjs token-check/dist/index.cjs status/dist/index.cjs; do
  echo "--- $BUNDLE ---"
  OUTPUT=$(node "$BUNDLE" 2>&1) || true
  echo "$OUTPUT" | grep -q "::error::" \
    && ! echo "$OUTPUT" | grep -qE "ReferenceError|SyntaxError|Cannot find module|is not defined" \
    && echo "OK" || echo "NG"
done
```

Expected: 4つすべて `OK`

- [ ] **Step 3: 計画2 に進む**

`only-changed` の実装計画（仕様書 §6・§7）を writing-plans スキルで作成する。

---

## Self-Review の結果

**仕様カバレッジ:** §4.1〜4.5（Task 1・2）、§4.2 の埋め込み規則4パターン（Task 1 のテスト）、§4.3 の長さ制御（Task 1）、§4.4 の復元規則（Task 2）、§5.1 の対象解決と `@HEAD`・デプロイ0件（Task 5）、§5.2 入力・§5.3 出力（Task 6）、§5.4 全対象試行（Task 8）、§5.5 サマリ（Task 7）。§11 の既存への変更はすべて Task 3・4・6・9 に割り当て済み。

**型の一貫性:** `ProvenanceSource` / `Provenance` / `VersionDescription`（Task 1・2）、`DeploymentStatus` / `StatusOptions`（Task 5）、`StatusTargetResult`（Task 8、Task 7 から参照）を確認した。`buildVersionDescription` は `{ description, warnings }` を返し、Task 4 の呼び出し側もその形で受けている。

**既知の順序依存:** Task 7 のテストは Task 8 で `StatusTargetResult` が定義されるまで通らない。これは意図的で、Task 7 の Step 4 に明記してある。
