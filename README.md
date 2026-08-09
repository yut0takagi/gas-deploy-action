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

## 出力

| 出力 | 説明 |
|---|---|
| `changed` | 差分があったかどうか（`true` / `false`） |
| `version-number` | 作成されたバージョン番号 |
| `deployment-id` | 更新または作成されたデプロイ ID |
| `web-app-url` | Web アプリの URL（該当する場合） |
| `summary` | 人間可読のサマリ（Markdown） |

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

一度発行した `deployment-id` は、`deployments.update` で `versionNumber` を差し替えるだけで、実質的なロールバックにも使える（v0.1 では専用のロールバック機能そのものは提供していない）。

## 制限事項

- **サービスアカウント非対応。** Apps Script API は Google 側の仕様としてサービスアカウントのトークンを受け付けない。clasp v3 の `--adc` オプションも公式に EXPERIMENTAL / NOT WORKING とされている。ユーザーアカウントの refresh token を Secret に格納する方式が現状唯一の選択肢であり、これは本 Action ではなく Google 側の制約。
- **TypeScript のトランスパイルはしない。** `root-dir` にはビルド済みの JS を置くこと。clasp v2 のような独自の `.ts` 変換は行わない。
- **v0.1 では単一プロジェクトのみ。** 1リポジトリで複数の GAS プロジェクトを扱うモノレポ構成や、環境別（dev/stg/prod）の設定ファイル（`gasdeploy.yml`）はまだ無い。1プロジェクト・1ワークフローとして使う。
- **`updateContent` はローカルディレクトリの内容で全ファイルを置き換える。** ローカルが真実になるので、`root-dir` の指定を誤ると（例: `appsscript.json` だけが残るディレクトリを指してしまった場合など）稼働中のスクリプトから大半のファイルが消える。リモートの半分以上のファイルが削除される場合は警告を出すが、**実行そのものは止めない**。`root-dir` は必ず確認すること。
- **部分的な失敗が再実行で救済されないことがある。** `updateContent` の成功後に `versions.create` が 5xx で失敗すると、実行全体は失敗として報告される。ここで再実行すると、HEAD は既に新しい内容になっているため差分ゼロと判定され、**何もせずに成功したかのように終了する**。デプロイは古いバージョンを指したままになる。この事故を防ぐため、本 Action は POST リクエストを 5xx では自動リトライしない（二重にバージョン・デプロイが作られる方が危険なため）。5xx で失敗した場合は、その旨と再実行では直らない可能性があることをメッセージで案内する。差分を手動で確認するか、内容を変更してから再実行すること。
- **`root-dir` 直下の非マニフェスト JSON は黙って除外される。** `appsscript.json` 以外の `.json` ファイル（例: `config.json`）は Apps Script がそもそも保持できないため、file-collector が収集対象から除外する。clasp と同じ挙動だが、除外されたことを示す警告や diff エントリは出ない。`root-dir` に設定ファイルなどの JSON を混在させている場合は注意すること。

## 既知の未検証事項

- **`script.projects` が Google の審査対象スコープかどうかは未検証。** 個人 Gmail アカウントでの「確認されていないアプリ」警告の有無に影響する（前述の該当節を参照）。
- **`setup-cli` のループバック認可は実環境で未検証。** Desktop タイプの OAuth クライアントが任意のポートの `http://127.0.0.1:<port>` を事前登録なしで受け入れるという前提に立っている（RFC 8252 §7.3、`clasp login` や `gcloud auth login` と同じ仕組み）。もし固定ポートの登録が必要だと判明した場合、実装はポートを固定するだけで対応できるが、セットアップ手順の説明が変わる。

なお `runs.using: node24` は実際の GitHub Actions ランナーで**動作を確認済み**（2026-08-09）。GitHub 側でも Node 20 は非推奨となり Node 24 が既定になっている。

## 実地確認の裏付け

上記の挙動（`.claspignore` の解釈、デプロイ上限、ファイル名の拡張子処理、シンボリックリンクの扱いなど）は、実際の Apps Script API と clasp に対して行った検証に基づく。詳細は [`docs/superpowers/notes/2026-08-09-api-verification.md`](docs/superpowers/notes/2026-08-09-api-verification.md) を参照。
