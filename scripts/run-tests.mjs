import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const testsDirectory = fileURLToPath(new URL('../tests/', import.meta.url));
const requestedTestFiles = process.argv.slice(2);
const testFiles = (requestedTestFiles.length > 0
  ? requestedTestFiles.map((testFile) => path.resolve(testFile))
  : readdirSync(testsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.test.cjs'))
      .map((entry) => path.join(testsDirectory, entry.name)))
  .sort((left, right) => left.localeCompare(right, 'en'));

if (testFiles.length === 0) {
  console.error('[test] No tests/*.test.cjs files found.');
  process.exit(1);
}

for (const testFile of testFiles) {
  const result = spawnSync(process.execPath, ['--test', testFile], {
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`[test] Failed to start ${path.basename(testFile)}:`, result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
