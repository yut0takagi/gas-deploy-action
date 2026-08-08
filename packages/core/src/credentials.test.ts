import { describe, expect, it } from 'vitest';
import { parseCredentials } from './credentials.js';
import { GasDeployError } from './errors.js';

const EXPECTED = {
  clientId: 'cid.apps.googleusercontent.com',
  clientSecret: 'secret-value',
  refreshToken: 'refresh-value',
};

describe('parseCredentials', () => {
  it('accepts the minimal snake_case format', () => {
    const raw = JSON.stringify({
      client_id: 'cid.apps.googleusercontent.com',
      client_secret: 'secret-value',
      refresh_token: 'refresh-value',
    });
    expect(parseCredentials(raw)).toEqual(EXPECTED);
  });

  it('accepts the clasp v2 .clasprc.json format', () => {
    const raw = JSON.stringify({
      token: {
        access_token: 'ignored-access-token',
        refresh_token: 'refresh-value',
        expiry_date: 1234567890,
      },
      oauth2ClientSettings: {
        clientId: 'cid.apps.googleusercontent.com',
        clientSecret: 'secret-value',
        redirectUri: 'http://localhost',
      },
      isLocalCreds: false,
    });
    expect(parseCredentials(raw)).toEqual(EXPECTED);
  });

  it('accepts a nested per-user format such as clasp v3 uses', () => {
    const raw = JSON.stringify({
      tokens: {
        default: {
          type: 'authorized_user',
          client_id: 'cid.apps.googleusercontent.com',
          client_secret: 'secret-value',
          refresh_token: 'refresh-value',
        },
      },
    });
    expect(parseCredentials(raw)).toEqual(EXPECTED);
  });

  it('never returns the access token even when one is present', () => {
    const raw = JSON.stringify({
      token: { access_token: 'ignored-access-token', refresh_token: 'refresh-value' },
      oauth2ClientSettings: { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'secret-value' },
    });
    expect(JSON.stringify(parseCredentials(raw))).not.toContain('ignored-access-token');
  });

  it('throws a guided error on malformed JSON', () => {
    expect(() => parseCredentials('not json')).toThrowError(GasDeployError);
  });

  it('does not carry the malformed input into the error cause', () => {
    const secret = 'SUPER-SECRET-NOT-JSON';
    const err = (() => {
      try {
        parseCredentials(secret);
        return undefined;
      } catch (e) {
        return e as GasDeployError;
      }
    })();
    expect(err).toBeInstanceOf(GasDeployError);
    expect(err!.cause).toBeUndefined();
  });

  it('prefers the default account when the file holds several', () => {
    const raw = JSON.stringify({
      tokens: {
        cyberagent: {
          client_id: 'wrong-id',
          client_secret: 'wrong-secret',
          refresh_token: 'wrong-refresh',
        },
        default: {
          client_id: 'cid.apps.googleusercontent.com',
          client_secret: 'secret-value',
          refresh_token: 'refresh-value',
        },
      },
    });
    expect(parseCredentials(raw)).toEqual(EXPECTED);
  });

  it('refuses to guess when several accounts exist and none is default', () => {
    const raw = JSON.stringify({
      tokens: {
        alice: { client_id: 'a', client_secret: 'b', refresh_token: 'c' },
        bob: { client_id: 'd', client_secret: 'e', refresh_token: 'f' },
      },
    });
    const err = (() => {
      try {
        parseCredentials(raw);
        return undefined;
      } catch (e) {
        return e as GasDeployError;
      }
    })();
    expect(err).toBeInstanceOf(GasDeployError);
    expect(err!.nextSteps.join('\n')).toContain('alice');
    expect(err!.nextSteps.join('\n')).toContain('bob');
  });

  it('masks email-shaped account keys in the ambiguity error', () => {
    const raw = JSON.stringify({
      tokens: {
        'someone@example.com': { client_id: 'a', client_secret: 'b', refresh_token: 'c' },
        'other@example.com': { client_id: 'd', client_secret: 'e', refresh_token: 'f' },
      },
    });
    const err = (() => {
      try {
        parseCredentials(raw);
        return undefined;
      } catch (e) {
        return e as GasDeployError;
      }
    })();
    expect(err!.nextSteps.join('\n')).not.toContain('example.com');
    expect(err!.nextSteps.join('\n')).toContain('<メールアドレス>');
  });

  it('lists the supported shapes when nothing matches', () => {
    const err = (() => {
      try {
        parseCredentials(JSON.stringify({ unrelated: true }));
        return undefined;
      } catch (e) {
        return e as GasDeployError;
      }
    })();
    expect(err).toBeInstanceOf(GasDeployError);
    expect(err!.nextSteps.join('\n')).toContain('.clasprc.json');
  });
});
