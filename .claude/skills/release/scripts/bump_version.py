#!/usr/bin/env python3
"""リリースのためにバージョン番号を書き換える。

使い方: python3 bump_version.py <旧バージョン> <新バージョン>
例:     python3 bump_version.py 0.3.0 0.4.0

書き換える箇所:
- ルートとワークスペース全体の package.json の "version"
- 内部依存（"@gas-deploy/<名前>": "<旧>"）。揃えないと npm install が
  registry 上の旧版を探しに行き、404 で落ちる
- packages/core/src/index.ts の VERSION と、その値を確かめるテスト
- README.md の使用例の "@v<旧>"。"@" の付かない記述（「実際に v0.2.0 で〜」
  のような過去の出来事）は書き換えない

package-lock.json は書き換えない。実行後に npm install --prefer-offline を回す。
"""
import glob
import json
import re
import subprocess
import sys
from pathlib import Path

VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")


def repo_root() -> Path:
    out = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True)
    return Path(out.stdout.strip())


def package_json_files(root: Path) -> list[Path]:
    workspaces = json.loads((root / "package.json").read_text())["workspaces"]
    files = [root / "package.json"]
    for pattern in workspaces:
        for directory in sorted(glob.glob(str(root / pattern))):
            candidate = Path(directory) / "package.json"
            if candidate.is_file():
                files.append(candidate)
    return files


def replaced(path: Path, old: str, new: str) -> tuple[str, int]:
    text = path.read_text()
    count = text.count(old)
    if count == 0:
        sys.exit(f"想定した記述が見つかりません: {path} に {old!r}")
    return text.replace(old, new), count


def main() -> None:
    if len(sys.argv) != 3 or not all(VERSION_PATTERN.match(v) for v in sys.argv[1:]):
        sys.exit(__doc__)
    old, new = sys.argv[1], sys.argv[2]
    root = repo_root()

    # 全ファイルを検査してから書く。途中で止まって一部だけ書き換わった状態を残さない。
    updates: list[tuple[Path, str]] = []
    for path in package_json_files(root):
        text = path.read_text()
        updated = text.replace(f'"version": "{old}"', f'"version": "{new}"')
        updated = re.sub(rf'("@gas-deploy/[a-z0-9-]+": )"{re.escape(old)}"', rf'\1"{new}"', updated)
        if updated == text:
            sys.exit(f"{path} に {old} がありません。旧バージョンの指定を確かめてください")
        if f'"{old}"' in updated:
            sys.exit(f"書き換えきれなかった {old} が残っています: {path}")
        updates.append((path, updated))

    index_ts = root / "packages/core/src/index.ts"
    index_test = root / "packages/core/src/index.test.ts"
    readme = root / "README.md"
    updates.append((index_ts, replaced(index_ts, f"export const VERSION = '{old}';", f"export const VERSION = '{new}';")[0]))
    updates.append((index_test, replaced(index_test, f"toBe('{old}')", f"toBe('{new}')")[0]))
    readme_text, readme_count = replaced(readme, f"@v{old}", f"@v{new}")
    updates.append((readme, readme_text))

    for path, text in updates:
        path.write_text(text)
        print(f"更新: {path.relative_to(root)}")
    print(f"README.md の使用例: {readme_count} 箇所")
    print("次に npm install --prefer-offline を実行して package-lock.json を更新してください")


if __name__ == "__main__":
    main()
