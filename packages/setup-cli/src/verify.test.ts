import { GasDeployError, REQUESTED_SCOPES } from '@gas-deploy/core';
import type { Credentials } from '@gas-deploy/core';
import { describe, expect, it, vi } from 'vitest';
import { verifyCredentials } from './verify.js';

const CREDENTIALS: Credentials = {
  clientId: 'cid.apps.googleusercontent.com',
  clientSecret: 'secret-value',
  refreshToken: 'refresh-token-value',
};

/** getAccessToken (called first) always hits the token endpoint; tokeninfo is the second call. */
function stubFetch(tokeninfoStatus: number, tokeninfoBody: string) {
  return vi.fn(async (input: string | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    // 注意: '/tokeninfo' は '/token' で始まるため、判定は tokeninfo を先にチェックする。
    if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
      return new Response(tokeninfoBody, { status: tokeninfoStatus });
    }
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'at-123' }), { status: 200 });
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
}

async function captureError(fetchImpl: typeof fetch): Promise<GasDeployError> {
  try {
    await verifyCredentials(CREDENTIALS, fetchImpl);
    throw new Error('expected verifyCredentials to throw');
  } catch (e) {
    return e as GasDeployError;
  }
}

describe('verifyCredentials', () => {
  it('reports isMinimal true when the granted scope exactly matches REQUESTED_SCOPES', async () => {
    const fetchImpl = stubFetch(200, JSON.stringify({ scope: REQUESTED_SCOPES }));
    const result = await verifyCredentials(CREDENTIALS, fetchImpl as unknown as typeof fetch);
    expect(result.isMinimal).toBe(true);
    expect(result.unexpectedScopes).toEqual([]);
    expect(result.grantedScopes.sort()).toEqual(REQUESTED_SCOPES.split(' ').sort());
  });

  it('reports isMinimal false with the extras listed for a clasp-style 13-scope superset', async () => {
    const claspScopes = [
      REQUESTED_SCOPES,
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/drive.metadata.readonly',
      'https://www.googleapis.com/auth/service.management',
      'https://www.googleapis.com/auth/logging.read',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/forms',
      'https://www.googleapis.com/auth/forms.currentonly',
      'https://www.googleapis.com/auth/script.webapp.deploy',
      'openid',
      'https://www.googleapis.com/auth/drive.metadata',
    ].join(' ');

    const fetchImpl = stubFetch(200, JSON.stringify({ scope: claspScopes }));
    const result = await verifyCredentials(CREDENTIALS, fetchImpl as unknown as typeof fetch);

    expect(result.isMinimal).toBe(false);
    expect(result.unexpectedScopes).toContain('https://www.googleapis.com/auth/cloud-platform');
    expect(result.unexpectedScopes.length).toBeGreaterThan(0);
    expect(result.unexpectedScopes).not.toContain('https://www.googleapis.com/auth/script.projects');
  });

  it('reports isMinimal false when the grant is missing one of the requested scopes', async () => {
    const onlyOneScope = 'https://www.googleapis.com/auth/script.projects';
    const fetchImpl = stubFetch(200, JSON.stringify({ scope: onlyOneScope }));
    const result = await verifyCredentials(CREDENTIALS, fetchImpl as unknown as typeof fetch);

    expect(result.isMinimal).toBe(false);
    expect(result.unexpectedScopes).toEqual([]);
  });

  it('wraps a non-JSON tokeninfo response in a GasDeployError with nextSteps, without leaking the body', async () => {
    const fetchImpl = stubFetch(200, 'not-json{');
    const err = await captureError(fetchImpl as unknown as typeof fetch);
    expect(err).toBeInstanceOf(GasDeployError);
    expect(err.nextSteps.length).toBeGreaterThan(0);
    expect(err.cause).toBeUndefined();
  });

  it('wraps a tokeninfo error response (e.g. expired token) in a GasDeployError with nextSteps, without leaking the body', async () => {
    const fetchImpl = stubFetch(400, JSON.stringify({ error: 'invalid_token', error_description: 'SENSITIVE' }));
    const err = await captureError(fetchImpl as unknown as typeof fetch);
    expect(err).toBeInstanceOf(GasDeployError);
    expect(err.nextSteps.length).toBeGreaterThan(0);
    expect(err.cause).toBeUndefined();
  });

  it('wraps a tokeninfo response missing the scope field in a GasDeployError', async () => {
    const fetchImpl = stubFetch(200, JSON.stringify({ expires_in: 3599 }));
    const err = await captureError(fetchImpl as unknown as typeof fetch);
    expect(err).toBeInstanceOf(GasDeployError);
    expect(err.cause).toBeUndefined();
  });

  it('propagates the GasDeployError from getAccessToken when the refresh token exchange fails', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    await expect(verifyCredentials(CREDENTIALS, fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      GasDeployError,
    );
  });
});
