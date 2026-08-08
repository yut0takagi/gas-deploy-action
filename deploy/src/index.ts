import * as core from '@actions/core';
import { GasDeployError } from '@gas-deploy/core';
import { run } from './main.js';

// esbuild の cjs 出力はトップレベル await を扱えないため、必ず関数の中で await する。
void run().catch((error: unknown) => {
  if (error instanceof GasDeployError) {
    core.setFailed(error.format());
  } else {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
});
