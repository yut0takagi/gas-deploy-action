#!/bin/bash
# CI（.github/workflows/ci.yml）と同じ検証を手元で通す。
# 型チェック → テスト → ビルド → バンドルの起動確認 → dist の変化の報告。
set -e
cd "$(git rev-parse --show-toplevel)"

npm run typecheck > /dev/null 2>&1 || { echo "型チェックに失敗"; npm run typecheck 2>&1 | tail -20; exit 1; }
OUT=$(npx vitest run 2>&1) || { echo "テストに失敗"; echo "$OUT" | grep -E "FAIL|✗|×|Error" | head -20; exit 1; }
echo "$OUT" | grep -E "Test Files|Tests " | sed 's/^ *//'
npm run build > /dev/null 2>&1 || { echo "ビルドに失敗"; npm run build 2>&1 | tail -20; exit 1; }

# 入力が無いので必ず失敗する。@actions/core の ::error:: まで届いていれば正常で、
# モジュール形式の不一致や依存の欠落では Node の生のエラーで止まる。
for B in */dist/index.cjs; do
  set +e; O=$(node "$B" 2>&1); set -e
  if ! echo "$O" | grep -q "::error::" || echo "$O" | grep -qE "ReferenceError|SyntaxError|Cannot find module|is not defined"; then
    echo "起動確認に失敗: $B"; echo "$O" | head -5; exit 1
  fi
done
echo "型チェック / テスト / ビルド / 起動確認: OK"

CHANGED=$(git status --porcelain -- '*/dist/*')
if [ -n "$CHANGED" ]; then
  echo "dist がビルドで変わりました。コミットに含めてください（CI は dist の同期を検査します）:"
  echo "$CHANGED"
fi
