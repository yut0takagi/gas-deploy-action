import { describe, expect, it, vi } from 'vitest';
import { REQUIRED_SCOPES } from './auth.js';
import { GasDeployError } from './errors.js';
import { preflight, verifyScopes } from './preflight.js';

const CREDENTIALS = {
  clientId: 'cid.apps.googleusercontent.com',
  clientSecret: 'secret-value',
  refreshToken: 'refresh-value',
};

/**
 * 失敗を取り出す。成功してしまった場合は握り潰さずに落とす
 * （`catch` で拾うだけだと、期待した例外が出なくてもテストが緑になる）。
 */
async function captureFailure(promise: Promise<unknown>): Promise<GasDeployError> {
  try {
    await promise;
  } catch (error) {
    return error as GasDeployError;
  }
  throw new Error('preflight が失敗しませんでした');
}

function healthyDeps() {
  return {
    exchange: vi.fn(async () => ({ accessToken: 'at-123', grantedScopes: [...REQUIRED_SCOPES] })),
    readProject: vi.fn(async () => {}),
  };
}

describe('verifyScopes', () => {
  it('reports nothing when both required scopes are granted', () => {
    expect(verifyScopes([...REQUIRED_SCOPES])).toEqual([]);
  });

  it('names the missing scope', () => {
    const warnings = verifyScopes(['https://www.googleapis.com/auth/script.projects']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('script.deployments');
  });

  // 応答に scope が無いことは「付与されていない」ではなく「判定できない」。
  // ここで警告を出すと、正常に動いている構成に毎回ノイズが出る。
  it('stays silent when the response carried no scope at all', () => {
    expect(verifyScopes([])).toEqual([]);
  });

  // 要求より広いスコープが返るのは通常のこと（絞り込みが効かない認証情報がある）。
  it('does not complain about extra scopes beyond the required ones', () => {
    expect(verifyScopes([...REQUIRED_SCOPES, 'https://www.googleapis.com/auth/drive'])).toEqual([]);
  });
});

describe('preflight', () => {
  it('returns the access token so the deploy does not exchange twice', async () => {
    const deps = healthyDeps();
    const result = await preflight({ credentials: CREDENTIALS, scriptIds: [] }, deps);
    expect(result.accessToken).toBe('at-123');
    expect(deps.exchange).toHaveBeenCalledTimes(1);
  });

  it('checks every script id before returning', async () => {
    const deps = healthyDeps();
    const result = await preflight({ credentials: CREDENTIALS, scriptIds: ['a', 'b', 'c'] }, deps);
    expect(result.checkedScriptIds).toEqual(['a', 'b', 'c']);
    expect(deps.readProject).toHaveBeenCalledTimes(3);
  });

  // 単一プロジェクトでは deploy() が書き込み前に getContent を呼ぶ。ここで
  // projects.get を足すとリクエストが増えるだけなので、呼ばないことを固定する。
  it('makes no project request when no script ids are given', async () => {
    const deps = healthyDeps();
    await preflight({ credentials: CREDENTIALS, scriptIds: [] }, deps);
    expect(deps.readProject).not.toHaveBeenCalled();
  });

  it('surfaces a scope shortfall as a warning rather than a failure', async () => {
    const deps = {
      ...healthyDeps(),
      exchange: vi.fn(async () => ({
        accessToken: 'at-123',
        grantedScopes: ['https://www.googleapis.com/auth/script.projects'],
      })),
    };
    const result = await preflight({ credentials: CREDENTIALS, scriptIds: [] }, deps);
    expect(result.warnings.join('\n')).toContain('script.deployments');
  });

  // 交換の失敗は auth.ts が原因別に分類済み。包み直すと invalid_rapt のような
  // 確定した案内が潰れるため、そのまま通ることを固定する。
  it('lets a classified exchange failure through untouched', async () => {
    const original = new GasDeployError('認証情報が失効しています（Google Workspace の再認証ポリシー） (400)', {
      code: 'reauth-required',
      nextSteps: ['clasp login をやり直してください'],
    });
    const deps = {
      ...healthyDeps(),
      exchange: vi.fn(async () => {
        throw original;
      }),
    };
    await expect(preflight({ credentials: CREDENTIALS, scriptIds: ['a'] }, deps)).rejects.toBe(original);
  });

  it('does not touch any project when the exchange fails', async () => {
    const deps = {
      ...healthyDeps(),
      exchange: vi.fn(async () => {
        throw new GasDeployError('失効', { code: 'token-invalid' });
      }),
    };
    await expect(preflight({ credentials: CREDENTIALS, scriptIds: ['a'] }, deps)).rejects.toThrow(GasDeployError);
    expect(deps.readProject).not.toHaveBeenCalled();
  });

  // 「どれが原因か」が分からないと、10プロジェクトの構成では調べようがない。
  it('names the script id that failed the permission check', async () => {
    const deps = {
      ...healthyDeps(),
      readProject: vi.fn(async (_token: string, scriptId: string) => {
        if (scriptId === 'bad-id') {
          throw new GasDeployError('Apps Script プロジェクトへのアクセスが拒否されました (403)', {
            code: 'access-denied',
            status: 403,
            nextSteps: ['編集権限があるか確認してください'],
          });
        }
      }),
    };

    const error = await captureFailure(preflight({ credentials: CREDENTIALS, scriptIds: ['ok-id', 'bad-id'] }, deps));
    expect(error.message).toContain('bad-id');
    expect(error.code).toBe('access-denied');
    expect(error.status).toBe(403);
  });

  it('keeps the original next steps and adds that nothing was written yet', async () => {
    const deps = {
      ...healthyDeps(),
      readProject: vi.fn(async () => {
        throw new GasDeployError('Apps Script プロジェクトが見つかりません (404)', {
          code: 'not-found',
          nextSteps: ['scriptId が正しいか確認してください'],
        });
      }),
    };

    const error = await captureFailure(preflight({ credentials: CREDENTIALS, scriptIds: ['a'] }, deps));
    expect(error.nextSteps.join('\n')).toContain('scriptId が正しいか');
    expect(error.nextSteps.join('\n')).toContain('まだ書き換えられていません');
  });

  // 3件目で落ちたときに1・2件目が書き換わっているのを防ぐのが目的なので、
  // 失敗した時点で以降を試さずに止まることを固定する。
  it('stops at the first failure without checking the rest', async () => {
    const readProject = vi.fn(async (_token: string, scriptId: string) => {
      if (scriptId === 'b') {
        throw new GasDeployError('拒否 (403)', { code: 'access-denied' });
      }
    });
    const deps = { ...healthyDeps(), readProject };

    await expect(
      preflight({ credentials: CREDENTIALS, scriptIds: ['a', 'b', 'c'] }, deps),
    ).rejects.toThrow(GasDeployError);
    expect(readProject.mock.calls.map((call) => call[1])).toEqual(['a', 'b']);
  });
});
