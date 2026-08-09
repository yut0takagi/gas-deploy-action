#!/usr/bin/env node
import { GasDeployError } from '@gas-deploy/core';
import { runSetup } from './run.js';

// トップレベル await は esbuild の cjs 出力で扱えないケースがあるため（deploy/src/index.ts と同様）、
// 必ず関数の中で await し、ここでは catch のみを行う。
void runSetup().catch((error: unknown) => {
  if (error instanceof GasDeployError) {
    console.error(error.format());
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
