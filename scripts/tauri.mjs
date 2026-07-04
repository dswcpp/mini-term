// Tauri CLI 包装器：先按 dev/build 对应 profile staging sidecar，
// 再转交给 @tauri-apps/cli。
//
// 不能用 npm 的 `pretauri` 钩子：它无法可靠区分 `dev` 和 `build`，
// 本地 release bundle 容易混入 debug sidecar。

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const rawArgs = process.argv.slice(2);
const tauriCli = join('node_modules', '@tauri-apps', 'cli', 'tauri.js');
const stageScript = join('scripts', 'stage-sidecars.mjs');

function runNode(args) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return 1;
  }
  return result.status ?? 1;
}

function normalizeTauriArgs(args) {
  const normalized = args.filter((arg) => arg !== '--');

  if (normalized[0] !== 'build') {
    return { args: normalized, target: null };
  }

  let target = null;
  for (let i = 1; i < normalized.length; i += 1) {
    const arg = normalized[i];
    if (arg === '--target' && normalized[i + 1]) {
      target = normalized[i + 1];
      break;
    }
    if (arg.startsWith('--target=')) {
      target = arg.slice('--target='.length);
      break;
    }
  }

  // 有些 npm/PowerShell 组合会把 `--target` 当 npm config 吞掉，只留下
  // target triple 作为位置参数。这里兼容这种常见形态。
  if (!target && normalized[1] && !normalized[1].startsWith('-') && normalized[1].includes('-')) {
    target = normalized[1];
    normalized.splice(1, 1, '--target', target);
  }

  return { args: normalized, target };
}

const { args: tauriArgs, target } = normalizeTauriArgs(rawArgs);
const command = tauriArgs[0];
const metadataOnly = tauriArgs.some((arg) =>
  arg === '--help' || arg === '-h' || arg === '--version' || arg === '-V'
);

if (!metadataOnly && command === 'dev') {
  const status = runNode([stageScript]);
  if (status !== 0) process.exit(status);
} else if (!metadataOnly && command === 'build') {
  const stageArgs = [stageScript, '--release'];
  if (target) stageArgs.push('--target', target);
  const status = runNode(stageArgs);
  if (status !== 0) process.exit(status);
}

process.exit(runNode([tauriCli, ...tauriArgs]));
