import { describe, expect, it, vi } from 'vitest';
import { getAccessToken } from './auth.js';
import { GasDeployError } from './errors.js';

const CREDENTIALS = {
  clientId: 'cid.apps.googleusercontent.com',
  clientSecret: 'secret-value',
  refreshToken: 'refresh-value',
};

function stubFetch(status: number, body: string) {
  return vi.fn(async () => new Response(body, { status }));
}

describe('getAccessToken', () => {
  it('exchanges the refresh token for an access token', async () => {
    const fetchImpl = stubFetch(200, JSON.stringify({ access_token: 'at-123', expires_in: 3599 }));
    const token = await getAccessToken(CREDENTIALS, fetchImpl as unknown as typeof fetch);
    expect(token).toBe('at-123');
  });

  it('posts the grant_type and credentials as form-encoded data', async () => {
    const fetchImpl = stubFetch(200, JSON.stringify({ access_token: 'at-123' }));
    await getAccessToken(CREDENTIALS, fetchImpl as unknown as typeof fetch);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.method).toBe('POST');
    const params = init.body as URLSearchParams;
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('refresh-value');
    expect(params.get('client_id')).toBe('cid.apps.googleusercontent.com');
  });

  it('explains the 7-day testing-status expiry when the exchange fails', async () => {
    const fetchImpl = stubFetch(400, JSON.stringify({ error: 'invalid_grant' }));
    await expect(getAccessToken(CREDENTIALS, fetchImpl as unknown as typeof fetch)).rejects.toThrowError(GasDeployError);

    const err = await (async () => {
      try {
        await getAccessToken(CREDENTIALS, fetchImpl as unknown as typeof fetch);
        return undefined;
      } catch (e) {
        return e as GasDeployError;
      }
    })();
    expect(err!.nextSteps.join('\n')).toContain('テスト');
  });

  it('fails when the response has no access_token', async () => {
    const fetchImpl = stubFetch(200, JSON.stringify({ token_type: 'Bearer' }));
    await expect(getAccessToken(CREDENTIALS, fetchImpl as unknown as typeof fetch)).rejects.toThrowError(GasDeployError);
  });

  it('does not carry the response body into the error cause', async () => {
    const fetchImpl = stubFetch(200, JSON.stringify({ id_token: 'SENSITIVE-ID-TOKEN' }));
    const err = await (async () => {
      try {
        await getAccessToken(CREDENTIALS, fetchImpl as unknown as typeof fetch);
        return undefined;
      } catch (e) {
        return e as GasDeployError;
      }
    })();
    expect(err).toBeInstanceOf(GasDeployError);
    expect(err!.cause).toBeUndefined();
  });
});
