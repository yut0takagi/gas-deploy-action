# Google Apps Script を GitHub Actions からデプロイする — clasp をラップしない Action を作った

Google Apps Script（GAS）を GitHub で管理していると、どこかで「push したら自動でデプロイされてほしい」と思う。ところが実際にやろうとすると、CI から `clasp push` を叩く方式は思ったより素直に進まない。対話プロンプトで止まる、エラーがメッセージ本文でしか判別できない、clasp のバージョンが上がると挙動が変わる。何より、CI で本当に欲しい「マージ前に差分を見る」「デプロイ URL を変えない」といった機能が、CLI の外側からは作れない。

そこで [gas-deploy-action](https://github.com/yut0takagi/gas-deploy-action) という GitHub Action を作った。clasp をラップせず、Apps Script API（`projects.updateContent` / `projects.versions.create` / `projects.deployments`）を直接呼び出す。

この記事は使い方の紹介。最短で動かすところから、実運用で必ず踏むポイントまでを順に書く。

## 何ができるか

4つのアクションを提供している。

| アクション | 役割 |
|---|---|
| `deploy` | ファイルのアップロード、バージョン作成、デプロイ |
| `rollback` | デプロイが指すバージョンを過去のものに差し替える |
| `status` | 本番で動いているコードがどのコミット由来かを引く |
| `token-check` | 認証情報が失効していないかを定期監視する |

`deploy` の主な機能は次のとおり。

- 差分がなければ何もしない（バージョン番号とデプロイ枠を無駄に消費しない）
- `dry-run` で「何が本番に出るか」だけを表示する
- その結果を PR にコメントする（同じキーのコメントは積み上げず更新する）
- 既存デプロイを更新して Web アプリの URL を維持する
- 1リポジトリに複数の GAS プロジェクトを置き、環境ごとにまとめてデプロイする

## まず動かす

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

      - uses: yut0takagi/gas-deploy-action/deploy@v0
        with:
          credentials: ${{ secrets.CLASPRC_JSON }}
          script-id: ${{ secrets.GAS_SCRIPT_ID }}
          root-dir: dist
          deployment-id: ${{ secrets.GAS_DEPLOYMENT_ID }}
```

`@v0` を指定するとパッチリリースに追従する。固定したければ `@v0.1.1` のようにタグを直接指定する。

`root-dir` にはビルド済みの JS を置く。この Action は TypeScript のトランスパイルをしない。clasp v2 が持っていたような独自の `.ts` 変換は行わないので、TypeScript で書いている場合は先に `tsc` なりを走らせて、その出力先を渡す。

## 認証情報を用意する

ここが唯一の面倒なところ。経路が2つあり、権限の広さが違う。

| | 手間 | Secrets に入るトークンの権限 |
|---|---|---|
| A. 専用トークンを発行する | GCP コンソール操作が必要 | 2スコープのみ |
| B. clasp の認証情報を借りる | `clasp login` だけ | 13スコープ（`cloud-platform` を含む） |

### A. 専用トークンを発行する

リポジトリをクローンして、付属の CLI を走らせる。

```bash
git clone https://github.com/yut0takagi/gas-deploy-action.git
cd gas-deploy-action
npm install
npm run setup
```

対話形式で、GCP プロジェクトの用意 → Apps Script API の有効化 → OAuth 同意画面の設定 → Desktop タイプの OAuth クライアント作成、までを案内する。そのあとブラウザで認可すると、`script.projects` と `script.deployments` の2つだけを要求したリフレッシュトークンが発行される。

発行後に、実際に付与されたスコープが要求どおり2つだけかを検証する。余分なスコープが混ざっていた場合は保存せずに中断する。`gh` が使える環境なら GitHub Secrets への登録までやる。

### B. clasp の認証情報をそのまま使う

すでに clasp を使っているなら、こちらのほうが早い。

```bash
clasp login                                   # ~/.clasprc.json ができる
gh secret set CLASPRC_JSON < ~/.clasprc.json
```

加えて https://script.google.com/home/usersettings で Apps Script API を有効にしておく。これを忘れると、デプロイ対象のスクリプトが何であれ `403` になる。

`.clasprc.json` の中身は書き換えなくていい。ただしこの経路では最小権限にならない。

### 経路 B の権限について、正確なところ

この Action がリフレッシュトークンと交換して得るアクセストークンは、`script.projects` と `script.deployments` の2つに絞ってある。Google はリフレッシュ交換時のスコープ絞り込みを受け付けるので、これは実際に効いている。

ただし、**絞られるのはアクセストークンであって、リフレッシュトークンそのものではない**。Secrets に保存されるリフレッシュトークンは、clasp が認可された時点の13スコープをそのまま持ち続ける。つまり Secrets が漏洩した場合、攻撃者は同じリフレッシュトークンで `cloud-platform` を含む全スコープのアクセストークンを取得できる。

「この Action は2スコープしか使わない」ことと「漏洩時の被害が2スコープ分に収まる」ことは別の話だ。本当に最小権限にしたいなら経路 A を使う。経路 B のまま運用するなら、Secrets の管理と、不要になったトークンの[失効](https://myaccount.google.com/permissions)で担保することになる。

### OAuth 同意画面が「テスト」だと1週間で壊れる

これは経路 A・B に関係なく効いてくる。

OAuth 同意画面が **テスト（Testing）** 状態のままだと、発行された refresh token は7日で失効する。初回のデプロイは成功するので気づかず、1週間ほど経ってから CI が `invalid_grant` で止まる。

- Google Workspace アカウント → 同意画面を **内部（Internal）** に設定する
- 個人 Gmail アカウント → **本番（Production）に公開** する

どちらも Google Cloud Console の「OAuth 同意画面」から設定できる。

もう一つ、アカウントに再認証ポリシー（reauthentication policy）が設定されていると、保存済みの refresh token では突破できず `invalid_grant` / `invalid_rapt` になる。そのアカウントは無人 CI には向かないので、デプロイ専用のアカウントを用意するのが無難。

なお `~/.clasprc.json` は `{ tokens: { <アカウント名>: {...}, default: {...} } }` の形で複数アカウントを保持できる。この Action は常に `default` を使う。複数あって `default` が無い場合は、どれを使うか推測せずエラーにする。

## `deployment-id` は最初に用意しておく

GAS の CI で一番起きやすい事故がこれ。

**`deployment-id` を省略すると、実行のたびに新しいデプロイが作られ、新しい URL が発行される。** 既存の URL を見ていたトラフィックは古いデプロイに取り残される。Web アプリやアドオンとして運用しているなら、ほぼ必ず `deployment-id` を指定する必要がある。

実際に測ってみると挙動は明確だった。

```
[1] deployment-id 無し
    webAppUrl = https://script.google.com/macros/s/AKfycbxDPA1HGN.../exec

[2] 同じ deployment-id を指定
    webAppUrl = [1] と完全に同一

[3] deployment-id 無しで再デプロイ
    webAppUrl = https://script.google.com/macros/s/AKfycbz7v0iXe1.../exec  ← 別 URL
```

`project-type` が `webapp` または `addon` で、`deployment-id` が未指定かつ差分がある場合には、実行前に警告を出すようにしてある。

もう一点、Apps Script はバージョン付きデプロイを最大20個までしか持てない（実測で確認。21個目は `FAILED_PRECONDITION` になる。`@HEAD` デプロイは別枠で上限に含まれない）。`deployment-id` を指定せず新規デプロイを作り続けると、いずれ枠が尽きる。この Action は18件を超えたあたりで警告を出す。

そして `deployment-id` を指定した運用でなければ、後述のロールバックもできない。戻すべき安定した参照先が存在しないからだ。

## `.claspignore` は gitignore ではない

これも事故につながるので先に書いておく。

`.claspignore` は glob マッチであって、gitignore のディレクトリ指定・ルート指定の意味論を持たない。gitignore の感覚で書いたパターンは、エラーにも警告にもならず、静かに何も除外しない。

clasp v3.3.0 の実際の判定を測った結果がこれ。

| 書き方（誤り） | 実際の挙動 | 正しい書き方 |
|---|---|---|
| `/Code.js` | ルート限定にならず、そもそも何も除外しない | `Code.js` |
| `build/` | ディレクトリごと除外にならない | `build/**` |
| `ui/` | ディレクトリごと除外にならない | `ui/**` |
| `secrets.js` | ルート直下のみ対象。`nested/secrets.js` は除外されない | `**/secrets.js` |

とくに危ないのが `*.test.js`。gitignore の感覚だと「テストを全部除外した」つもりになるが、実際に除外されるのはルート直下のものだけで、サブディレクトリのテストは本番にそのままデプロイされる。階層を問わず除外したいなら `**/*.test.js` と書く。

この Action は clasp の判定と一致させてあり、その一致は `clasp status --json` の出力と突き合わせるゴールデンテストで固定している。挙動を「直感的に」修正することはしない。修正すると clasp 互換が壊れるため。

## マージ前に差分を PR で見る

`dry-run` と `comment-on-pr` を組み合わせると、何が本番に出るかを PR 上で確認できる。

```yaml
permissions:
  contents: read
  pull-requests: write     # これが無いと 403 になる

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: yut0takagi/gas-deploy-action/deploy@v0
        with:
          credentials: ${{ secrets.CLASPRC_JSON }}
          script-id: ${{ secrets.GAS_SCRIPT_ID }}
          dry-run: true
          comment-on-pr: true
```

コメントには隠しマーカーを埋め込んでいるので、push のたびに新しいコメントが積み上がることはなく、同じコメントが更新される。dev と prod のプレビューを同じ PR に並べても互いを上書きしない（`comment-key` でキーを分けられる）。

単一プロジェクトモードを1つのワークフローで複数回実行する場合だけ注意がいる。既定のキーが固定なので、後の実行が前の実行のコメントを上書きしてしまう。`comment-key` を明示的に分けること。

コメント投稿に失敗しても、ジョブは失敗にせず警告に留めるようにした。成功した本番デプロイを赤い実行結果として報告すると、それを見て動くロールバック自動化や人間の判断を誤らせるため。サマリの内容はこの時点でジョブサマリに書き出してあるので、コメントが出なくても情報は失われない。

push で走るワークフローに `comment-on-pr: true` が付いたままでも失敗しない。「PR ではない」は異常ではなく通常の状態として扱う。ただしフォークからの `pull_request` イベントでは、既定の `GITHUB_TOKEN` が読み取り専用になるためコメントは投稿できない。これは GitHub 側のセキュリティ仕様。

## 複数プロジェクトをまとめて扱う

1リポジトリに複数の GAS プロジェクトを置いて、環境ごとにデプロイできる。リポジトリ直下に `gasdeploy.yml` を置く。

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

ワークフロー側では `environment` を渡す。

```yaml
- uses: yut0takagi/gas-deploy-action/deploy@v0
  with:
    credentials: ${{ secrets.CLASPRC_JSON }}
    environment: prod
  env:
    PROD_WEBAPP_SCRIPT_ID: ${{ secrets.PROD_WEBAPP_SCRIPT_ID }}
    PROD_WEBAPP_DEPLOYMENT_ID: ${{ secrets.PROD_WEBAPP_DEPLOYMENT_ID }}
    SHEET_TOOLS_SCRIPT_ID: ${{ secrets.SHEET_TOOLS_SCRIPT_ID }}
```

`gasdeploy.yml` はリポジトリ内のただの YAML なので `${{ }}` は展開されない。そこでこの Action が `${VAR}` を環境変数から展開する。scriptId をリポジトリに直書きしたくないときに使う。未定義の変数はエラーにしている。空文字のまま進めると、空の scriptId で API を叩いて意味不明な 404 になるため。

デプロイは逐次実行で、最初の失敗で停止する。並列にしないのは、API のレート制限と、失敗時にどこまで進んだか分からなくなるのを避けるため。停止した場合は、どのプロジェクトが完了済みでどれが未着手かをサマリに明記する。`deployments` 出力にも全ターゲットが `deployed` / `unchanged` / `failed` / `skipped` の状態付きで入るので、赤いジョブを見た人が Apps Script のコンソールを開かずに現状を把握できる。

なお `script-id` 入力があると設定ファイルは完全に無視される。両方を混ぜると挙動が読めなくなるため。既存の単一プロジェクトの使い方はそのまま動く。

## ロールバック

`rollback` は別のアクションとして提供している。デプロイが指すバージョン番号を差し替えるだけで、ファイルの書き込みもバージョンの作成もしない。Apps Script にはバージョンを削除する API が存在しないため、過去のバージョンはいつでも指し直せる。

```yaml
- uses: yut0takagi/gas-deploy-action/rollback@v0
  with:
    credentials: ${{ secrets.CLASPRC_JSON }}
    script-id: ${{ secrets.PROD_SCRIPT_ID }}
    deployment-id: ${{ secrets.PROD_DEPLOYMENT_ID }}
    version-number: '38'
```

### ロールバックしても HEAD のソースは戻らない

この機能で最も事故になりやすいのがここ。

ロールバックが書き換えるのはデプロイが指すバージョン番号だけで、プロジェクトの HEAD — スクリプトエディタを開いたときに見えるソース — は問題のあるコードのまま残る。

この状態でリポジトリを直さずに次のデプロイを走らせると、こうなる。

1. 差分として検出されるのは「その後に加えた変更」だけ
2. しかし作られるバージョンは、問題のあるコードを含んだ HEAD 全体のスナップショット
3. そのバージョンがデプロイされ、ロールバックが静かに巻き戻る

無関係な一行の修正をプッシュしただけで本番が再び壊れる。ロールバックしたら、必ずリポジトリ側も revert すること。この Action は実行のたびにこの警告を出す。

### デプロイ直後は `version-number` を明示する

`version-number` を省略すると「現在のバージョンの1つ前」に戻すのだが、この「現在のバージョン」は API から読んで計算している。ところが Apps Script API のデプロイ読み取りは、書き込み直後の一貫性を保証しない。

`deployments.update` の直後に `deployments.list` を1秒間隔でポーリングした実測がこれ（v8 → v7 に書き換えた直後）。

```
+1325ms  list=v7  get=v8
+3828ms  list=v8  get=v8     ← 古い値に戻った
+6044ms  list=v7  get=v8
+8517ms  list=v7  get=v7
```

単調ですらない。別の実行では `list` が30秒間ずっと古い値を返し続けた。複数のレプリカが別々の履歴地点を返していると思われる。

緩和策として、現在のバージョンは一覧ではなく単体取得（`deployments.get`、実測でより速く収束する）から読み、さらに連続2回の読み取りが一致するまで待つようにしてある。それでも一致しなければ、推測せずに失敗して `version-number` の明示を促す。

ただしこれは確率を下げるだけで保証ではない。2回の読み取りが両方とも同じ古いレプリカに当たれば通ってしまう（実測で発生した）。その場合、意図より1つ余計に古いバージョンへ静かに戻る。

障害対応でロールバックする、つまりデプロイ直後に戻すという最もありがちな流れがちょうどこの窓に入る。実用上は `version-number` を明示するのが確実。

### 戻り先を確実に受け渡す

`deploy` は `previous-version-number` を出力する。デプロイを更新する**前に**読み取った値なので、上記の読み取り一貫性の問題を受けない。これを `rollback` に渡せば問題を完全に回避できる。

```yaml
- id: deploy
  uses: yut0takagi/gas-deploy-action/deploy@v0
  with:
    credentials: ${{ secrets.CLASPRC_JSON }}
    script-id: ${{ secrets.GAS_SCRIPT_ID }}
    deployment-id: ${{ secrets.GAS_DEPLOYMENT_ID }}

- name: スモークテスト
  id: smoke
  continue-on-error: true
  run: ./scripts/smoke-test.sh

- name: 失敗したら直前のバージョンに戻す
  if: steps.smoke.outcome == 'failure'
  uses: yut0takagi/gas-deploy-action/rollback@v0
  with:
    credentials: ${{ secrets.CLASPRC_JSON }}
    script-id: ${{ secrets.GAS_SCRIPT_ID }}
    deployment-id: ${{ secrets.GAS_DEPLOYMENT_ID }}
    version-number: ${{ steps.deploy.outputs.previous-version-number }}
```

複数プロジェクトモードでは `deployments` 出力の各要素に `previousVersionNumber` が入る。

ロールバックは一度に1プロジェクトのみで、`all` は指定できない。障害時に戻したいのは壊れた1プロジェクトであって、正常に動いている残りまで巻き戻すのはほぼ確実に事故になるため。

## 本番で動いているコミットを知る / 認証情報を監視する

残り2つのアクションは、運用に入ってから効いてくるもの。

> この2つはまだリリースされていない。`v0.1.1` および `v0` タグには含まれていないので、現時点では `@main` を指定する必要がある。

`status` は「本番で動いているコードがどのコミット由来か」を返す。GAS にはこれを記録する場所がないので、`deploy` がバージョン説明にコミット情報を埋め込み、`status` がそれを読む。

```yaml
- id: status
  uses: yut0takagi/gas-deploy-action/status@main
  with:
    credentials: ${{ secrets.CLASPRC_JSON }}
    script-id: ${{ secrets.GAS_SCRIPT_ID }}
    deployment-id: ${{ secrets.GAS_DEPLOYMENT_ID }}

- run: echo "本番は ${{ steps.status.outputs.sha }} (PR #${{ steps.status.outputs.pr }})"
```

バージョン説明はこの形式で記録される。

```text
ci sha=6251c8c9f2a1b3d4e5f6a7b8c9d0e1f2a3b4c5d6 run=31344375660 pr=42 by=yut0takagi
```

この形式に完全一致しないバージョンは「CI 管理外」として報告する。部分一致から情報を拾うと、人が手で作ったバージョンを CI 製と取り違えるため、意図的に厳格にしている。

`token-check` は refresh token の失効を先に検知するためのもの。失効は普通、次にデプロイが必要になった瞬間に初めて分かる。障害対応でロールバックしようとしたら認証が通らない、が最悪の形なので、週次で先に潰しておく。

```yaml
on:
  schedule:
    - cron: '0 3 * * 1'     # 毎週月曜

permissions:
  contents: read
  issues: write

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - id: check
        uses: yut0takagi/gas-deploy-action/token-check@main
        with:
          credentials: ${{ secrets.CLASPRC_JSON }}
          script-id: ${{ secrets.GAS_SCRIPT_ID }}

      - name: 失効していたら Issue を起票する
        if: failure() && steps.check.outputs.status == 'invalid'
        run: gh issue create --title "GAS の認証情報が失効しました" --body "${{ steps.check.outputs.summary }}"
        env:
          GH_TOKEN: ${{ github.token }}
```

`script-id` を指定すると、トークンの交換だけでなく実際にそのプロジェクトを読み取れるかまで確認する。「トークンは生きているが Apps Script API を無効化された」「対象スクリプトの権限を外された」は、交換だけでは検知できないため。

判定は3状態ある。

| `status` | 意味 | 既定の挙動 |
|---|---|---|
| `valid` | 使える | 何もしない |
| `invalid` | 使えない。このままではデプロイが失敗する | ジョブを失敗させる |
| `unknown` | 有効かどうか判定できなかった。失効したとは限らない | 警告のみ |

`unknown` で既定ではジョブを落とさない。ランナーが Google に到達できなかっただけで週次ジョブが赤くなると、本当に失効したときの赤が「またいつもの失敗」として埋もれる。監視の価値は赤が希少であることに依っている。到達性の問題まで検知したいなら `fail-on-unknown: true` を指定する。

分岐にはメッセージ本文ではなく `reason` を使うこと。`ok` / `token-invalid` / `insufficient-scope` / `unauthorized` / `api-disabled` / `access-denied` / `not-found` / `connectivity` / `response-invalid` / `api-error` / `unclassified` のいずれかを返す。

## 導入前に知っておくべき制限

- **サービスアカウントは使えない。** Apps Script API は Google 側の仕様としてサービスアカウントのトークンを受け付けない。clasp v3 の `--adc` オプションも公式に EXPERIMENTAL / NOT WORKING とされている。ユーザーアカウントの refresh token を Secret に格納する方式が現状唯一の選択肢で、これはこの Action ではなく Google 側の制約。
- **TypeScript のトランスパイルはしない。** `root-dir` にはビルド済み JS を置く。
- **`updateContent` はローカルの内容で全ファイルを置き換える。** `root-dir` の指定を誤ると、稼働中のスクリプトから大半のファイルが消える。リモートの半分以上が削除される場合は警告を出すが、実行そのものは止めない。`root-dir` は必ず確認すること。
- **部分的な失敗が再実行で救済されないことがある。** `updateContent` の成功後に `versions.create` が 5xx で落ちると、実行全体は失敗として報告される。ここで再実行すると HEAD は既に新しい内容なので差分ゼロと判定され、何もせず成功したかのように終了する。デプロイは古いバージョンを指したまま残る。この事故を防ぐため、POST リクエストは 5xx で自動リトライしない（二重にバージョン・デプロイが作られる方が危険なため）。5xx で失敗した場合はその旨をメッセージで案内する。
- **`root-dir` 直下の非マニフェスト JSON は黙って除外される。** `appsscript.json` 以外の `.json`（例: `config.json`）は Apps Script が保持できないため、収集対象から外れる。clasp と同じ挙動だが、除外されたことを示す警告や diff エントリは出ない。
- **`.clasp.json` の `scriptExtensions` / `filePushOrder` には未対応。** 拡張子とファイル種別の対応はハードコードしている（既定値とは一致する）。

## clasp をラップしなかった理由

最後に設計の話を少しだけ。

dry-run、差分表示、既存デプロイの更新による URL 維持、デプロイ上限の警告。これらはいずれも clasp CLI の外側からは実装できない。既存の clasp ラッパー系 Action が対話プロンプトやエラー出力、バージョン間の仕様変更に振り回されがちなのは、構造上そうならざるを得ないからだ。

代わりに、`.claspignore` の解釈やファイル種別の判定といった「clasp 互換」を自前で保証する責任を負うことになる。ここは `clasp status --json` の判定結果と実装の出力を突き合わせるゴールデンテストで固定している。実際、この過程で自分の実装のほうが間違っていた箇所がいくつか見つかった。

- シンボリックリンクを無言でスキップしていた（clasp は push する）
- `Code.js` と `Code.gs` の同居を黙って重複エントリにしていた（clasp は push 全体を拒否する）
- `deployments.list` が既定で1件しか返さないことに気づかず、デプロイ上限の警告が永久に発火しない状態だった

最後のものは特に厄介で、`pageSize` を指定しないと21件あるうち `@HEAD` の1件しか返ってこない。ユニットテストでは絶対に見つからない類の不具合だった。

継続的な検証として、`push → 内容の確認 → デプロイ → ロールバック → 復元` を実 GAS に通す E2E を週次ワークフローに置いている。

## まとめ

GAS を CI でデプロイするなら、まず押さえるべきは3つ。

1. OAuth 同意画面を「テスト」のままにしない（1週間で壊れる）
2. `deployment-id` を最初に用意する（省略すると URL が変わる、ロールバックもできない）
3. `.claspignore` を gitignore の感覚で書かない（静かに何も除外しない）

この Action はこれらを警告として実装しているが、仕様そのものは GAS 側のものなので、どのツールを使っても踏むポイントではある。

リポジトリはこちら。MIT ライセンス。
https://github.com/yut0takagi/gas-deploy-action

実測の詳細（何をどう測って何が分かったか）は [`docs/superpowers/notes/2026-08-09-api-verification.md`](https://github.com/yut0takagi/gas-deploy-action/blob/main/docs/superpowers/notes/2026-08-09-api-verification.md) にまとめてある。
