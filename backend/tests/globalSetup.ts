import { execSync } from 'node:child_process';

const TEST_DB = 'postgresql://reachinbox:reachinbox@localhost:5432/reachinbox?schema=test';

/**
 * Syncs the isolated `test` schema (non-destructive). No data is wiped between runs:
 * every test creates its own user/sender/unique tags and asserts only on its own rows,
 * and the test queue is obliterated per test file.
 */
export default async function setup() {
  execSync('npx prisma db push --skip-generate', {
    stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: TEST_DB },
  });
}
