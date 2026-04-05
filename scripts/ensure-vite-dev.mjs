import { spawn } from 'node:child_process';
import process from 'node:process';

const DEV_URL = 'http://localhost:1420';
const EXPECTED_MARKERS = ['<title>Mini-Term</title>', '/src/main.tsx'];

async function probeExistingDevServer() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);

  try {
    const response = await fetch(DEV_URL, { signal: controller.signal });
    const html = await response.text();
    const matchesProject = EXPECTED_MARKERS.every((marker) => html.includes(marker));

    return {
      reachable: response.ok,
      matchesProject,
    };
  } catch {
    return {
      reachable: false,
      matchesProject: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

const existingServer = await probeExistingDevServer();

if (existingServer.matchesProject) {
  console.log(`[mini-term] Reusing existing Vite dev server at ${DEV_URL}.`);
  process.exit(0);
}

if (existingServer.reachable) {
  console.error(
    `[mini-term] Port 1420 is already serving another app. Stop that process or change the dev port before running Tauri dev.`,
  );
  process.exit(1);
}

const cwd = process.cwd().startsWith('\\\\?\\')
  ? process.cwd().slice(4)
  : process.cwd();

const child = process.platform === 'win32'
  ? spawn(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', 'npm run dev'],
      {
        stdio: 'inherit',
        env: process.env,
        cwd,
      },
    )
  : spawn('npm', ['run', 'dev'], {
      stdio: 'inherit',
      env: process.env,
      cwd,
    });

const forwardSignal = (signal) => {
  if (!child.killed) {
    child.kill(signal);
  }
};

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
