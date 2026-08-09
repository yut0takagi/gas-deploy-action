import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { GasDeployError, REQUESTED_SCOPES } from '@gas-deploy/core';
import type { Credentials } from '@gas-deploy/core';
import {
  accountTypeStep,
  consentScreenStep,
  enableApiStep,
  oauthClientStep,
  projectStep,
  promptInput,
  type AccountType,
} from './guide.js';
import {
  buildAuthorizationUrl,
  deriveCodeChallenge,
  exchangeCodeForRefreshToken,
  generateCodeVerifier,
  generateState,
  waitForAuthorizationCode,
} from './oauth.js';
import { verifyCredentials } from './verify.js';

const DEFAULT_SECRET_NAME = 'GAS_DEPLOY_CREDENTIALS';
const DEFAULT_CREDENTIALS_PATH = './gas-deploy-credentials.json';

export interface RunSetupOptions {
  /** テスト・デバッグ用の差し替え。既定はグローバルの fetch。 */
  fetchImpl?: typeof fetch;
  /** 案内・状態メッセージの出力先。既定は console.log。 */
  log?: (message: string) => void;
  /** 標準入力からの読み取り。既定は guide.ts の promptInput。 */
  promptInputImpl?: (question: string) => Promise<string>;
  /** ブラウザ起動・gh 呼び出しに使う execFile。既定は node:child_process の execFile。 */
  execFileImpl?: typeof execFile;
}

interface ResolvedOptions {
  fetchImpl: typeof fetch;
  log: (message: string) => void;
  promptInputImpl: (question: string) => Promise<string>;
  execFileImpl: typeof execFile;
}

function resolveOptions(options: RunSetupOptions): ResolvedOptions {
  return {
    fetchImpl: options.fetchImpl ?? fetch,
    log: options.log ?? ((message: string) => console.log(message)),
    promptInputImpl: options.promptInputImpl ?? promptInput,
    execFileImpl: options.execFileImpl ?? execFile,
  };
}

function execFilePromise(execFileImpl: typeof execFile, command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFileImpl(command, args, (error) => resolve(!error));
  });
}

/**
 * ブラウザを開く。失敗してもプロセスを止めない設計にする — URL を表示して手動で開いてもらえば
 * 済むため、ブラウザを起動できないこと自体は致命的な失敗ではない
 * （execFile が使えない環境やヘッドレス環境で setup-cli 全体が死ぬのを避ける）。
 */
function openBrowser(execFileImpl: typeof execFile, url: string): Promise<boolean> {
  const platform = process.platform;
  const [command, args]: [string, string[]] =
    platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['start', ['', url]] : ['xdg-open', [url]];
  return execFilePromise(execFileImpl, command, args);
}

/** `gh` が利用可能かつ認証済みかを確認する。 */
async function isGhReady(execFileImpl: typeof execFile): Promise<boolean> {
  const hasGh = await execFilePromise(execFileImpl, 'gh', ['--version']);
  if (!hasGh) return false;
  return execFilePromise(execFileImpl, 'gh', ['auth', 'status']);
}

/**
 * JSON を argv ではなく標準入力経由で `gh secret set` に渡す。
 * argv に渡すと `ps` 等のプロセス一覧にシークレットが露出しうるため、必ず stdin 経由にする。
 */
function ghSecretSetFromStdin(execFileImpl: typeof execFile, secretName: string, jsonBody: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFileImpl('gh', ['secret', 'set', secretName], (error) => {
      if (error) {
        reject(
          new GasDeployError('GitHub Secret の登録に失敗しました', {
            cause: error,
            nextSteps: [
              'gh auth status で認証状態を確認してください',
              'リポジトリに対する admin 権限があるか確認してください',
              '認証情報は画面に表示していません。もう一度このコマンドを実行してやり直してください',
            ],
          }),
        );
        return;
      }
      resolve();
    });
    child.stdin?.end(jsonBody);
  });
}

/**
 * GitHub Secrets への登録・ファイルへの書き出し以外では、この関数の戻り値（refresh token・
 * client secret を含む JSON 文字列）を絶対にログ出力・console.log してはならない。
 */
function toMinimalJson(credentials: Credentials): string {
  return JSON.stringify(credentials);
}

async function offerPersistence(resolved: ResolvedOptions, credentials: Credentials): Promise<void> {
  const { log, promptInputImpl, execFileImpl } = resolved;

  const answer = await promptInputImpl('\nこの認証情報を GitHub Secrets に登録しますか？ (Y/n): ');
  if (/^n/i.test(answer.trim())) {
    log('登録をスキップしました。認証情報はどこにも保存していません。必要な場合は再度このコマンドを実行してください。');
    return;
  }

  const ghReady = await isGhReady(execFileImpl);
  if (ghReady) {
    const secretNameRaw = await promptInputImpl(`登録する Secret 名を入力してください (既定: ${DEFAULT_SECRET_NAME}): `);
    const secretName = secretNameRaw.trim() || DEFAULT_SECRET_NAME;
    await ghSecretSetFromStdin(execFileImpl, secretName, toMinimalJson(credentials));
    log(`GitHub Secret "${secretName}" に登録しました。`);
    return;
  }

  log('gh コマンドが利用できないか、認証されていません。GitHub Secrets への自動登録をスキップします。');
  const pathRaw = await promptInputImpl(
    `代わりに認証情報をファイルに書き出します。保存先のパスを入力してください (既定: ${DEFAULT_CREDENTIALS_PATH}): `,
  );
  const path = pathRaw.trim() || DEFAULT_CREDENTIALS_PATH;
  await writeFile(path, toMinimalJson(credentials), 'utf8');
  log(
    [
      `認証情報を ${path} に書き出しました。`,
      '  - GitHub Secrets への登録が終わったら、このファイルは必ず削除してください',
      '  - このファイルを絶対にコミットしないでください（.gitignore への追加を推奨します）',
    ].join('\n'),
  );
}

/**
 * setup-cli の対話フロー全体を実行する。
 * この関数を呼び出したときにだけ動く — import しただけでは何も実行されない
 * （`deploy/src/main.ts` と同じ、副作用をエントリポイントから分離する設計）。
 */
export async function runSetup(options: RunSetupOptions = {}): Promise<void> {
  const resolved = resolveOptions(options);
  const { fetchImpl, log, promptInputImpl, execFileImpl } = resolved;

  log(accountTypeStep());
  const accountTypeAnswer = await promptInputImpl('番号を入力してください (1 または 2): ');
  const accountType: AccountType = accountTypeAnswer.trim() === '1' ? 'workspace' : 'personal';

  log('\n' + projectStep());
  log('\n' + enableApiStep());
  log('\n' + consentScreenStep(accountType));
  log('\n' + oauthClientStep());

  const clientId = (await promptInputImpl('\nクライアント ID: ')).trim();
  const clientSecret = (await promptInputImpl('クライアント シークレット: ')).trim();

  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = deriveCodeChallenge(codeVerifier);

  let redirectUri = '';
  const codePromise = waitForAuthorizationCode({
    state,
    onListening: (port) => {
      redirectUri = `http://127.0.0.1:${port}/`;
      const authorizationUrl = buildAuthorizationUrl({ clientId, redirectUri, state, codeChallenge });
      log(`\n次の URL をブラウザで開いて認可してください:\n${authorizationUrl}\n`);
      void openBrowser(execFileImpl, authorizationUrl).then((opened) => {
        if (!opened) {
          log('ブラウザを自動的に開けませんでした。上記の URL を手動でブラウザに貼り付けて開いてください。');
        }
      });
    },
  });

  const code = await codePromise;

  const credentials = await exchangeCodeForRefreshToken(
    { clientId, clientSecret, code, codeVerifier, redirectUri },
    fetchImpl,
  );

  log('認証情報を取得しました。付与されたスコープを検証しています...');
  const verification = await verifyCredentials(credentials, fetchImpl);

  if (verification.isMinimal) {
    log(`検証結果: OK。付与された権限は要求した2スコープ (${REQUESTED_SCOPES}) だけに絞り込まれています。`);
  } else {
    log('検証結果: NG。発行されたリフレッシュトークンのグラントが要求した2スコープと一致していません。');
    log(
      `想定外のスコープ: ${verification.unexpectedScopes.join(', ') || '(なし。要求スコープの一部が付与されていません)'}`,
    );
    log(
      '多くの場合、OAuth クライアントに紐づく同意画面に他のスコープが設定されていることが原因です。' +
        '同意画面の「スコープ」設定を見直し、この2つだけになるよう修正してから、再度このコマンドを実行してください。',
    );
    // isMinimal が false のまま Secrets 登録に進めることは「絞り込みを保証する」という
    // このパッケージの存在理由に反するため、ここで処理を打ち切る（persistence には進まない）。
    throw new GasDeployError('付与されたスコープが要求した2スコープと一致しませんでした', {
      nextSteps: [
        'OAuth 同意画面の「スコープ」設定を、要求する2スコープだけに修正してください',
        'https://myaccount.google.com/permissions で一度アクセスを取り消してからやり直すと、変更が反映されやすくなります',
      ],
    });
  }

  await offerPersistence(resolved, credentials);

  log('\nセットアップが完了しました。');
}
