# バージョン↔コミットの対応と、変更分のみデプロイ 設計仕様書

**日付:** 2026-08-14
**対象バージョン:** v0.1.1 の次
**関連:** [v0.1 設計仕様書](2026-08-09-gas-deploy-actions-design.md)（§9 の v2.0 スコープ「変更プロジェクトのみデプロイ」に対応）

---

## 1. 目的とスコープ

clasp との差別化を、**API 直叩き × CI 文脈**という土台にしかできない領域に寄せる。本仕様は2つの機能を扱う。

| 機能 | 解決する痛み | clasp で不可能な理由 |
|---|---|---|
| **バージョン↔コミットの対応** | 「いま本番で動いているのはどのコミットか」が GAS 側から一切分からない | clasp は CI 文脈（sha / run / PR / actor）を持たない |
| **変更のあったプロジェクトのみデプロイ** | モノレポで無変更のプロジェクトにも毎回 API を叩く | clasp は git を知らず、`gasdeploy.yml` の構造も知らない |

### 非スコープ

- **ドリフト検知**（リモート HEAD が CI 管理外で編集されたかの検出）。価値は高いが別機能として判断する
- GitHub compare API による変更検出。git CLI で足りる
- `since` 入力による base の手動指定。base はイベントから決定できるときだけ使う
- `@HEAD` デプロイの由来追跡。`@HEAD` はバージョンを持たないため、原理的に対応できない
- 複数プロジェクトの並列デプロイ。逐次実行の方針（v0.1 設計 §6.3）を変えない

---

## 2. 前提の確認

設計判断の土台になる事実を先に固定する。

**変更分のみデプロイは、デプロイ結果を変えない。** 既存の differ は内容の差分がゼロならスキップするため、git 差分で絞っても最終状態は同じである。得られるのは API 呼び出し回数・レート制限・実行時間の削減だけである。

**そして副作用が1つある。** 誰かがスクリプトエディタでリモートを直接編集した場合、内容ベースの判定なら差分として検出して上書きする（= リポジトリの状態に復元される）。git 差分ベースでスキップすると、**その手編集が生き残る**。

この副作用があるため、`only-changed` は**オプトインで既定オフ**とする。手編集を隠すリスクは、それを選んだ利用者だけが背負う。

---

## 3. アーキテクチャ

既存の分離（純粋ロジックは `packages/core`、副作用はアダプタ）を崩さない。

| パス | 責務 | 副作用 |
|---|---|---|
| `packages/core/src/provenance.ts` | 由来情報の整形と復元 | なし |
| `packages/core/src/changed.ts` | 変更パスから対象を絞る判定 | なし |
| `deploy/src/git.ts` | `git diff` / `git ls-files` の実行 | プロセス起動 |
| `deploy/src/changed-files.ts` | イベントから base を決定し、変更パスを集めるアダプタ | 環境変数・ファイル読み取り |
| `status/` | 新アクション（薄いアダプタ） | API 読み取り |

`git` の実行を `core` に入れない。`core` は GHA も HTTP も知らないという不変条件がテストの速さを支えている。

アダプタ側を `changed-files.ts` としているのは、`core` 側の `changed.ts` と basename が衝突しないようにするためである。同名だと import 元がどちらか読んで分からなくなる。

### 実装は2つの計画に分ける

2機能はコードを共有しない（`provenance.ts` と `changed.ts` の間に依存がない）。したがって実装計画も分ける。

1. **計画1: 由来情報と `status` アクション** — §4・§5
2. **計画2: `only-changed`** — §6・§7

計画1を先に行う。`status` は読み取り専用で既存の挙動を一切変えないため、リスクが低い。

---

## 4. 由来情報（provenance）

### 4.1 形式

```
ci sha=6251c8c9f2a1b3d4e5f6a7b8c9d0e1f2a3b4c5d6 run=31344375660 pr=42 by=yut0takagi
```

- キーの順序は `sha` → `run` → `pr` → `by` に固定する。順序が揺れると復元側の正規表現が複雑になるだけで、得るものがない
- `sha` は40桁すべてを入れる。短縮すると GitHub 側で確実に引けなくなる
- `run` / `pr` / `by` は取得できたときだけ付ける。**空値では付けない**（`pr=` のような欠損表現を作らない）
- 保存場所は Apps Script のバージョン説明のみ。GAS 側に他の保存場所が存在しない

### 4.2 埋め込み規則

| 状況 | 説明文 |
|---|---|
| CI 実行・`description` 入力なし | `ci sha=... run=... pr=... by=...` |
| CI 実行・`description` 入力あり | `ci sha=... run=... \| <指定値>` |
| `GITHUB_SHA` なし（Actions 外）・`description` あり | `<指定値>` |
| `GITHUB_SHA` なし・`description` なし | `manual` |
| `GITHUB_SHA` なし・`description` が**由来情報の形をしている** | `manual \| <指定値>` |

**`description` 入力を由来情報で置き換えない。** 由来を無条件に残すことが本機能の目的であり、指定値を優先して追跡を失う設計は目的と矛盾する。区切りは ` | ` に固定する。

**最後の行が重要である。** Actions 外の経路で指定値をそのまま保存すると、その文字列がたまたま（あるいは意図的に）由来情報の形をしていた場合、後から本物の CI 由来として復元されてしまう。§4.4 の「完全一致のみを受け付ける」という厳格さは、**書き込み側が同じ形の文字列を素通しさせない限り成立しない。** 接頭辞を付けて形を崩し（`ci sha=` で始まらなくなるため復元されない）、その旨を警告に出す。指定値そのものは接頭辞の後に保持する。

### 4.3 長さの制御

`MAX_DESCRIPTION_LENGTH = 250`（保守的な暫定値。§10 参照）。

- 由来情報は常に全長を保持する。切り詰めるのは指定値の側だけ
- 指定値に割ける残余が8文字未満なら ` | ` 以降を付けない。切れ端は情報価値がないため
- 切り詰めた場合は末尾に `…` を付け、切り詰めた事実を警告に出す。**`…` は上限に含める**（付けた結果 251 文字になってはならない）

### 4.4 復元規則

```
/^ci sha=(?<sha>[0-9a-f]{7,40})(?: run=(?<run>\d+))?(?: pr=(?<pr>\d+))?(?: by=(?<by>[^\s|]+))?(?: \| (?<rest>.*))?$/
```

- **完全一致しなければ「CI 管理外」とする。** 部分一致から情報を拾おうとしない。手動作成のバージョンや、GAS の UI で説明を書き換えられたバージョンを、CI が作ったものと取り違える方が有害である
- 旧形式 `ci-<sha7>-<run_number>` は復元しない。7桁 sha からは GitHub 側で一意に引けるとは限らず、`run_number`（連番）は `run_id` と別物で API から辿れないため、復元できても使えない
- `sha` は7〜40桁を受け付ける。将来短縮形式を採る余地を残すためで、現在の生成側は常に40桁

### 4.5 公開インターフェース

```ts
export interface Provenance {
  sha: string;
  runId?: string;
  pr?: number;
  actor?: string;
  /** ` | ` 以降のユーザー指定分。 */
  description?: string;
}

export interface ProvenanceSource {
  sha?: string;
  runId?: string;
  pr?: number;
  actor?: string;
}

/** 説明文を組み立てる。切り詰めが起きた場合は warnings に理由を入れる。 */
export function buildVersionDescription(
  source: ProvenanceSource,
  userDescription: string | undefined,
): { description: string; warnings: string[] };

/** 説明文から由来情報を復元する。完全一致しなければ undefined。 */
export function parseVersionDescription(description: string): Provenance | undefined;
```

---

## 5. `status` アクション

デプロイが指すバージョン → その説明 → 由来情報、の順に引く。**書き込みは一切しない。**

### 5.1 対象の解決

| 入力 | 挙動 |
|---|---|
| `script-id` あり | 単一対象。`config` は読まない |
| `script-id` なし | `config` + `environment` が必須。`projects` は既定 `all` |

`deployment-id` を省略した場合、バージョン付きデプロイがちょうど1つならそれを採用する。複数なら候補を列挙して失敗する（`rollback` と同じ規則を再利用する）。

**`@HEAD` デプロイしか無い場合はエラーにしない。** `rollback` は `@HEAD` を専用エラーにするが、あれは書き換え対象として成立しないためである。`status` は読み取りなので、「`@HEAD` デプロイのため由来情報を持たない」と報告する方が有用である。

**デプロイが1件も存在しない場合はエラーにする。** 調べる対象がそもそも無いのは、scriptId の間違いか、まだ一度もデプロイされていないかであり、どちらも利用者が知るべき情報である。「由来なし」として正常終了させると両者が区別できない。

### 5.2 入力

| 入力 | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `credentials` | ○ | — | 他のアクションと同じ |
| `script-id` | △ | — | 指定すると `config` を読まない |
| `deployment-id` | — | — | 省略時、バージョン付きデプロイが1つのときだけ自動特定 |
| `config` | — | `gasdeploy.yml` | `script-id` 未指定時に読む |
| `environment` | △ | — | config モードでは必須 |
| `projects` | — | `all` | 対象プロジェクト名（カンマ区切り） |

### 5.3 出力

| 出力 | 説明 |
|---|---|
| `managed` | 由来情報を復元できたか（`true` / `false`） |
| `version-number` | デプロイが指すバージョン番号 |
| `sha` | コミットの SHA（復元できた場合） |
| `run-id` | ワークフロー実行 ID（同上） |
| `pr` | PR 番号（同上） |
| `actor` | 実行者（同上） |
| `created-at` | バージョンの作成日時 |
| `deployment-id` | 対象のデプロイ ID |
| `web-app-url` | Web アプリの URL（該当する場合） |
| `summary` | 人間可読のサマリ（Markdown） |
| `targets` | 複数対象時の結果（JSON 配列） |

単一対象向けの出力（`managed` 〜 `web-app-url`）は、複数対象モードでは設定しない。`deploy` の単一／複数モードの扱いに合わせる。

### 5.4 複数対象時の失敗の扱い

**全対象を試行してから結果を返す。** `deploy` は逐次実行して最初の失敗で停止するが、あれは書き込みが進んだ範囲を確定させるためである。`status` は読み取りなので、途中で止めると「調べたかったのに一部しか分からない」という最も困る結果になる。

各要素に `error` を持たせ、1件以上失敗した場合はジョブを失敗させる。成功分もサマリに出す。

### 5.5 サマリ

`project` / `environment` / `version` / `commit` / `作成日時` の表を出す。由来情報を復元できなかった対象は `commit` 欄に「CI 管理外」と明示する。空欄にしない。

---

## 6. `only-changed`

### 6.1 適用範囲

**複数プロジェクトモードのみ。** 単一プロジェクトモードで `only-changed: true` が指定されたらエラーにする。対象が1つしかないため、スキップは「実行全体が無操作」を意味し、得られる利益がリスクに見合わない。

### 6.2 base の決定

| イベント | base |
|---|---|
| `pull_request` / `pull_request_target` | `event.pull_request.base.sha` |
| `push` | `event.before`（40桁すべて `0` なら決定不能） |
| その他（`workflow_dispatch` / `schedule` 等） | 決定不能 |

**決定不能ならエラーにする。** 黙って全件デプロイにフォールバックしない。`only-changed: true` と書いた利用者が、実際には絞り込まれていないことに気づけないためである。

エラーの `nextSteps` に回避策を載せる。

```yaml
only-changed: ${{ github.event_name == 'push' }}
```

### 6.3 変更ファイルの取得

```
git diff --name-only <base>...HEAD
```

- 3点表記（マージベースからの差分）を使う。PR の `base.sha` は PR 作成時点のベース先端であり、2点表記だとベースブランチ側の無関係な変更が混ざる
- head 側は `GITHUB_SHA` ではなく **`HEAD`** を使う。`pull_request` イベントの `GITHUB_SHA` はマージコミットを指すが、ワークフローが `ref: ${{ github.event.pull_request.head.sha }}` を指定してチェックアウトしている場合、そのコミットはローカルに存在せず `git diff` が失敗する。`HEAD` なら実際にチェックアウトされたものを必ず指す
- 失敗したら `fetch-depth: 0` の設定を促すエラーにする。`actions/checkout` の既定は `fetch-depth: 1` で、そのままでは base を参照できない

### 6.4 判定規則

| 条件 | 結果 |
|---|---|
| 変更ファイルが0件 | 全プロジェクトを `skipped`（理由: 変更なし）。正常終了 |
| `config` のパスが変更に含まれる | **全プロジェクトを対象**（理由: 設定変更） |
| 監視パス配下に、`ignore` に一致しない変更が1件以上 | 対象 |
| 上記以外 | `skipped`（理由: 変更なし） |

`gasdeploy.yml` の変更で全件に倒すのは、`rootDir` や `ignore` の意味が変わった可能性があり、変更の影響範囲を静的に判定できないためである。

`ignore` は監視パスにも適用する。テストファイルだけの変更でデプロイしないため。相対化の基準は「一致した監視パス」とする。

**「監視パス配下」の判定規則を明示する。** 変更パス `p` が監視パス `w` の配下であるとは、`p === w` または `p` が `w + '/'` で始まることをいう。単純な前方一致にすると、`watch: apps/web` が `apps/web-app/src/Code.js` に誤って一致する。両方が存在する構成は現実的にありうるため、この誤判定は「変更していないプロジェクトを毎回デプロイする」形で表面化する。

### 6.5 ⚠️ `root-dir` がビルド出力である場合の罠

README は「`root-dir` にはビルド済み JS を指定する」と明記しており、`dist/` は通常 gitignore される。**この構成に素朴な git 差分フィルタを載せると、変更が永久に検出されず全プロジェクトがスキップされ、静かに何もしないデプロイになる。** 推奨構成そのものが罠になる。

対策は2段構えとする。

1. `gasdeploy.yml` に任意の `watch:`（監視するソースパス）を追加する。既定は `[rootDir]`
2. **有効な監視パスに git 追跡ファイルが1件も無ければエラーにする。** `git ls-files -- <path>` が空かどうかで判定する。`only-changed` が有効なときだけ実行する

2 が本質である。設定漏れを黙って通さないことで、この罠が事故になる経路を閉じる。

### 6.6 スキップの表現

既存の `skipped` ステータスを再利用する。`deployments` 出力とサマリに**理由を明記**する。理由のないスキップは「なぜデプロイされていないのか」を調べる時間を生むだけである。

### 6.7 公開インターフェース

```ts
export interface ChangeFilterTarget {
  project: string;
  environment: string;
  /** 監視するリポジトリ相対パス。空配列は不可。 */
  watch: readonly string[];
  ignore: readonly string[];
}

export interface ChangeFilterResult<T> {
  selected: T[];
  skipped: { target: T; reason: string }[];
  /** 設定ファイルの変更で全件対象にした場合に true。 */
  configChanged: boolean;
}

export function filterChangedTargets<T extends ChangeFilterTarget>(
  targets: readonly T[],
  changedPaths: readonly string[],
  options: { configPath: string },
): ChangeFilterResult<T>;
```

---

## 7. `gasdeploy.yml` のスキーマ拡張

```yaml
projects:
  web-app:
    rootDir: apps/web-app/dist
    watch:
      - apps/web-app/src
      - packages/shared
    environments:
      prod:
        scriptId: ${PROD_WEBAPP_SCRIPT_ID}
```

- `watch` は任意。文字列配列
- **空配列はエラー**にする。「監視しない」は `only-changed` の下では「常にスキップ」を意味し、書き手の意図と一致しない
- 未指定時の既定は `[rootDir]`
- `${VAR}` 展開の対象とする（`rootDir` と同じ扱い）
- `defaults` には置かない。監視パスはプロジェクト固有であり、共通の既定値に意味がない

`ResolvedTarget` に `watch: readonly string[]` を追加する（常に解決済みの値が入り、`undefined` を持たせない）。

---

## 8. エラー処理

すべて既存の `GasDeployError` + `nextSteps` に載せる。**新しい機械可読コード（`GasErrorCode`）は追加しない。** 今回追加する失敗はすべて設定ミスであり、呼び出し側が分岐して挙動を変える必要がないためである。

| 失敗 | 案内する内容 |
|---|---|
| base が決定不能 | イベント名、`only-changed` を式で切り替える例、`only-changed: false` |
| `git diff` の失敗 | `fetch-depth: 0` の設定、base と head の値 |
| 監視パスが git 未追跡 | 該当プロジェクト名、`watch` の設定方法、`rootDir` がビルド出力である可能性 |
| 単一モードでの `only-changed` | 複数プロジェクトモード専用であること、単一なら差分ゼロで既にスキップされること |
| `watch` が空配列 | 監視パスを1つ以上書くか、`watch` を省略して `rootDir` を使うこと |

---

## 9. テスト戦略

`provenance.ts` と `changed.ts` は純粋関数なので単体テストで網羅する。アダプタは既存規約どおり純粋ヘルパを切り出してテストする（`run()` 自体はテストしない）。

**provenance**

- 形式の往復（全フィールドあり / `pr`・`by` 欠落）
- ユーザー指定分の後置と復元
- 250文字での切り詰めと警告、残余8文字未満での ` | ` 省略
- 完全一致しない説明は `undefined`（旧形式 `ci-abc1234-5`、手書き、前後に余分な文字）
- `GITHUB_SHA` なしの3経路

**changed**

- 設定ファイル変更で全件対象になる
- `watch` 未指定時に `rootDir` が使われる
- 複数の監視パスのいずれかに変更があれば対象
- `ignore` に一致する変更だけならスキップ
- 変更0件で全件スキップ
- 監視パス外の変更（README 等）は無関係
- サブディレクトリ配下の変更を拾う
- パスの前方一致誤判定を起こさない（`apps/web` と `apps/web-app`）

**アダプタ**

- base の決定（`pull_request` / `push` / 全ゼロ / その他）
- 単一プロジェクトモードでの `only-changed` 拒否
- `status` の対象解決と `@HEAD` の扱い
- サマリ描画（`managed` / CI 管理外 / 失敗を含む複数対象）

---

## 10. 未確定事項

| # | 内容 | 影響 | 検証タイミング |
|---|---|---|---|
| 1 | **Apps Script のバージョン説明の最大長** | 由来情報は約115文字で、ユーザー指定分を足すと超えうる。暫定で全体250文字に打ち切る。実際の上限がこれより短ければ、由来情報だけで超過して `versions.create` が失敗する | 実 API が必要。E2E 用 Secrets の設定後 |
| 2 | `git ls-files` が利用できない環境 | ランナーには git が入っているが、コンテナジョブなど git の無い環境では監視パスの検証ができない。その場合は検証をスキップせずエラーにする（黙って通す方が危険） | 実 CI で確認 |

未確定事項 #1 が「250文字より短い」だった場合、由来情報から `by` → `pr` → `run` の順に落とす。`sha` は最後まで残す。

---

## 11. 既存への変更

| ファイル | 変更 |
|---|---|
| `packages/core/src/config.ts` | `watch` の解析、`ResolvedTarget` への追加 |
| `packages/core/src/index.ts` | 新モジュールの再エクスポート |
| `deploy/action.yml` | `only-changed` 入力の追加 |
| `deploy/src/main.ts` | 説明文の生成を `provenance` に差し替え、`only-changed` の経路を追加 |
| `deploy/src/summary.ts` | スキップ理由の表示 |
| `vitest.config.ts` / `tsconfig.json` / `package.json` / `scripts/build.mjs` / `.github/workflows/ci.yml` | `status` アクションの登録（4バンドル目） |
| `README.md` / `docs/index.html` | 2機能の文書化、`watch` のスキーマ、罠の明記 |

**既定の説明文の形式が変わる。** 破壊的変更ではない（説明文は単なるラベルで、挙動を変えない）が、過去のバージョンは `status` から「CI 管理外」と報告される。README に明記する。
