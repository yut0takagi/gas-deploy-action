import { parse as parseYaml } from 'yaml';
import { GasDeployError } from './errors.js';
import type { ProjectType } from './types.js';

const VALID_PROJECT_TYPES: readonly ProjectType[] = ['webapp', 'addon', 'bound', 'standalone'];

export interface EnvironmentConfig {
  scriptId: string;
  deploymentId?: string;
}

export interface ProjectConfig {
  rootDir: string;
  type?: ProjectType;
  ignore?: readonly string[];
  environments: Record<string, EnvironmentConfig>;
}

export interface GasDeployConfig {
  version: 1;
  defaults?: { ignore?: readonly string[] };
  projects: Record<string, ProjectConfig>;
}

export interface ResolveTargetsOptions {
  environment: string;
  /** undefined または ['all'] は全プロジェクトを意味する。 */
  projects?: string[];
  env: Record<string, string | undefined>;
}

export interface ResolvedTarget {
  project: string;
  environment: string;
  scriptId: string;
  rootDir: string;
  ignore: readonly string[];
  projectType?: ProjectType;
  deploymentId?: string;
}

/** 検証エラーを「どこで」失敗したかを含む GasDeployError として送出する。 */
function fail(path: string, message: string, nextSteps: string[]): never {
  throw new GasDeployError(`${path}: ${message}`, { nextSteps });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    fail(path, '文字列の配列である必要があります', ['YAML のリスト形式（例: - "**/*.test.js"）で指定してください']);
  }
  return value.map((item, index) => {
    if (typeof item !== 'string') {
      fail(`${path}[${index}]`, '文字列である必要があります', ['配列の各要素を文字列にしてください']);
    }
    return item;
  });
}

/**
 * gasdeploy.yml のテキストを検証済みの GasDeployConfig にパースする。
 * ファイル読み込みや環境変数展開は行わない。呼び出し元が YAML テキストを渡す。
 */
export function parseConfig(yamlText: string): GasDeployConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new GasDeployError(`gasdeploy.yml の構文が不正です: ${detail}`, {
      cause,
      nextSteps: [
        'インデントやコロンの後ろのスペースなど、YAML の構文を確認してください',
        'エディタの YAML リンタでエラー箇所を確認してください',
      ],
    });
  }

  if (!isPlainObject(raw)) {
    fail('(root)', 'gasdeploy.yml のトップレベルはマップである必要があります', [
      'version, defaults, projects をキーに持つ YAML マップにしてください',
    ]);
  }

  const version = raw.version;
  if (version !== 1) {
    fail('version', `version は 1 である必要があります（実際の値: ${JSON.stringify(version)}）`, [
      'gasdeploy.yml に version: 1 を指定してください',
      'この Action がより新しい version をサポートしている場合は、README の案内に従って Action 自体をアップグレードしてください',
    ]);
  }

  let defaultIgnore: readonly string[] | undefined;
  const defaultsRaw = raw.defaults;
  if (defaultsRaw !== undefined) {
    if (!isPlainObject(defaultsRaw)) {
      fail('defaults', 'defaults はマップである必要があります', ['defaults.ignore を持つマップにしてください']);
    }
    if (defaultsRaw.ignore !== undefined) {
      defaultIgnore = parseStringArray(defaultsRaw.ignore, 'defaults.ignore');
    }
  }

  const projectsRaw = raw.projects;
  if (!isPlainObject(projectsRaw)) {
    fail('projects', 'projects はマップである必要があります', ['プロジェクト名をキーとするマップを定義してください']);
  }

  const projectNames = Object.keys(projectsRaw);
  if (projectNames.length === 0) {
    fail('projects', '少なくとも1つのプロジェクトを定義する必要があります', [
      'gasdeploy.yml に projects.<プロジェクト名> を1つ以上追加してください',
    ]);
  }

  const projects: Record<string, ProjectConfig> = {};
  for (const name of projectNames) {
    const projectPath = `projects.${name}`;
    const projectRaw = projectsRaw[name];
    if (!isPlainObject(projectRaw)) {
      fail(projectPath, 'プロジェクト定義はマップである必要があります', [
        'rootDir, type, ignore, environments を持つマップにしてください',
      ]);
    }

    const rootDirRaw = projectRaw.rootDir;
    if (typeof rootDirRaw !== 'string' || rootDirRaw.length === 0) {
      fail(`${projectPath}.rootDir`, 'rootDir は必須の文字列です', [
        'ビルド成果物のディレクトリを指定してください（例: apps/web-app/dist）',
      ]);
    }
    const rootDir = rootDirRaw;

    let type: ProjectType | undefined;
    if (projectRaw.type !== undefined) {
      const typeRaw = projectRaw.type;
      if (typeof typeRaw !== 'string' || !(VALID_PROJECT_TYPES as readonly string[]).includes(typeRaw)) {
        fail(
          `${projectPath}.type`,
          `次のいずれかである必要があります: ${VALID_PROJECT_TYPES.join(', ')}（実際の値: ${JSON.stringify(typeRaw)}）`,
          [`type には ${VALID_PROJECT_TYPES.join(' / ')} のいずれかを指定してください`],
        );
      }
      type = typeRaw as ProjectType;
    }

    let ignore: readonly string[] | undefined;
    if (projectRaw.ignore !== undefined) {
      ignore = parseStringArray(projectRaw.ignore, `${projectPath}.ignore`);
    }

    const environmentsRaw = projectRaw.environments;
    if (!isPlainObject(environmentsRaw)) {
      fail(`${projectPath}.environments`, 'environments はマップである必要があります', [
        'dev, prod などの環境名をキーとするマップを定義してください',
      ]);
    }
    const envNames = Object.keys(environmentsRaw);
    if (envNames.length === 0) {
      fail(`${projectPath}.environments`, '少なくとも1つの環境を定義する必要があります', [
        `${projectPath}.environments に dev や prod などの環境を1つ以上追加してください`,
      ]);
    }

    const environments: Record<string, EnvironmentConfig> = {};
    for (const envName of envNames) {
      const envPath = `${projectPath}.environments.${envName}`;
      const envRaw = environmentsRaw[envName];
      if (!isPlainObject(envRaw)) {
        fail(envPath, '環境定義はマップである必要があります', [
          'scriptId（必須）と deploymentId（任意）を持つマップにしてください',
        ]);
      }

      const scriptIdRaw = envRaw.scriptId;
      if (typeof scriptIdRaw !== 'string' || scriptIdRaw.length === 0) {
        fail(`${envPath}.scriptId`, 'scriptId は必須の文字列です', [
          'スクリプトエディタの「プロジェクトの設定」で scriptId を確認してください',
          '${VAR} 形式で環境変数から展開する場合、キー名の綴りが正しいか確認してください',
        ]);
      }

      let deploymentId: string | undefined;
      if (envRaw.deploymentId !== undefined) {
        const deploymentIdRaw = envRaw.deploymentId;
        if (typeof deploymentIdRaw !== 'string' || deploymentIdRaw.length === 0) {
          fail(`${envPath}.deploymentId`, '文字列である必要があります', [
            'deploymentId を指定する場合は文字列にしてください（不要なら省略してください）',
          ]);
        }
        deploymentId = deploymentIdRaw;
      }

      environments[envName] = deploymentId === undefined ? { scriptId: scriptIdRaw } : { scriptId: scriptIdRaw, deploymentId };
    }

    const projectConfig: ProjectConfig = { rootDir, environments };
    if (type !== undefined) projectConfig.type = type;
    if (ignore !== undefined) projectConfig.ignore = ignore;
    projects[name] = projectConfig;
  }

  const config: GasDeployConfig = { version: 1, projects };
  if (defaultIgnore !== undefined) config.defaults = { ignore: defaultIgnore };
  return config;
}

/**
 * `${NAME}` を env マップから展開する。
 *
 * エスケープ: `$$` はリテラルな `$` 1文字を出力する。したがって `$${NAME}` と書くと
 * `$` の後に展開対象でないプレーンテキスト `{NAME}` が続くことになり、結果として
 * 展開されない文字どおりの `${NAME}` が得られる。`${` を特別扱いするのではなく、
 * 「`$` そのものをエスケープする」という一段階シンプルなルールにすることで、
 * `${` 以外の並び（例: `$$$`）でも一貫した挙動になる。
 *
 * 未定義または空文字列の変数は必ずエラーにする。空の scriptId が API まで届いて
 * 分かりにくい 404 になる事故を、設定を読む時点で防ぐため。
 */
export function expandVariables(value: string, env: Record<string, string | undefined>): string {
  let result = '';
  let i = 0;
  while (i < value.length) {
    if (value[i] === '$' && value[i + 1] === '$') {
      result += '$';
      i += 2;
      continue;
    }

    if (value[i] === '$' && value[i + 1] === '{') {
      const end = value.indexOf('}', i + 2);
      if (end === -1) {
        throw new GasDeployError(`変数展開の構文が不正です（"}" が見つかりません）: ${value}`, {
          nextSteps: ['${NAME} の形式で閉じ括弧まで書いてください', 'リテラルの "${" が必要な場合は "$${" とエスケープしてください'],
        });
      }
      const name = value.slice(i + 2, end);
      const varValue = env[name];
      if (varValue === undefined || varValue === '') {
        throw new GasDeployError(`環境変数 ${name} が設定されていません（gasdeploy.yml で \${${name}} として参照されています）`, {
          nextSteps: [
            `${name} を GitHub Secrets またはワークフローの環境変数として設定してください`,
            'ジョブや Action への渡し方（env: / secrets:）が正しいか確認してください',
          ],
        });
      }
      result += varValue;
      i = end + 1;
      continue;
    }

    result += value[i];
    i += 1;
  }
  return result;
}

/**
 * 指定された environment / projects に対してデプロイ対象を解決する。
 *
 * - `projects` が未指定または `['all']` のときは全プロジェクトが対象。
 * - ある environment を持たないプロジェクトはスキップする（エラーにしない）。
 * - config 全体を見てもその environment を持つプロジェクトが1つも無ければエラー。
 * - 明示的に指定されたプロジェクト名が config に存在しなければエラー。
 * - 返す順序は `projects` オプションの並びではなく、常に gasdeploy.yml での宣言順。
 *   デプロイ順序はユーザーが YAML 内でのプロジェクトの並びによって制御する。
 */
export function resolveTargets(config: GasDeployConfig, options: ResolveTargetsOptions): ResolvedTarget[] {
  const allProjectNames = Object.keys(config.projects);
  const isAll = options.projects === undefined || (options.projects.length === 1 && options.projects[0] === 'all');

  let includedNames: readonly string[];
  if (isAll) {
    includedNames = allProjectNames;
  } else {
    const requested = options.projects ?? [];
    const unknown = requested.filter((name) => !allProjectNames.includes(name));
    if (unknown.length > 0) {
      throw new GasDeployError(`指定されたプロジェクトが見つかりません: ${unknown.join(', ')}`, {
        nextSteps: [
          `projects 入力のタイプミスがないか確認してください（有効なプロジェクト名: ${allProjectNames.join(', ')}）`,
          'all を指定するとすべてのプロジェクトが対象になります',
        ],
      });
    }
    includedNames = requested;
  }
  const includedSet = new Set(includedNames);

  // environment のタイプミスは config 全体を見て判定する。特定のプロジェクトにその
  // environment が無いだけなら Rule 1 によりスキップで済むが、config のどこにも
  // 存在しない environment はほぼ確実にタイプミスなので、常にエラーにする。
  const knownEnvironments = new Set<string>();
  for (const name of allProjectNames) {
    const project = config.projects[name];
    if (project === undefined) continue;
    for (const envName of Object.keys(project.environments)) {
      knownEnvironments.add(envName);
    }
  }
  if (!knownEnvironments.has(options.environment)) {
    throw new GasDeployError(`environment "${options.environment}" を定義しているプロジェクトがありません`, {
      nextSteps: [
        `environment 入力のタイプミスがないか確認してください（実在する環境: ${[...knownEnvironments].sort().join(', ')}）`,
        'gasdeploy.yml の該当プロジェクトに environments.<環境名> を追加してください',
      ],
    });
  }

  const targets: ResolvedTarget[] = [];
  for (const projectName of allProjectNames) {
    if (!includedSet.has(projectName)) continue;
    const project = config.projects[projectName];
    if (project === undefined) continue;

    const envConfig = project.environments[options.environment];
    if (envConfig === undefined) continue; // Rule 1: このプロジェクトは対象 environment を持たない → スキップ

    const ignore = project.ignore ?? config.defaults?.ignore ?? [];

    const target: ResolvedTarget = {
      project: projectName,
      environment: options.environment,
      scriptId: expandVariables(envConfig.scriptId, options.env),
      rootDir: expandVariables(project.rootDir, options.env),
      ignore,
    };
    if (project.type !== undefined) {
      target.projectType = project.type;
    }
    if (envConfig.deploymentId !== undefined) {
      target.deploymentId = expandVariables(envConfig.deploymentId, options.env);
    }
    targets.push(target);
  }

  return targets;
}
