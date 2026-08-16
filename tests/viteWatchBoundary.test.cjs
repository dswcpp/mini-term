const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const viteConfig = fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');

assert.match(
  styles,
  /@import\s+"tailwindcss"\s+source\(none\);/,
  'Tailwind must not auto-scan the repository root',
);

assert.match(
  styles,
  /@source\s+"\.";/,
  'Tailwind must explicitly scan only the src directory',
);

assert.match(
  viteConfig,
  /watch:\s*\{\s*ignored:\s*devWatchIgnored\s*\}/,
  'Vite dev server must use the shared devWatchIgnored list',
);

[
  '**/src-tauri/**',
  '**/.agents/**',
  '**/.claude/**',
  '**/.codex/**',
  '**/.qwen/**',
  '**/.run-logs/**',
  '**/.spec-workflow/**',
  '**/.tmp-tests/**',
  '**/.trellis/**',
  '**/dist/**',
].forEach((pattern) => {
  assert.ok(
    viteConfig.includes(`"${pattern}"`),
    `Vite dev watch ignore list is missing ${pattern}`,
  );
});
