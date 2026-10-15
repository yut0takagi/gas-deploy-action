---
name: release
description: gas-deploy-action の新しいバージョンをリリースする。全パッケージのバージョンを上げて main に push し、vX.Y.Z タグを打ち、追従用の v0 タグを移し、GitHub Release を作る。日本語トリガー: 「リリースして」「タグを打って」「バージョンを上げて」「v0.x.0 を出して」「リリースノートを書いて」。
---

# リリース手順

v0.2.0 と v0.3.0 はこの手順で出した。順番を入れ替えない。とくにタグは、リリースコミットの CI が通ってから打つ。

## 1. 現状の確認

```bash
git checkout main && git pull --ff-only
git status --short                       # 空であること
git describe --tags --abbrev=0           # 前回のタグ
git log --oneline <前回のタグ>..main     # 今回入る変更
gh run list --branch main --limit 1      # main の CI が success であること
```

## 2. バージョンを決める

1.0 未満なので、上げるのはマイナーかパッチだけ。

- マイナー: 新機能、破壊的変更、既存のワークフローの結果が変わりうる挙動の変更（例: v0.3.0 では、差分ゼロの実行でも deployment-id を読むようになり、ID が誤っていると失敗するようになった）
- パッチ: 利用者から見た挙動が変わらない修正だけ

迷ったらマイナーにする。`@v0` の利用者には、どちらでも次の実行から届く。

## 3. ユーザーの承認を取る

この手順には、main への直接 push、タグの強制 push、公開の Release が含まれる。AskUserQuestion で次をまとめて1回だけ確かめ、承認を得てから 4 に進む。

- 新しいバージョン番号とその理由
- 次の4つを行うこと: リリースコミットを main に直接 push する、vX.Y.Z を打つ、v0 を移す、GitHub Release を作る
- v0 を動かさない選択肢と、リリースコミットを PR 経由にする選択肢

承認は今回のリリースに限る。前回の承認を流用しない。

## 4. バージョンを上げる

```bash
python3 .claude/skills/release/scripts/bump_version.py <旧> <新>
npm install --prefer-offline             # package-lock.json を更新する
```

スクリプトが書き換えるのは次の箇所。全ファイルを検査してから書くので、途中で止まっても書きかけは残らない。

- ルートとワークスペース全体の package.json の version
- 内部依存（`@gas-deploy/core` など）の版。揃えないと npm install が registry を探しに行き 404 になる
- `packages/core/src/index.ts` の VERSION と、そのテスト
- README.md の使用例の `@v<旧>`。「実際に v0.2.0 で〜」のような `@` の付かない過去の記述は残す

ワークスペースを足したときも、ルートの package.json の workspaces から拾うのでスクリプトの修正は要らない。

## 5. 検証してコミットする

```bash
.claude/skills/release/scripts/verify.sh
```

CI と同じく、型チェック、テスト、ビルド、バンドルの起動確認を通す。VERSION 定数はバンドルに含まれないので、通常 dist は変わらない。変わったと報告されたらコミットに含める。

コミットメッセージは `chore(release): vX.Y.Z` とし、本文にマイナーかパッチかの理由を書く。

`git add` するのは、スクリプトが更新したファイル、`package-lock.json`、変わっていれば dist だけにする。`git status --short` で、それ以外の変更が混ざっていないかを先に確かめる。コミットメッセージの末尾には Co-Authored-By を付ける。

```bash
git commit
git push origin main
```

push したら、そのコミットの CI が終わるまで待つ。

```bash
SHA=$(git rev-parse --short HEAD)
for i in $(seq 1 30); do
  S=$(rtk proxy gh run list --branch main --event push --limit 1 --json status,conclusion,headSha \
      -q '.[0] | .headSha[0:7] + " " + .status + " " + (.conclusion // "-")')
  case "$S" in "$SHA"*completed*) break;; esac; sleep 15
done; echo "$S"
```

success でなければ止まり、ユーザーに報告する。タグは打たない。

## 6. タグを打つ

どちらも注釈付きタグにする。v0 は既存のタグを置き換えるので強制 push になる。

```bash
git tag -a vX.Y.Z -m "vX.Y.Z" <リリースコミット>
git push origin vX.Y.Z
git tag -f -a v0 -m "v0 (latest v0.x)" <リリースコミット>
git push -f origin v0
git ls-remote --tags origin 'v0*' | grep '\^{}$'   # v0 と vX.Y.Z が同じコミットを指すこと
```

## 7. GitHub Release を作る

```bash
gh release create vX.Y.Z --verify-tag --title "vX.Y.Z" --notes-file <ノート> --latest
```

ノートは敬体で書き、次の順に並べる。該当しない節は省く。

1. 挙動の変更（破壊的変更なら「⚠️ 破壊的変更」）。v0 の利用者が次の実行で受ける影響を先頭に置く。各項目の1文目を太字にする。最後に「`@v0` を使っている場合、このタグは vX.Y.Z に移動済みです」と、本番では `@vX.Y.Z` に固定するよう勧める一文を入れる
2. 新機能。機能ごとに小見出しを立て、PR 番号を付ける
3. 修正。独立した修正を箇条書きで並べる
4. その他の変更。内部のリファクタリングは、利用者から見た挙動が変わるかどうかだけを書く
5. 未検証の前提。実 API で確かめていない前提があれば書く

書いたら yomiyasu の lint を通す。

```bash
python3 ~/.claude/skills/yomiyasu/scripts/yomiyasu_lint.py <ノート>
```

## 8. 報告する

リリースコミット、タグ、v0 の移動、Release の URL を表にして報告する。戻し方も添える。

## 戻し方

- v0 を前の版に戻す: `git tag -f -a v0 -m "v0 (latest v0.x)" <前の版>^{}` のあと `git push -f origin v0`。`@v0` の利用者は次の実行から前の挙動に戻る
- Release を取り下げる: `gh release delete vX.Y.Z`。タグは残るので、`@vX.Y.Z` に固定した利用者は壊れない。タグまで消すのは、誰も使っていないと確かめられたときだけにする

## つまずきやすい点

- **rtk が出力を加工する。** `gh pr checks` の結果が欠けたり、`git stash -u` の `-u` が落ちたりした。状態の確認には `rtk proxy` を付ける
- **タグを先に打たない。** CI が落ちたリリースコミットにタグを打つと、`@v0` の利用者に壊れた版が届く
- **リリースのための PR を積み重ねない。** 子 PR のベースを親 PR のブランチにすると、親ブランチを残したまま子をマージしたとき main に届かない（#12 で起きた）
