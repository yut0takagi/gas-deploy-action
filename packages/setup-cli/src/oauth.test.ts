import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { GasDeployError, REQUESTED_SCOPES } from '@gas-deploy/core';
import {
  buildAuthorizationUrl,
  deriveCodeChallenge,
  exchangeCodeForRefreshToken,
  generateCodeVerifier,
  generateState,
  waitForAuthorizationCode,
} from './oauth.js';

const AUTH_URL_PARAMS = {
  clientId: 'cid.apps.googleusercontent.com',
  redirectUri: 'http://127.0.0.1:5555/',
  state: 'state-value',
  codeChallenge: 'challenge-value',
};

describe('buildAuthorizationUrl', () => {
  it('targets the Google authorization endpoint', () => {
    const url = new URL(buildAuthorizationUrl(AUTH_URL_PARAMS));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  });

  it('requests exactly REQUESTED_SCOPES and nothing else', () => {
    const url = new URL(buildAuthorizationUrl(AUTH_URL_PARAMS));
    expect(url.searchParams.get('scope')).toBe(REQUESTED_SCOPES);
  });

  it('sets access_type=offline and prompt=consent so a refresh token is always returned', () => {
    const url = new URL(buildAuthorizationUrl(AUTH_URL_PARAMS));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('sets response_type=code and PKCE S256 parameters', () => {
    const url = new URL(buildAuthorizationUrl(AUTH_URL_PARAMS));
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('carries state and redirect_uri through unchanged', () => {
    const url = new URL(buildAuthorizationUrl(AUTH_URL_PARAMS));
    expect(url.searchParams.get('state')).toBe('state-value');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5555/');
  });
});

describe('PKCE helpers', () => {
  it('generates a code_verifier satisfying RFC 7636 length and charset constraints', () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it('generates a different verifier on each call', () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
  });

  it('derives the S256 code_challenge as the base64url SHA-256 digest, verified independently', () => {
    const verifier = generateCodeVerifier();
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(deriveCodeChallenge(verifier)).toBe(expected);
  });
});

describe('generateState', () => {
  it('generates a non-empty, unique value on each call', () => {
    const a = generateState();
    const b = generateState();
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});

/**
 * onListening resolves synchronously-assigned promise variables once the port is known.
 *
 * `codePromise` gets a no-op `.catch` attached immediately so a rejection that settles
 * before the test's own assertion runs doesn't surface as an unhandled rejection — the
 * assertion below still observes the same rejection, since `.catch` derives a new promise
 * rather than consuming the original's settled state.
 */
async function startAndCapturePort(options: { state: string; timeoutMs?: number }) {
  let codePromise!: Promise<string>;
  const port = await new Promise<number>((resolve) => {
    codePromise = waitForAuthorizationCode({ ...options, onListening: resolve });
  });
  codePromise.catch(() => {});
  return { port, codePromise };
}

async function assertPortIsFree(port: number): Promise<void> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => resolve());
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
}

describe('waitForAuthorizationCode', () => {
  it('returns the code for a well-formed callback delivered over a real request', async () => {
    const { port, codePromise } = await startAndCapturePort({ state: 'expected-state' });
    const response = await fetch(`http://127.0.0.1:${port}/?code=auth-code-123&state=expected-state`);
    expect(response.status).toBe(200);
    await expect(codePromise).resolves.toBe('auth-code-123');
  });

  it('rejects and withholds the code on a state mismatch', async () => {
    const { port, codePromise } = await startAndCapturePort({ state: 'expected-state' });
    await fetch(`http://127.0.0.1:${port}/?code=auth-code-123&state=WRONG-STATE`);
    await expect(codePromise).rejects.toThrow(GasDeployError);
  });

  it('rejects with a GasDeployError when Google reports access_denied', async () => {
    const { port, codePromise } = await startAndCapturePort({ state: 'expected-state' });
    await fetch(`http://127.0.0.1:${port}/?error=access_denied`);
    await expect(codePromise).rejects.toThrow(GasDeployError);
  });

  it('rejects after the timeout so an abandoned browser cannot hang the process', async () => {
    const { codePromise } = await startAndCapturePort({ state: 'expected-state', timeoutMs: 20 });
    await expect(codePromise).rejects.toThrow(GasDeployError);
  });

  it('closes the server after a successful exchange, freeing the port', async () => {
    const { port, codePromise } = await startAndCapturePort({ state: 'expected-state' });
    await fetch(`http://127.0.0.1:${port}/?code=auth-code-123&state=expected-state`);
    await codePromise;
    await assertPortIsFree(port);
  });

  it('closes the server after a state-mismatch rejection, freeing the port', async () => {
    const { port, codePromise } = await startAndCapturePort({ state: 'expected-state' });
    await fetch(`http://127.0.0.1:${port}/?code=auth-code-123&state=WRONG-STATE`);
    await expect(codePromise).rejects.toThrow();
    await assertPortIsFree(port);
  });

  it('closes the server after a timeout rejection, freeing the port', async () => {
    const { port, codePromise } = await startAndCapturePort({ state: 'expected-state', timeoutMs: 20 });
    await expect(codePromise).rejects.toThrow();
    await assertPortIsFree(port);
  });
});

describe('exchangeCodeForRefreshToken', () => {
  const PARAMS = {
    clientId: 'cid.apps.googleusercontent.com',
    clientSecret: 'secret-value',
    code: 'auth-code-123',
    codeVerifier: 'verifier-value',
    redirectUri: 'http://127.0.0.1:5555/',
  };

  function stubFetch(status: number, body: string) {
    return vi.fn(async () => new Response(body, { status }));
  }

  async function captureError(fetchImpl: typeof fetch): Promise<GasDeployError> {
    try {
      await exchangeCodeForRefreshToken(PARAMS, fetchImpl);
      throw new Error('expected exchangeCodeForRefreshToken to throw');
    } catch (e) {
      return e as GasDeployError;
    }
  }

  it('returns the three credential fields on a successful exchange', async () => {
    const fetchImpl = stubFetch(200, JSON.stringify({ refresh_token: 'rt-123', access_token: 'at-123' }));
    const credentials = await exchangeCodeForRefreshToken(PARAMS, fetchImpl as unknown as typeof fetch);
    expect(credentials).toEqual({
      clientId: PARAMS.clientId,
      clientSecret: PARAMS.clientSecret,
      refreshToken: 'rt-123',
    });
  });

  it('sends grant_type=authorization_code and the code_verifier', async () => {
    const fetchImpl = stubFetch(200, JSON.stringify({ refresh_token: 'rt-123' }));
    await exchangeCodeForRefreshToken(PARAMS, fetchImpl as unknown as typeof fetch);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const params = init.body as URLSearchParams;
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('auth-code-123');
    expect(params.get('code_verifier')).toBe('verifier-value');
    expect(params.get('redirect_uri')).toBe(PARAMS.redirectUri);
  });

  it('explains that revoking access can fix a response with no refresh_token', async () => {
    const fetchImpl = stubFetch(200, JSON.stringify({ access_token: 'at-123' }));
    const err = await captureError(fetchImpl as unknown as typeof fetch);
    expect(err).toBeInstanceOf(GasDeployError);
    expect(err.nextSteps.join('\n')).toContain('myaccount.google.com/permissions');
    expect(err.nextSteps.join('\n')).toContain('取り消');
  });

  it('does not leak the response body into the error cause on a failed exchange', async () => {
    const fetchImpl = stubFetch(400, JSON.stringify({ error: 'invalid_grant', error_description: 'SENSITIVE' }));
    const err = await captureError(fetchImpl as unknown as typeof fetch);
    expect(err).toBeInstanceOf(GasDeployError);
    expect(err.cause).toBeUndefined();
  });

  it('does not leak a successful-but-incomplete response body into the error cause', async () => {
    const fetchImpl = stubFetch(200, JSON.stringify({ access_token: 'SENSITIVE-ACCESS-TOKEN' }));
    const err = await captureError(fetchImpl as unknown as typeof fetch);
    expect(err).toBeInstanceOf(GasDeployError);
    expect(err.cause).toBeUndefined();
  });

  it('wraps a network-level failure in a guided GasDeployError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(exchangeCodeForRefreshToken(PARAMS, fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      GasDeployError,
    );
  });

  it('wraps a JSON parse failure in a guided GasDeployError without leaking the body', async () => {
    const fetchImpl = stubFetch(200, 'not-json{');
    const err = await captureError(fetchImpl as unknown as typeof fetch);
    expect(err).toBeInstanceOf(GasDeployError);
    expect(err.cause).toBeUndefined();
  });
});
