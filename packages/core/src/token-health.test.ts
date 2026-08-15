import { describe, expect, it, vi } from 'vitest';
import { GasDeployError, classifyApiError } from './errors.js';
import { checkTokenHealth } from './token-health.js';

const CREDENTIALS = {
  clientId: 'cid.apps.googleusercontent.com',
  clientSecret: 'secret-value',
  refreshToken: 'refresh-value',
};

/** 交換は成功し、プロジェクトも読める既定の依存。 */
function healthyDeps() {
  return {
    exchangeToken: vi.fn(async () => 'at-123'),
    readProject: vi.fn(async () => undefined),
  };
}

describe('checkTokenHealth', () => {
  it('reports valid when the refresh token can be exchanged', async () => {
    const result = await checkTokenHealth({ credentials: CREDENTIALS }, healthyDeps());
    expect(result.status).toBe('valid');
    expect(result.reason).toBe('ok');
  });

  it('does not claim the project was checked when no scriptId is given', async () => {
    const deps = healthyDeps();
    const result = await checkTokenHealth({ credentials: CREDENTIALS }, deps);
    expect(result.projectChecked).toBe(false);
    expect(deps.readProject).not.toHaveBeenCalled();
  });

  it('reads the project with the freshly issued token when a scriptId is given', async () => {
    const deps = healthyDeps();
    const result = await checkTokenHealth({ credentials: CREDENTIALS, scriptId: 'script-1' }, deps);
    expect(result.status).toBe('valid');
    expect(result.projectChecked).toBe(true);
    expect(deps.readProject).toHaveBeenCalledWith('at-123', 'script-1');
  });

  it('reports the token as invalid when the exchange fails on an expired token', async () => {
    const deps = {
      ...healthyDeps(),
      exchangeToken: vi.fn(async () => {
        throw new GasDeployError('アクセストークンの取得に失敗しました (400)', {
          code: 'token-invalid',
          nextSteps: ['同意画面を確認してください'],
        });
      }),
    };
    const result = await checkTokenHealth({ credentials: CREDENTIALS }, deps);
    expect(result.status).toBe('invalid');
    expect(result.reason).toBe('token-invalid');
    expect(result.nextSteps).toContain('同意画面を確認してください');
  });

  it('reports insufficient scope as invalid rather than blaming expiry', async () => {
    const deps = {
      ...healthyDeps(),
      exchangeToken: vi.fn(async () => {
        throw new GasDeployError('要求したスコープが付与されていません (400)', { code: 'insufficient-scope' });
      }),
    };
    const result = await checkTokenHealth({ credentials: CREDENTIALS }, deps);
    expect(result.status).toBe('invalid');
    expect(result.reason).toBe('insufficient-scope');
  });

  // ランナーが Google に到達できなかっただけで「トークンが死んだ」と報告すると、
  // 死活監視そのものが信用されなくなる。判定できなかったことを判定できなかったと言う。
  it('reports unknown when the token endpoint is unreachable', async () => {
    const deps = {
      ...healthyDeps(),
      exchangeToken: vi.fn(async () => {
        throw new GasDeployError('トークンエンドポイントに接続できませんでした', { code: 'connectivity' });
      }),
    };
    const result = await checkTokenHealth({ credentials: CREDENTIALS }, deps);
    expect(result.status).toBe('unknown');
    expect(result.reason).toBe('connectivity');
  });

  it('reports a disabled Apps Script API as invalid, since deploys cannot succeed', async () => {
    const deps = {
      ...healthyDeps(),
      readProject: vi.fn(async () => {
        throw classifyApiError(403, 'Apps Script API has not been used in project 1 before');
      }),
    };
    const result = await checkTokenHealth({ credentials: CREDENTIALS, scriptId: 'script-1' }, deps);
    expect(result.status).toBe('invalid');
    expect(result.reason).toBe('api-disabled');
  });

  it('reports a server-side API failure as unknown', async () => {
    const deps = {
      ...healthyDeps(),
      readProject: vi.fn(async () => {
        throw classifyApiError(503, 'unavailable');
      }),
    };
    const result = await checkTokenHealth({ credentials: CREDENTIALS, scriptId: 'script-1' }, deps);
    expect(result.status).toBe('unknown');
    expect(result.reason).toBe('api-error');
  });

  it('reports an unclassified failure as unknown instead of guessing', async () => {
    const deps = {
      ...healthyDeps(),
      exchangeToken: vi.fn(async () => {
        throw new GasDeployError('何かが起きました');
      }),
    };
    const result = await checkTokenHealth({ credentials: CREDENTIALS }, deps);
    expect(result.status).toBe('unknown');
    expect(result.reason).toBe('unclassified');
  });

  it('wraps a non-GasDeployError failure instead of leaking it', async () => {
    const deps = {
      ...healthyDeps(),
      exchangeToken: vi.fn(async () => {
        throw new TypeError('boom');
      }),
    };
    const result = await checkTokenHealth({ credentials: CREDENTIALS }, deps);
    expect(result.status).toBe('unknown');
    expect(result.reason).toBe('unclassified');
  });

  it('does not attempt to read the project when the exchange already failed', async () => {
    const deps = {
      ...healthyDeps(),
      exchangeToken: vi.fn(async () => {
        throw new GasDeployError('失効', { code: 'token-invalid' });
      }),
    };
    await checkTokenHealth({ credentials: CREDENTIALS, scriptId: 'script-1' }, deps);
    expect(deps.readProject).not.toHaveBeenCalled();
  });

  // 結果はジョブサマリと出力に載る。access token や client_secret が混ざれば
  // そのままログに出る。
  it('keeps credentials and the access token out of the result', async () => {
    const deps = {
      ...healthyDeps(),
      readProject: vi.fn(async () => {
        throw new GasDeployError('失敗', { code: 'access-denied', cause: 'raw body with at-123' });
      }),
    };
    const result = await checkTokenHealth({ credentials: CREDENTIALS, scriptId: 'script-1' }, deps);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('at-123');
    expect(serialized).not.toContain('secret-value');
    expect(serialized).not.toContain('refresh-value');
  });
});
