import { describe, expect, it, vi } from 'vitest';
import { REQUESTED_SCOPES, getAccessToken } from './auth.js';
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
    expect(params.get('client_secret')).toBe('secret-value');
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

  it('reports a guided error when the response body is not an object', async () => {
    const fetchImpl = stubFetch(200, 'null');
    const err = await (async () => {
      try {
        await getAccessToken(CREDENTIALS, fetchImpl as unknown as typeof fetch);
        return undefined;
      } catch (e) {
        return e as GasDeployError;
      }
    })();
    expect(err).toBeInstanceOf(GasDeployError);
    expect(err!.nextSteps.length).toBeGreaterThan(0);
  });

  it('wraps a network-level failure in a guided error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const err = await (async () => {
      try {
        await getAccessToken(CREDENTIALS, fetchImpl as unknown as typeof fetch);
        return undefined;
      } catch (e) {
        return e as GasDeployError;
      }
    })();
    expect(err).toBeInstanceOf(GasDeployError);
    expect(err!.nextSteps.join('\n')).toContain('プロキシ');
  });

  it('wraps a body-read failure in a guided error', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw new TypeError('terminated');
      },
    })) as unknown as typeof fetch;

    const err = await (async () => {
      try {
        await getAccessToken(CREDENTIALS, fetchImpl);
        return undefined;
      } catch (e) {
        return e as GasDeployError;
      }
    })();
    expect(err).toBeInstanceOf(GasDeployError);
    expect(err!.nextSteps.join('\n')).toContain('プロキシ');
  });

  it('narrows the granted scope to only what this action needs', async () => {
    const fetchImpl = stubFetch(200, JSON.stringify({ access_token: 'at-123' }));
    await getAccessToken(CREDENTIALS, fetchImpl as unknown as typeof fetch);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const params = init.body as URLSearchParams;
    expect(params.get('scope')).toBe(REQUESTED_SCOPES);
  });

  it('requests neither cloud-platform nor any drive scope', () => {
    expect(REQUESTED_SCOPES).not.toContain('cloud-platform');
    expect(REQUESTED_SCOPES).not.toContain('drive');
  });

  it('explains a scope mismatch rather than blaming token expiry', async () => {
    const fetchImpl = stubFetch(
      400,
      JSON.stringify({ error: 'invalid_scope', error_description: 'Some requested scopes were invalid.' }),
    );
    const err = await (async () => {
      try {
        await getAccessToken(CREDENTIALS, fetchImpl as unknown as typeof fetch);
        return undefined;
      } catch (e) {
        return e as GasDeployError;
      }
    })();

    expect(err).toBeInstanceOf(GasDeployError);
    expect(err!.nextSteps.join('\n')).toContain('script.projects');
    expect(err!.nextSteps.join('\n')).not.toContain('テスト');
  });

  it('still blames token expiry for invalid_grant', async () => {
    const fetchImpl = stubFetch(400, JSON.stringify({ error: 'invalid_grant' }));
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

  it('falls back to the default guidance when the error body is not JSON', async () => {
    const fetchImpl = stubFetch(500, '<html>proxy error</html>');
    const err = await (async () => {
      try {
        await getAccessToken(CREDENTIALS, fetchImpl as unknown as typeof fetch);
        return undefined;
      } catch (e) {
        return e as GasDeployError;
      }
    })();

    expect(err).toBeInstanceOf(GasDeployError);
    expect(err!.nextSteps.length).toBeGreaterThan(0);
  });

  it('mentions the reauth policy when Google reports invalid_rapt', async () => {
    const fetchImpl = stubFetch(
      400,
      JSON.stringify({
        error: 'invalid_grant',
        error_description: 'reauth related error (invalid_rapt)',
        error_subtype: 'invalid_rapt',
      }),
    );
    const err = await (async () => {
      try {
        await getAccessToken(CREDENTIALS, fetchImpl as unknown as typeof fetch);
        return undefined;
      } catch (e) {
        return e as GasDeployError;
      }
    })();
    expect(err).toBeInstanceOf(GasDeployError);
    expect(err!.message).toContain('再認証ポリシー');
    expect(err!.nextSteps.join('\n')).toContain('clasp login');
    expect(err!.nextSteps.join('\n')).toContain('gh secret set');
  });

  // 汎用の案内は「同意画面をテストから本番へ」を先頭に出す。この失効は同意画面の
  // ステータスと無関係に起きるため、それを混ぜると直らない対処に誘導することになる。
  it('does not blame the consent screen when the cause is the reauth policy', async () => {
    const fetchImpl = stubFetch(
      400,
      JSON.stringify({ error: 'invalid_grant', error_description: 'reauth related error (invalid_rapt)' }),
    );
    const err = await (async () => {
      try {
        await getAccessToken(CREDENTIALS, fetchImpl as unknown as typeof fetch);
        return undefined;
      } catch (e) {
        return e as GasDeployError;
      }
    })();
    expect(err!.nextSteps.join('\n')).not.toContain('7日');
  });

  // 死活監視は「失効したのか、スコープが足りないのか、そもそも繋がらないのか」で
  // 報告を変える。同じ 400 が失効とスコープ不足の両方で返るため、ステータスでは区別できない。
  describe('failure codes', () => {
    async function capture(fetchImpl: typeof fetch): Promise<GasDeployError> {
      try {
        await getAccessToken(CREDENTIALS, fetchImpl);
        throw new Error('getAccessToken が失敗しませんでした');
      } catch (e) {
        return e as GasDeployError;
      }
    }

    it('tags an expired or revoked refresh token as token-invalid', async () => {
      const err = await capture(stubFetch(400, JSON.stringify({ error: 'invalid_grant' })) as unknown as typeof fetch);
      expect(err.code).toBe('token-invalid');
    });

    // 同じ invalid_grant でも、再認証ポリシーによる失効だけは対処が異なる。
    // error_description まで見て初めて区別できるため、コードで分けておく。
    it('tags a reauth-policy expiry as reauth-required, not token-invalid', async () => {
      const err = await capture(
        stubFetch(
          400,
          JSON.stringify({ error: 'invalid_grant', error_description: 'reauth related error (invalid_rapt)' }),
        ) as unknown as typeof fetch,
      );
      expect(err.code).toBe('reauth-required');
    });

    it('tags a scope mismatch as insufficient-scope', async () => {
      const err = await capture(stubFetch(400, JSON.stringify({ error: 'invalid_scope' })) as unknown as typeof fetch);
      expect(err.code).toBe('insufficient-scope');
    });

    it('tags a network-level failure as connectivity', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new TypeError('fetch failed');
      });
      const err = await capture(fetchImpl as unknown as typeof fetch);
      expect(err.code).toBe('connectivity');
    });

    it('tags a 200 response without an access_token as response-invalid', async () => {
      const err = await capture(stubFetch(200, JSON.stringify({ token_type: 'Bearer' })) as unknown as typeof fetch);
      expect(err.code).toBe('response-invalid');
    });
  });
});
