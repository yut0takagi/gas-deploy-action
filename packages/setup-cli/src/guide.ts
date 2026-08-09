import { createInterface } from 'node:readline/promises';
import { GasDeployError, REQUESTED_SCOPES } from '@gas-deploy/core';

export type AccountType = 'workspace' | 'personal';

const SCOPE_LIST = REQUESTED_SCOPES.split(' ');

/** 空欄・非対話環境からの入力に対する再試行回数の上限。標準入力が閉じている場合に無限ループしないための保険。 */
const MAX_PROMPT_ATTEMPTS = 3;

const NON_INTERACTIVE_NEXT_STEPS = [
  'このコマンドは対話的なターミナルからの入力を必要とします',
  '標準入力を /dev/null にリダイレクトしたり、パイプや非対話的なスクリプト・CI から実行しないでください',
];

/**
 * ステップ1: アカウントの種類。
 * この後のステップ（特に OAuth 同意画面の設定）はここでの回答によって案内文が変わる。
 */
export function accountTypeStep(): string {
  return [
    'ステップ1/5: アカウントの種類を選んでください。',
    '',
    '  1. Google Workspace のアカウント（会社・組織のメールアドレス）',
    '  2. 個人の Gmail アカウント',
    '',
    'これによって、この後の OAuth 同意画面の設定手順が変わります。',
  ].join('\n');
}

/** ステップ2: Google Cloud プロジェクトの作成 or 選択。 */
export function projectStep(): string {
  return [
    'ステップ2/5: Google Cloud プロジェクトを作成するか、既存のものを選んでください。',
    '',
    '  https://console.cloud.google.com/projectcreate を開き、新規プロジェクトを作成するか、',
    '  既にデプロイ用に使っているプロジェクトがあればそれを選択してください。',
  ].join('\n');
}

/**
 * ステップ3: Apps Script API の有効化。
 * 2箇所で有効化が必要（Cloud Console と usersettings）。片方だけだと分かりにくい失敗になる。
 */
export function enableApiStep(): string {
  return [
    'ステップ3/5: Apps Script API を「2箇所」で有効化してください。',
    '',
    '  1. Google Cloud Console の API ライブラリで「Google Apps Script API」を有効化してください',
    '     （検索: https://console.cloud.google.com/apis/library/script.googleapis.com ）',
    '  2. さらに https://script.google.com/home/usersettings を開き、',
    '     そこでも「Google Apps Script API」をオンにしてください',
    '',
    '  この2つ目を忘れる人が非常に多く、Cloud Console 側は有効化済みなのに',
    '  デプロイ時にだけ 403 エラーになる、という分かりにくい失敗の原因になります。',
    '  両方オンになっていることを必ず確認してください。',
  ].join('\n');
}

/**
 * ステップ4: OAuth 同意画面の設定。
 * アカウント種別によって「内部/外部」「本番への公開」の要否が変わるため案内文を分岐する。
 */
export function consentScreenStep(accountType: AccountType): string {
  const header = [
    'ステップ4/5: OAuth 同意画面を設定してください。',
    '',
    '  要求するスコープは次の2つだけにしてください。',
    '  同意画面の設定を保存したら、この2つだけが表示されていることを必ず確認してください:',
    `    - ${SCOPE_LIST[0]}`,
    `    - ${SCOPE_LIST[1]}`,
    '',
  ];

  const expiryWarning = [
    '  公開ステータスが「テスト (Testing)」のままだと、発行されたリフレッシュトークンは',
    '  7日で失効します。これは「先週まで動いていたのに急に動かなくなった」の',
    '  最もよくある原因です。必ず「テスト」から次のステータスに変更してください。',
    '',
  ];

  if (accountType === 'workspace') {
    return [
      ...header,
      '  Google Workspace アカウントの場合:',
      '    ユーザーの種類は「内部 (Internal)」を選択してください。',
      '    内部であれば公開ステータスの変更は不要です（組織内では最初から有効です）。',
      '',
      ...expiryWarning,
    ].join('\n');
  }

  return [
    ...header,
    '  個人の Gmail アカウントの場合:',
    '    ユーザーの種類は「外部 (External)」を選択してください。',
    '    保存後、公開ステータスを必ず「本番 (Production)」に変更してください。',
    '',
    ...expiryWarning,
    '  注記（未検証）: script.projects スコープの要求が、個人アカウントで Google の',
    '  「確認されていないアプリ」の警告をトリガーするかどうかは、本ツールでは未計測です。',
    '  警告が出た場合は、それを認識した上で自己責任で進めてください。',
  ].join('\n');
}

/** ステップ5: OAuth クライアント（Desktop app）の作成。 */
export function oauthClientStep(): string {
  return [
    'ステップ5/5: OAuth クライアント ID を作成してください。',
    '',
    '  アプリケーションの種類は必ず「デスクトップ アプリ (Desktop app)」を選択してください',
    '  （ウェブ アプリケーションではありません。リダイレクト URI をローカルのループバック',
    '  アドレスに動的に割り当てるため、Desktop app タイプが前提になっています）。',
    '',
    '  作成後に表示される「クライアント ID」と「クライアント シークレット」を、',
    '  この後の入力プロンプトに貼り付けてください。',
  ].join('\n');
}

/**
 * 標準入力から1行読み取る薄い I/O 関数。
 * ガイド文（純粋関数、上記）とは分離してあるため、ガイド文だけをテストできる。
 */
export async function promptInput(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

/**
 * 空欄を許さない入力を読み取る。空欄（空白のみを含む）が返ってきた場合は再プロンプトし、
 * 最大 `MAX_PROMPT_ATTEMPTS` 回で諦めて `GasDeployError` を投げる。
 *
 * 標準入力が閉じている・非対話的にリダイレクトされている場合、`promptInputImpl` は毎回
 * 即座に空文字列を返す。ここで弾かなければ、クライアント ID が空のまま認可 URL の構築や
 * ブラウザ起動に進んでしまい、ずっと後になってから分かりにくい OAuth エラーとして表面化する。
 */
export async function promptRequiredInput(
  question: string,
  promptInputImpl: (question: string) => Promise<string> = promptInput,
): Promise<string> {
  let currentQuestion = question;
  for (let attempt = 1; attempt <= MAX_PROMPT_ATTEMPTS; attempt++) {
    const answer = (await promptInputImpl(currentQuestion)).trim();
    if (answer.length > 0) {
      return answer;
    }
    currentQuestion = `(空欄は使えません。もう一度入力してください)\n${question}`;
  }
  throw new GasDeployError('必須の入力が得られませんでした', {
    nextSteps: NON_INTERACTIVE_NEXT_STEPS,
  });
}

/**
 * ステップ1の回答（アカウント種別）を読み取る。`1` か `2` 以外（空欄を含む）は再プロンプトし、
 * `promptRequiredInput` と同じ上限・同じ理由で `GasDeployError` を投げる。
 */
export async function promptAccountType(
  promptInputImpl: (question: string) => Promise<string> = promptInput,
): Promise<AccountType> {
  const baseQuestion = '番号を入力してください (1 または 2): ';
  let currentQuestion = baseQuestion;
  for (let attempt = 1; attempt <= MAX_PROMPT_ATTEMPTS; attempt++) {
    const answer = (await promptInputImpl(currentQuestion)).trim();
    if (answer === '1') return 'workspace';
    if (answer === '2') return 'personal';
    currentQuestion = `(「1」または「2」のいずれかを入力してください)\n${baseQuestion}`;
  }
  throw new GasDeployError('必須の入力（1 または 2）が得られませんでした', {
    nextSteps: NON_INTERACTIVE_NEXT_STEPS,
  });
}
