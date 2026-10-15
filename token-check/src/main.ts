import * as core from '@actions/core';
import { parseBooleanInput, readCredentials } from '@gas-deploy/action-io';
import { type TokenHealth, checkTokenHealth } from '@gas-deploy/core';
import { renderTokenHealthSummary } from './summary.js';

export interface OutcomeOptions {
  failOnInvalid: boolean;
  failOnUnknown: boolean;
}

export interface Outcome {
  level: 'none' | 'warning' | 'failure';
  message: string;
}

/**
 * 判定をジョブの結果に写す。
 *
 * 既定では `unknown` でジョブを落とさない。到達できなかっただけで週次ジョブが赤くなると、
 * 本当に失効したときの赤が「またいつもの失敗」として埋もれる。監視の価値は赤の希少性にある。
 */
export function decideOutcome(health: TokenHealth, options: OutcomeOptions): Outcome {
  if (health.status === 'valid') {
    return { level: 'none', message: health.message };
  }

  const message = `${health.message}（理由: ${health.reason}）`;
  const shouldFail = health.status === 'invalid' ? options.failOnInvalid : options.failOnUnknown;
  return { level: shouldFail ? 'failure' : 'warning', message };
}

export async function run(): Promise<void> {
  // ネットワーク呼び出しの前に、ローカルで判定できる入力をすべて読み切って失敗させる。
  const failOnInvalid = parseBooleanInput('fail-on-invalid');
  const failOnUnknown = parseBooleanInput('fail-on-unknown');
  const scriptId = core.getInput('script-id');

  const credentials = readCredentials();

  // アクセストークンは core の内部で使われるだけで、ここには返らない。マスクする対象が
  // そもそも露出しないため、deploy / rollback のような setSecret は不要。
  const health = await checkTokenHealth({
    credentials,
    ...(scriptId ? { scriptId } : {}),
  });

  const summary = renderTokenHealthSummary(health);
  core.setOutput('status', health.status);
  core.setOutput('reason', health.reason);
  core.setOutput('project-checked', String(health.projectChecked));
  core.setOutput('summary', summary);

  await core.summary.addRaw(summary).write();

  const outcome = decideOutcome(health, { failOnInvalid, failOnUnknown });
  if (outcome.level === 'failure') {
    core.setFailed(outcome.message);
  } else if (outcome.level === 'warning') {
    core.warning(outcome.message);
  }
}
