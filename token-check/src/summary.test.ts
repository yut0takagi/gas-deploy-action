import type { TokenHealth } from '@gas-deploy/core';
import { describe, expect, it } from 'vitest';
import { renderTokenHealthSummary } from './summary.js';

const VALID: TokenHealth = {
  status: 'valid',
  reason: 'ok',
  message: 'refresh token は有効です',
  nextSteps: [],
  projectChecked: false,
};

describe('renderTokenHealthSummary', () => {
  it('states that the token is alive when the check passed', () => {
    const summary = renderTokenHealthSummary(VALID);
    expect(summary).toContain('有効');
    expect(summary).not.toContain('失効');
  });

  it('says whether the project read was actually verified', () => {
    expect(renderTokenHealthSummary(VALID)).toContain('トークンの交換のみ');
    expect(renderTokenHealthSummary({ ...VALID, projectChecked: true })).toContain('プロジェクトの読み取り');
  });

  it('surfaces the failure message and the guided next steps when invalid', () => {
    const summary = renderTokenHealthSummary({
      status: 'invalid',
      reason: 'token-invalid',
      message: 'アクセストークンの取得に失敗しました (400)',
      nextSteps: ['同意画面を「本番」に変更してください', '認証情報を再発行してください'],
      projectChecked: false,
    });
    expect(summary).toContain('アクセストークンの取得に失敗しました (400)');
    expect(summary).toContain('同意画面を「本番」に変更してください');
    expect(summary).toContain('認証情報を再発行してください');
  });

  // 「今デプロイしたら落ちる」のか「判定できなかった」のかが読んで分からないと、
  // 受け取った人がトークンを不要に再発行する。
  it('tells an invalid result apart from an undetermined one', () => {
    const invalid = renderTokenHealthSummary({
      status: 'invalid',
      reason: 'token-invalid',
      message: '失効しています',
      nextSteps: [],
      projectChecked: false,
    });
    const unknown = renderTokenHealthSummary({
      status: 'unknown',
      reason: 'connectivity',
      message: 'トークンエンドポイントに接続できませんでした',
      nextSteps: [],
      projectChecked: false,
    });
    expect(invalid).toContain('デプロイは失敗します');
    expect(unknown).toContain('判定できませんでした');
    expect(unknown).not.toContain('デプロイは失敗します');
  });

  it('includes the machine-readable reason so the summary can be triaged', () => {
    expect(
      renderTokenHealthSummary({
        status: 'invalid',
        reason: 'api-disabled',
        message: 'Apps Script API が有効化されていません (403)',
        nextSteps: [],
        projectChecked: false,
      }),
    ).toContain('api-disabled');
  });
});
