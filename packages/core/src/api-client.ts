import { GasDeployError, classifyApiError } from './errors.js';
import type { Deployment, ScriptFile } from './types.js';

const BASE_URL = 'https://script.googleapis.com/v1';
const MANIFEST_FILE_NAME = 'appsscript';
const DEFAULT_MAX_RETRIES = 3;

/**
 * deployments.list は pageSize を指定しないと1件しか返さない（実測）。
 * 明示的に指定しないとデプロイ数の把握が丸ごと壊れる。
 */
const DEPLOYMENTS_PAGE_SIZE = 50;

/** ページネーションの暴走を止める上限。20件しか作れないので通常は1ページで足りる。 */
const MAX_DEPLOYMENT_PAGES = 20;

const CONNECTIVITY_NEXT_STEPS = [
  'ランナーからインターネットに到達できるか確認してください',
  'プロキシやファイアウォールで script.googleapis.com が遮断されていないか確認してください',
  '一時的な障害の可能性があります。しばらく待って再実行してください',
];

const PARSE_FAILURE_NEXT_STEPS = [
  'プロキシやファイアウォールが応答を書き換えていないか確認してください',
  '一時的な障害の可能性があります。しばらく待って再実行してください',
];

export interface ClientOptions {
  fetch?: typeof fetch;
  maxRetries?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface RawDeployment {
  deploymentId?: string;
  deploymentConfig?: { versionNumber?: number; description?: string };
  entryPoints?: Array<{ entryPointType?: string; webApp?: { url?: string } }>;
}

function toDeployment(raw: RawDeployment): Deployment {
  const webAppUrl = raw.entryPoints?.find((entry) => entry.entryPointType === 'WEB_APP')?.webApp?.url;
  const deployment: Deployment = { deploymentId: raw.deploymentId ?? '' };
  if (raw.deploymentConfig?.versionNumber !== undefined) {
    deployment.versionNumber = raw.deploymentConfig.versionNumber;
  }
  if (raw.deploymentConfig?.description !== undefined) {
    deployment.description = raw.deploymentConfig.description;
  }
  if (webAppUrl !== undefined) {
    deployment.webAppUrl = webAppUrl;
  }
  return deployment;
}

/**
 * 429 はどのメソッドでもリトライしてよい（処理前に弾かれる拒否のため、
 * リトライしても二重処理にならない）。
 *
 * 5xx の POST はサーバ側で処理済みかどうか判別できない。リトライすると
 * バージョンやデプロイが二重に作られ、20枠しかないデプロイを黙って消費する。
 * Apps Script には冪等キーが無いため事後の検出もできない。GET/PUT は
 * べき等なので 5xx でもリトライしてよい。
 */
function isRetryable(method: string, status: number): boolean {
  if (status === 429) {
    return true;
  }
  return status >= 500 && method !== 'POST';
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

export class AppsScriptClient {
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly accessToken: string,
    options: ClientOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    let lastError: GasDeployError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${BASE_URL}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (cause) {
        // DNS 解決失敗や接続拒否など、レスポンスに到達する前の失敗。
        // 429/5xx と同じリトライ予算に載せる。
        lastError = new GasDeployError('Apps Script API に接続できませんでした', {
          cause,
          nextSteps: CONNECTIVITY_NEXT_STEPS,
        });
        if (attempt < this.maxRetries) {
          await this.sleep(2 ** attempt * 1000);
        }
        continue;
      }

      let text: string;
      try {
        text = await response.text();
      } catch (cause) {
        // ヘッダー受信後に接続が切れた場合。本文は取得できていないため
        // cause を保持してよい（クレデンシャルやソースコードは含まれない）。
        lastError = new GasDeployError('Apps Script API の応答を読み取れませんでした', {
          cause,
          nextSteps: CONNECTIVITY_NEXT_STEPS,
        });
        if (attempt < this.maxRetries) {
          await this.sleep(2 ** attempt * 1000);
        }
        continue;
      }

      if (response.ok) {
        if (text.length === 0) {
          return {};
        }
        try {
          return JSON.parse(text);
        } catch {
          // getContent の成功応答にはユーザーのスクリプトソースが含まれるため、
          // cause には本文を載せない。
          throw new GasDeployError('Apps Script API の応答を解析できませんでした', {
            nextSteps: PARSE_FAILURE_NEXT_STEPS,
          });
        }
      }

      if (method === 'POST' && response.status >= 500) {
        // サーバ側で処理が完了していた場合、リトライすると二重にバージョン/
        // デプロイが作られる可能性があるため、リトライせず状態確認を促す。
        throw new GasDeployError(
          `Apps Script API がエラーを返しました (${response.status})。サーバ側で処理が完了した可能性があります`,
          {
            nextSteps: [
              'デプロイ一覧を確認し、意図しないバージョンやデプロイが作成されていないか確認してください',
              'HEAD の更新は完了している可能性があります。その場合、再実行しても差分ゼロと判定されてスキップされるため、デプロイが古いままになります',
              '状態を確認したうえで、必要ならデプロイを手動で作成し直してください',
            ],
            cause: text,
          },
        );
      }

      lastError = classifyApiError(response.status, text);
      if (!isRetryable(method, response.status)) {
        throw lastError;
      }
      if (attempt < this.maxRetries) {
        await this.sleep(2 ** attempt * 1000);
      }
    }

    throw lastError ?? new GasDeployError('Apps Script API へのリクエストが失敗しました');
  }

  async getContent(scriptId: string): Promise<ScriptFile[]> {
    const result = (await this.request('GET', `/projects/${encodePathSegment(scriptId)}/content`)) as {
      files?: ScriptFile[];
    };
    return result.files ?? [];
  }

  async updateContent(scriptId: string, files: ScriptFile[]): Promise<void> {
    await this.request('PUT', `/projects/${encodePathSegment(scriptId)}/content`, { files });
  }

  async createVersion(scriptId: string, description: string): Promise<number> {
    const result = (await this.request('POST', `/projects/${encodePathSegment(scriptId)}/versions`, {
      description,
    })) as {
      versionNumber?: number;
    };
    if (result.versionNumber === undefined) {
      throw new GasDeployError('バージョン作成の応答に versionNumber が含まれていません', {
        nextSteps: ['しばらく待って再実行してください'],
      });
    }
    return result.versionNumber;
  }

  async listDeployments(scriptId: string): Promise<Deployment[]> {
    const all: RawDeployment[] = [];
    let pageToken: string | undefined;
    let pages = 0;

    do {
      if (pages >= MAX_DEPLOYMENT_PAGES) {
        throw new GasDeployError('デプロイ一覧の取得がページ上限に達しました', {
          nextSteps: [
            'Apps Script API が想定外の応答を返している可能性があります',
            'しばらく待って再実行してください',
          ],
        });
      }
      const query = new URLSearchParams({ pageSize: String(DEPLOYMENTS_PAGE_SIZE) });
      if (pageToken !== undefined) {
        query.set('pageToken', pageToken);
      }
      const result = (await this.request(
        'GET',
        `/projects/${encodePathSegment(scriptId)}/deployments?${query.toString()}`,
      )) as {
        deployments?: RawDeployment[];
        nextPageToken?: string;
      };
      all.push(...(result.deployments ?? []));
      // 空文字列のトークンは「次ページなし」を意味する（実測）。undefined と区別せず扱うと
      // while ループが終了条件を失い暴走する。
      pageToken = result.nextPageToken || undefined;
      pages += 1;
    } while (pageToken !== undefined);

    return all.map(toDeployment);
  }

  async updateDeployment(
    scriptId: string,
    deploymentId: string,
    versionNumber: number,
    description: string,
  ): Promise<Deployment> {
    const result = await this.request(
      'PUT',
      `/projects/${encodePathSegment(scriptId)}/deployments/${encodePathSegment(deploymentId)}`,
      {
        deploymentConfig: {
          scriptId,
          versionNumber,
          manifestFileName: MANIFEST_FILE_NAME,
          description,
        },
      },
    );
    return toDeployment(result as RawDeployment);
  }

  async createDeployment(scriptId: string, versionNumber: number, description: string): Promise<Deployment> {
    const result = await this.request('POST', `/projects/${encodePathSegment(scriptId)}/deployments`, {
      versionNumber,
      manifestFileName: MANIFEST_FILE_NAME,
      description,
    });
    return toDeployment(result as RawDeployment);
  }
}
