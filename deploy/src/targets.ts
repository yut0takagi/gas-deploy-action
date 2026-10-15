import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_IGNORE,
  type DeployTarget,
  GasDeployError,
  PROJECT_TYPES,
  type ProjectType,
  type ResolvedTarget,
  isProjectType,
  parseClaspIgnore,
} from '@gas-deploy/core';

export function parseProjectType(raw: string): ProjectType {
  if (isProjectType(raw)) {
    return raw;
  }
  throw new GasDeployError(`project-type の値が不正です: ${raw}`, {
    nextSteps: [`次のいずれかを指定してください: ${PROJECT_TYPES.join(' | ')}`],
  });
}

export async function resolveIgnorePatterns(rootDir: string, rawInput: string): Promise<readonly string[]> {
  const fromInput = parseClaspIgnore(rawInput);
  if (fromInput.length > 0) {
    return fromInput;
  }
  try {
    return parseClaspIgnore(await readFile(join(rootDir, '.claspignore'), 'utf8'));
  } catch (error) {
    // ファイルが無いのは正常。既定値にフォールバックする。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return DEFAULT_IGNORE;
    }
    // 存在するのに読めない場合に黙って既定値へ落とすと、利用者が除外したつもりの
    // ファイルがデプロイされる。既定値は実際の .claspignore よりはるかに狭い。
    throw new GasDeployError('.claspignore を読み取れませんでした', {
      cause: error,
      nextSteps: [
        '.claspignore のパーミッションを確認してください',
        '.claspignore がディレクトリになっていないか確認してください',
        '意図的に除外設定を使わない場合は、.claspignore を削除するか ignore 入力を指定してください',
      ],
    });
  }
}

/**
 * ターゲットの `ignore` を解決する。`resolveTargets` はプロジェクトにも defaults にも
 * ignore が無いとき `[]` を返す。この空を「除外パターン無し」と早合点せず、単一プロジェクト
 * モードと同じ優先順位（ignore 入力 → .claspignore → DEFAULT_IGNORE）にフォールバックする
 * かどうかは、config を知らない core 側ではなくこのアダプタが決める。
 */
export async function resolveTargetIgnore(
  target: Pick<ResolvedTarget, 'ignore' | 'rootDir'>,
  ignoreInput: string,
): Promise<readonly string[]> {
  if (target.ignore.length > 0) {
    return target.ignore;
  }
  return resolveIgnorePatterns(target.rootDir, ignoreInput);
}

export interface GlobalDeployOptions {
  ignoreInput: string;
  dryRun: boolean;
  createVersion: boolean;
  description: string;
  allowDelete: boolean;
}

/**
 * `resolveTargets` が返す `ResolvedTarget`（プロジェクトごとの設定）に、dry-run /
 * create-version / description といった実行全体で共通の設定（config には現れない、
 * action 入力由来の値）を合成し、`deployAll` にそのまま渡せる形にする。
 */
export async function buildDeployTargets(
  targets: readonly ResolvedTarget[],
  options: GlobalDeployOptions,
): Promise<DeployTarget[]> {
  const result: DeployTarget[] = [];
  for (const target of targets) {
    const ignore = await resolveTargetIgnore(target, options.ignoreInput);
    result.push({
      ...target,
      ignore,
      dryRun: options.dryRun,
      createVersion: options.createVersion,
      description: options.description,
      allowDelete: options.allowDelete,
    });
  }
  return result;
}
