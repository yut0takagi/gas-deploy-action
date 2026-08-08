import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['deploy/src/main.ts'],
  outfile: 'deploy/dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  legalComments: 'none',
});

console.log('built deploy/dist/index.js');
