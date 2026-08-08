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

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
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
      const response = await this.fetchImpl(`${BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      const text = await response.text();

      if (response.ok) {
        return text.length > 0 ? JSON.parse(text) : {};
      }

      lastError = classifyApiError(response.status, text);
      if (!isRetryable(response.status)) {
        throw lastError;
      }
      if (attempt < this.maxRetries) {
        await this.sleep(2 ** attempt * 1000);
      }
    }

    throw lastError ?? new GasDeployError('Apps Script API へのリクエストが失敗しました');
  }

  async getContent(scriptId: string): Promise<ScriptFile[]> {
    const result = (await this.request('GET', `/projects/${scriptId}/content`)) as { files?: ScriptFile[] };
    return result.files ?? [];
  }

  async updateContent(scriptId: string, files: ScriptFile[]): Promise<void> {
    await this.request('PUT', `/projects/${scriptId}/content`, { files });
  }

  async createVersion(scriptId: string, description: string): Promise<number> {
    const result = (await this.request('POST', `/projects/${scriptId}/versions`, { description })) as {
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

    do {
      const query = new URLSearchParams({ pageSize: String(DEPLOYMENTS_PAGE_SIZE) });
      if (pageToken !== undefined) {
        query.set('pageToken', pageToken);
      }
      const result = (await this.request('GET', `/projects/${scriptId}/deployments?${query.toString()}`)) as {
        deployments?: RawDeployment[];
        nextPageToken?: string;
      };
      all.push(...(result.deployments ?? []));
      pageToken = result.nextPageToken;
    } while (pageToken !== undefined);

    return all.map(toDeployment);
  }

  async updateDeployment(
    scriptId: string,
    deploymentId: string,
    versionNumber: number,
    description: string,
  ): Promise<Deployment> {
    const result = await this.request('PUT', `/projects/${scriptId}/deployments/${deploymentId}`, {
      deploymentConfig: {
        scriptId,
        versionNumber,
        manifestFileName: MANIFEST_FILE_NAME,
        description,
      },
    });
    return toDeployment(result as RawDeployment);
  }

  async createDeployment(scriptId: string, versionNumber: number, description: string): Promise<Deployment> {
    const result = await this.request('POST', `/projects/${scriptId}/deployments`, {
      versionNumber,
      manifestFileName: MANIFEST_FILE_NAME,
      description,
    });
    return toDeployment(result as RawDeployment);
  }
}
