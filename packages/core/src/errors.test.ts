import { describe, expect, it } from 'vitest';
import { GasDeployError, classifyApiError } from './errors.js';

describe('GasDeployError', () => {
  it('formats the message with numbered next steps', () => {
    const err = new GasDeployError('失敗しました', { nextSteps: ['A を確認', 'B を確認'] });
    expect(err.format()).toBe('失敗しました\n\n次の手順を確認してください:\n  1. A を確認\n  2. B を確認');
  });

  it('formats to the bare message when there are no next steps', () => {
    const err = new GasDeployError('失敗しました');
    expect(err.format()).toBe('失敗しました');
  });

  it('exposes a machine-readable code without leaking it into the formatted output', () => {
    const err = new GasDeployError('失敗しました', { code: 'token-invalid' });
    expect(err.code).toBe('token-invalid');
    expect(err.format()).toBe('失敗しました');
  });

  it('leaves the code undefined when it is not given', () => {
    expect(new GasDeployError('失敗しました').code).toBeUndefined();
  });
});

describe('classifyApiError', () => {
  it('points 401 at refresh token expiry with the 7-day testing-status cause', () => {
    const err = classifyApiError(401, '{"error":"invalid_grant"}');
    expect(err.message).toContain('401');
    expect(err.nextSteps.join('\n')).toContain('テスト');
  });

  it('points a disabled-API 403 at the user settings page', () => {
    const err = classifyApiError(403, 'Apps Script API has not been used in project 12345 before');
    expect(err.nextSteps.join('\n')).toContain('script.google.com/home/usersettings');
  });

  it('points a permission 403 at account access rather than the settings page', () => {
    const err = classifyApiError(403, '{"error":{"message":"The caller does not have permission"}}');
    expect(err.nextSteps.join('\n')).not.toContain('usersettings');
    expect(err.nextSteps.join('\n')).toContain('権限');
  });

  it('points 404 at a wrong scriptId or missing access', () => {
    const err = classifyApiError(404, '{}');
    expect(err.nextSteps.join('\n')).toContain('scriptId');
  });

  it('falls back to a generic message for unexpected statuses', () => {
    const err = classifyApiError(500, 'boom');
    expect(err.message).toContain('500');
  });

  it('preserves the raw response body as the error cause', () => {
    const err = classifyApiError(401, '{"error":"invalid_grant"}');
    expect(err.cause).toBe('{"error":"invalid_grant"}');
  });

  // メッセージ本文は将来変わりうるため、呼び出し側が分岐に使える機械可読な識別子を持たせる。
  it('tags each classified status with a machine-readable code', () => {
    expect(classifyApiError(401, '{}').code).toBe('unauthorized');
    expect(classifyApiError(403, 'Apps Script API has not been used in project 1 before').code).toBe('api-disabled');
    expect(classifyApiError(403, 'The caller does not have permission').code).toBe('access-denied');
    expect(classifyApiError(404, '{}').code).toBe('not-found');
    expect(classifyApiError(500, 'boom').code).toBe('api-error');
  });
});
