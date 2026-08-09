import { describe, expect, it } from 'vitest';
import { expandVariables, parseConfig, resolveTargets } from './config.js';
import { GasDeployError } from './errors.js';

const FULL_VALID_YAML = `
version: 1

defaults:
  ignore:
    - "**/*.test.js"
    - "node_modules/**"

projects:
  web-app:
    rootDir: apps/web-app/dist
    type: webapp
    environments:
      dev:
        scriptId: \${DEV_WEBAPP_SCRIPT_ID}
      prod:
        scriptId: \${PROD_WEBAPP_SCRIPT_ID}
        deploymentId: \${PROD_WEBAPP_DEPLOYMENT_ID}

  sheet-tools:
    rootDir: apps/sheet-tools/dist
    type: bound
    environments:
      prod:
        scriptId: \${SHEET_TOOLS_SCRIPT_ID}
`;

const FULL_ENV = {
  DEV_WEBAPP_SCRIPT_ID: 'dev-webapp-script-id',
  PROD_WEBAPP_SCRIPT_ID: 'prod-webapp-script-id',
  PROD_WEBAPP_DEPLOYMENT_ID: 'prod-webapp-deployment-id',
  SHEET_TOOLS_SCRIPT_ID: 'sheet-tools-script-id',
};

describe('parseConfig', () => {
  it('parses a full valid config', () => {
    const config = parseConfig(FULL_VALID_YAML);
    expect(config.version).toBe(1);
    expect(config.defaults?.ignore).toEqual(['**/*.test.js', 'node_modules/**']);
    expect(Object.keys(config.projects)).toEqual(['web-app', 'sheet-tools']);
    expect(config.projects['web-app']?.rootDir).toBe('apps/web-app/dist');
    expect(config.projects['web-app']?.type).toBe('webapp');
    expect(config.projects['web-app']?.environments.dev?.scriptId).toBe('${DEV_WEBAPP_SCRIPT_ID}');
    expect(config.projects['web-app']?.environments.prod?.deploymentId).toBe('${PROD_WEBAPP_DEPLOYMENT_ID}');
  });

  it('rejects malformed YAML with a GasDeployError mentioning where', () => {
    const malformed = 'version: 1\nprojects:\n  web-app: [unterminated\n';
    let error: unknown;
    try {
      parseConfig(malformed);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GasDeployError);
    const gasError = error as GasDeployError;
    // yaml パーサーの行/列情報が含まれ、どこで壊れているか分かること
    expect(gasError.message).toMatch(/line \d+/);
  });

  it('rejects version 2 with a GasDeployError', () => {
    const yaml = `
version: 2
projects:
  web-app:
    rootDir: apps/web-app/dist
    environments:
      prod:
        scriptId: abc123
`;
    let error: unknown;
    try {
      parseConfig(yaml);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GasDeployError);
    expect((error as GasDeployError).message).toContain('version');
  });

  it('rejects a missing scriptId, naming the path', () => {
    const yaml = `
version: 1
projects:
  web-app:
    rootDir: apps/web-app/dist
    environments:
      prod: {}
`;
    let error: unknown;
    try {
      parseConfig(yaml);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GasDeployError);
    expect((error as GasDeployError).message).toContain('projects.web-app.environments.prod.scriptId');
  });

  it('rejects an invalid type, listing valid values', () => {
    const yaml = `
version: 1
projects:
  web-app:
    rootDir: apps/web-app/dist
    type: not-a-real-type
    environments:
      prod:
        scriptId: abc123
`;
    let error: unknown;
    try {
      parseConfig(yaml);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GasDeployError);
    const message = (error as GasDeployError).message;
    expect(message).toContain('projects.web-app.type');
    for (const validType of ['webapp', 'addon', 'bound', 'standalone']) {
      expect(message).toContain(validType);
    }
  });

  it('rejects a non-1 version even when omitted entirely', () => {
    const yaml = `
projects:
  web-app:
    rootDir: apps/web-app/dist
    environments:
      prod:
        scriptId: abc123
`;
    expect(() => parseConfig(yaml)).toThrow(GasDeployError);
  });

  it('rejects an empty projects map', () => {
    const yaml = `
version: 1
projects: {}
`;
    let error: unknown;
    try {
      parseConfig(yaml);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GasDeployError);
    expect((error as GasDeployError).message).toContain('projects');
  });

  it('rejects a missing rootDir, naming the path', () => {
    const yaml = `
version: 1
projects:
  web-app:
    environments:
      prod:
        scriptId: abc123
`;
    let error: unknown;
    try {
      parseConfig(yaml);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GasDeployError);
    expect((error as GasDeployError).message).toContain('projects.web-app.rootDir');
  });
});

describe('expandVariables', () => {
  it('expands ${NAME} from the supplied env map', () => {
    expect(expandVariables('${FOO}', { FOO: 'bar' })).toBe('bar');
    expect(expandVariables('prefix-${FOO}-suffix', { FOO: 'bar' })).toBe('prefix-bar-suffix');
  });

  it('leaves text outside ${...} untouched', () => {
    expect(expandVariables('plain text, no vars', {})).toBe('plain text, no vars');
  });

  it('throws a GasDeployError naming the variable when it is undefined', () => {
    let error: unknown;
    try {
      expandVariables('${MISSING_VAR}', {});
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GasDeployError);
    expect((error as GasDeployError).message).toContain('MISSING_VAR');
  });

  it('treats an empty-string variable as missing', () => {
    let error: unknown;
    try {
      expandVariables('${EMPTY_VAR}', { EMPTY_VAR: '' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GasDeployError);
    expect((error as GasDeployError).message).toContain('EMPTY_VAR');
  });

  it('supports $$ escaping so a literal ${ is expressible', () => {
    // $$ は 1 文字の $ を出力する。したがって $${NAME} は "$" + "{NAME}"（プレーンテキスト）となり、
    // 展開されない文字どおりの "${NAME}" が得られる。
    expect(expandVariables('$${NAME}', {})).toBe('${NAME}');
    expect(expandVariables('price: $$5', {})).toBe('price: $5');
  });
});

describe('resolveTargets', () => {
  const config = parseConfig(FULL_VALID_YAML);

  it('resolves prod to targets in config order with the right fields', () => {
    const targets = resolveTargets(config, { environment: 'prod', projects: undefined, env: FULL_ENV });
    expect(targets).toEqual([
      {
        project: 'web-app',
        environment: 'prod',
        scriptId: 'prod-webapp-script-id',
        rootDir: 'apps/web-app/dist',
        ignore: ['**/*.test.js', 'node_modules/**'],
        projectType: 'webapp',
        deploymentId: 'prod-webapp-deployment-id',
      },
      {
        project: 'sheet-tools',
        environment: 'prod',
        scriptId: 'sheet-tools-script-id',
        rootDir: 'apps/sheet-tools/dist',
        ignore: ['**/*.test.js', 'node_modules/**'],
        projectType: 'bound',
      },
    ]);
  });

  it('skips a project that has no dev environment', () => {
    const targets = resolveTargets(config, { environment: 'dev', projects: undefined, env: FULL_ENV });
    expect(targets).toHaveLength(1);
    expect(targets[0]?.project).toBe('web-app');
  });

  it('treats projects: ["all"] the same as undefined', () => {
    const withUndefined = resolveTargets(config, { environment: 'prod', projects: undefined, env: FULL_ENV });
    const withAll = resolveTargets(config, { environment: 'prod', projects: ['all'], env: FULL_ENV });
    expect(withAll).toEqual(withUndefined);
  });

  it('throws a GasDeployError listing real environments when none defines the requested one', () => {
    let error: unknown;
    try {
      resolveTargets(config, { environment: 'staging', projects: undefined, env: FULL_ENV });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GasDeployError);
    const message = (error as GasDeployError).message;
    expect(message).toContain('staging');
    const err = error as GasDeployError;
    expect(err.nextSteps.join('\n')).toContain('dev');
    expect(err.nextSteps.join('\n')).toContain('prod');
  });

  it('throws a GasDeployError listing valid names when an explicitly requested project does not exist', () => {
    let error: unknown;
    try {
      resolveTargets(config, { environment: 'prod', projects: ['does-not-exist'], env: FULL_ENV });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GasDeployError);
    const message = (error as GasDeployError).message;
    expect(message).toContain('does-not-exist');
    const err = error as GasDeployError;
    expect(err.nextSteps.join('\n')).toContain('web-app');
    expect(err.nextSteps.join('\n')).toContain('sheet-tools');
  });

  it('replaces defaults.ignore with a project-level ignore rather than concatenating', () => {
    const yaml = `
version: 1

defaults:
  ignore:
    - "**/*.test.js"

projects:
  web-app:
    rootDir: apps/web-app/dist
    ignore:
      - "**/*.spec.js"
    environments:
      prod:
        scriptId: abc123
`;
    const cfg = parseConfig(yaml);
    const targets = resolveTargets(cfg, { environment: 'prod', projects: undefined, env: {} });
    expect(targets[0]?.ignore).toEqual(['**/*.spec.js']);
    expect(targets[0]?.ignore).not.toContain('**/*.test.js');
  });

  it('falls back to defaults.ignore when a project has no ignore of its own', () => {
    const yaml = `
version: 1

defaults:
  ignore:
    - "**/*.test.js"

projects:
  web-app:
    rootDir: apps/web-app/dist
    environments:
      prod:
        scriptId: abc123
`;
    const cfg = parseConfig(yaml);
    const targets = resolveTargets(cfg, { environment: 'prod', projects: undefined, env: {} });
    expect(targets[0]?.ignore).toEqual(['**/*.test.js']);
  });

  it('returns an empty ignore array when neither project nor defaults specify one', () => {
    const yaml = `
version: 1
projects:
  web-app:
    rootDir: apps/web-app/dist
    environments:
      prod:
        scriptId: abc123
`;
    const cfg = parseConfig(yaml);
    const targets = resolveTargets(cfg, { environment: 'prod', projects: undefined, env: {} });
    expect(targets[0]?.ignore).toEqual([]);
  });

  it('throws naming the variable when scriptId expansion is missing a var', () => {
    let error: unknown;
    try {
      resolveTargets(config, { environment: 'prod', projects: undefined, env: {} });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GasDeployError);
    expect((error as GasDeployError).message).toContain('PROD_WEBAPP_SCRIPT_ID');
  });
});
