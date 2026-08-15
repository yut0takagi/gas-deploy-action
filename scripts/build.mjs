import * as esbuild from 'esbuild';

// 拡張子は .cjs にすること。各アクションの package.json に "type": "module" があるため、
// .js のままだと Node が ESM として読み込み、CJS バンドル内の require が
// "require is not defined in ES module scope" で落ちる。実ランナーでしか露見しない。
const ACTIONS = [
  { entry: 'deploy/src/index.ts', outfile: 'deploy/dist/index.cjs' },
  { entry: 'rollback/src/index.ts', outfile: 'rollback/dist/index.cjs' },
  { entry: 'token-check/src/index.ts', outfile: 'token-check/dist/index.cjs' },
  { entry: 'status/src/index.ts', outfile: 'status/dist/index.cjs' },
];

for (const { entry, outfile } of ACTIONS) {
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    legalComments: 'none',
  });
  console.log(`built ${outfile}`);
}
