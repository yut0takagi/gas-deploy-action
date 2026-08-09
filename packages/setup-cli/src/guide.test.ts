import { GasDeployError, REQUESTED_SCOPES } from '@gas-deploy/core';
import { describe, expect, it, vi } from 'vitest';
import {
  accountTypeStep,
  consentScreenStep,
  enableApiStep,
  oauthClientStep,
  projectStep,
  promptAccountType,
  promptRequiredInput,
} from './guide.js';

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

/** vi.fn 版の promptInputImpl。渡した配列を順番に返し、尽きたら例外を投げる。 */
function scripted(answers: string[]) {
  const queue = [...answers];
  return vi.fn(async () => {
    if (queue.length === 0) throw new Error('scripted() called more times than answers provided');
    return queue.shift()!;
  });
}

describe('promptRequiredInput', () => {
  it('returns the value once a non-empty answer is given', async () => {
    const promptInputImpl = scripted(['value']);
    await expect(promptRequiredInput('Q: ', promptInputImpl)).resolves.toBe('value');
    expect(promptInputImpl).toHaveBeenCalledTimes(1);
  });

  it('re-prompts on an empty answer and returns the next valid one', async () => {
    const promptInputImpl = scripted(['', 'value']);
    await expect(promptRequiredInput('Q: ', promptInputImpl)).resolves.toBe('value');
    expect(promptInputImpl).toHaveBeenCalledTimes(2);
  });

  it('treats a whitespace-only answer as empty', async () => {
    const promptInputImpl = scripted(['   \t  ', 'value']);
    await expect(promptRequiredInput('Q: ', promptInputImpl)).resolves.toBe('value');
    expect(promptInputImpl).toHaveBeenCalledTimes(2);
  });

  it('throws a GasDeployError after three consecutive empty answers', async () => {
    const promptInputImpl = scripted(['', '', '']);
    await expect(promptRequiredInput('Q: ', promptInputImpl)).rejects.toThrow(GasDeployError);
    expect(promptInputImpl).toHaveBeenCalledTimes(3);
  });
});

describe('promptAccountType', () => {
  it('returns workspace for "1"', async () => {
    const promptInputImpl = scripted(['1']);
    await expect(promptAccountType(promptInputImpl)).resolves.toBe('workspace');
  });

  it('returns personal for "2"', async () => {
    const promptInputImpl = scripted(['2']);
    await expect(promptAccountType(promptInputImpl)).resolves.toBe('personal');
  });

  it('rejects "3" and re-prompts until a valid answer arrives', async () => {
    const promptInputImpl = scripted(['3', '2']);
    await expect(promptAccountType(promptInputImpl)).resolves.toBe('personal');
    expect(promptInputImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects an empty answer the same way as an invalid one', async () => {
    const promptInputImpl = scripted(['', '1']);
    await expect(promptAccountType(promptInputImpl)).resolves.toBe('workspace');
    expect(promptInputImpl).toHaveBeenCalledTimes(2);
  });

  it('throws a GasDeployError after three consecutive invalid answers', async () => {
    const promptInputImpl = scripted(['3', 'x', '']);
    await expect(promptAccountType(promptInputImpl)).rejects.toThrow(GasDeployError);
    expect(promptInputImpl).toHaveBeenCalledTimes(3);
  });
});
