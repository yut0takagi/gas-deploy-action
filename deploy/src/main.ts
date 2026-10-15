import * as core from '@actions/core';
import { authenticate, parseBooleanInput, parseProjectsInput, readConfigInput } from '@gas-deploy/action-io';
import {
  AppsScriptClient,
  GasDeployError,
  buildVersionDescription,
  deploy,
  deployAll,
  parseConfig,
  resolveTargets,
} from '@gas-deploy/core';
import { upsertComment } from './comment.js';
import { resolvePrCommentContext, resolveProvenanceSource } from './github-context.js';
import { buildDeploymentsOutput } from './outputs.js';
import { renderMultiSummary, renderSummary } from './summary.js';
import { buildDeployTargets, parseProjectType, resolveIgnorePatterns } from './targets.js';

/** 両モードに共通する、実行全体に効く入力。config には現れない。 */
interface RunOptions {
  dryRun: boolean;
  createVersion: boolean;
  allowDelete: boolean;
  commentOnPr: boolean;
  /** 由来情報を埋め込んだバージョンの説明。 */
  description: string;
}

/** 両モードに共通する入力を読む。ローカルで判定できる入力ミスを I/O の前に落とすため、認証より前に呼ぶ。 */
async function readRunOptions(): Promise<RunOptions> {
  const dryRun = parseBooleanInput('dry-run');
  const createVersion = parseBooleanInput('create-version');
  const allowDelete = parseBooleanInput('allow-delete');
  const commentOnPr = parseBooleanInput('comment-on-pr');
  const provenanceSource = await resolveProvenanceSource(process.env);
  const versionDescription = buildVersionDescription(provenanceSource, core.getInput('description'));
  for (const warning of versionDescription.warnings) {
    core.warning(warning);
  }
  return { dryRun, createVersion, allowDelete, commentOnPr, description: versionDescription.description };
}

/**
 * サマリを PR にコメントする。
 *
 * 失敗しても例外にしない。コメントは補助であり、成功した本番デプロイを赤い実行結果として
 * 報告すると、それを見て動くロールバック自動化や人間の判断を誤らせる。内容自体は
 * この時点で既にジョブサマリに書き出してあるので、コメントが出なくても失われない。
 */
async function commentIfRequested(enabled: boolean, summary: string, defaultKey: string): Promise<void> {
  if (!enabled) {
    return;
  }

  const token = core.getInput('github-token');
  if (!token) {
    core.warning('comment-on-pr が有効ですが github-token が空のため、コメントを投稿しません');
    return;
  }
  core.setSecret(token);

  const context = await resolvePrCommentContext(process.env);
  if (context === undefined) {
    core.info('PR の実行ではないため、コメントは投稿しません');
    return;
  }

  const key = core.getInput('comment-key') || defaultKey;
  try {
    const result = await upsertComment({ ...context, token }, key, summary);
    core.info(
      `PR #${context.prNumber} のコメントを${result.action === 'created' ? '作成' : '更新'}しました (id: ${result.id})`,
    );
  } catch (error) {
    core.warning(
      `PR へのコメントに失敗しました（デプロイ自体の結果は上記のとおりで、この失敗の影響を受けていません）: ${
        error instanceof GasDeployError ? error.format() : String(error)
      }`,
    );
  }
}

/** サマリを出力とジョブサマリに書き、求められていれば PR にもコメントする。 */
async function publishSummary(summary: string, commentOnPr: boolean, defaultCommentKey: string): Promise<void> {
  core.setOutput('summary', summary);
  await core.summary.addRaw(summary).write();
  await commentIfRequested(commentOnPr, summary, defaultCommentKey);
}

export async function run(): Promise<void> {
  // script-id が指定されていれば単一プロジェクトモード、無ければ config を使う
  // 複数プロジェクトモード。両者を混ぜると挙動が予測しづらくなるため、
  // script-id が有るときは config を一切読まない。
  const scriptId = core.getInput('script-id');
  if (scriptId) {
    await runSingleProject(scriptId);
    return;
  }
  await runMultiProject();
}

async function runSingleProject(scriptId: string): Promise<void> {
  // ネットワーク呼び出し（preflight / deploy）の前に、ローカルで検証できる入力を
  // すべて読み切って失敗させる。
  const rootDir = core.getInput('root-dir') || '.';
  const deploymentId = core.getInput('deployment-id');
  const projectType = parseProjectType(core.getInput('project-type') || 'standalone');
  const options = await readRunOptions();
  const ignore = await resolveIgnorePatterns(rootDir, core.getInput('ignore'));

  // 単一プロジェクトでは scriptIds を渡さない。deploy() が書き込みの前に必ず
  // getContent を呼ぶため、ここで projects.get を足しても得られる情報は同じで、
  // リクエストが1つ増えるだけになる。スコープの検証だけを先に済ませる。
  const accessToken = await authenticate();

  const result = await deploy(new AppsScriptClient(accessToken), {
    scriptId,
    rootDir,
    ignore,
    ...(deploymentId ? { deploymentId } : {}),
    projectType,
    dryRun: options.dryRun,
    createVersion: options.createVersion,
    allowDelete: options.allowDelete,
    description: options.description,
  });

  for (const warning of result.warnings) {
    core.warning(warning);
  }

  core.setOutput('changed', String(result.changed));
  core.setOutput('version-number', result.versionNumber ?? '');
  core.setOutput('previous-version-number', result.previousVersionNumber ?? '');
  core.setOutput('deployment-id', result.deploymentId ?? '');
  core.setOutput('web-app-url', result.webAppUrl ?? '');

  // 単一プロジェクトモードには環境という概念が無いため、既定のキーは固定。1つの
  // ワークフローで複数回実行する場合は comment-key で分ける必要がある。
  await publishSummary(renderSummary(result), options.commentOnPr, 'default');
}

async function runMultiProject(): Promise<void> {
  // environment はネットワーク呼び出しは元より、設定ファイルの読み込みより前に検証する。
  // 単一プロジェクトモードと同じく「ローカルで判定できる入力ミスは、I/O の前に落とす」順序。
  const environment = core.getInput('environment');
  if (!environment) {
    throw new GasDeployError('environment の指定が必要です（複数プロジェクトモードでは必須です）', {
      nextSteps: [
        'environment 入力に gasdeploy.yml で定義した環境名（例: prod, dev）を指定してください',
        '単一プロジェクトとしてデプロイする場合は script-id 入力を指定してください',
      ],
    });
  }

  const projects = parseProjectsInput(core.getInput('projects'));
  const config = parseConfig(await readConfigInput());
  const targets = resolveTargets(config, { environment, projects, env: process.env });

  const options = await readRunOptions();
  const deployTargets = await buildDeployTargets(targets, {
    ignoreInput: core.getInput('ignore'),
    dryRun: options.dryRun,
    createVersion: options.createVersion,
    allowDelete: options.allowDelete,
    description: options.description,
  });

  // 逐次デプロイなので、3件目で権限切れに気づくと1・2件目は既に置き換わった後になる。
  // 対象全件の読み取り権限をここでまとめて確認し、1件でも欠ければ何も書かずに止める。
  // 同じプロジェクトを複数の対象が指す構成がありうるため、重複は除いてから渡す。
  const scriptIds = [...new Set(targets.map((target) => target.scriptId))];
  const accessToken = await authenticate(scriptIds);
  core.info(`デプロイ前の確認: ${scriptIds.length} 件のプロジェクトの読み取り権限を確認しました`);

  const client = new AppsScriptClient(accessToken);
  const multiResult = await deployAll(client, deployTargets);

  // 完了したプロジェクトごとに警告を出す。10 プロジェクトの実行でどのプロジェクトの
  // 警告か分からなくならないよう、必ずプロジェクト名を前置する。
  for (const entry of multiResult.completed) {
    for (const warning of entry.result.warnings) {
      core.warning(`[${entry.project}] ${warning}`);
    }
  }

  core.setOutput('changed', String(multiResult.changed));
  core.setOutput('deployments', JSON.stringify(buildDeploymentsOutput(targets, multiResult)));

  // 既定のキーを environment にすることで、同じ PR に dev と prod のコメントが
  // 並んでも互いを上書きしない。
  await publishSummary(renderMultiSummary(multiResult, targets), options.commentOnPr, environment);

  // deployAll は例外を投げず、代わりに failed を返す。ここで明示的に setFailed する
  // ことで、赤い実行結果からどのプロジェクトが完了/未実行かをサマリで追える状態を保ったまま
  // ジョブを失敗として報告できる（先に throw すると、この関数はサマリの書き込みや出力の
  // 設定を終える前に打ち切られてしまう）。
  if (multiResult.failed) {
    core.setFailed(multiResult.failed.error.format());
  }
}
