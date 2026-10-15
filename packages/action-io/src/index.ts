/**
 * 4つのアクションが共有する、GitHub Actions の入出力まわりの処理。
 *
 * core に置かないのは、core を @actions/core に依存させないため。core は setup-cli からも
 * 使われ、Actions の外で動く。入力の読み方・シークレットのマスク・失敗の報告のように
 * Actions の実行環境を前提にするものだけをここに集める。
 */
import * as core from '@actions/core';
import { type Credentials, GasDeployError, parseCredentials, preflight, readConfigFile } from '@gas-deploy/core';

/** `core.getBooleanInput` の raw throw を、次の手順つきの `GasDeployError` に包み直す。 */
export function parseBooleanInput(name: string): boolean {
  try {
    return core.getBooleanInput(name);
  } catch (error) {
    throw new GasDeployError(`${name} には true または false を指定してください`, {
      cause: error,
      nextSteps: [
        '現在の値は真偽値として解釈できません',
        'GitHub Actions の式を使う場合は ${{ ... }} が true / false を返すか確認してください',
      ],
    });
  }
}

/** `projects` 入力をパースする。空文字列または `all` は「全プロジェクト」を意味する `undefined`。 */
export function parseProjectsInput(raw: string): string[] | undefined {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'all') {
    return undefined;
  }
  return trimmed
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/** `credentials` 入力を読み、ログに出ないよう秘密の部分をマスクする。 */
export function readCredentials(): Credentials {
  const credentials = parseCredentials(core.getInput('credentials', { required: true }));
  core.setSecret(credentials.clientSecret);
  core.setSecret(credentials.refreshToken);
  return credentials;
}

/**
 * 認証情報を読み、アクセストークンに交換する。`scriptIds` を渡すと、その全件の読み取り権限も
 * 確かめる（書き込む前に、権限の欠けを1件目の書き込みより手前で見つけるため）。
 *
 * スコープ不足の警告はここで出す。トークンはマスクしてから返す。
 */
export async function authenticate(scriptIds: readonly string[] = []): Promise<string> {
  const credentials = readCredentials();
  const { accessToken, warnings } = await preflight({ credentials, scriptIds });
  core.setSecret(accessToken);
  for (const warning of warnings) {
    core.warning(warning);
  }
  return accessToken;
}

/**
 * `config` 入力が指す設定ファイルを読み、YAML のテキストを返す。
 * パースは呼び出し側に任せる（rollback と status は対象の解決とパースを1つの関数で検証している）。
 */
export async function readConfigInput(): Promise<string> {
  const configPath = core.getInput('config') || 'gasdeploy.yml';
  return readConfigFile(configPath, {
    notFoundSteps: [
      'scriptId を直接指定する場合は script-id 入力を使ってください',
      `gasdeploy.yml を使う場合は ${configPath} に設定ファイルを作成してください`,
      'config 入力で別のパスを指定している場合は、そのパスが正しいか確認してください',
    ],
  });
}

/**
 * アクションの入口。失敗を `core.setFailed` で報告する。
 *
 * esbuild の cjs 出力はトップレベル await を扱えないため、必ず関数の中で await する。
 */
export function runAction(run: () => Promise<void>): void {
  void run().catch((error: unknown) => {
    if (error instanceof GasDeployError) {
      core.setFailed(error.format());
    } else {
      core.setFailed(error instanceof Error ? error.message : String(error));
    }
  });
}
