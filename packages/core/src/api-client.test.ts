import { describe, expect, it, vi } from 'vitest';
import { AppsScriptClient } from './api-client.js';
import { GasDeployError } from './errors.js';

const SCRIPT_ID = 'script-abc';

function clientWith(responses: Array<{ status: number; body: string }>) {
  let index = 0;
  const fetchImpl = vi.fn(async () => {
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return new Response(response.body, { status: response.status });
  });
  const sleep = vi.fn(async (_ms: number) => undefined);
  const client = new AppsScriptClient('at-123', { fetch: fetchImpl as unknown as typeof fetch, sleep });
  return { client, fetchImpl, sleep };
}

describe('AppsScriptClient.getContent', () => {
  it('returns the files array', async () => {
    const { client } = clientWith([
      { status: 200, body: JSON.stringify({ files: [{ name: 'Code', type: 'SERVER_JS', source: 'x' }] }) },
    ]);

    await expect(client.getContent(SCRIPT_ID)).resolves.toEqual([
      { name: 'Code', type: 'SERVER_JS', source: 'x' },
    ]);
  });

  it('returns an empty array when the project has no files', async () => {
    const { client } = clientWith([{ status: 200, body: '{}' }]);
    await expect(client.getContent(SCRIPT_ID)).resolves.toEqual([]);
  });

  it('sends the bearer token', async () => {
    const { client, fetchImpl } = clientWith([{ status: 200, body: '{}' }]);
    await client.getContent(SCRIPT_ID);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://script.googleapis.com/v1/projects/script-abc/content');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer at-123');
  });
});

describe('AppsScriptClient retry behaviour', () => {
  it('retries on 429 and succeeds', async () => {
    const { client, fetchImpl } = clientWith([
      { status: 429, body: 'rate limited' },
      { status: 200, body: JSON.stringify({ files: [] }) },
    ]);

    await expect(client.getContent(SCRIPT_ID)).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries on 500 with exponential backoff delays', async () => {
    const { client, sleep } = clientWith([
      { status: 500, body: 'boom' },
      { status: 500, body: 'boom' },
      { status: 200, body: '{}' },
    ]);

    await client.getContent(SCRIPT_ID);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
  });

  it('gives up after the retry budget and throws the classified error', async () => {
    const { client, fetchImpl } = clientWith([{ status: 500, body: 'boom' }]);

    await expect(client.getContent(SCRIPT_ID)).rejects.toThrowError(GasDeployError);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('does not retry on 403', async () => {
    const { client, fetchImpl } = clientWith([{ status: 403, body: 'The caller does not have permission' }]);

    await expect(client.getContent(SCRIPT_ID)).rejects.toThrowError(GasDeployError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('AppsScriptClient write methods', () => {
  it('PUTs the files to the content endpoint', async () => {
    const { client, fetchImpl } = clientWith([{ status: 200, body: '{}' }]);
    await client.updateContent(SCRIPT_ID, [{ name: 'Code', type: 'SERVER_JS', source: 'x' }]);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://script.googleapis.com/v1/projects/script-abc/content');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      files: [{ name: 'Code', type: 'SERVER_JS', source: 'x' }],
    });
  });

  it('returns the version number from createVersion', async () => {
    const { client } = clientWith([{ status: 200, body: JSON.stringify({ versionNumber: 7 }) }]);
    await expect(client.createVersion(SCRIPT_ID, 'ci-abc1234-5')).resolves.toBe(7);
  });

  it('fails when createVersion returns no version number', async () => {
    const { client } = clientWith([{ status: 200, body: '{}' }]);
    await expect(client.createVersion(SCRIPT_ID, 'desc')).rejects.toThrowError(GasDeployError);
  });

  it('extracts the web app url from deployment entry points', async () => {
    const { client } = clientWith([
      {
        status: 200,
        body: JSON.stringify({
          deploymentId: 'dep-1',
          deploymentConfig: { versionNumber: 7, description: 'desc' },
          entryPoints: [{ entryPointType: 'WEB_APP', webApp: { url: 'https://script.google.com/macros/s/dep-1/exec' } }],
        }),
      },
    ]);

    await expect(client.updateDeployment(SCRIPT_ID, 'dep-1', 7, 'desc')).resolves.toEqual({
      deploymentId: 'dep-1',
      versionNumber: 7,
      description: 'desc',
      webAppUrl: 'https://script.google.com/macros/s/dep-1/exec',
    });
  });

  it('sends manifestFileName appsscript when updating a deployment', async () => {
    const { client, fetchImpl } = clientWith([{ status: 200, body: JSON.stringify({ deploymentId: 'dep-1' }) }]);
    await client.updateDeployment(SCRIPT_ID, 'dep-1', 7, 'desc');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://script.googleapis.com/v1/projects/script-abc/deployments/dep-1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      deploymentConfig: {
        scriptId: SCRIPT_ID,
        versionNumber: 7,
        manifestFileName: 'appsscript',
        description: 'desc',
      },
    });
  });
});

describe('AppsScriptClient.listDeployments', () => {
  it('always requests an explicit pageSize, because the API returns only one item without it', async () => {
    const { client, fetchImpl } = clientWith([{ status: 200, body: JSON.stringify({ deployments: [] }) }]);
    await client.listDeployments(SCRIPT_ID);

    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('pageSize=');
  });

  it('lists deployments', async () => {
    const { client } = clientWith([
      { status: 200, body: JSON.stringify({ deployments: [{ deploymentId: 'a' }, { deploymentId: 'b' }] }) },
    ]);
    await expect(client.listDeployments(SCRIPT_ID)).resolves.toHaveLength(2);
  });

  it('follows nextPageToken and concatenates every page', async () => {
    const { client, fetchImpl } = clientWith([
      { status: 200, body: JSON.stringify({ deployments: [{ deploymentId: 'a' }], nextPageToken: 'tok' }) },
      { status: 200, body: JSON.stringify({ deployments: [{ deploymentId: 'b' }] }) },
    ]);

    await expect(client.listDeployments(SCRIPT_ID)).resolves.toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const [secondUrl] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(secondUrl).toContain('pageToken=tok');
  });

  it('distinguishes the HEAD deployment, which has no version number', async () => {
    const { client } = clientWith([
      {
        status: 200,
        body: JSON.stringify({
          deployments: [
            { deploymentId: 'head' },
            { deploymentId: 'v1', deploymentConfig: { versionNumber: 1 } },
          ],
        }),
      },
    ]);

    const deployments = await client.listDeployments(SCRIPT_ID);
    expect(deployments.filter((d) => d.versionNumber !== undefined)).toHaveLength(1);
  });
});
