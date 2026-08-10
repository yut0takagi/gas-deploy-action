# gas-deploy-action

Google Apps Script（GAS）プロジェクトを Apps Script API 直叩きでデプロイする GitHub Action。

## これは何か、なぜ clasp をラップしないのか

`clasp push` / `clasp deploy` を CI から呼び出すラッパーではない。Apps Script API（`projects.updateContent` / `projects.versions.create` / `projects.deployments`）を直接呼び出す。

理由は単純で、dry-run・差分表示・既存デプロイの更新による URL 維持・デプロイ上限の警告は、いずれも clasp CLI の外側からは実装できないからだ。既存の clasp ラッパー系 Action が対話プロンプトやエラー出力、バージョン間の仕様変更に振り回されて「hack」化しているのは、まさにこの構造が原因になっている。

その代わり、`.claspignore` の解釈やファイル種別の判定などの「clasp 互換」を自前で保証する責任を負う。この互換性は、実際の `clasp status --json` の判定結果と本実装の出力を突き合わせるゴールデンテストで担保している。

## クイックスタート

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

      - uses: yut0takagi/gas-deploy-action/deploy@v0.1.0
        with:
          credentials: ${{ secrets.CLASPRC_JSON }}
          script-id: ${{ secrets.GAS_SCRIPT_ID }}
          root-dir: dist
          deployment-id: ${{ secrets.GAS_DEPLOYMENT_ID }}
```

`root-dir` にはビルド済み JS（TypeScript ならトランスパイル後の出力先）を指定する。詳細は下記「制限事項」を参照。

バージョンは `@v0.1.0` のように固定するか、`@v0` を指定してパッチリリースに追従させる。

## セットアップ

認証情報の用意には2つの経路がある。**権限の広さが違う**ので、違いを理解して選ぶこと。

| | 手間 | Secrets に入るトークンの権限 |
|---|---|---|
| **A. `setup-cli`（推奨）** | GCP コンソール操作が必要 | **2スコープのみ** |
| **B. clasp の認証情報を借りる** | `clasp login` だけ | **13スコープ**（`cloud-platform` を含む） |

### A. `setup-cli` で専用トークンを発行する（推奨）

このリポジトリをクローンして実行する。

```bash
npm install
npm run setup
```

対話形式で、GCP プロジェクトの用意、Apps Script API の有効化（2箇所）、OAuth 同意画面の設定、Desktop タイプの OAuth クライアント作成までを案内する。その後ブラウザで認可し、**`script.projects` と `script.deployments` の2つだけを要求した**リフレッシュトークンを発行する。

発行後、実際に付与されたスコープが要求どおり2つだけかを検証する。**余分なスコープが混ざっていた場合は保存せずに中断する。** 最小権限を保証すると謳う道具が、保証できていない認証情報を黙って保存しては意味がないため。

`gh` が使える環境なら、そのまま GitHub Secrets への登録まで行う。

### B. clasp の認証情報をそのまま使う（手早い）

既に clasp を使っているなら、トークンを発行し直さずに始められる。

1. ローカルで `clasp login` を実行し、`~/.clasprc.json` を作る（clasp が未導入なら `npm i -g @google/clasp`）。
2. https://script.google.com/home/usersettings で Apps Script API を有効化する。これを忘れるとデプロイ対象のスクリプトに関わらず `403` になる。
3. `~/.clasprc.json` の中身をそのまま GitHub の Secret（例 `CLASPRC_JSON`）に登録する。中身を書き換える必要はない。

```bash
gh secret set CLASPRC_JSON < ~/.clasprc.json
```

**ただしこの経路では最小権限にならない。** 後述の「clasp のトークンより狭いスコープ」を必ず読むこと。

### ⚠️ OAuth 同意画面の状態を必ず確認する

これがこの Action が「1週間後に壊れる」最大の原因になる。

OAuth 同意画面が **テスト（Testing）** 状態のままだと、発行された refresh token は **7日で失効する**。CI は初回成功後、1週間ほどで `invalid_grant` を出して止まる。

- Google Workspace アカウントの場合 → 同意画面を **内部（Internal）** に設定する
- 個人 Gmail アカウントの場合 → **本番（Production）に公開**する

どちらも Google Cloud Console の「OAuth 同意画面」設定から行う。

また、アカウントに**再認証ポリシー**（reauthentication policy）が設定されていると `invalid_grant` / `invalid_rapt` で失敗し、保存済み refresh token では突破できない。そのアカウントは無人 CI での利用に向かない。専用のデプロイ用アカウントを用意することを推奨する。

### 個人 Gmail アカウントと「確認されていないアプリ」画面について

本 Action が使う `script.projects` スコープが Google の審査対象（sensitive / restricted）スコープかどうかは**未検証**である。

- Google Workspace アカウントで同意画面を **内部（Internal）** にしている場合、この問題は発生しない。
- 個人 Gmail アカウントは前述の通り同意画面を **本番（Production）に公開**する必要があるが、そのとき Google が「確認されていないアプリ」の警告を表示するか、あるいは公開時に確認（verification）を要求してくるかは、実際には確かめていない。

スコープの審査対象該否によって挙動が変わりうるが、どちらになるかは未計測であり、ここで断定はしない。個人 Gmail アカウントで試す場合は、この警告や確認プロンプトが出る可能性を踏まえておくこと。

### 複数アカウントを保持する `.clasprc.json`

`~/.clasprc.json` は `{ tokens: { <アカウント名>: {...}, default: {...} } }` の形で複数アカウントを保持できる。本 Action は常に `default` を使う。複数アカウントが存在し `default` という名前のものが無い場合は、どれを使うべきか黙って推測せずにエラーにする。

### clasp のトークンより狭いスコープ

clasp のトークンは `cloud-platform` を含む広いスコープを要求する。本 Action が実際に要求するスコープは次の2つのみで、`.clasprc.json` から必要な分だけを使う。

> ⚠️ **ただしリフレッシュトークン自体の権限は狭まらない。**
>
> 本 Action が絞っているのは、リフレッシュトークンと交換して得る**アクセストークン**のスコープである。Secrets に保存されるリフレッシュトークンは、clasp がユーザーに認可された時点の権限（13スコープ）をそのまま持ち続ける。
>
> したがって **Secrets が漏洩した場合、攻撃者は同じリフレッシュトークンで `cloud-platform` を含む全スコープのアクセストークンを取得できる。** 「本 Action は2スコープしか使わない」ことと「漏洩時の被害が2スコープ分に収まる」ことは別である。
>
> 真の最小権限を得るには、最初から2スコープだけを認可した専用の OAuth クライアントでトークンを発行する必要がある。それを行う `setup-cli` は v1.0 で提供予定。それまでは、Secrets の管理と、不要になったトークンの失効（[Google アカウントのセキュリティ設定](https://myaccount.google.com/permissions)）で担保すること。

- `https://www.googleapis.com/auth/script.projects`
- `https://www.googleapis.com/auth/script.deployments`

## 複数プロジェクトをまとめてデプロイする

1リポジトリに複数の GAS プロジェクトを置き、環境（dev / stg / prod）ごとにデプロイできる。リポジトリ直下に `gasdeploy.yml` を置く。

```yaml
version: 1

defaults:
  ignore:
    - "**/*.test.js"
    - "node_modules/**"

projects:
  web-app:
    rootDir: apps/web-app/dist
    type: webapp
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

```yaml
      - uses: yut0takagi/gas-deploy-action/deploy@v0.1.0
        with:
          credentials: ${{ secrets.CLASPRC_JSON }}
          environment: prod
        env:
          PROD_WEBAPP_SCRIPT_ID: ${{ secrets.PROD_WEBAPP_SCRIPT_ID }}
          PROD_WEBAPP_DEPLOYMENT_ID: ${{ secrets.PROD_WEBAPP_DEPLOYMENT_ID }}
          SHEET_TOOLS_SCRIPT_ID: ${{ secrets.SHEET_TOOLS_SCRIPT_ID }}
```

`projects` 入力で対象を絞れる（例 `projects: web-app,sheet-tools`）。既定は `all`。

### `${VAR}` は GitHub Actions の式ではない

`gasdeploy.yml` はリポジトリ内のただの YAML なので、`${{ }}` は展開されない。そこで本 Action が `${VAR}` を**環境変数から**展開する。上の例のように `env:` で渡すこと。scriptId をリポジトリに直書きしたくない場合に使う。

**未定義の変数はエラーになる。** 空文字のまま進めると、空の scriptId で API を叩いて意味不明な 404 になるため、設定を読んだ時点で失敗させる。

### 失敗したときに何が起きるか

**逐次実行し、最初の失敗で停止する。** 並列にしないのは、API のレート制限と、失敗時にどこまで進んだか分からなくなるのを避けるため。

停止した場合、**どのプロジェクトが完了済みで、どれが未着手か**をサマリに明記する。`deployments` 出力にも全ターゲットが `status`（`deployed` / `unchanged` / `failed` / `skipped`）付きで含まれるので、赤いジョブを見た人が Apps Script のコンソールを開かずに現状を把握できる。

### 単一プロジェクトモードとの関係

**`script-id` 入力があれば設定ファイルは完全に無視される。** 両方を混ぜると挙動が読めなくなるため。既存の単一プロジェクトの使い方はそのまま動く。

### 環境が無いプロジェクトの扱い

`projects: all` で走らせたとき、指定した環境を持たないプロジェクトは**スキップされる**（`prod` しか持たないプロジェクトがあってよい）。

ただし **プロジェクト名を明示して指定した場合は、環境が無ければエラー**になる。名指しした対象がデプロイされないまま成功と表示されるのを防ぐため。

## 入力（`deploy/action.yml`）

| 入力 | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `credentials` | ○ | — | clasp の `.clasprc.json`、または `{client_id, client_secret, refresh_token}` の JSON |
| `script-id` | ○ | — | デプロイ先の scriptId |
| `root-dir` | — | `.` | アップロードするファイルのルートディレクトリ |
| `deployment-id` | — | — | 更新する既存デプロイの ID。省略すると新規デプロイが作成され Web アプリの URL が変わる |
| `project-type` | — | `standalone` | `webapp` \| `addon` \| `bound` \| `standalone` |
| `ignore` | — | — | 除外パターン（改行区切り）。省略時は `.claspignore`、それも無ければ既定値を使う |
| `dry-run` | — | `false` | 差分の表示のみ行い、書き込みを行わない |
| `create-version` | — | `true` | バージョン作成とデプロイを行うかどうか |
| `description` | — | `ci-<sha7>-<run_number>` | バージョンの説明 |
| `comment-on-pr` | — | `false` | サマリを PR にコメントする |
| `github-token` | — | `${{ github.token }}` | PR コメントに使うトークン |
| `comment-key` | — | environment または `default` | コメントを識別するキー |

## 出力

| 出力 | 説明 |
|---|---|
| `changed` | 差分があったかどうか（`true` / `false`） |
| `version-number` | 作成されたバージョン番号 |
| `deployment-id` | 更新または作成されたデプロイ ID |
| `web-app-url` | Web アプリの URL（該当する場合） |
| `summary` | 人間可読のサマリ（Markdown） |

## PR に差分をコメントする

`dry-run` と組み合わせると、マージ前に「何が本番に出るか」を PR 上で確認できる。

```yaml
permissions:
  contents: read
  pull-requests: write     # これが無いと 403 になる

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: yut0takagi/gas-deploy-action/deploy@v0.1.0
        with:
          credentials: ${{ secrets.CLASPRC_JSON }}
          environment: prod
          dry-run: true
          comment-on-pr: true
```

コメントには隠しマーカー（`<!-- gas-deploy-action:<key> -->`）を埋め込んでおり、**同じキーのコメントは新規作成ではなく更新される。** push のたびにコメントが積み上がることはない。

キーの既定値は複数プロジェクトモードでは `environment`、単一プロジェクトモードでは `default`。つまり同じ PR に dev と prod のプレビューを並べても互いを上書きしない。**単一プロジェクトモードを1つのワークフローで複数回実行する場合は、`comment-key` で明示的に分けること**（既定値が固定なので、後の実行が前の実行のコメントを上書きする）。

### コメントの失敗はデプロイの失敗にしない

コメント投稿に失敗しても、ジョブは失敗扱いにせず警告に留める。成功した本番デプロイを赤い実行結果として報告すると、それを見て動くロールバック自動化や人間の判断を誤らせるため。サマリの内容はこの時点で既にジョブサマリに書き出してあるので、コメントが出なくても情報は失われない。

### PR 以外の実行では何もしない

push で走るワークフローに `comment-on-pr: true` が付いたままでも失敗しない。「PR ではない」は異常ではなく通常の状態として扱う。

なお **フォークからの `pull_request` イベントでは、既定の `GITHUB_TOKEN` が読み取り専用になるためコメントを投稿できない。** これは GitHub 側のセキュリティ仕様。

コメントの作成・更新・キーによる分離は、実際の GitHub API に対して確認済み（2026-08-10、[検証ノート](docs/superpowers/notes/2026-08-09-api-verification.md)）。403 の経路と、100件を超えるコメントを持つ PR でのページングは未検証。

## デプロイをロールバックする

`rollback` は別のアクションとして提供する。デプロイが指すバージョン番号を差し替えるだけの操作で、ファイルの書き込みもバージョンの作成も行わない。バージョンは Apps Script 側に永続する（削除する API が存在しない）ため、過去のバージョンはいつでも指し直せる。

```yaml
- uses: yut0takagi/gas-deploy-action/rollback@v0.1.0
  with:
    credentials: ${{ secrets.CLASPRC_JSON }}
    environment: prod
    project: web-app
```

`version-number` を省略すると、**現在のバージョンの1つ前**に戻す。特定のバージョンを指定することもできる。

```yaml
- uses: yut0takagi/gas-deploy-action/rollback@v0.1.0
  with:
    credentials: ${{ secrets.CLASPRC_JSON }}
    script-id: ${{ secrets.PROD_SCRIPT_ID }}
    deployment-id: ${{ secrets.PROD_DEPLOYMENT_ID }}
    version-number: '38'
```

### ⚠️ ロールバックは HEAD のソースを戻さない

**これがこの機能で最も事故になりやすい点。**

ロールバックが書き換えるのはデプロイが指すバージョン番号だけで、プロジェクトの HEAD — スクリプトエディタを開いたときに見えるソース — は問題のあるコードのまま残る。

この状態でリポジトリを直さずに次のデプロイを走らせると、こうなる。

1. 差分として検出されるのは「その後に加えた変更」だけ
2. しかし作られるバージョンは、問題のあるコードを含んだ **HEAD 全体のスナップショット**
3. そのバージョンがデプロイされ、**ロールバックが静かに巻き戻る**

無関係な一行の修正をプッシュしただけで本番が再び壊れる。ロールバックしたら、**必ずリポジトリ側も revert すること。** 本 Action は実行のたびにこの警告を出す。

### ⚠️ デプロイ直後のロールバックでは `version-number` を明示すること

`version-number` を省略した「1つ前に戻す」は、**現在のバージョンを API から読んで計算する**。ところが Apps Script API のデプロイ読み取りは書き込み直後の一貫性を保証しない。実測では、`deployments.list` が30秒以上にわたり古い値を返し続け、しかも新しい値と古い値の間で振動した。

本 Action は緩和策として、現在のバージョンを一覧ではなく単体取得（`deployments.get`、実測でより速く収束する）から読み、さらに連続2回の読み取りが一致するまで待つ。それでも一致しなければ、推測せずに失敗して `version-number` の明示を促す。

**ただしこれは確率を下げるだけで、保証ではない。** 2回の読み取りが両方とも同じ古いレプリカに当たれば通ってしまう（実測で発生した）。その場合、意図より1つ余計に古いバージョンへ静かに戻る。

デプロイ直後にロールバックする — つまり障害対応で最もありがちな流れ — では、**`version-number` を明示すること。** 明示すれば戻り先はこの問題の影響を受けない（影響は「現在のバージョン」の表示と無操作判定に留まる）。

### ロールバック対象の特定

`deployment-id` を省略した場合、バージョン付きデプロイが**ちょうど1つ**のときだけ自動で特定する。複数ある場合（本番とステージングを同じスクリプトで運用している等）は、当てずっぽうに選ばず候補を列挙して停止する。無関係な環境を巻き戻さないための制約。

`@HEAD` デプロイは常に最新のソースを指すため、バージョンを指し直すという操作が成立しない。対象から除外し、指定された場合は専用のエラーにする。

### 一度に1プロジェクトのみ

`project` は単数で、`all` は指定できない。障害時に戻したいのは壊れた1プロジェクトであって、正常に動いている残りまで巻き戻すのは、ほぼ確実に事故になるため。複数戻す必要がある場合はプロジェクトごとに実行する。

### 入力（`rollback/action.yml`）

| 入力 | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `credentials` | ○ | — | デプロイ用アクションと同じ |
| `script-id` | — | — | 指定すると `config` を読み込まない |
| `deployment-id` | — | — | 省略時、バージョン付きデプロイが1つのときだけ自動特定。`config` の値より優先される |
| `version-number` | — | — | 戻り先。省略すると現在の1つ前。1以上の整数のみ受け付ける |
| `dry-run` | — | `false` | 戻り先の実在確認だけ行い、デプロイを書き換えない |
| `description` | — | `rollback to v<N> (was v<M>)` | デプロイに設定する説明 |
| `config` | — | `gasdeploy.yml` | `script-id` 未指定時に読む設定ファイル |
| `environment` | — | — | `config` モードでは必須 |
| `project` | — | — | `config` モードでは必須。`all` は不可 |

### 出力（`rollback/action.yml`）

| 出力 | 説明 |
|---|---|
| `rolled-back` | 実際に書き換えたか。dry-run と「すでに戻り先を指していた」場合は `false` |
| `from-version` | ロールバック前に指していたバージョン番号 |
| `to-version` | 戻り先のバージョン番号（dry-run では戻す予定のもの） |
| `deployment-id` | 対象となったデプロイの ID |
| `web-app-url` | Web アプリの URL（該当する場合）。ロールバックしても変わらない |
| `summary` | 人間可読のサマリ（Markdown） |

`version-number` に現在より**新しい**バージョンを指定することもできる（ロールバックの取り消しなど）。その場合はロールフォワードである旨を警告したうえで実行する。すでに戻り先バージョンを指している場合は何も書き換えず、`rolled-back` を `false` にしてその旨を返す。「効いたのか、元から同じだったのか」を区別できない成功を返さないため。

## ⚠️ `.claspignore` は gitignore ではない

`.claspignore` は **glob マッチであり、gitignore のディレクトリ・ルート指定の意味論を持たない**。gitignore の感覚で書いたパターンは、エラーにも警告にもならず、**静かに何も除外しない**。

これは実測で確認した挙動で、clasp v3.3.0 自身の判定に合わせてある。テストを gitignore のつもりのパターンで除外したと思い込み、実際には本番にテストコードがデプロイされ続けている、という事故を起こしうる箇所なので、必ず確認すること。

| 書き方（誤り） | 実際の挙動 | 正しい書き方 |
|---|---|---|
| `/Code.js` | ルート限定にならず、そもそも何も除外しない | `Code.js` |
| `build/` | ディレクトリごと除外にならない | `build/**` |
| `ui/` | ディレクトリごと除外にならない | `ui/**` |
| `secrets.js` | ルート直下の `secrets.js` のみ対象。`nested/secrets.js` は除外されない | `**/secrets.js`（階層を問わず除外） |

とくに `**/*.test.js` のような「階層を問わず除外したい」パターンを、gitignore の感覚で `*.test.js` とだけ書いて満足してしまうと、ルート以外のテストファイルが本番にそのまま出力される。挙動そのものは意図的に clasp と一致させているため、この Action 側で「直感的に」修正することはしない。

## デプロイ上限と `deployment-id`

Apps Script は **バージョン付きデプロイを最大20個まで**しか持てない（実測で確認。`@HEAD` デプロイは別枠でこの上限に含まれない）。21個目の作成は `FAILED_PRECONDITION` で失敗する。本 Action は上限に近づくと（バージョン付きデプロイが18件以上になった時点で）警告を出す。

**`deployment-id` を省略すると、常に新しいデプロイが作成され、新しい URL が発行される。** 既存の URL を指していたトラフィックは古いデプロイに取り残される。これが GAS の CI で最も起きやすい本番事故であり、Web アプリ・アドオンとして運用している場合はほぼ必ず `deployment-id` を指定する必要がある。`project-type` が `webapp` または `addon` で `deployment-id` が未指定かつ差分がある場合、本 Action は実行前に警告を出す。

一度発行した `deployment-id` は、`deployments.update` で `versionNumber` を差し替えるだけでロールバックにも使える。これを行うのが [`rollback` アクション](#デプロイをロールバックする)で、**`deployment-id` を指定した運用でなければロールバックもできない**（新規デプロイを作り続けていると、戻すべき安定した参照先が存在しない）。

## 制限事項

- **サービスアカウント非対応。** Apps Script API は Google 側の仕様としてサービスアカウントのトークンを受け付けない。clasp v3 の `--adc` オプションも公式に EXPERIMENTAL / NOT WORKING とされている。ユーザーアカウントの refresh token を Secret に格納する方式が現状唯一の選択肢であり、これは本 Action ではなく Google 側の制約。
- **TypeScript のトランスパイルはしない。** `root-dir` にはビルド済みの JS を置くこと。clasp v2 のような独自の `.ts` 変換は行わない。
- **複数プロジェクトのデプロイは逐次実行で、失敗すると以降が未実行のまま残る。** 途中で失敗した場合、それまでにデプロイされたプロジェクトは元に戻らない。全体を1つの原子的な操作として扱うことはできないため、`deployments` 出力の `status` で各プロジェクトの状態を必ず確認すること。
- **`updateContent` はローカルディレクトリの内容で全ファイルを置き換える。** ローカルが真実になるので、`root-dir` の指定を誤ると（例: `appsscript.json` だけが残るディレクトリを指してしまった場合など）稼働中のスクリプトから大半のファイルが消える。リモートの半分以上のファイルが削除される場合は警告を出すが、**実行そのものは止めない**。`root-dir` は必ず確認すること。
- **部分的な失敗が再実行で救済されないことがある。** `updateContent` の成功後に `versions.create` が 5xx で失敗すると、実行全体は失敗として報告される。ここで再実行すると、HEAD は既に新しい内容になっているため差分ゼロと判定され、**何もせずに成功したかのように終了する**。デプロイは古いバージョンを指したままになる。この事故を防ぐため、本 Action は POST リクエストを 5xx では自動リトライしない（二重にバージョン・デプロイが作られる方が危険なため）。5xx で失敗した場合は、その旨と再実行では直らない可能性があることをメッセージで案内する。差分を手動で確認するか、内容を変更してから再実行すること。
- **`root-dir` 直下の非マニフェスト JSON は黙って除外される。** `appsscript.json` 以外の `.json` ファイル（例: `config.json`）は Apps Script がそもそも保持できないため、file-collector が収集対象から除外する。clasp と同じ挙動だが、除外されたことを示す警告や diff エントリは出ない。`root-dir` に設定ファイルなどの JSON を混在させている場合は注意すること。

## 既知の未検証事項

- **`script.projects` が Google の審査対象スコープかどうかは未検証。** 個人 Gmail アカウントでの「確認されていないアプリ」警告の有無に影響する（前述の該当節を参照）。
- **`rollback` の「1つ前に戻す」はデプロイ直後に誤りうる。** 実 API での検証は済んでおり（バージョンの差し替え・URL 維持・HEAD が戻らないことをすべて確認）、原因は Apps Script API 側の読み取り一貫性にある。詳細と緩和策は[前述の該当節](#️-デプロイ直後のロールバックでは-version-number-を明示すること)を参照。
- **`setup-cli` のループバック認可は実環境で未検証。** Desktop タイプの OAuth クライアントが任意のポートの `http://127.0.0.1:<port>` を事前登録なしで受け入れるという前提に立っている（RFC 8252 §7.3、`clasp login` や `gcloud auth login` と同じ仕組み）。もし固定ポートの登録が必要だと判明した場合、実装はポートを固定するだけで対応できるが、セットアップ手順の説明が変わる。

なお `runs.using: node24` は実際の GitHub Actions ランナーで**動作を確認済み**（2026-08-09）。GitHub 側でも Node 20 は非推奨となり Node 24 が既定になっている。

## 実地確認の裏付け

上記の挙動（`.claspignore` の解釈、デプロイ上限、ファイル名の拡張子処理、シンボリックリンクの扱いなど）は、実際の Apps Script API と clasp に対して行った検証に基づく。詳細は [`docs/superpowers/notes/2026-08-09-api-verification.md`](docs/superpowers/notes/2026-08-09-api-verification.md) を参照。
