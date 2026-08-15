import type { TokenHealth } from '@gas-deploy/core';
import { describe, expect, it } from 'vitest';
import { decideOutcome } from './main.js';

function health(overrides: Partial<TokenHealth>): TokenHealth {
  return {
    status: 'valid',
    reason: 'ok',
    message: 'refresh token は有効です',
    nextSteps: [],
    projectChecked: false,
    ...overrides,
  };
}

const DEFAULTS = { failOnInvalid: true, failOnUnknown: false };

describe('decideOutcome', () => {
  it('does nothing when the token is valid', () => {
    expect(decideOutcome(health({}), DEFAULTS).level).toBe('none');
  });

  it('fails the job when the token is unusable', () => {
    const outcome = decideOutcome(health({ status: 'invalid', reason: 'token-invalid' }), DEFAULTS);
    expect(outcome.level).toBe('failure');
  });

  // 到達できなかっただけで週次ジョブが赤くなると、本当に失効したときの赤が埋もれる。
  it('only warns on an undetermined result by default', () => {
    const outcome = decideOutcome(health({ status: 'unknown', reason: 'connectivity' }), DEFAULTS);
    expect(outcome.level).toBe('warning');
  });

  it('fails on an undetermined result when the caller opts in', () => {
    const outcome = decideOutcome(health({ status: 'unknown', reason: 'connectivity' }), {
      failOnInvalid: true,
      failOnUnknown: true,
    });
    expect(outcome.level).toBe('failure');
  });

  it('warns instead of failing when failing on invalid is switched off', () => {
    const outcome = decideOutcome(health({ status: 'invalid', reason: 'token-invalid' }), {
      failOnInvalid: false,
      failOnUnknown: false,
    });
    expect(outcome.level).toBe('warning');
  });

  it('never fails a valid result even when both switches are on', () => {
    const outcome = decideOutcome(health({}), { failOnInvalid: true, failOnUnknown: true });
    expect(outcome.level).toBe('none');
  });

  it('carries the failure message and reason into the reported text', () => {
    const outcome = decideOutcome(
      health({ status: 'invalid', reason: 'insufficient-scope', message: 'スコープが足りません' }),
      DEFAULTS,
    );
    expect(outcome.message).toContain('スコープが足りません');
    expect(outcome.message).toContain('insufficient-scope');
  });
});
