import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['deploy/src/index.ts'],
  // 拡張子は .cjs にすること。deploy/package.json に "type": "module" があるため、
  // .js のままだと Node が ESM として読み込み、CJS バンドル内の require が
  // "require is not defined in ES module scope" で落ちる。実ランナーでしか露見しない。
  outfile: 'deploy/dist/index.cjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  legalComments: 'none',
});

console.log('built deploy/dist/index.cjs');
