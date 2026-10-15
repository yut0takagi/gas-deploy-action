import { GasDeployError, classifyApiError } from './errors.js';
import type { Deployment, ScriptFile, Version } from './types.js';

const BASE_URL = 'https://script.googleapis.com/v1';
const MANIFEST_FILE_NAME = 'appsscript';
const DEFAULT_MAX_RETRIES = 3;

/**
 * 1リクエストあたりの上限。応答本文の受信までを含む。
 *
 * 指定しないと fetch（undici）の既定の5分が効き、リトライ予算を使い切るまで20分以上
 * 待つことになる。Apps Script API は数 MB の updateContent でも数秒で返るので、
 * 60秒を超えるのは接続が詰まっているときだけと見てよい。
 */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Retry-After に従う上限。これより長い指定でも、この時間だけ待って次を試す。 */
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * リクエストを送る前に失敗したと確定できるエラーコード（fetch が投げる TypeError の cause）。
 * 名前解決と TCP 接続の段階の失敗で、サーバには何も届いていない。
 */
const PRE_SEND_ERROR_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

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

const OUTCOME_UNKNOWN_NEXT_STEPS = [
  'デプロイ一覧を確認し、意図しないバージョンやデプロイが作成されていないか確認してください',
  'deployment-id を指定している場合は、そのまま再実行すればバージョンの作成とデプロイの更新だけがやり直されます',
  'deployment-id を指定していない場合は、HEAD が更新済みだと再実行しても差分ゼロと判定されてスキップされます。その場合はデプロイを手動で作成し直してください',
];

type HttpMethod = 'GET' | 'PUT' | 'POST';

export interface ClientOptions {
  fetch?: typeof fetch;
  maxRetries?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** 1リクエストあたりのタイムアウト。テストから差し替えるための入口。 */
  timeoutMs?: number;
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
 * 1回の試行の結果。リトライするかどうかの判断を、失敗を作った場所に置くための形。
 *
 * 判断の基準は1つだけで、「もう一度送ったときに二重に処理されうるか」。429 は処理の前に
 * 弾かれるのでどのメソッドでも繰り返してよい。GET / PUT はべき等なので、5xx でも通信の
 * 失敗でも繰り返してよい。POST（versions.create / deployments.create）は、サーバに届いた
 * 可能性が残る失敗では繰り返さない。繰り返すとバージョンやデプロイが二重に作られ、
 * 20枠しかないデプロイを黙って消費する。Apps Script には冪等キーが無く、事後の検出もできない。
 */
type Attempt =
  | { ok: true; value: unknown }
  | { ok: false; error: GasDeployError; retryable: boolean; retryAfterMs?: number };

/** fetch の失敗が、リクエストを送る前に起きたと確定できるか。確定できなければ false。 */
function failedBeforeSend(cause: unknown): boolean {
  const code = (cause as { cause?: { code?: unknown } } | null | undefined)?.cause?.code;
  return typeof code === 'string' && PRE_SEND_ERROR_CODES.has(code);
}

/**
 * Retry-After をミリ秒に直す。秒数の形式だけを扱う。HTTP 日付の形式や不正な値は
 * 無視して指数バックオフに任せる（Google の API が日付の形式で返す例を確認していない）。
 */
function parseRetryAfter(header: string | null): number | undefined {
  if (header === null || !/^\d+$/.test(header.trim())) {
    return undefined;
  }
  return Math.min(Number(header.trim()) * 1000, MAX_RETRY_AFTER_MS);
}

/** POST がサーバ側で処理済みかどうか判別できない失敗。リトライせず、状態の確認を促す。 */
function outcomeUnknownError(reason: string, details: { cause?: unknown; status?: number; code: 'connectivity' | 'api-error' }): GasDeployError {
  return new GasDeployError(`${reason}。サーバ側で処理が完了した可能性があります`, {
    ...details,
    nextSteps: OUTCOME_UNKNOWN_NEXT_STEPS,
  });
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

export class AppsScriptClient {
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(
    private readonly accessToken: string,
    options: ClientOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request(method: HttpMethod, path: string, body?: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await this.attempt(method, path, body);
      if (outcome.ok) {
        return outcome.value;
      }
      if (!outcome.retryable || attempt >= this.maxRetries) {
        throw outcome.error;
      }
      await this.sleep(Math.max(2 ** attempt * 1000, outcome.retryAfterMs ?? 0));
    }
  }

  private async attempt(method: HttpMethod, path: string, body: unknown): Promise<Attempt> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      // タイムアウトや接続のリセットは、リクエストが届いた後でも起きる。
      if (method === 'POST' && !failedBeforeSend(cause)) {
        return {
          ok: false,
          retryable: false,
          error: outcomeUnknownError('Apps Script API との通信が途中で失敗しました', { cause, code: 'connectivity' }),
        };
      }
      return {
        ok: false,
        retryable: true,
        error: new GasDeployError('Apps Script API に接続できませんでした', {
          cause,
          code: 'connectivity',
          nextSteps: CONNECTIVITY_NEXT_STEPS,
        }),
      };
    }

    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      // ヘッダーが届いた時点で、サーバは処理を終えている。本文は取得できていないため
      // cause を保持してよい（クレデンシャルやソースコードは含まれない）。
      if (method === 'POST') {
        return {
          ok: false,
          retryable: false,
          error: outcomeUnknownError('Apps Script API の応答を読み取れませんでした', { cause, code: 'connectivity' }),
        };
      }
      return {
        ok: false,
        retryable: true,
        error: new GasDeployError('Apps Script API の応答を読み取れませんでした', {
          cause,
          code: 'connectivity',
          nextSteps: CONNECTIVITY_NEXT_STEPS,
        }),
      };
    }

    if (response.ok) {
      if (text.length === 0) {
        return { ok: true, value: {} };
      }
      try {
        return { ok: true, value: JSON.parse(text) };
      } catch {
        // getContent の成功応答にはユーザーのスクリプトソースが含まれるため、
        // cause には本文を載せない。
        return {
          ok: false,
          retryable: false,
          error: new GasDeployError('Apps Script API の応答を解析できませんでした', {
            code: 'response-invalid',
            nextSteps: PARSE_FAILURE_NEXT_STEPS,
          }),
        };
      }
    }

    if (method === 'POST' && response.status >= 500) {
      return {
        ok: false,
        retryable: false,
        error: outcomeUnknownError(`Apps Script API がエラーを返しました (${response.status})`, {
          cause: text,
          status: response.status,
          code: 'api-error',
        }),
      };
    }

    const error = classifyApiError(response.status, text);
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      return { ok: false, error, retryable: true, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    }
    return { ok: false, error, retryable: response.status >= 500 };
  }

  /**
   * プロジェクトのメタデータだけを読む。存在と閲覧権限の確認に使う。
   *
   * `getContent` ではなくこちらを使うのは、スクリプトのソース全体を落とさずに済むため。
   * デプロイ前の権限確認を全プロジェクト分まとめて行うのが用途で、そこで `/content` を
   * 叩くと、直後の `deploy` が同じものをもう一度取得することになる。
   */
  async getProject(scriptId: string): Promise<void> {
    await this.request('GET', `/projects/${encodePathSegment(scriptId)}`);
  }

  /** `versionNumber` を省略すると HEAD を、指定するとそのバージョンのスナップショットを返す。 */
  async getContent(scriptId: string, versionNumber?: number): Promise<ScriptFile[]> {
    const query = versionNumber === undefined ? '' : `?${new URLSearchParams({ versionNumber: String(versionNumber) })}`;
    const result = (await this.request('GET', `/projects/${encodePathSegment(scriptId)}/content${query}`)) as {
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

  /**
   * 単一バージョンの情報を取得する。存在しなければ 404 の `GasDeployError` を投げる。
   *
   * 一覧（versions.list）ではなく単体取得なのは、CI が毎回バージョンを作る運用では
   * バージョンが数百件に達し、一覧の走査が「1件を確認したいだけ」の操作に見合わないため。
   */
  async getVersion(scriptId: string, versionNumber: number): Promise<Version> {
    const result = (await this.request(
      'GET',
      `/projects/${encodePathSegment(scriptId)}/versions/${encodePathSegment(String(versionNumber))}`,
    )) as { versionNumber?: number; description?: string; createTime?: string };

    const version: Version = { versionNumber: result.versionNumber ?? versionNumber };
    if (result.description !== undefined) {
      version.description = result.description;
    }
    if (result.createTime !== undefined) {
      version.createTime = result.createTime;
    }
    return version;
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

  /**
   * 単一デプロイを取得する。
   *
   * deployments.list は書き込み後しばらく複数のレプリカ状態を行き来し、単調ですらない
   * （実測）。単体取得は同条件で単調に収束したため、特定のデプロイの現在バージョンを
   * 知りたい場合は一覧ではなくこちらを使う。
   */
  async getDeployment(scriptId: string, deploymentId: string): Promise<Deployment> {
    const result = await this.request(
      'GET',
      `/projects/${encodePathSegment(scriptId)}/deployments/${encodePathSegment(deploymentId)}`,
    );
    return toDeployment(result as RawDeployment);
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
