import { describe, expect, it, vi } from 'vitest';
import { GasDeployError } from './errors.js';
import { HEAD_NOT_REVERTED_WARNING, rollback } from './rollback.js';
import type { AppsScriptClient } from './api-client.js';
import type { Deployment, Version } from './types.js';

const LIVE: Deployment = {
  deploymentId: 'dep-live',
  versionNumber: 42,
  description: 'ci-abc1234-42',
  webAppUrl: 'https://example.com/exec',
};

/** @HEAD は常に存在し、versionNumber を持たない。 */
const HEAD: Deployment = { deploymentId: 'dep-head' };

function version(versionNumber: number, overrides: Partial<Version> = {}): Version {
  return {
    versionNumber,
    description: `ci-abc1234-${versionNumber}`,
    createTime: '2026-08-09T10:00:00Z',
    ...overrides,
  };
}

function fakeClient(overrides: Record<string, unknown> = {}) {
  const client = {
    listDeployments: vi.fn(async (): Promise<Deployment[]> => [HEAD, LIVE]),
    getDeployment: vi.fn(async (_scriptId: string, deploymentId: string): Promise<Deployment> => {
      const found = [HEAD, LIVE].find((entry) => entry.deploymentId === deploymentId);
      if (found === undefined) throw new Error(`unexpected deploymentId: ${deploymentId}`);
      return found;
    }),
    getVersion: vi.fn(async (_scriptId: string, versionNumber: number) => version(versionNumber)),
    updateDeployment: vi.fn(
      async (
        _scriptId: string,
        deploymentId: string,
        versionNumber: number,
        _description: string,
      ): Promise<Deployment> => ({
        deploymentId,
        versionNumber,
        webAppUrl: 'https://example.com/exec',
      }),
    ),
    ...overrides,
  };
  return client as unknown as AppsScriptClient & typeof client;
}

/** 読み取り安定化の待機はテストでは不要。実時間を待つと全体が数十秒遅くなる。 */
function baseOptions() {
  return { scriptId: 'script-abc', dryRun: false, sleep: async (): Promise<void> => undefined };
}

/** GasDeployError#format() は message と nextSteps の両方を含むため、案内文まで検証できる。 */
async function formatOfRejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GasDeployError);
    return (error as GasDeployError).format();
  }
  throw new Error('expected the promise to reject, but it resolved');
}

describe('rollback', () => {
  describe('デプロイの特定', () => {
    it('バージョン付きデプロイが1つだけなら deploymentId 無しで特定する', async () => {
      const client = fakeClient();

      const result = await rollback(client, baseOptions());

      expect(result.deploymentId).toBe('dep-live');
      expect(client.updateDeployment).toHaveBeenCalledWith('script-abc', 'dep-live', 41, expect.any(String));
    });

    it('バージョン付きデプロイが複数ある場合は、候補を列挙して失敗する', async () => {
      const other: Deployment = { deploymentId: 'dep-other', versionNumber: 30, description: 'staging' };
      const client = fakeClient({ listDeployments: vi.fn(async () => [HEAD, LIVE, other]) });

      const message = await formatOfRejection(rollback(client, baseOptions()));

      // どれを選べばよいか判断できるよう、ID・バージョン・説明がすべて出ていること。
      expect(message).toContain('dep-live');
      expect(message).toContain('dep-other');
      expect(message).toContain('42');
      expect(message).toContain('30');
      expect(message).toContain('staging');
      expect(client.updateDeployment).not.toHaveBeenCalled();
    });

    it('バージョン付きデプロイが1つも無い場合は失敗する', async () => {
      const client = fakeClient({ listDeployments: vi.fn(async () => [HEAD]) });

      const message = await formatOfRejection(rollback(client, baseOptions()));

      expect(message).toContain('バージョン付きデプロイ');
      expect(client.updateDeployment).not.toHaveBeenCalled();
    });

    it('指定した deploymentId が存在しない場合は失敗する', async () => {
      const client = fakeClient();

      const message = await formatOfRejection(rollback(client, { ...baseOptions(), deploymentId: 'dep-missing' }));

      expect(message).toContain('dep-missing');
      expect(client.updateDeployment).not.toHaveBeenCalled();
    });

    it('指定した deploymentId が @HEAD（バージョン未固定）の場合は失敗する', async () => {
      const client = fakeClient();

      const message = await formatOfRejection(rollback(client, { ...baseOptions(), deploymentId: 'dep-head' }));

      // @HEAD は常に最新のソースを指すため、バージョンを指すという操作自体が成立しない。
      expect(message).toContain('@HEAD');
      expect(client.updateDeployment).not.toHaveBeenCalled();
    });
  });

  describe('ロールバック先バージョンの決定', () => {
    it('versionNumber 未指定なら現在のバージョンの1つ前に戻す', async () => {
      const client = fakeClient();

      const result = await rollback(client, baseOptions());

      expect(result.fromVersion).toBe(42);
      expect(result.toVersion).toBe(41);
    });

    it('現在のバージョンが 1 の場合、戻り先が無いため失敗する', async () => {
      const first: Deployment = { ...LIVE, versionNumber: 1 };
      const client = fakeClient({
        listDeployments: vi.fn(async () => [HEAD, first]),
        getDeployment: vi.fn(async () => first),
      });

      const message = await formatOfRejection(rollback(client, baseOptions()));

      expect(message).toContain('最初のバージョン');
      expect(client.updateDeployment).not.toHaveBeenCalled();
    });

    it('versionNumber を明示するとそのバージョンに戻す', async () => {
      const client = fakeClient();

      const result = await rollback(client, { ...baseOptions(), versionNumber: 10 });

      expect(result.toVersion).toBe(10);
      expect(client.updateDeployment).toHaveBeenCalledWith('script-abc', 'dep-live', 10, expect.any(String));
    });

    it('戻り先バージョンが存在しない場合、API の 404 をそのまま返さず専用の案内にする', async () => {
      const notFound = new GasDeployError('Apps Script プロジェクトが見つかりません (404)', { status: 404 });
      const client = fakeClient({
        getVersion: vi.fn(async () => {
          throw notFound;
        }),
      });

      const message = await formatOfRejection(rollback(client, { ...baseOptions(), versionNumber: 999 }));

      expect(message).toContain('999');
      expect(client.updateDeployment).not.toHaveBeenCalled();
    });

    it('404 以外のエラーは握りつぶさずそのまま伝播させる', async () => {
      const serverError = new GasDeployError('Apps Script API がエラーを返しました (503)', { status: 503 });
      const client = fakeClient({
        getVersion: vi.fn(async () => {
          throw serverError;
        }),
      });

      await expect(rollback(client, { ...baseOptions(), versionNumber: 10 })).rejects.toBe(serverError);
    });

    it('戻り先バージョンの説明と作成日時を結果に含める', async () => {
      const client = fakeClient({
        getVersion: vi.fn(async () =>
          version(41, { description: '安定版', createTime: '2026-08-01T00:00:00Z' }),
        ),
      });

      const result = await rollback(client, baseOptions());

      expect(result.toVersionDescription).toBe('安定版');
      expect(result.toVersionCreateTime).toBe('2026-08-01T00:00:00Z');
    });
  });

  describe('書き込みを伴わないケース', () => {
    it('すでに戻り先バージョンを指している場合は何もせず、その旨を返す', async () => {
      const client = fakeClient();

      const result = await rollback(client, { ...baseOptions(), versionNumber: 42 });

      expect(result.rolledBack).toBe(false);
      expect(client.updateDeployment).not.toHaveBeenCalled();
      expect(result.warnings.join('\n')).toContain('すでに');
    });

    it('dryRun では検証だけ行い、デプロイを書き換えない', async () => {
      const client = fakeClient();

      const result = await rollback(client, { ...baseOptions(), dryRun: true });

      expect(result.rolledBack).toBe(false);
      expect(result.toVersion).toBe(41);
      // dry-run が「実行したら何が起きるか」を示せるよう、戻り先の実在確認だけは行う。
      expect(client.getVersion).toHaveBeenCalledWith('script-abc', 41);
      expect(client.updateDeployment).not.toHaveBeenCalled();
    });
  });

  describe('警告', () => {
    it('HEAD のソースが戻らないことを必ず警告する', async () => {
      const client = fakeClient();

      const result = await rollback(client, baseOptions());

      expect(result.warnings).toContain(HEAD_NOT_REVERTED_WARNING);
    });

    it('dryRun でも HEAD のソースが戻らないことを警告する', async () => {
      const client = fakeClient();

      const result = await rollback(client, { ...baseOptions(), dryRun: true });

      expect(result.warnings).toContain(HEAD_NOT_REVERTED_WARNING);
    });

    it('現在より新しいバージョンを指定した場合はロールバックでないことを警告する', async () => {
      const client = fakeClient();

      const result = await rollback(client, { ...baseOptions(), versionNumber: 50 });

      expect(result.rolledBack).toBe(true);
      expect(result.warnings.join('\n')).toContain('新しい');
    });

    it('現在より古いバージョンへの通常のロールバックでは、新しい旨の警告を出さない', async () => {
      const client = fakeClient();

      const result = await rollback(client, { ...baseOptions(), versionNumber: 10 });

      expect(result.warnings.join('\n')).not.toContain('新しい');
    });
  });

  describe('デプロイの説明', () => {
    it('既定の説明には戻り先と戻し元の両方のバージョンが入る', async () => {
      const client = fakeClient();

      await rollback(client, baseOptions());

      const description = client.updateDeployment.mock.calls[0]?.[3] as string;
      expect(description).toContain('41');
      expect(description).toContain('42');
    });

    it('description を指定するとそれを使う', async () => {
      const client = fakeClient();

      await rollback(client, { ...baseOptions(), description: 'incident-1234 の復旧' });

      expect(client.updateDeployment).toHaveBeenCalledWith('script-abc', 'dep-live', 41, 'incident-1234 の復旧');
    });
  });

  describe('読み取りの安定化', () => {
    /** 単体取得の versionNumber が呼び出しごとに揺れるクライアントを作る。 */
    function flakyClient(sequence: readonly number[]) {
      let call = 0;
      return fakeClient({
        getDeployment: vi.fn(async (): Promise<Deployment> => {
          const versionNumber = sequence[Math.min(call, sequence.length - 1)] ?? 42;
          call += 1;
          return { ...LIVE, versionNumber };
        }),
      });
    }

    it('連続2回の読み取りが一致するまで待つ', async () => {
      // 1回目 40、2回目 42、3回目 42 → 2回目と3回目が一致した時点で確定する。
      const client = flakyClient([40, 42, 42]);

      const result = await rollback(client, baseOptions());

      expect(result.fromVersion).toBe(42);
      expect(result.toVersion).toBe(41);
      expect(client.getDeployment).toHaveBeenCalledTimes(3);
    });

    it('現在のバージョンは一覧ではなく単体取得から確定させる', async () => {
      // 一覧が古い値を返しても、単体取得の値が使われること。
      const client = fakeClient({
        listDeployments: vi.fn(async (): Promise<Deployment[]> => [HEAD, { ...LIVE, versionNumber: 99 }]),
      });

      const result = await rollback(client, baseOptions());

      expect(result.fromVersion).toBe(42);
    });

    it('揺れが収まらず戻り先も未指定なら、推測せず失敗する', async () => {
      // 毎回違う値を返す。「1つ前」を計算する根拠が無い。
      const client = flakyClient([40, 42, 38, 44, 36, 46, 34]);

      const message = await formatOfRejection(rollback(client, baseOptions()));

      expect(message).toContain('version-number');
      expect(client.updateDeployment).not.toHaveBeenCalled();
    });

    it('揺れが収まらなくても version-number が明示されていれば実行し、警告する', async () => {
      // 戻り先が明示されていれば、揺れの影響は無操作判定と表示上の現在バージョンに留まる。
      const client = flakyClient([40, 42, 38, 44, 36, 46, 34]);

      const result = await rollback(client, { ...baseOptions(), versionNumber: 10 });

      expect(result.rolledBack).toBe(true);
      expect(result.toVersion).toBe(10);
      expect(result.warnings.join('\n')).toContain('安定していません');
    });

    it('安定している通常のケースでは警告を出さない', async () => {
      const client = fakeClient();

      const result = await rollback(client, baseOptions());

      expect(result.warnings.join('\n')).not.toContain('安定していません');
    });
  });

  it('更新後のデプロイから Web アプリ URL を返す', async () => {
    const client = fakeClient();

    const result = await rollback(client, baseOptions());

    expect(result.webAppUrl).toBe('https://example.com/exec');
  });
});
