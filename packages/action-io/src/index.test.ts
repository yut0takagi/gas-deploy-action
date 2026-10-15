import { GasDeployError } from '@gas-deploy/core';
import { afterEach, describe, expect, it } from 'vitest';
import { parseBooleanInput, parseProjectsInput } from './index.js';

describe('parseProjectsInput', () => {
  it('treats an empty value as every project', () => {
    expect(parseProjectsInput('')).toBeUndefined();
  });

  it('treats all as every project', () => {
    expect(parseProjectsInput(' all ')).toBeUndefined();
  });

  it('splits a comma separated list and trims each name', () => {
    expect(parseProjectsInput('web-app, sheet-tools ,other')).toEqual(['web-app', 'sheet-tools', 'other']);
  });

  it('drops empty entries produced by stray commas', () => {
    expect(parseProjectsInput('web-app,,sheet-tools,')).toEqual(['web-app', 'sheet-tools']);
  });
});

describe('parseBooleanInput', () => {
  // @actions/core は入力を INPUT_<名前の大文字> の環境変数から読む。
  const key = 'INPUT_DRY-RUN';

  afterEach(() => {
    delete process.env[key];
  });

  it('reads true and false', () => {
    process.env[key] = 'true';
    expect(parseBooleanInput('dry-run')).toBe(true);
    process.env[key] = 'false';
    expect(parseBooleanInput('dry-run')).toBe(false);
  });

  it('turns an unreadable value into a GasDeployError with next steps', () => {
    process.env[key] = 'yes please';
    const error = (() => {
      try {
        parseBooleanInput('dry-run');
      } catch (e) {
        return e;
      }
      return undefined;
    })() as GasDeployError;
    expect(error).toBeInstanceOf(GasDeployError);
    expect(error.message).toContain('dry-run');
    expect(error.nextSteps.length).toBeGreaterThan(0);
  });
});
