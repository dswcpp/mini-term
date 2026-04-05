import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const WAIT_TIMEOUT_MS = 30_000;
const TASK_START_ATTEMPTS = process.platform === 'win32' ? 6 : 3;

function repoRoot() {
  return process.cwd();
}

function tauriManifestPath() {
  return path.join(repoRoot(), 'src-tauri', 'Cargo.toml');
}

function binaryFileName(binaryName) {
  return process.platform === 'win32' ? `${binaryName}.exe` : binaryName;
}

function resolveCommand(command) {
  if (process.platform === 'win32' && !path.extname(command)) {
    return `${command}.exe`;
  }
  return command;
}

function runOrThrow(command, args, options = {}) {
  const result = spawnSync(resolveCommand(command), args, {
    cwd: repoRoot(),
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(' ')}`,
        result.error ? String(result.error) : '',
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  return result;
}

function ensureMcpBinary() {
  const cargoTargetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-term-mcp-target-'));
  runOrThrow(
    'cargo',
    ['build', '--manifest-path', tauriManifestPath(), '--bin', 'mini-term-mcp'],
    {
      env: {
        ...process.env,
        CARGO_TARGET_DIR: cargoTargetDir,
      },
    },
  );
  const builtBinaryPath = path.join(cargoTargetDir, 'debug', binaryFileName('mini-term-mcp'));
  assert.ok(fs.existsSync(builtBinaryPath), `missing MCP binary: ${builtBinaryPath}`);
  return builtBinaryPath;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeLines(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function encodeProjectPath(projectPath) {
  return projectPath.replace(/[:\\/]/g, '-');
}

function createRuntimeState(workspaceRoot, hostControl) {
  const now = Date.now();
  return {
    schemaVersion: 1,
    updatedAt: now,
    host: {
      appVersion: '0.2.3',
      desktopPid: 43210,
      transportMode: 'app-data-snapshot',
      lastHeartbeatAt: now,
      ...(hostControl
        ? {
            hostControl: {
              baseUrl: hostControl.baseUrl,
              token: hostControl.token,
              capabilities: hostControl.capabilities,
            },
          }
        : {}),
    },
    ptys: [
      {
        ptyId: 5,
        sessionId: 'runtime-session-5',
        shell: 'powershell',
        shellKind: 'powershell',
        cwd: workspaceRoot,
        rootPath: workspaceRoot,
        mode: 'human',
        phase: 'running',
        status: 'running',
        lastOutputAt: now - 500,
        outputPreview: 'tail-preview-xyz',
        outputTail: 'tail-preview-xyz',
        startupOutput: '',
        cols: 120,
        rows: 32,
        rootPid: null,
        createdAt: now - 5_000,
        updatedAt: now - 250,
        exitCode: null,
      },
      {
        ptyId: 8,
        sessionId: 'runtime-session-8',
        shell: 'cmd',
        shellKind: 'cmd',
        cwd: workspaceRoot,
        rootPath: workspaceRoot,
        mode: 'agent',
        phase: 'exited',
        status: 'exited',
        lastOutputAt: now - 1_000,
        outputPreview: 'agent done',
        outputTail: 'agent done',
        startupOutput: '',
        cols: 120,
        rows: 32,
        rootPid: null,
        createdAt: now - 9_000,
        updatedAt: now - 700,
        exitCode: 0,
      },
    ],
    watchers: [
      {
        watchPath: workspaceRoot,
        projectPath: workspaceRoot,
        recursive: true,
        updatedAt: now - 300,
      },
    ],
    recentEvents: [
      {
        eventId: 'evt-1',
        kind: 'pty-session-created',
        timestamp: now - 4_000,
        summary: 'PTY 5 created',
        payloadPreview: { ptyId: 5 },
      },
      {
        eventId: 'evt-2',
        kind: 'pty-output',
        timestamp: now - 2_000,
        summary: 'PTY 5 emitted output',
        payloadPreview: { ptyId: 5, preview: 'abc' },
      },
      {
        eventId: 'evt-3',
        kind: 'fs-change',
        timestamp: now - 1_000,
        summary: 'workspace file changed',
        payloadPreview: {
          projectPath: workspaceRoot,
          path: path.join(workspaceRoot, 'README.md'),
          kind: 'Modify',
        },
      },
    ],
  };
}

async function startMockHostControlServer(workspaceRoot) {
  const token = 'mock-host-token';
  const capabilities = ['pty-control', 'runtime-observation-detail', 'ui-control'];
  const requests = [];
  let nextPtyId = 90;
  let nextTabId = 1;
  let nextPaneId = 1;
  const sendJson = (res, statusCode, value) => {
    const payload = JSON.stringify(value);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      Connection: 'close',
    });
    res.end(payload);
  };

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/host-control') {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }

    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const envelope = JSON.parse(body || '{}');
        requests.push({
          action: envelope.action,
          payload: envelope.payload,
        });
        let data;
        switch (envelope.action) {
          case 'get_pty_detail':
            data = {
              ptyId: envelope.payload.ptyId,
              cwd: workspaceRoot,
              shell: 'powershell',
              shellKind: 'powershell',
              status: 'running',
              phase: 'running',
              cols: 120,
              rows: 32,
              rootPid: 5010,
            };
            break;
          case 'get_process_tree':
            data = {
              root: {
                pid: 5010,
                parentPid: null,
                name: 'powershell.exe',
                exe: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
                commandLine: 'powershell',
                alive: true,
                children: [
                  {
                    pid: 5011,
                    parentPid: 5010,
                    name: 'node.exe',
                    exe: 'C:/Program Files/nodejs/node.exe',
                    commandLine: 'node child.js',
                    alive: true,
                    children: [],
                  },
                ],
              },
            };
            break;
          case 'create_pty':
            nextPtyId += 1;
            data = {
              ptyId: nextPtyId,
              sessionId: `mock-pty-${nextPtyId}`,
              cwd: envelope.payload.cwd,
              shell: envelope.payload.shell,
              status: 'running',
            };
            break;
          case 'write_pty':
            data = { ok: true, echoed: envelope.payload.data, ptyId: envelope.payload.ptyId };
            break;
          case 'resize_pty':
            data = {
              ok: true,
              ptyId: envelope.payload.ptyId,
              cols: envelope.payload.cols,
              rows: envelope.payload.rows,
            };
            break;
          case 'kill_pty':
            data = { ok: true, ptyId: envelope.payload.ptyId, status: 'killed' };
            break;
          case 'focus_workspace':
            data = { ok: true, workspaceId: envelope.payload.workspaceId };
            break;
          case 'create_tab': {
            const tabId = `tab-${nextTabId++}`;
            const paneId = `pane-${nextPaneId++}`;
            data = { ok: true, tabId, paneId, cwd: envelope.payload.cwd };
            break;
          }
          case 'close_tab':
            data = { ok: true, workspaceId: envelope.payload.workspaceId, tabId: envelope.payload.tabId };
            break;
          case 'split_pane':
            data = {
              ok: true,
              tabId: envelope.payload.tabId,
              paneId: `pane-${nextPaneId++}`,
              direction: envelope.payload.direction,
            };
            break;
          case 'notify_user':
            data = { ok: true, message: envelope.payload.message, tone: envelope.payload.tone ?? 'info' };
            break;
          default:
            data = { ok: true, action: envelope.action, payload: envelope.payload };
            break;
        }
        sendJson(res, 200, { ok: true, data });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'mock host control must bind to a TCP port');

  return {
    baseUrl: `http://127.0.0.1:${address.port}/host-control`,
    token,
    capabilities,
    requests,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}

function createConfig(workspaceRoot) {
  return {
    workspaces: [
      {
        id: 'workspace-1',
        name: 'mini-term-smoke',
        roots: [
          {
            id: 'root-1',
            name: 'mini-term-smoke',
            path: workspaceRoot,
            role: 'primary',
          },
        ],
        pinned: true,
        createdAt: 1,
        lastOpenedAt: 1,
        expandedDirsByRoot: {},
      },
    ],
    recentWorkspaces: [],
    lastWorkspaceId: 'workspace-1',
    defaultShell: 'powershell',
    availableShells: [
      { name: 'powershell', command: 'powershell' },
      { name: 'cmd', command: 'cmd' },
    ],
    uiFontSize: 13,
    terminalFontSize: 14,
    theme: { preset: 'warm-carbon', windowEffect: 'auto' },
  };
}

function setupWorkspace(root) {
  const dataDir = path.join(root, 'data');
  const homeDir = path.join(root, 'home');
  const workspaceRoot = path.join(root, 'workspace');
  fs.mkdirSync(workspaceRoot, { recursive: true });

  fs.writeFileSync(path.join(workspaceRoot, 'AGENTS.md'), 'workspace instructions\n');
  fs.writeFileSync(path.join(workspaceRoot, 'README.md'), 'Mini-Term workspace readme\nneedle token\n');
  fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'src', 'review.txt'), 'line one\nline two\n');
  fs.writeFileSync(path.join(workspaceRoot, 'notes.txt'), 'Needle in a haystack\n');

  runOrThrow('git', ['init'], { cwd: workspaceRoot });
  runOrThrow('git', ['config', 'user.email', 'mcp-smoke@example.com'], { cwd: workspaceRoot });
  runOrThrow('git', ['config', 'user.name', 'Mini-Term MCP Smoke'], { cwd: workspaceRoot });
  runOrThrow('git', ['add', '.'], { cwd: workspaceRoot });
  runOrThrow('git', ['commit', '-m', 'initial'], { cwd: workspaceRoot });
  fs.writeFileSync(path.join(workspaceRoot, 'src', 'review.txt'), 'line one\nline two changed\nline three\n');

  writeJson(path.join(dataDir, 'config.json'), createConfig(workspaceRoot));
  writeJson(path.join(dataDir, 'runtime_mcp_state.json'), createRuntimeState(workspaceRoot));

  writeLines(
    path.join(homeDir, '.claude', 'projects', encodeProjectPath(workspaceRoot), 'claude-1.jsonl'),
    ['{"type":"user","timestamp":"2026-04-01T09:30:00Z","message":{"content":"Claude prompt"}}'],
  );
  writeLines(path.join(homeDir, '.codex', 'session_index.jsonl'), ['{"id":"codex-1","thread_name":"Codex Thread"}']);
  writeLines(
    path.join(homeDir, '.codex', 'sessions', '2026', '04', '04', 'codex-1.jsonl'),
    [
      `{"type":"session_meta","payload":{"cwd":${JSON.stringify(workspaceRoot)},"id":"codex-1","timestamp":"2026-04-04T12:00:00Z"}}`,
    ],
  );

  const shimPath = path.join(root, 'agent-shim.js');
  fs.writeFileSync(
    shimPath,
    [
      "const target = process.argv[2] || '';",
      "console.log(`READY:${target}`);",
      "console.log('TITLE:');",
      "let buffer = '';",
      "process.stdin.setEncoding('utf8');",
      'process.stdin.resume();',
      'setInterval(() => {}, 1000);',
      "process.stdin.on('data', (chunk) => {",
      "  buffer += chunk;",
      "  const normalized = buffer.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');",
      "  const lines = normalized.split('\\n');",
      "  buffer = lines.pop() ?? '';",
      '  for (const line of lines) {',
      "    if (line === 'exit') {",
      "      console.log('BYE');",
      '      process.exit(0);',
      '    }',
      "    console.log(line.length === 0 ? 'ECHO:<ENTER>' : `ECHO:${line}`);",
      '  }',
      '});',
      '',
    ].join('\n'),
  );

  return { dataDir, homeDir, workspaceRoot, shimPath };
}

function createClient(env, binaryPath) {
  const child = spawn(binaryPath, [], {
    cwd: repoRoot(),
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let nextId = 1;
  let buffer = Buffer.alloc(0);
  let stderr = '';
  const pending = new Map();

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const marker = buffer.indexOf('\r\n\r\n');
      if (marker === -1) {
        return;
      }
      const header = buffer.slice(0, marker).toString('utf8');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      assert.ok(match, `missing Content-Length header: ${header}`);
      const bodyLength = Number(match[1]);
      const fullLength = marker + 4 + bodyLength;
      if (buffer.length < fullLength) {
        return;
      }
      const body = buffer.slice(marker + 4, fullLength).toString('utf8');
      buffer = buffer.slice(fullLength);
      const message = JSON.parse(body);
      if (!Object.prototype.hasOwnProperty.call(message, 'id')) {
        continue;
      }
      const handler = pending.get(message.id);
      if (handler) {
        pending.delete(message.id);
        handler.resolve(message);
      }
    }
  });

  child.on('exit', (code) => {
    for (const { reject } of pending.values()) {
      reject(new Error(`mini-term-mcp exited with code ${code}\n${stderr}`));
    }
    pending.clear();
  });

  function send(message) {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  }

  function request(method, params = {}) {
    const id = nextId++;
    const promise = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    send({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  async function initialize() {
    const response = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-smoke', version: '0.0.0' },
    });
    assert.equal(response.result.serverInfo.name, 'mini-term-mcp');
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  }

  async function callTool(name, args = {}) {
    const response = await request('tools/call', { name, arguments: args });
    return response.result.structuredContent;
  }

  async function close() {
    child.stdin.end();
    await new Promise((resolve) => child.once('exit', resolve));
  }

  return { initialize, request, callTool, close };
}

async function waitFor(task, predicate, message) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(typeof message === 'function' ? message() : message);
}

function taskOutputContains(detail, needle) {
  const excerpt = detail?.data?.recentOutputExcerpt;
  if (typeof excerpt === 'string' && excerpt.includes(needle)) {
    return true;
  }
  const logPath = detail?.data?.logPath;
  if (typeof logPath !== 'string' || logPath.length === 0) {
    return false;
  }
  try {
    return fs.readFileSync(logPath, 'utf8').includes(needle);
  } catch {
    return false;
  }
}

function isTransientTaskStartupFailure(detail) {
  const summary = detail?.data?.summary;
  const excerpt = detail?.data?.recentOutputExcerpt;
  return (
    summary?.status === 'error'
    && typeof excerpt === 'string'
    && (
      excerpt.includes('before producing terminal output')
      || excerpt.includes('Task startup failed:')
      || excerpt.includes('0xC0000142')
      || excerpt.includes('-1073741502')
    )
  );
}

async function waitForTaskOutput(client, taskId, needle, message) {
  let lastDetail = null;
  return waitFor(
    client,
    async () => {
      const detail = await client.callTool('get_task_status', { taskId });
      lastDetail = detail;
      return taskOutputContains(detail, needle) ? detail : null;
    },
    () => {
      const summary = lastDetail?.data?.summary ?? {};
      const excerpt = typeof lastDetail?.data?.recentOutputExcerpt === 'string'
        ? JSON.stringify(lastDetail.data.recentOutputExcerpt)
        : '<missing>';
      const logPath = typeof lastDetail?.data?.logPath === 'string' ? lastDetail.data.logPath : '<missing>';
      return `${message}; status=${summary.status ?? '<missing>'}; exitCode=${summary.exitCode ?? '<missing>'}; logPath=${logPath}; excerpt=${excerpt}`;
    },
  );
}

async function startSmokeTask(client, workspaceId) {
  let lastError = null;
  for (let attempt = 1; attempt <= TASK_START_ATTEMPTS; attempt += 1) {
    const started = await client.callTool('start_task', {
      workspaceId,
      target: 'codex',
      prompt: 'Smoke task prompt',
      contextPreset: 'light',
      title: `Smoke task ${attempt}`,
    });
    const taskId = started.data.taskId;
    assert.equal(started.data.promptPreview, 'Smoke task prompt');
    try {
      const readyStatus = await waitForTaskOutput(client, taskId, 'READY:codex', 'task never reported READY:codex');
      return { started, taskId, readyStatus };
    } catch (error) {
      const detail = await client.callTool('get_task_status', { taskId }).catch(() => null);
      if (attempt < TASK_START_ATTEMPTS && isTransientTaskStartupFailure(detail)) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? new Error('task never became ready');
}

async function main() {
  const binaryPath = ensureMcpBinary();

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-term-mcp-smoke-'));
  const { dataDir, homeDir, workspaceRoot, shimPath } = setupWorkspace(root);
  const mockHost = await startMockHostControlServer(workspaceRoot);
  writeJson(path.join(dataDir, 'runtime_mcp_state.json'), createRuntimeState(workspaceRoot, mockHost));
  const client = createClient({
    MINI_TERM_DATA_DIR: dataDir,
    MINI_TERM_HOME_DIR: homeDir,
    MINI_TERM_AGENT_SHIM: shimPath,
    MINI_TERM_TEST_AGENT_SHIM: shimPath,
  }, binaryPath);

  const completed = [];

  try {
    await client.initialize();

    const protocolList = await client.request('tools/list');
    assert.ok(protocolList.result.tools.length >= 37);
    assert.ok(protocolList.result.tools.some((tool) => tool.name === 'get_pty_detail'));
    completed.push('protocol.tools/list');

    const ping = await client.callTool('ping');
    assert.equal(ping.data.status, 'ok');
    completed.push('ping');

    const serverInfo = await client.callTool('server_info');
    assert.equal(serverInfo.data.hostConnection.status, 'connected');
    assert.equal(serverInfo.data.hostConnection.mode, 'app-data-snapshot');
    assert.equal(serverInfo.data.hostConnection.hostControl.token, mockHost.token);
    completed.push('server_info');

    const runtimeTools = await client.callTool('list_tools', { group: 'runtime-observation', limit: 10 });
    assert.ok(runtimeTools.data.items.some((item) => item.name === 'list_fs_watches'));
    completed.push('list_tools');

    const ptyPage1 = await client.callTool('list_ptys', { limit: 1 });
    const ptyPage2 = await client.callTool('list_ptys', { limit: 1, cursor: ptyPage1.data.nextCursor });
    assert.deepEqual(ptyPage1.data.items.map((item) => item.ptyId), [5]);
    assert.deepEqual(ptyPage2.data.items.map((item) => item.ptyId), [8]);
    completed.push('list_ptys');

    const ptyDetail = await client.callTool('get_pty_detail', { ptyId: 5 });
    assert.equal(ptyDetail.ok, true, JSON.stringify(ptyDetail));
    assert.equal(ptyDetail.data.ptyId, 5);
    assert.equal(ptyDetail.data.rootPid, 5010);
    assert.equal(mockHost.requests.at(-1)?.action, 'get_pty_detail');
    completed.push('get_pty_detail');

    const processTree = await client.callTool('get_process_tree', { ptyId: 5 });
    assert.equal(processTree.ok, true, JSON.stringify(processTree));
    assert.equal(processTree.data.root.pid, 5010);
    assert.equal(processTree.data.root.children[0].pid, 5011);
    assert.equal(mockHost.requests.at(-1)?.action, 'get_process_tree');
    completed.push('get_process_tree');

    const createdPty = await client.callTool('create_pty', {
      workspaceId: 'workspace-1',
      cwd: workspaceRoot,
      shellName: 'cmd',
      mode: 'agent',
      cols: 100,
      rows: 30,
    });
    assert.equal(createdPty.data.workspaceId, 'workspace-1');
    assert.equal(createdPty.data.shellName, 'cmd');
    assert.equal(createdPty.data.session.ptyId, 91);
    assert.equal(mockHost.requests.at(-1)?.payload.shell, 'cmd');
    completed.push('create_pty');

    const writePty = await client.callTool('write_pty', {
      ptyId: createdPty.data.session.ptyId,
      data: 'dir',
    });
    assert.equal(writePty.data.ok, true);
    assert.equal(writePty.data.echoed, 'dir');
    completed.push('write_pty');

    const resizedPty = await client.callTool('resize_pty', {
      ptyId: createdPty.data.session.ptyId,
      cols: 140,
      rows: 40,
    });
    assert.equal(resizedPty.data.cols, 140);
    assert.equal(resizedPty.data.rows, 40);
    completed.push('resize_pty');

    const pendingKillPty = await client.callTool('kill_pty', { ptyId: createdPty.data.session.ptyId });
    assert.equal(pendingKillPty.requiresConfirmation, true);
    const killPtyRequestId = pendingKillPty.confirmation.requestId;
    const approvedKillPty = await client.callTool('decide_approval_request', {
      requestId: killPtyRequestId,
      decision: 'approved',
    });
    assert.equal(approvedKillPty.data.status, 'approved');
    const killedPty = await client.callTool('kill_pty', {
      ptyId: createdPty.data.session.ptyId,
      approvalRequestId: killPtyRequestId,
    });
    assert.equal(killedPty.data.status, 'killed');
    completed.push('kill_pty');

    const watchList = await client.callTool('list_fs_watches', { limit: 10 });
    assert.equal(watchList.data.items[0].watchPath, workspaceRoot);
    completed.push('list_fs_watches');

    const recentEvents = await client.callTool('get_recent_events', {
      kinds: ['pty-output', 'fs-change'],
      limit: 10,
    });
    assert.deepEqual(
      recentEvents.data.items.map((item) => item.kind),
      ['fs-change', 'pty-output'],
    );
    completed.push('get_recent_events');

    const aiPage1 = await client.callTool('get_ai_sessions', { workspaceId: 'workspace-1', limit: 1 });
    const aiPage2 = await client.callTool('get_ai_sessions', {
      workspaceId: 'workspace-1',
      limit: 1,
      cursor: aiPage1.data.nextCursor,
    });
    assert.equal(aiPage1.data.items[0].sessionType, 'codex');
    assert.equal(aiPage2.data.items[0].sessionType, 'claude');
    completed.push('get_ai_sessions');

    const configView = await client.callTool('get_config', { sections: ['shells', 'theme'] });
    assert.equal(configView.data.config.defaultShell, 'powershell');
    completed.push('get_config');

    const configDryRun = await client.callTool('set_config_fields', {
      dryRun: true,
      patch: { uiFontSize: 16, terminalFontSize: 18 },
    });
    assert.deepEqual(configDryRun.data.changedFields, ['uiFontSize', 'terminalFontSize']);
    const configApply = await client.callTool('set_config_fields', {
      patch: { defaultShell: 'cmd', theme: { preset: 'ghostty-light' } },
    });
    assert.equal(configApply.data.config.defaultShell, 'cmd');
    completed.push('set_config_fields');

    const workspaces = await client.callTool('list_workspaces');
    assert.equal(workspaces.data[0].workspaceId, 'workspace-1');
    completed.push('list_workspaces');

    const focused = await client.callTool('focus_workspace', { workspaceId: 'workspace-1' });
    assert.equal(focused.data.ok, true);
    assert.equal(focused.data.workspaceId, 'workspace-1');
    completed.push('focus_workspace');

    const context = await client.callTool('get_workspace_context', { workspaceId: 'workspace-1', preset: 'review' });
    assert.equal(context.data.workspace.workspaceId, 'workspace-1');
    assert.ok(context.data.instructions.some((item) => item.label === 'AGENTS'));
    completed.push('get_workspace_context');

    const createdTab = await client.callTool('create_tab', {
      workspaceId: 'workspace-1',
      cwd: workspaceRoot,
      shellName: 'powershell',
      activate: true,
    });
    assert.equal(createdTab.data.ok, true);
    assert.equal(createdTab.data.tabId, 'tab-1');
    assert.equal(createdTab.data.paneId, 'pane-1');
    completed.push('create_tab');

    const splitPane = await client.callTool('split_pane', {
      workspaceId: 'workspace-1',
      tabId: createdTab.data.tabId,
      paneId: createdTab.data.paneId,
      direction: 'vertical',
      cwd: workspaceRoot,
      shellName: 'cmd',
      activate: true,
    });
    assert.equal(splitPane.data.ok, true);
    assert.equal(splitPane.data.direction, 'vertical');
    completed.push('split_pane');

    const notification = await client.callTool('notify_user', {
      message: 'smoke host notice',
      tone: 'success',
      durationMs: 1200,
    });
    assert.equal(notification.data.ok, true);
    assert.equal(notification.data.tone, 'success');
    completed.push('notify_user');

    const pendingCloseTab = await client.callTool('close_tab', {
      workspaceId: 'workspace-1',
      tabId: createdTab.data.tabId,
    });
    assert.equal(pendingCloseTab.requiresConfirmation, true);
    const closeTabRequestId = pendingCloseTab.confirmation.requestId;
    const approvedCloseTab = await client.callTool('decide_approval_request', {
      requestId: closeTabRequestId,
      decision: 'approved',
    });
    assert.equal(approvedCloseTab.data.status, 'approved');
    const closedTab = await client.callTool('close_tab', {
      workspaceId: 'workspace-1',
      tabId: createdTab.data.tabId,
      approvalRequestId: closeTabRequestId,
    });
    assert.equal(closedTab.data.ok, true);
    assert.equal(closedTab.data.tabId, createdTab.data.tabId);
    completed.push('close_tab');

    const readme = await client.callTool('read_file', { path: path.join(workspaceRoot, 'README.md') });
    assert.match(readme.data.content, /needle token/);
    completed.push('read_file');

    const search = await client.callTool('search_files', { rootPath: workspaceRoot, query: 'needle', limit: 10 });
    assert.ok(search.data.length >= 2);
    completed.push('search_files');

    const gitSummary = await client.callTool('get_git_summary', { projectPath: workspaceRoot });
    assert.equal(gitSummary.data.repoCount, 1);
    assert.ok(gitSummary.data.changedFiles.some((item) => item.path === 'src/review.txt'));
    completed.push('get_git_summary');

    const diff = await client.callTool('get_diff_for_review', {
      projectPath: workspaceRoot,
      filePath: 'src/review.txt',
    });
    assert.equal(diff.data.filePath, 'src/review.txt');
    assert.ok(diff.data.diff.hunks.length > 0);
    completed.push('get_diff_for_review');

    const legacySessions = await client.callTool('list_ai_sessions', { projectPaths: [workspaceRoot] });
    assert.ok(legacySessions.data.some((item) => item.id === 'codex-1'));
    completed.push('list_ai_sessions');

    const { started, taskId, readyStatus } = await startSmokeTask(client, 'workspace-1');
    completed.push('start_task');
    assert.equal(readyStatus.data.summary.taskId, taskId);
    completed.push('get_task_status');

    const attentionTasks = await client.callTool('list_attention_tasks');
    assert.ok(attentionTasks.data.some((item) => item.taskId === taskId));
    completed.push('list_attention_tasks');

    const resumed = await client.callTool('resume_session', { taskId });
    assert.equal(resumed.data.summary.taskId, taskId);
    completed.push('resume_session');

    const taskInput = await client.callTool('send_task_input', { taskId, input: 'hello smoke' });
    assert.equal(taskInput.data.taskId, taskId);
    await waitForTaskOutput(client, taskId, 'ECHO:hello smoke', 'task never echoed hello smoke');
    const submitOnly = await client.callTool('send_task_input', { taskId, submitOnly: true });
    assert.equal(submitOnly.data.taskId, taskId);
    await waitForTaskOutput(client, taskId, 'ECHO:<ENTER>', 'task never echoed bare enter');
    completed.push('send_task_input');

    const pendingWrite = await client.callTool('write_file', {
      path: path.join(workspaceRoot, 'approved-write.txt'),
      content: 'hello from approval\n',
    });
    assert.equal(pendingWrite.requiresConfirmation, true);
    const writeRequestId = pendingWrite.confirmation.requestId;
    completed.push('write_file');

    const pendingApprovals = await client.callTool('list_approval_requests', {
      status: 'pending',
      toolName: 'write_file',
    });
    assert.ok(pendingApprovals.data.some((item) => item.requestId === writeRequestId));
    completed.push('list_approval_requests');

    const approvedWrite = await client.callTool('decide_approval_request', {
      requestId: writeRequestId,
      decision: 'approved',
    });
    assert.equal(approvedWrite.data.status, 'approved');
    completed.push('decide_approval_request');

    const writeResult = await client.callTool('write_file', {
      path: path.join(workspaceRoot, 'approved-write.txt'),
      content: 'hello from approval\n',
      approvalRequestId: writeRequestId,
    });
    assert.equal(writeResult.data.ok, true);
    assert.equal(fs.readFileSync(path.join(workspaceRoot, 'approved-write.txt'), 'utf8'), 'hello from approval\n');

    const pendingCommand = await client.callTool('run_workspace_command', {
      workspacePath: workspaceRoot,
      command: 'echo command-smoke',
    });
    assert.equal(pendingCommand.requiresConfirmation, true);
    const commandRequestId = pendingCommand.confirmation.requestId;
    const rejectedCommand = await client.callTool('decide_approval_request', {
      requestId: commandRequestId,
      decision: 'rejected',
    });
    assert.equal(rejectedCommand.data.status, 'rejected');
    const commandRetry = await client.callTool('run_workspace_command', {
      workspacePath: workspaceRoot,
      command: 'echo command-smoke',
      approvalRequestId: commandRequestId,
    });
    assert.equal(commandRetry.requiresConfirmation, true);
    const pendingApprovedCommand = await client.callTool('run_workspace_command', {
      workspacePath: workspaceRoot,
      command: 'echo command-smoke-approved',
    });
    assert.equal(pendingApprovedCommand.requiresConfirmation, true);
    const approvedCommand = await client.callTool('decide_approval_request', {
      requestId: pendingApprovedCommand.confirmation.requestId,
      decision: 'approved',
    });
    assert.equal(approvedCommand.data.status, 'approved');
    const commandResult = await client.callTool('run_workspace_command', {
      workspacePath: workspaceRoot,
      command: 'echo command-smoke-approved',
      approvalRequestId: pendingApprovedCommand.confirmation.requestId,
    });
    assert.equal(commandResult.data.status, 0);
    assert.match(commandResult.data.stdout, /command-smoke-approved/i);
    completed.push('run_workspace_command');

    const pendingClose = await client.callTool('close_task', { taskId });
    assert.equal(pendingClose.requiresConfirmation, true);
    const closeRequestId = pendingClose.confirmation.requestId;
    const approvedClose = await client.callTool('decide_approval_request', {
      requestId: closeRequestId,
      decision: 'approved',
    });
    assert.equal(approvedClose.data.status, 'approved');
    const closeResult = await client.callTool('close_task', {
      taskId,
      approvalRequestId: closeRequestId,
    });
    assert.equal(closeResult.data.status, 'exited');
    assert.equal(closeResult.data.attentionState, 'completed');
    assert.equal(closeResult.data.terminationCause, 'manual-close');
    completed.push('close_task');

    console.log(
      JSON.stringify(
        {
          ok: true,
          root,
          completed,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.close().catch(() => {});
    await mockHost.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
