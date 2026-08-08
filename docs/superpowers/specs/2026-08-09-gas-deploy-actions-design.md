# gas-deploy-actions 設計仕様書

- **作成日**: 2026-08-09
- **ステータス**: 設計承認済み / 実装計画待ち
- **リポジトリ**: `gas-deploy-actions`

---

## 1. 目的とスコープ

Google Apps Script（GAS）のデプロイを GitHub Actions で自動化する、**再利用可能な OSS GitHub Action** を提供する。

対象とする GAS プロジェクトの種別は限定しない。Web アプリ、Workspace アドオン、コンテナバインドスクリプト、スタンドアロンスクリプトのすべてを扱う。

### 中心価値（3軸）

1. **認証の苦痛を消す** — トークン発行を対話 CLI で一発化し、Workspace / 個人 Gmail の両方に対応する
2. **マルチプロジェクト対応** — 1リポジトリに複数 GAS プロジェクトを置き、環境別（dev/stg/prod）にデプロイする
3. **デプロイ安全性** — dry-run、差分表示、既存デプロイの更新による URL 維持、ロールバック

3軸すべてを最終的に実装するが、段階リリースで順に届ける（§9）。

### 非スコープ

- TypeScript のトランスパイル（§6.1 で理由を記述）
- GAS プロジェクトの新規作成（`projects.create`）
- Apps Script 以外の Google サービスの操作

---

## 2. 技術的前提と制約

### 2.1 サービスアカウントは使用できない

Apps Script API は Google 側の仕様としてサービスアカウントのトークンを受け付けない。clasp v3 に CI 向けの `--adc`（Application Default Credentials）オプションが存在するが、公式 README 上で **EXPERIMENTAL / NOT WORKING** と明記されている。

したがって **Workload Identity Federation によるクリーンな CI 認証は現時点で成立しない**。ユーザーアカウントの refresh token を GitHub Secrets に格納する方式が唯一の現実解である。

この制約は本プロジェクトが解決できるものではなく、Google 側の仕様変更を待つほかない。ドキュメントで明示する。

### 2.2 使用する Apps Script API

| エンドポイント | 用途 |
|---|---|
| `GET  /v1/projects/{scriptId}/content` | 現在の HEAD 取得（差分計算用） |
| `PUT  /v1/projects/{scriptId}/content` | HEAD の**アトミック全置換** |
| `POST /v1/projects/{scriptId}/versions` | バージョン発番 |
| `GET/POST/PUT/DELETE /v1/projects/{scriptId}/deployments` | デプロイ管理 |

`updateContent` は既存ファイルを全消去してから書き込むため、**デプロイの原子性が API レベルで保証される**。中途半端な状態は発生しない。

ファイルリソースは `name`（拡張子なし）/ `type`（`SERVER_JS` | `HTML` | `JSON`）/ `source` で表現される。`appsscript` という名前の `JSON` ファイル（マニフェスト）が必須。

### 2.3 要求 OAuth スコープ

- `https://www.googleapis.com/auth/script.projects`
- `https://www.googleapis.com/auth/script.deployments`

clasp は Drive 全体を含む遥かに広いスコープを要求する。**最小権限であること自体をセキュリティ上の差別化とする。**

**リフレッシュ交換時に `scope` を明示的に指定すること。** 省略すると元のリフレッシュトークンに付与された全スコープがそのまま返る（RFC 6749 §6）。clasp 由来の認証情報をそのまま受理する設計である以上、指定を省略すればこの差別化は成立しない。Google が絞り込みを受け付けること、およびこの2スコープで全操作が動くことは実測で確認済み（§10 #2）。

---

## 3. 既存 OSS との差別化

| 既存 OSS | 方式 | 弱み |
|---|---|---|
| `daikikatsuragawa/clasp-action` | Docker | 認証を5つの input でバラ渡し。単一プロジェクトのみ。clasp v2 世代。v1.1.0 で停滞 |
| `ericanastas/deploy-google-app-script-action` | Composite | 作者自身が *"the whole system is a hack"* と明記。単一プロジェクト前提 |
| `namaggarwal/clasp-token-action` | — | `.clasprc.json` を生成するだけの単機能 |

空いているポジション: clasp v3 / Node 22 対応、モノレポ、環境別デプロイ、`deploymentId` 更新のファーストクラス扱い、初期セットアップ体験。

### 採用アプローチ

**TypeScript 製 JS Action ＋ Apps Script API 直叩き ＋ セットアップ CLI 同梱。**

clasp CLI をラップする案も検討したが却下した。dry-run、差分表示、ロールバック、デプロイ上限の自動回収は、いずれも clasp CLI の外側からは実装できない。既存 OSS が「hack」化している根本原因は、clasp の対話プロンプト・エラー出力・バージョン間の仕様変更に振り回される構造にある。

**トレードオフ**: API 直叩きにすると「clasp 互換」を自前で保証する責任を負う（`.claspignore` の解釈、ファイル種別判定、`appsscript.json` の扱い）。このリスクは §8 のゴールデンテストで管理する。

---

## 4. アーキテクチャ

### 4.1 レイヤ分割

中心のロジックは GitHub Actions を一切知らない。

```
┌──────────────────────────────────────────────────┐
│ deploy/action.yml      refresh-token/action.yml   │  GHA アダプタ（薄い）
│   inputs → core 呼出 → outputs / job summary      │
└──────────────────────────────────────────────────┘
                     ↓ 依存
┌──────────────────────────────────────────────────┐
│ packages/core                                     │  純ロジック（GHA 非依存）
│   auth / config / file-collector /                │
│   differ / deployer / api-client / errors         │
└──────────────────────────────────────────────────┘
                     ↑ 依存
┌──────────────────────────────────────────────────┐
│ packages/setup-cli   (npx gas-deploy-setup)       │  ローカル実行のトークン発行 CLI
└──────────────────────────────────────────────────┘
```

`core` を GHA 非依存にする理由:

- 単体テストが GHA ランナー無しで高速に回る
- setup-cli が同じ API クライアントを再利用できる
- 将来 GitLab CI やローカル実行へ展開する余地を残す

### 4.2 リポジトリ構成

リポジトリ名が複数形であることに合わせ、複数アクションを1リポジトリで提供する。

```
gas-deploy-actions/
├── deploy/
│   ├── action.yml          # uses: <owner>/gas-deploy-actions/deploy@v1
│   └── dist/index.js       # バンドル済み（コミット対象）
├── refresh-token/
│   ├── action.yml          # uses: <owner>/gas-deploy-actions/refresh-token@v1
│   └── dist/index.js
├── packages/
│   ├── core/               # 純ロジック + 単体テスト
│   └── setup-cli/          # npm 公開（npx gas-deploy-setup）
└── .github/workflows/      # 自身の CI + dist 差分チェック + E2E
```

### 4.3 データフロー

```
gasdeploy.yml + workflow inputs
   ↓ config resolver      環境(dev/stg/prod)とプロジェクトを解決
   ↓ auth                 refresh token → access token
   ↓ file collector       .claspignore 互換 → File[] (name/type/source)
   ↓ differ               projects.getContent と比較
   ↓  ── dry-run ならここで終了し、差分をサマリ出力 ──
   ↓ projects.updateContent      HEAD をアトミック更新
   ↓ projects.versions.create    バージョン発番
   ↓ deployments.update          既存 deploymentId を更新（URL 維持）
   ↓ outputs + job summary
```

`differ` を `updateContent` の前段に独立させることで、dry-run・PR コメント・「差分ゼロならスキップ」が同一の部品で実現される。

---

## 5. 設定スキーマと Action インターフェース

### 5.1 二段構え

設定ファイルは**任意**とする。単一プロジェクトのユーザーに YAML を強制すると導入障壁になるため。

- **軽量モード** — `script-id` などを action の input で直接渡す。既存 OSS からの乗り換えがそのまま効く
- **設定ファイルモード** — `gasdeploy.yml` を置くとモノレポ・複数環境が使える

input が設定ファイルより優先。両方無ければエラー。

### 5.2 `gasdeploy.yml`

```yaml
version: 1

defaults:
  ignore:
    - "**/*.test.ts"
    - "node_modules/**"

projects:
  web-app:
    rootDir: apps/web-app/dist
    type: webapp              # webapp | addon | bound | standalone
    environments:
      dev:
        scriptId: ${DEV_WEBAPP_SCRIPT_ID}
      prod:
        scriptId: ${PROD_WEBAPP_SCRIPT_ID}
        deploymentId: ${PROD_WEBAPP_DEPLOYMENT_ID}

  sheet-tools:
    rootDir: apps/sheet-tools/dist
    type: bound
    environments:
      prod:
        scriptId: ${SHEET_TOOLS_SCRIPT_ID}
```

`${VAR}` は本ツールが環境変数から展開する。GHA の `${{ }}` はリポジトリ内の素の YAML では展開されないため、**あえて別記法**として混同を防ぐ。これにより scriptId をリポジトリに直書きしたくないユーザーにも対応する。

`type` の役割は**バリデーションとデフォルト値のみ**である。`webapp` / `addon` で `deploymentId` が未指定の場合に警告を出す。これは「デプロイしたら Web アプリの URL が変わり本番が停止する」という GAS で最も頻度の高い事故を防ぐためであり、`type` を持つ価値はこの一点に集約される。

### 5.3 `deploy` アクションの入出力

```yaml
inputs:
  credentials:      # 必須（§5.4）
  config:           # 既定 ./gasdeploy.yml（無ければ軽量モード）
  environment:      # 例 prod
  projects:         # 例 "web-app,sheet-tools" / "all"（既定）
  script-id:        # 軽量モード用
  deployment-id:    #   〃
  root-dir:         #   〃
  dry-run:          # 既定 false
  create-version:   # 既定 true
  description:      # 既定 "ci-<sha7>-<run_number>"

outputs:
  changed:          # 差分の有無（true/false）
  deployments:      # JSON 配列（project / scriptId / versionNumber / deploymentId / webAppUrl）
  summary:          # 人間可読サマリ（job summary にも自動出力）
```

### 5.4 認証情報フォーマット

`credentials` は **clasp の `.clasprc.json` をそのまま受理する。**

```yaml
- uses: <owner>/gas-deploy-actions/deploy@v1
  with:
    credentials: ${{ secrets.CLASPRC_JSON }}
```

既存の clasp ユーザーが**シークレットを1文字も変更せずに乗り換えられる**ことを移行ストーリーの中心に据える。API 直叩きに変えても、ユーザーから見た入口は clasp のままである。

加えて自前の最小フォーマット（`client_id` / `client_secret` / `refresh_token` の3つのみ）も受理する。setup-cli はこちらを生成する。`.clasprc.json` は access token など不要な情報を含むため、新規ユーザーには最小形式を推奨する。

> **未確定 #1**: clasp v3 で `.clasprc.json` のスキーマが v2 から変わっている可能性がある。v2/v3 両形式のパースをサポートする前提で設計し、実装時に実物を確認して確定する。

---

## 6. デプロイエンジン

### 6.1 file-collector

`rootDir` を走査し、Apps Script API の `File[]` に変換する。

| 入力 | `name` | `type` |
|---|---|---|
| `Code.js` / `Code.gs` | `Code` | `SERVER_JS` |
| `ui/Sidebar.html` | `ui/Sidebar` | `HTML` |
| `appsscript.json` | `appsscript` | `JSON` |

`.claspignore` があれば読むが、`ignore` 設定が非空の場合は `.claspignore` を読まずに `ignore` の内容で**置き換える**（マージはしない。glob 記法は clasp と同一）。`appsscript.json` が存在しない場合は `updateContent` が必ず失敗するため、**API を叩く前にローカルでエラーとする**。

**TypeScript のトランスパイルは実装しない。** clasp v2 は `.ts` を独自にトランスパイルするが、これは意図的に非互換とする。モダンな GAS 開発では esbuild / rollup による自前ビルドが主流であり、clasp の独自変換は制御しづらい。`rootDir` に**ビルド済み JS を置く前提**とし、README に明記する。これは機能ではなく**割り切り**として文書化する。

> **未確定 #5**: サブディレクトリを `/` 区切りの `name`（例 `ui/Sidebar`）で表現できるかは実 API の挙動で確認する。GAS のエディタはフラット構造に見えるが `/` を含む名前を保持する。

### 6.2 differ

`projects.getContent` で現在の HEAD を取得し、正規化して比較する。

- **正規化**: 改行コードを LF に統一、末尾改行を揃える → 偽差分によるバージョン番号の無駄な消費を防ぐ
- **比較**: `name` + `type` をキーに added / modified / deleted を算出

**差分ゼロなら `updateContent` もバージョン作成も丸ごとスキップ**し、`changed: false` を返す。GAS はバージョン番号もデプロイ数も有限資源であるため実用上の効果が大きい。

dry-run 指定時はここで終了し、差分を job summary に出力する。同じ部品が PR コメント（v2.0）にもそのまま使える。

**往復一致は実測で確認済み**（§10 参照）。push した内容を `getContent` で取得し直すと、`appsscript.json` を含めて `normalizeSource` 適用後にバイト単位で一致する。API による JSON の再整形も BOM 付与も起きない。この性質が崩れると差分が永久に収束せず、毎回バージョンを消費し続けることになるため、前提として明記しておく。

### ⚠️ skip-when-unchanged の副作用: 部分的に成功したデプロイが救済されない

次の連鎖が成立しうる。

1. `updateContent` が成功する（HEAD は新しい内容になる）
2. `versions.create` が 5xx で失敗し、実行全体が失敗する
3. 利用者が再実行する。HEAD は既に新しいので**差分ゼロ**と判定される
4. `changed: false` を返してすべてスキップする。**バージョンもデプロイも作られない**

結果として、実行は成功と表示されるのにデプロイは古いバージョンを指したままになる。差分ゼロを信頼するがゆえの穴である。

v0.1 での緩和策:

- **`POST` は 5xx でリトライしない。** サーバ側で処理が完了したかどうか判別できないため、リトライするとバージョンやデプロイが二重に作られる。Apps Script には冪等キーが無く事後の検出もできない。デプロイは20枠しかないので、誰も知らないデプロイが1枠を占有する事態は避ける。`429` は処理前の拒否なのでリトライしてよい
- **`POST` が 5xx で失敗したときは、部分的な書き込みが起きた可能性と、再実行では救済されないことを明示的に案内する。** 静かな穴を、発生した瞬間の大きな警告に変える

根本的な解決（デプロイが指すバージョンと HEAD の内容を突き合わせてから skip を判断する）は v1.0 以降で検討する。

### 6.3 deployer

```
updateContent          HEAD をアトミック更新
  ↓
versions.create        description = "ci-<sha7>-<run_number>"
  ↓
deploymentId あり ─→ deployments.update  既存を更新（URL 維持）★
deploymentId なし ─→ deployments.create  新規（URL が変わる）
  ↓
entryPoints から webAppUrl を抽出して output へ
```

★ が本番事故を防ぐ経路である。`type: webapp | addon` で `deploymentId` が未指定の場合、実行前に警告を出す。ただし**差分がある場合にのみ**警告する。何もしない実行で毎回鳴らすと、本当に危険な実行の警告が埋もれるため。dry-run では「実際に走らせたらどうなるか」を示す必要があるので出す。

### ⚠️ 大量削除の防護

`updateContent` が全ファイルをアトミックに置換するということは、**ローカルの集合がそのまま真実になる**ということでもある。したがって `root-dir` の指定ミス・ビルド失敗・include glob の絞りすぎのいずれでも、**稼働中のスクリプトからファイルが消える**。

しかも `file-collector` の「`appsscript.json` が無ければ失敗」というガードは、この事故を捕まえられない。最も危険なケース（`root-dir` にマニフェストだけが存在する）では、そのマニフェストがあるがゆえにガードを通過してしまう。レビューで実際に再現された。

対処として、**リモートの半分以上が削除される場合に警告する**（`MASS_DELETION_RATIO = 0.5`、ただし2件未満では鳴らさない）。通常のリファクタで1〜2ファイル消すケースでは黙り、設定ミスのケースでだけ鳴る。dry-run でも表示されるので実行前に気づける。

v0.1 では警告に留め、実行の中断はしない。中断を既定にすると正当な大規模削除ができなくなる。明示的な確認フラグは v1.0 以降で検討する。

### ページネーションの打ち切り

`deployments.list` が同じ `nextPageToken` を返し続けると、各ページが正常な 200 のためリトライ予算も効かず、CI ジョブが GitHub のタイムアウトまで停止する。ページ数に上限（20）を設け、超えたら案内付きエラーで失敗する。空文字列のトークンは「無し」として扱う。

デプロイ数上限については、`deployments.list` で現在数を取得し**閾値超過を警告するのみ**とする。自動削除は破壊的であるため、明示オプトインの機能として v2.0 に回す。

数え方には2つの落とし穴があり、どちらも実測で確認済み（§10 #4）。

1. **`pageSize` を明示しないと1件しか返らない。** 指定し、`nextPageToken` があれば追従する
2. **数えるのはバージョン付きデプロイのみ。** `@HEAD` は常に存在し上限の対象外なので、総数で数えると1件ずれる

ロールバックはバージョンが残る性質を利用し、`deployments.update` で過去の `versionNumber` を指すだけで実現できる。v2.0 で `rollback` アクションとして提供する。

> **未確定 #4**: 「アクティブなデプロイは20個まで」という制約はコミュニティ報告ベースであり、公式ドキュメントに記載がない。真偽と正確な単位を実測で確認する。

### 6.4 エラーハンドリング

既存 clasp 運用の最大の不満は、エラーが何を意味するか分からない点にある。ここを正面から解決する。

| 状況 | 挙動 |
|---|---|
| `403` Apps Script API 無効 | `script.google.com/home/usersettings` の URL と手順を提示 |
| `401` / `invalid_grant` | 「refresh token が失効しています。同意画面が『テスト』状態の場合7日で失効します」と原因候補を列挙 |
| `404` scriptId | 「scriptId が誤っているか、認証アカウントに閲覧権限がありません」 |
| `429` / `5xx` | 指数バックオフで自動リトライ（最大3回） |
| `appsscript.json` 不在 | API を叩く前にローカルで検出して停止 |

全エラーを自前の型に包み直し、**「何が起きたか」ではなく「次に何をすべきか」**を出力する。

---

## 7. 認証コンポーネント

### 7.1 設計上の単純化: 「自動更新」ではなく「死活監視」

既存 OSS（`ericanastas/...`）は週次で Secrets を書き換えてトークンを更新している。これが「hack」と自認されている中身である。

しかし **refresh token は失効しない限り不変**である。あの実装が週次更新を必要とするのは、`.clasprc.json` を丸ごと保存しており、その中の access token が1時間で切れるためである。

**本設計は refresh token のみに依存する**ため、自動更新の仕組み自体が不要になる。§5.4 の通り `.clasprc.json` 形式も受理するが、そこから読み取るのは `client_id` / `client_secret` / `refresh_token` の3つだけであり、**同梱される access token / id_token は無視して毎回新規に取得する**。したがって入力形式にかかわらず「保存されたトークンが古くなる」という状態は発生しない。

結果として `refresh-token` アクションの役割は「更新」ではなく **「死活監視」** となる。

```
週次 cron → refresh token で access token 取得を試行
   ├─ 成功 → 何もしない
   └─ 失敗 → Issue を自動起票
```

失効をゼロにはできないため、**壊れたことを早く知る**方向に倒す。本番デプロイが必要になった瞬間に初めて失効に気づく事態を防ぐ。

### 7.2 refresh token が失効する条件

「無期限」と言い切れないため、CLI とドキュメントで明示する。

| 条件 | 対策 |
|---|---|
| **同意画面が「テスト」状態 → 7日で失効** | CLI が状態を確認し「本番」/「内部」への変更を促す。**最大の事故要因** |
| **再認証要求（`invalid_rapt`）** | **実環境で観測済み・原因未特定。** clasp v3.3.0 で個人 Gmail アカウントにログインした直後（トークン取得から2分後）にもかかわらず、トークン交換が `invalid_grant` + `error_subtype: invalid_rapt` で失敗した。RAPT（ReAuth Proof Token）は対話的な再認証を要求するもので、保存済みリフレッシュトークンでは供給できない。**もしこれが clasp 由来の認証情報で恒常的に起きるなら、本プロジェクトの認証方式の前提そのものに関わる。** 切り分けと結論は §10 未確定 #7 を参照 |
| 6ヶ月間未使用 | 週次死活監視が実質的に防ぐ |
| アカウントのパスワード変更 | 専用デプロイアカウントの利用を推奨して緩和 |
| 同一クライアント × ユーザーで発行が100個超 | 古いものから無効化される旨を明記 |
| 管理者による失効 | 死活監視で検知 |

### 7.3 `npx gas-deploy-setup`

トークン発行は参入障壁そのものであるため、対話 CLI ですべて面倒を見る。

```
1. アカウント種別を判定            Workspace か個人 Gmail か
2. GCP プロジェクトの案内          作成手順 or 既存選択
3. Apps Script API を2箇所で有効化  GCP 側 API + script.google.com/home/usersettings
                                   （後者の忘れが定番の詰まりポイント）
4. OAuth 同意画面の設定            Workspace → 「内部」
                                   個人      → 「外部 + 本番公開」を明示的に指示
5. OAuth クライアント（デスクトップ）作成 → client_id / secret を入力
6. ブラウザ認可 → localhost で code 受領 → refresh_token 取得
7. 検証: 実際に access token を取得し、対象 scriptId が読めるか確認
8. gh CLI があれば `gh secret set GAS_CREDENTIALS` まで実行
```

**ステップ7の検証が肝である。**「セットアップは通ったが CI で初めて失敗する」を潰す。

### 7.4 ログ安全性

access token と credentials は `@actions/core.setSecret()` で必ずマスクし、エラー時のスタックトレースにも載らないようにする。API クライアント層で例外を包み直す。

---

## 8. テスト戦略

案 A の最大のリスクは「clasp 互換を自前で保証する責任」である。これに正面から手当てする。

| レベル | 内容 | 実行頻度 |
|---|---|---|
| **1. core 単体テスト** | `core` は GHA も HTTP も知らないため Vitest で高速に回る。file-collector・differ・config resolver・エラー分類を固める | 常時 |
| **2. API クライアントのモックテスト** | 実 API のレスポンスを fixture として記録し MSW で再生。429 リトライや 401 分類も再現 | 常時 |
| **3. clasp 互換ゴールデンテスト ★** | 同一の `rootDir` に対し、実際の clasp が生成する `File[]` と本実装の file-collector 出力を突き合わせる。clasp を devDependency に入れ内部変換結果を fixture 化 | 常時 |
| **4. 実 GAS への E2E** | 専用テストアカウントの scriptId に対し `push → getContent 検証 → デプロイ → ロールバック → 後片付け` を通す | 週次 + リリース前 |
| **5. dist 同期チェック** | ビルドして `git diff` が出たら CI を失敗させる | 常時 |

★ が案 A のリスクを潰す中核である。`.claspignore` の解釈違い、拡張子マッピング、サブディレクトリの扱いといった互換の穴を、GAS に一切触れずに検出できる。

レベル4 はシークレットを必要とするため、**fork からの PR では実行しない**。これを怠ると外部コントリビュータの PR がすべて失敗する。

---

## 9. 段階リリース

| | スコープ | 認証の入口 |
|---|---|---|
| **v0.1**<br>内部検証 | `deploy` アクション（単一プロジェクト）／API 直叩き／differ + dry-run／既存 `deploymentId` 更新／エラーメッセージ整備 | **clasp の `.clasprc.json` を借りる**（setup-cli 不要） |
| **v1.0**<br>公開・Marketplace | `gasdeploy.yml` によるモノレポ・複数環境／`setup-cli` 完成版／`refresh-token` 死活監視／job summary／README・サンプル／E2E | setup-cli で自己完結 |
| **v2.0** | PR への差分コメント／`rollback` アクション／デプロイ上限の自動回収（オプトイン）／変更プロジェクトのみデプロイ | — |

**v0.1 で setup-cli を作らないことが要点である。** clasp 互換の認証情報を受理するため、既存 clasp ユーザーはトークン発行の手間ゼロで試せる。認証という最も重い部分を後回しにしても v0.1 が単体で価値を持つ。

中心価値の3軸は段階に対応する。v0.1 が「安全性の基礎」、v1.0 が「認証の苦痛を消す + マルチプロジェクト」、v2.0 が「高度な安全性」。

---

## 10. 未確定事項

実装時に確定させる。番号は本文中の参照に対応する。

| # | 内容 | 影響 | 検証タイミング |
|---|---|---|---|
| 1 | ~~clasp v3 の `.clasprc.json` スキーマ~~ | **解決済み。** 実物は `{ tokens: { <アカウント名>: { client_id, client_secret, type, refresh_token, access_token, ... } } }`。両形式パースで吸収できている | 実測で確定 |
| 2 | ~~Web アプリのデプロイに `script.webapp.deploy` が必要か~~ | **解決済み。不要。** リフレッシュ交換時に `scope` を指定して2スコープに絞ったトークンで、`getContent` / `updateContent` / `versions.create` / `deployments.create` の全てが成功した。setup-cli を待たずに確定 | 実測で確定 |
| 3 | `script.projects` が Google の審査対象スコープ（sensitive/restricted）か | **個人 Gmail 対応の難易度を左右する最大の不確定要素** | **v0.1 実装初日** |
| 4 | ~~デプロイ数上限20の真偽と正確な単位~~ | **解決済み。バージョン付きデプロイ20個まで**（`@HEAD` は別枠。21個目で `FAILED_PRECONDITION`）。**併せて `deployments.list` の重大な落とし穴が判明（下記）** | 実測で確定 |
| 5 | ~~サブディレクトリを `name` に `/` 区切りで表現できるか~~ | **解決済み。できる**（`ui/Sidebar` として格納される） | 実測で確定 |
| 6 | ~~clasp v3 の `.clasprc.json` が複数ユーザーを保持しうるか~~ | **解決済み。保持しうる。** 実物は `{ tokens: { <アカウント名>: {...}, default: {...} } }` の形だった | 実測で確定 |

| 7 | ~~`invalid_rapt` の原因~~ | **解決済み。本実装のバグだった**（Google 側の問題ではない） | 実測で確定 |

**#4 の補足: `deployments.list` は既定で1件しか返さない**

上限に到達した状態（`@HEAD` 1件 + バージョン付き20件 = 21件）で一覧を取得したところ、クエリパラメータの有無で結果が変わった。

| リクエスト | 返却件数 |
|---|---|
| `GET /deployments` | **1** |
| `GET /deployments?pageSize=50` | **21** |

`pageSize` を指定しないと `@HEAD` の1件しか返らない。当初の `AppsScriptClient.listDeployments()` は `pageSize` を渡していなかったため、**常に1を返し、deployer の「閾値超過を警告」は永久に発火しない**状態だった。実装前に判明したため設計に反映済み（§6.3）。

**#6 / #7 の顛末（同一の原因）**

実環境で `invalid_grant` + `error_subtype: invalid_rapt` によるトークン交換の失敗を観測した。切り分けの結果：

1. `npx @google/clasp list` は**成功した** → 認証情報ファイル自体は健全で、Google 側の問題ではない
2. `.clasprc.json` の構造を確認したところ **2アカウント**（法人アカウントと `default`）を保持していた
3. パーサは再帰探索で**最初に見つかった**法人アカウントを採用しており、clasp が実際に使う `default` を無視していた。その法人アカウントに再認証ポリシーが掛かっていたため `invalid_rapt` になった

**採用した対処**（`packages/core/src/credentials.ts`）:

- 候補を**すべて収集**してから選ぶ方式に変更
- 候補が複数あり `default` が存在すればそれを採用する（clasp 自身の既定アカウントの規約に合わせる）
- 候補が複数あり `default` が無ければ**エラーにする**。アカウント名を列挙して利用者に選ばせる。黙って選ぶことはしない
- エラーメッセージ中のアカウント名は、メールアドレス形式であれば伏せる（CI ログに出るため）

**教訓**: この欠陥は Task 3 のコードレビューで指摘されていたが、「誤ったアカウントを選んでも API 層で明示的に失敗するから v0.1 では許容できる」と判断して見送った。実際に明示的には失敗したものの、エラーが `invalid_rapt` という無関係に見えるものだったため、原因究明に大きな回り道を強いられた。**「失敗が目に見える」ことと「原因が分かる」ことは別**である。

**#3 が「審査必要」だった場合**、個人 Gmail ユーザーは自分の GCP プロジェクトで未確認アプリ警告を通す運用となる。利用不能にはならないが、README での説明の重さが変わる。v0.1 実装初日に検証すべき最優先項目である。

---

## 付録: 参考資料

- [clasp 公式ガイド](https://developers.google.com/apps-script/guides/clasp)
- [google/clasp README](https://github.com/google/clasp)
- [Apps Script API - projects.updateContent](https://developers.google.com/apps-script/api/reference/rest/v1/projects/updateContent)
- [Apps Script API - projects.deployments](https://developers.google.com/apps-script/api/reference/rest/v1/projects.deployments)
- [clasp issue #225 — service account での CI デプロイ](https://github.com/google/clasp/issues/225)
- [daikikatsuragawa/clasp-action](https://github.com/daikikatsuragawa/clasp-action)
- [ericanastas/deploy-google-app-script-action](https://github.com/ericanastas/deploy-google-app-script-action)
- [clasp + GitHub Actions 実践記事（8apps）](https://www.8apps.co/blog/shipping-google-workspace-addon-clasp-github-actions)
