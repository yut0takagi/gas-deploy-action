import { REQUESTED_SCOPES } from '@gas-deploy/core';
import { describe, expect, it } from 'vitest';
import { accountTypeStep, consentScreenStep, enableApiStep, oauthClientStep, projectStep } from './guide.js';

const [SCOPE_PROJECTS, SCOPE_DEPLOYMENTS] = REQUESTED_SCOPES.split(' ');

describe('accountTypeStep', () => {
  it('asks the user to choose between Workspace and personal Gmail', () => {
    const text = accountTypeStep();
    expect(text).toContain('Workspace');
    expect(text).toContain('Gmail');
  });
});

describe('projectStep', () => {
  it('tells the user to create or choose a Google Cloud project', () => {
    const text = projectStep();
    expect(text).toContain('Google Cloud');
  });
});

describe('enableApiStep', () => {
  it('mentions the two places the Apps Script API must be enabled', () => {
    const text = enableApiStep();
    expect(text).toContain('https://script.google.com/home/usersettings');
    expect(text).toContain('Apps Script API');
    // 「2箇所」であることが伝わる文言を含む
    expect(text).toMatch(/2\s*(箇所|つ)/);
  });
});

describe('consentScreenStep', () => {
  it('includes the exact two requested scope URLs so the user can confirm the consent screen', () => {
    const workspaceText = consentScreenStep('workspace');
    const personalText = consentScreenStep('personal');
    for (const text of [workspaceText, personalText]) {
      expect(text).toContain(SCOPE_PROJECTS);
      expect(text).toContain(SCOPE_DEPLOYMENTS);
    }
  });

  it('warns that Testing status makes the refresh token expire after 7 days', () => {
    for (const accountType of ['workspace', 'personal'] as const) {
      const text = consentScreenStep(accountType);
      expect(text).toContain('7日');
      expect(text).toMatch(/テスト/);
    }
  });

  it('tells Workspace users to choose Internal', () => {
    const text = consentScreenStep('workspace');
    expect(text).toContain('内部');
    expect(text).toContain('Internal');
  });

  it('tells personal-account users to choose External and publish to Production', () => {
    const text = consentScreenStep('personal');
    expect(text).toContain('外部');
    expect(text).toContain('External');
    expect(text).toContain('本番');
    expect(text).toContain('Production');
  });

  it('honestly notes that the unverified-app warning for script.projects on personal accounts is unmeasured', () => {
    const text = consentScreenStep('personal');
    expect(text).toContain('未検証');
    expect(text).toContain('script.projects');
  });
});

describe('oauthClientStep', () => {
  it('instructs the user to create a Desktop app OAuth client', () => {
    const text = oauthClientStep();
    expect(text).toContain('Desktop');
    expect(text).toContain('クライアント ID');
    expect(text).toContain('クライアント シークレット');
  });
});
