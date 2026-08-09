import { GasDeployError, REQUESTED_SCOPES } from '@gas-deploy/core';
import { describe, expect, it, vi } from 'vitest';
import { resolveBrowserCommand, runSetup } from './run.js';
import type { RunSetupOptions } from './run.js';

const FAKE_CLIENT_ID = 'fake-client-id.apps.googleusercontent.com';
const FAKE_CLIENT_SECRET = 'FAKE-CLIENT-SECRET-VALUE-DO-NOT-LOG';
const FAKE_REFRESH_TOKEN = 'FAKE-REFRESH-TOKEN-VALUE-DO-NOT-LOG';

type ExecFileImpl = NonNullable<RunSetupOptions['execFileImpl']>;

/** promptInputImpl の代役。渡した配列を1回ずつ順番に返し、尽きたら例外を投げる。 */
function scriptedPromptInput(answers: string[]) {
  const queue = [...answers];
  return vi.fn(async (_question: string) => {
    if (queue.length === 0) {
      throw new Error(`promptInputImpl called more times than the ${answers.length} scripted answers allow`);
    }
    return queue.shift()!;
  });
}

interface FakeExecFileCall {
  file: string;
  args: string[];
}

/**
 * execFileImpl の代役。実際のプロセスは一切起動しない。
 * `shouldFail` で特定の呼び出しだけ失敗させられる（既定はすべて成功）。
 * `gh secret set` の呼び出しでは stdin.end() に渡された内容を stdinWrites に記録する。
 */
function createFakeExecFile(shouldFail: (file: string, args: string[]) => boolean = () => false) {
  const calls: FakeExecFileCall[] = [];
  const stdinWrites: string[] = [];
  const impl = ((file: string, args: readonly string[], callback: (error: Error | null) => void) => {
    const argsArray = [...args];
    calls.push({ file, args: argsArray });
    const fail = shouldFail(file, argsArray);
    const fakeChild = {
      stdin: {
        end: (data: string) => {
          stdinWrites.push(data);
        },
      },
    };
    // queueMicrotask を使うことで、実ネットワーク I/O（ループバックへの実 fetch）よりも
    // 確実に早く解決する。setTimeout 等のマクロタスクだと順序が環境依存になりうるため避ける。
    queueMicrotask(() => callback(fail ? new Error('exec failed') : null));
    return fakeChild;
  }) as unknown as ExecFileImpl;
  return { impl, calls, stdinWrites };
}

/**
 * fetchImpl の代役。exchangeCodeForRefreshToken / getAccessToken が叩くトークンエンドポイントと、
 * verifyCredentials が叩く tokeninfo エンドポイントの両方に応答する。
 */
function createFakeFetch(grantedScope: string) {
  return vi.fn(async (input: string | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
      return new Response(JSON.stringify({ scope: grantedScope }), { status: 200 });
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(
        JSON.stringify({ access_token: 'fake-access-token', refresh_token: FAKE_REFRESH_TOKEN }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;
}

/**
 * log の代役。呼び出し内容を記録しつつ、認可 URL が出力された瞬間を検知して、
 * 実際のブラウザ操作の代わりにループバックサーバーへ直接コールバックを送る
 * （oauth.test.ts と同じ手法: 127.0.0.1 の実サーバーに実 fetch で応答する）。
 */
function createLogCollector() {
  const messages: string[] = [];
  const log = (message: string) => {
    messages.push(message);
    const match = message.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?\S+/);
    if (match) {
      const authorizationUrl = new URL(match[0]);
      const state = authorizationUrl.searchParams.get('state')!;
      const redirectUri = authorizationUrl.searchParams.get('redirect_uri')!;
      const callbackUrl = `${redirectUri}?code=FAKE-AUTH-CODE&state=${encodeURIComponent(state)}`;
      void fetch(callbackUrl).catch(() => {
        // テスト用のループバック呼び出し。失敗しても本体のアサーションで検知される。
      });
    }
  };
  return { log, messages };
}

describe('resolveBrowserCommand', () => {
  it('uses open on darwin', () => {
    expect(resolveBrowserCommand('darwin', 'https://example.com/auth')).toEqual([
      'open',
      ['https://example.com/auth'],
    ]);
  });

  it('uses start on win32', () => {
    expect(resolveBrowserCommand('win32', 'https://example.com/auth')).toEqual([
      'start',
      ['', 'https://example.com/auth'],
    ]);
  });

  it('uses xdg-open on any other platform', () => {
    expect(resolveBrowserCommand('linux', 'https://example.com/auth')).toEqual([
      'xdg-open',
      ['https://example.com/auth'],
    ]);
    expect(resolveBrowserCommand('freebsd', 'https://example.com/auth')).toEqual([
      'xdg-open',
      ['https://example.com/auth'],
    ]);
  });
});

describe('runSetup / non-interactive stdin', () => {
  it('fails immediately with a GasDeployError and never prompts when isTTY is false', async () => {
    const promptInputImpl = vi.fn(async () => '');
    await expect(runSetup({ isTTY: false, promptInputImpl, log: () => {} })).rejects.toThrow(GasDeployError);
    expect(promptInputImpl).not.toHaveBeenCalled();
  });
});

describe('runSetup / browser launch failure', () => {
  it('does not abort the run when execFileImpl fails to open the browser; the URL is printed instead', async () => {
    const { log, messages } = createLogCollector();
    const promptInputImpl = scriptedPromptInput(['1', FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, 'n']);
    const { impl: execFileImpl } = createFakeExecFile(() => true); // every execFile call fails, incl. browser open

    await runSetup({
      isTTY: true,
      platform: 'linux',
      log,
      promptInputImpl,
      execFileImpl,
      fetchImpl: createFakeFetch(REQUESTED_SCOPES),
    });

    const combined = messages.join('\n');
    expect(combined).toContain('ブラウザを自動的に開けませんでした');
    expect(combined).toContain('セットアップが完了しました');
  });
});

describe('runSetup / non-minimal verification', () => {
  it('throws and does not proceed to persistence (no gh call, no file write)', async () => {
    const { log, messages } = createLogCollector();
    const promptInputImpl = scriptedPromptInput(['1', FAKE_CLIENT_ID, FAKE_CLIENT_SECRET]);
    const { impl: execFileImpl, calls } = createFakeExecFile();
    const writeFileImpl = vi.fn(async (_path: string, _data: string) => {});
    const grantedScope = `${REQUESTED_SCOPES} https://www.googleapis.com/auth/cloud-platform`;

    await expect(
      runSetup({
        isTTY: true,
        platform: 'linux',
        log,
        promptInputImpl,
        execFileImpl,
        writeFileImpl,
        fetchImpl: createFakeFetch(grantedScope),
      }),
    ).rejects.toThrow(GasDeployError);

    // 昇格した persistence 経路（gh への問い合わせ、ファイル書き出し）には一切進んでいない。
    expect(calls.some((call) => call.file === 'gh')).toBe(false);
    expect(writeFileImpl).not.toHaveBeenCalled();
    // アカウント種別・クライアント ID・クライアントシークレットの3回で止まっている
    // （persistence の「登録しますか？」は尋ねられていない）。
    expect(promptInputImpl).toHaveBeenCalledTimes(3);
    expect(messages.join('\n')).toContain('NG');
  });
});

describe('runSetup / gh unavailable', () => {
  it('falls back to writing the minimal JSON to a file, warning about deletion and never committing', async () => {
    const { log, messages } = createLogCollector();
    const chosenPath = '/tmp/gas-deploy-setup-test-credentials.json';
    const promptInputImpl = scriptedPromptInput(['2', FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, 'y', chosenPath]);
    const { impl: execFileImpl } = createFakeExecFile(() => true); // gh --version fails => not ready
    const writeFileImpl = vi.fn(async (_path: string, _data: string) => {});

    await runSetup({
      isTTY: true,
      platform: 'linux',
      log,
      promptInputImpl,
      execFileImpl,
      writeFileImpl,
      fetchImpl: createFakeFetch(REQUESTED_SCOPES),
    });

    expect(writeFileImpl).toHaveBeenCalledTimes(1);
    const [path, data] = writeFileImpl.mock.calls[0]!;
    expect(path).toBe(chosenPath);
    expect(JSON.parse(data as string)).toEqual({
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
      refreshToken: FAKE_REFRESH_TOKEN,
    });

    const combined = messages.join('\n');
    expect(combined).toContain('削除してください');
    expect(combined).toContain('コミットしないでください');
  });
});

describe('runSetup / gh available', () => {
  it('pipes the JSON via stdin so argv carries only the secret name', async () => {
    const { log, messages } = createLogCollector();
    const promptInputImpl = scriptedPromptInput(['1', FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, 'y', 'MY_SECRET_NAME']);
    const { impl: execFileImpl, calls, stdinWrites } = createFakeExecFile(); // everything succeeds

    await runSetup({
      isTTY: true,
      platform: 'linux',
      log,
      promptInputImpl,
      execFileImpl,
      fetchImpl: createFakeFetch(REQUESTED_SCOPES),
    });

    const secretSetCall = calls.find((call) => call.file === 'gh' && call.args[0] === 'secret' && call.args[1] === 'set');
    expect(secretSetCall).toBeDefined();
    expect(secretSetCall!.args).toEqual(['secret', 'set', 'MY_SECRET_NAME']);
    expect(secretSetCall!.args.join(' ')).not.toContain(FAKE_CLIENT_SECRET);
    expect(secretSetCall!.args.join(' ')).not.toContain(FAKE_REFRESH_TOKEN);

    const secretBody = stdinWrites.find((body) => body.includes(FAKE_REFRESH_TOKEN));
    expect(secretBody).toBeDefined();
    expect(JSON.parse(secretBody!)).toEqual({
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
      refreshToken: FAKE_REFRESH_TOKEN,
    });

    expect(messages.join('\n')).toContain('MY_SECRET_NAME');
  });
});

describe('runSetup / nothing sensitive is logged', () => {
  it('never logs the refresh token or client secret across a full successful run', async () => {
    const { log, messages } = createLogCollector();
    const promptInputImpl = scriptedPromptInput(['2', FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, 'n']);
    const { impl: execFileImpl } = createFakeExecFile();

    await runSetup({
      isTTY: true,
      platform: 'darwin',
      log,
      promptInputImpl,
      execFileImpl,
      fetchImpl: createFakeFetch(REQUESTED_SCOPES),
    });

    const combined = messages.join('\n');
    expect(combined).not.toContain(FAKE_CLIENT_SECRET);
    expect(combined).not.toContain(FAKE_REFRESH_TOKEN);
    expect(combined).toContain('セットアップが完了しました');
  });
});
