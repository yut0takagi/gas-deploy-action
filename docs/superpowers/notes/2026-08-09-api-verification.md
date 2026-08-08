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

## スコープの絞り込み（実測）— #2 の決着

**当初の実装は「最小権限」を謳いながら、実際には clasp の広いスコープをそのまま使っていた。**

`getAccessToken` はリフレッシュ交換時に `scope` を指定していなかった。RFC 6749 §6 では `scope` 省略時、**元のリフレッシュトークンに付与された全スコープ**が返る。v0.1 の現実的な認証経路は clasp 由来の `.clasprc.json` だけなので、手にするトークンは clasp の 13 スコープを持っていた。シークレットが漏れた場合の被害範囲は、README が「避けられる」と書いていたまさにその広さだった。

Google がリフレッシュ交換での絞り込みを受け付けるかを実測した:

```
scope 指定なし → 13 スコープ
    email, profile, cloud-platform, drive.file, drive.metadata.readonly,
    logging.read, script.deployments, script.projects, script.webapp.deploy,
    service.management, userinfo.email, userinfo.profile, openid

scope 指定あり → 2 スコープ
    script.projects, script.deployments
```

**Google は絞り込みを受け付ける。** よって直すべきは README ではなく実装だった。`scope` を明示的に渡すよう修正済み。

### #2 script.webapp.deploy の要否 — 解決済み（不要）

絞り込んだ2スコープのトークンで、実際に全操作を試した:

```
getContent          HTTP 200 OK
updateContent       HTTP 200 OK
versions.create     HTTP 200 OK  version=3
deployments.create  HTTP 200 OK
deployments.delete  HTTP 200 OK
```

**`script.webapp.deploy` は不要。** `script.projects` と `script.deployments` の2つで足りる。setup-cli を待たずに確定した。

なお、この修正によって `invalid_scope` という新しい失敗経路が生まれた。元々付与されていないスコープは絞り込めないため、自前 OAuth クライアントでスコープが不足している場合に発生する。専用の案内を出すよう対応済み。

---

## 本実装による実 API での通し確認（E2E）

`packages/core` の `deploy()` を、検証専用プロジェクトに対して実際に実行した。**clasp を介さず、我々自身の書き込み経路を通した唯一の確認**である。

ローカルの `Code.js` に日本語コメントを含む変更を加えてから実行した結果:

```
[1] dry-run: changed=true modified=["Code"]
[2] 本実行: changed=true version=2 deployment=AKfycbwpjCDCWR...
[3] 再取得して差分: 差分ゼロ（収束した）
[4] 日本語コメントの保存: 一致（Unicode 正規化の問題なし）
[5] もう一度 dry-run: changed=false ← スキップされる
[6] デプロイ一覧: 全 2 件 / バージョン付き 1 件
```

確認できたこと:

- `updateContent` → `versions.create` → `deployments.create` の書き込み経路が実 API で動く
- **我々が書き込んだ内容を取得し直すと差分ゼロに収束する**。skip-when-unchanged の前提が、clasp 経由ではなく本実装自身で成立する
- **非 ASCII 文字（日本語）が往復しても壊れない。** differ のレビューで「未測定」として残っていた Unicode 正規化形（NFC/NFD）の懸念が解消された。日本語のコメントや文字列リテラルは対象利用者に頻出するため、ここが壊れていれば差分は永久に収束しなかった
- `listDeployments` が `@HEAD` を含む全2件を返し、そのうちバージョン付きは1件と正しく判別される。`pageSize` 修正と `@HEAD` 除外の両方が実環境で機能している

---

## 内容の往復一致（実測）— skip-when-unchanged の前提

差分ゼロならデプロイをスキップする機能は、「push した内容を取得し直したら差分が出ない」ことに依存する。ここが崩れると**毎回バージョン番号とデプロイ枠を消費し続ける**（上限20なのでいずれ詰まる）。最大の懸念は `appsscript.json` が API 側の JSON シリアライザで再整形されることだった。

fixture を push したのち `getContent` で取得し、`normalizeSource`（CRLF→LF、末尾改行の正規化）適用後に比較した結果:

```
一致   app.js.html        local=46B remote=46B  BOM(remote)=なし
一致   appsscript.json    local=125B remote=125B  BOM(remote)=なし
一致   Code.js            local=43B remote=43B  BOM(remote)=なし
一致   Legacy.gs          local=46B remote=46B  BOM(remote)=なし
一致   ui/Sidebar.html    local=35B remote=35B  BOM(remote)=なし
```

**不一致 0 件。JSON の再整形なし、BOM 付与なし。** `normalizeSource` は現状のままで十分。

**留保**: 今回 push したのは clasp なので、厳密には「clasp の正規化と本実装の正規化が一致している」ことの確認である。本実装の `updateContent` を使った往復は Task 14 の実地確認で押さえる。ただし「API が JSON を勝手に再整形する」という最悪のシナリオは否定できた。

**未測定**: 非 ASCII 文字を含むファイルの Unicode 正規化形（NFC/NFD）の保存。日本語のコメントや文字列リテラルは現実的に頻出するため、Task 14 で fixture に含めて確認すること。

---

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
