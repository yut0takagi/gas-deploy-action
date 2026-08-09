import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // アクションを追加したらここにも追加すること。書いたテストが一度も実行されないまま
    // CI が緑になる（実際に rollback を追加した際に起きた）。
    include: [
      'packages/*/src/**/*.test.ts',
      'deploy/src/**/*.test.ts',
      'rollback/src/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    environment: 'node',
  },
});
