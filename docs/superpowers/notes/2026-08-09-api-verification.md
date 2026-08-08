# Apps Script API 検証結果

実施日: 2026-08-09
検証環境: 個人 Gmail アカウント / clasp v3.3.0 / Node v24.13.1
検証用プロジェクト: 本検証のために新規作成したスタンドアロンスクリプト（既存プロジェクトは読み取りのみ、以降は不使用）

---

## #2 script.webapp.deploy スコープの要否 — 部分的に判明

`clasp login` で付与されたスコープ一覧:

```
email
profile
https://www.googleapis.com/auth/cloud-platform
https://www.googleapis.com/auth/drive.file
https://www.googleapis.com/auth/drive.metadata.readonly
https://www.googleapis.com/auth/logging.read
https://www.googleapis.com/auth/script.deployments
https://www.googleapis.com/auth/script.projects
https://www.googleapis.com/auth/script.webapp.deploy
https://www.googleapis.com/auth/service.management
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
openid
```

**判定: 未確定（clasp 経由では判別不能）。**

clasp は `script.webapp.deploy` を含む広範なスコープを要求するため、clasp 由来の認証情報を使う限りこのスコープは常に付いてくる。したがって「Web アプリのデプロイに必須かどうか」は clasp のトークンでは切り分けられない。**setup-cli（v1.0）で最小スコープのトークンを自前発行した時点で確定させる。**

**副次的な発見**: clasp のトークンには `cloud-platform`（GCP 全体への広範な権限）と `drive.metadata.readonly` が含まれる。本プロジェクトが要求するのは `script.projects` と `script.deployments` の2つだけなので、**最小権限であること自体が実際に差別化になる**ことが裏付けられた。README で明示する価値がある。

---

## #3 script.projects の審査対象該否 — 未検証

OAuth 同意画面の公開ステータス: 未確認
機密性の高いスコープとして表示されたか: 未確認
「本番」への切り替えに確認が要求されたか: 未確認

**判定: 未検証。** Google Cloud Console の「OAuth 同意画面」を人が目視で確認する必要があり、API では判定できない。v1.0 の setup-cli を作る前に確定させること。

---

## #4 デプロイ数上限 — 確定

使い捨てプロジェクトにデプロイを繰り返し作成して実測した。

- 開始時のデプロイ数: 1（新規プロジェクトでも `@HEAD` が最初から1件存在する）
- **21回目の作成で失敗**（HTTP 400 / `FAILED_PRECONDITION`）

```
Scripts may only have up to 20 versioned deployments at a time.
```

**判定: バージョン付きデプロイは20個まで。`@HEAD` は別枠。**

### ⚠️ 実装への重大な影響: `deployments.list` は既定で1件しか返さない

上限に到達した状態で一覧を取得したところ、**クエリパラメータの有無で結果が変わった**。

| リクエスト | 返却件数 | `nextPageToken` |
|---|---|---|
| `GET /deployments` | **1** | なし |
| `GET /deployments?pageSize=50` | **21** | なし |

`pageSize` を指定しないと、21件あるうち `@HEAD` の1件しか返らない。

計画中の `AppsScriptClient.listDeployments()` は `pageSize` を渡していないため、**このままでは常に1を返し、deployer の「18件で警告」は永久に発火しない**。機能が丸ごと死ぬ。

**対処（Task 9 / Task 10 に反映済み）**:

- `listDeployments` は `pageSize` を明示的に指定し、`nextPageToken` があれば追従する
- 警告の判定は**バージョン付きデプロイの件数**で行う（`deploymentConfig.versionNumber` を持つもの）。`@HEAD` は常に存在し上限の対象外なので、総数で数えると1件ずれる

---

## #5 サブディレクトリの name 表現 — 確定

`ui/Sidebar.html` と `app.js.html` を含むファイル一式を clasp で push し、`getContent` で取得した結果:

```
HTML       app.js
JSON       appsscript
SERVER_JS  Code
SERVER_JS  Legacy
HTML       ui/Sidebar
```

**判定: `/` 区切りで表現できる。**

**副次的な発見**: `app.js.html` が **name=`app.js` / type=HTML** として格納される。HTML テンプレートに JS を埋め込む GAS の定番パターンで、実在のプロジェクトでも確認された。**拡張子を1つだけ剥がす**現在の実装（`extname` の長さ分だけ切る）で正しく一致するが、`.js` で終わる名前が HTML 種別になりうるという直感に反する挙動なので、file-collector のテストケースに含めること。

---

## #6 .clasprc.json の複数ユーザー保持 — 確定

トップレベル構造（キー名のみ、値は非表示）:

```
tokens: object
  <アカウント名>: object
  default: object
```

**判定: 複数ユーザーを保持しうる。「最初に一致したものを採用」では不十分。**

実際にこれが原因で、法人アカウント側が選ばれ、そのアカウントの再認証ポリシーにより `invalid_grant` / `invalid_rapt` でトークン交換が失敗していた。詳細と対処は設計スペック §10 の #6 / #7 を参照。

---

## #7 invalid_rapt の原因 — 確定

**本実装のバグだった。** Google 側の問題ではない。`npx @google/clasp list` が成功したことで切り分けが完了した。詳細は設計スペック §10。

---

## `.claspignore` のパターン解釈（実測）

`.claspignore` の内容を書き換えながら `clasp status --json` を実行し、clasp v3.3.0 自身がどう解釈するかを実測した。fixture には `Code.js` / `Legacy.gs` / `app.js.html` / `ui/Sidebar.html` / `nested/secrets.js` / `build/out.js` / `Code.test.js` / `ignored.txt` を配置。

| パターン | clasp は除外したか | 本実装 |
|---|---|---|
| `/Code.js` | **いいえ**（`Code.js` は push された） | 一致（空振り） |
| `build/` | **いいえ**（`build/out.js` は push された） | 一致（空振り） |
| `ui/` | **いいえ**（`ui/Sidebar.html` は push された） | 一致（空振り） |
| `secrets.js` | **いいえ**（`nested/secrets.js` は push された） | 一致（ルートのみ対象） |
| `**/secrets.js` | **はい** | 一致 |
| `Code.js` | **はい**（ルートの `Code.js`） | 一致 |

**結論: 本実装は clasp と完全に一致している。**

**重要**: `.claspignore` は **gitignore ではなく glob マッチ**である。gitignore の常識で書いた `/foo`（ルート限定）や `build/`（ディレクトリ指定）は **エラーにもならず、ただ何も除外しない**。ディレクトリを除外するには `build/**`、階層を問わずファイル名で除外するには `**/secrets.js` と書く必要がある。

これは利用者が「テストファイルを除外したつもりが、そのままデプロイされていた」という事故を起こしうる罠なので、**README に明記すること**（Task 14）。挙動を gitignore 寄りに「修正」してはならない。clasp 互換が壊れる。

実測した挙動は `ignore.test.ts` に回帰テストとして固定済み。picomatch のバージョンアップで黙って乖離することを防ぐ。

## ファイル名の衝突（実測）

`Code.js` と `Code.gs` を同居させると、どちらも Apps Script 上では name=`Code` / type=`SERVER_JS` になる。clasp v3.3.0 の挙動:

```
$ clasp push -f
Conflicting files found
```

**push 全体を拒否し、リモートは一切変更されない。** `clasp status --json` もエラーになり出力を返さない。

当初の本実装は黙って重複エントリを生成しており、そのまま `updateContent` に渡すと正体不明の API エラーになるところだった。clasp に合わせて**収集時点で明示的に失敗**させるよう修正済み。`.gs` から `.js` への移行途中で古いファイルが残るという現実的なケースで踏む。

---

## シンボリックリンクの扱い（実測）

fixture にファイルへのリンクとディレクトリへのリンクを作り、`clasp status --json` で判定させた。

| リンク | clasp | 当初の本実装 |
|---|---|---|
| `Linked.js -> Code.js`（ファイル） | **push する** | **スキップしていた（乖離）** |
| `LinkedDir -> ui`（ディレクトリ） | 辿らない（untracked 扱い） | 辿らない（一致） |

`readdir(..., { withFileTypes: true })` はリンク自身の種別を返すため、シンボリックリンクは `isFile()` にも `isDirectory()` にも該当せず、当初の実装では無言で脱落していた。モノレポで共通コードをリンクしている構成では、**clasp なら push されるファイルが消える**ことになる。

対処: シンボリックリンクは `stat`（リンクを辿る）で解決し、ファイルなら収集、ディレクトリなら辿らない。リンク切れはスキップ。**ディレクトリを辿らないことが循環参照による無限再帰の防波堤にもなっている**ため、この非対称性は意図的に維持する。

---

## clasp 互換テストに関する発見（Task 13 への影響）

clasp v3 には **`clasp status --json`** がある。push 対象のファイル判定を機械可読な形で取得できる。

```json
{"filesToPush":["app.js.html","appsscript.json","Code.js","Legacy.gs","ui/Sidebar.html"],
 "untrackedFiles":[".clasp.json",".claspignore","Code.test.js","ignored.txt"]}
```

計画では「clasp の出力を一度記録した fixture と照合する」設計にしていたが、**実際の clasp の判定と直接突き合わせられる**。互換性の保証が一段強くなる。

また `.clasp.json` は v3 で拡張されており、**拡張子とファイル種別の対応がプロジェクトごとに設定可能**になっている。

```json
{
  "scriptExtensions": [".js", ".gs"],
  "htmlExtensions": [".html"],
  "jsonExtensions": [".json"],
  "filePushOrder": [],
  "skipSubdirectories": false
}
```

現在の実装はこの対応表をハードコードしている。既定値とは一致するが、`filePushOrder`（push 順序の制御。GAS ではトップレベル文の評価順に影響しうる）と併せて、対応するかどうかを判断する必要がある。v0.1 では非対応とし README に明記するのが妥当。
