/**
 * clasp 互換ゴールデンテスト
 *
 * gas-deploy-actions は clasp CLI をラップせず、Apps Script REST API を直接叩く。
 * そのため「どのファイルを push 対象にするか」の選定ロジックを自前で再実装しており、
 * clasp の挙動との乖離はそのまま実害（テストファイルの混入 / 必要ファイルの欠落）になる。
 *
 * このテストは記録済みのフィクスチャと突き合わせるのではなく、実際に `clasp status --json`
 * を実行してその場で得られる判定結果と、我々の collectFiles() の結果を直接比較する。
 * こうすることで、比較が一度きりの記録ではなく「今の clasp」との継続的な検証になる。
 *
 * 認証について（事前調査結果）:
 * `clasp status` はローカルの .clasp.json / .claspignore / ファイルツリーだけを見て
 * push 対象を判定しており、Google への認証を必要としない。
 * 実験方法: 存在しないパスを `-A <path>` (および `clasp_config_auth` 環境変数) で渡し、
 * 有効な認証情報が一切参照できない状態で `clasp status --json` を実行したところ、
 * 認証エラーにはならず正常な JSON が返った (clasp v3.3.0 で確認)。
 * そのためこのテストは CI でも無条件に実行され、通常は skip しない。
 * skip するのは clasp バイナリ自体が実行できない場合のみで、その際は理由を明示する。
 */
import { execFile, execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { collectFiles, parseClaspIgnore } from '@gas-deploy/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, 'fixtures', 'sample-project');
// リポジトリルートの node_modules/.bin/clasp を直接指す。PATH に依存しないことで、
// 「開発者のマシンにたまたま別バージョンの clasp がグローバルインストールされている」
// といった環境差を排除する。
const CLASP_BIN = join(__dirname, '..', 'node_modules', '.bin', 'clasp');
// 認証済みユーザーが実行しても実際の認証情報を拾わせないため、存在しないパスを明示的に渡す。
// 「clasp status --json は認証なしで動く」ことを、このテスト自身が毎回踏み直す形になる。
const NONEXISTENT_AUTH_PATH = join(tmpdir(), 'gas-deploy-clasp-compat-no-such-auth.json');

interface ClaspStatusResult {
  filesToPush: string[];
  untrackedFiles: string[];
}

/**
 * clasp バイナリ自体が実行できるかどうかを、テスト収集時に同期的に確認する。
 * `describe.skipIf` に渡す条件はテスト定義時点（トップレベル評価時）に確定している必要があるため、
 * ここだけは async ではなく execFileSync を使う。
 */
function checkClaspAvailable(): { available: boolean; reason?: string } {
  try {
    execFileSync(CLASP_BIN, ['--version'], { stdio: 'pipe' });
    return { available: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { available: false, reason };
  }
}

const claspAvailability = checkClaspAvailable();

if (!claspAvailability.available) {
  // describe.skipIf は結果をテストツリー上「skipped」として出すが、reporter によっては
  // 埋もれやすい。理由を stderr にも明示的に出し、CI ログを流し読みしただけでも
  // 「互換性チェックが今回は走っていない」と分かるようにする。
  // eslint-disable-next-line no-console
  console.warn(
    '\n' +
      '=================================================================\n' +
      '[clasp-compat] SKIPPED: clasp 互換テストを実行できませんでした。\n' +
      'gas-deploy-actions が実際の clasp と同じファイル選定を行うという\n' +
      '保証は、今回のテスト実行では検証されていません。\n' +
      `理由: ${claspAvailability.reason}\n` +
      '"npm install" を実行して @google/clasp (devDependency) が\n' +
      'node_modules/.bin/clasp に配置されているか確認してください。\n' +
      '=================================================================\n',
  );
}

/**
 * フィクスチャを一時ディレクトリへコピーし、ダミーの .clasp.json を書き込んで
 * `clasp status --json` を実行する。
 *
 * リポジトリ内では実行しない: `clasp status` は .clasp.json (実在の scriptId) を要求するため、
 * リポジトリに .clasp.json をコミットすると本物の scriptId が漏れることになる。
 */
async function runClaspStatus(rootDir: string): Promise<ClaspStatusResult> {
  const claspConfig = {
    // ダミーの scriptId。clasp status はローカル判定のみで API を呼ばないため、実在性は問われない。
    scriptId: '1DUMMYSCRIPTIDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    rootDir: '',
  };
  await writeFile(join(rootDir, '.clasp.json'), JSON.stringify(claspConfig), 'utf8');

  try {
    const { stdout } = await execFileAsync(CLASP_BIN, ['status', '--json', '-A', NONEXISTENT_AUTH_PATH], {
      cwd: rootDir,
    });
    return JSON.parse(stdout) as ClaspStatusResult;
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String((error as { stderr: unknown }).stderr) : '';
    const stdout = error && typeof error === 'object' && 'stdout' in error ? String((error as { stdout: unknown }).stdout) : '';
    // clasp が非0で終了した場合、それが clasp 自体の問題なのか、フィクスチャ/我々の呼び出し方の
    // 問題なのかを後から切り分けられるよう、stderr をそのままテスト失敗メッセージに含める。
    throw new Error(
      'clasp status --json が失敗しました。\n' + `--- stderr ---\n${stderr}\n--- stdout ---\n${stdout}`,
      { cause: error },
    );
  }
}

type FileType = 'SERVER_JS' | 'HTML' | 'JSON';

const EXTENSION_TO_TYPE: Record<string, FileType> = {
  '.js': 'SERVER_JS',
  '.gs': 'SERVER_JS',
  '.html': 'HTML',
  '.json': 'JSON',
};

/**
 * clasp の filesToPush (相対パス) を、我々の ScriptFile と同じ「拡張子を落とした名前 + 種別」の
 * 空間へ変換する。
 *
 * 逆方向（ScriptFile → 相対パス）には変換できない点に注意: ScriptFile は元の拡張子を保持しないため
 * (.js と .gs はどちらも SERVER_JS になる)、"Legacy.gs" から作った ScriptFile を relative path に
 * 戻そうとすると "Legacy.js" のような誤った拡張子を復元してしまう。そのため比較は必ずこちら向きに行う。
 */
function claspPathToKey(relativePath: string): string {
  const lastDot = relativePath.lastIndexOf('.');
  const extension = lastDot === -1 ? '' : relativePath.slice(lastDot).toLowerCase();
  const name = lastDot === -1 ? relativePath : relativePath.slice(0, lastDot);
  const type = EXTENSION_TO_TYPE[extension];
  return `${name} ${type ?? extension}`;
}

function ourFileToKey(file: { name: string; type: FileType }): string {
  return `${file.name} ${file.type}`;
}

describe.skipIf(!claspAvailability.available)('clasp status --json との互換性', () => {
  let tempDir: string;
  let claspResult: ClaspStatusResult;
  let ourFiles: Awaited<ReturnType<typeof collectFiles>>;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gas-deploy-clasp-compat-'));
    await cp(FIXTURE_DIR, tempDir, { recursive: true });

    // clasp 側: 実際に clasp status --json を実行して判定させる
    claspResult = await runClaspStatus(tempDir);

    // 自前実装側: 同じディレクトリに対して .claspignore を読み、collectFiles() を実行する
    const claspIgnoreContent = await readFile(join(tempDir, '.claspignore'), 'utf8');
    const ignorePatterns = parseClaspIgnore(claspIgnoreContent);
    ourFiles = await collectFiles(tempDir, ignorePatterns);
  });

  afterAll(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('collectFiles() が選ぶファイル集合は、実際の clasp が push するファイル集合と一致する', () => {
    // clasp の filesToPush の並び順は本質的な情報ではないため、両者をソートしてから比較する。
    const claspPushSet = claspResult.filesToPush.map(claspPathToKey).sort();
    const ourPushSet = ourFiles.map(ourFileToKey).sort();

    expect(ourPushSet).toEqual(claspPushSet);
  });

  it('Code.test.js と ignored.txt は .claspignore により両者から除外される', () => {
    expect(claspResult.untrackedFiles).toEqual(expect.arrayContaining(['Code.test.js', 'ignored.txt']));

    const ourNames = ourFiles.map((file) => file.name);
    expect(ourNames).not.toContain('Code.test');
    expect(ourNames).not.toContain('ignored');
  });

  it('.clasp.json と .claspignore 自体は push 対象に含まれない', () => {
    const claspPushSet = claspResult.filesToPush;
    expect(claspPushSet).not.toContain('.clasp.json');
    expect(claspPushSet).not.toContain('.claspignore');

    const ourNames = ourFiles.map((file) => file.name);
    expect(ourNames).not.toContain('.clasp');
    expect(ourNames).not.toContain('.claspignore');
  });

  it('拡張子の扱いとサブディレクトリの扱いが clasp と一致する（app.js.html / ui/Sidebar.html）', () => {
    // app.js.html は最後の拡張子だけが取り除かれ、名前は "app.js" になる（"app" にはならない）
    const appJs = ourFiles.find((file) => file.name === 'app.js');
    expect(appJs).toBeDefined();
    expect(appJs?.type).toBe('HTML');
    expect(claspResult.filesToPush).toContain('app.js.html');

    // ui/Sidebar.html はサブディレクトリを "/" 区切りで保持したまま拡張子だけ落とす
    const sidebar = ourFiles.find((file) => file.name === 'ui/Sidebar');
    expect(sidebar).toBeDefined();
    expect(sidebar?.type).toBe('HTML');
    expect(claspResult.filesToPush).toContain('ui/Sidebar.html');
  });
});
