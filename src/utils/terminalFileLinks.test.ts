import { describe, expect, it, vi } from 'vitest';
import {
  collectWrappedBufferText,
  createBufferRangeFromOffsets,
  extractTerminalFileLinks,
  resolveTerminalFileLink,
  shouldActivateTerminalFileLink,
} from './terminalFileLinks';

function createBufferLine(text: string, isWrapped = false) {
  return {
    isWrapped,
    length: text.length,
    translateToString(trimRight = false) {
      return trimRight ? text.replace(/\s+$/g, '') : text;
    },
  };
}

describe('terminalFileLinks', () => {
  it('detects modifier activation by platform', () => {
    expect(shouldActivateTerminalFileLink({ ctrlKey: true, metaKey: false, isMac: false })).toBe(true);
    expect(shouldActivateTerminalFileLink({ ctrlKey: false, metaKey: true, isMac: false })).toBe(false);
    expect(shouldActivateTerminalFileLink({ ctrlKey: true, metaKey: false, isMac: true })).toBe(false);
    expect(shouldActivateTerminalFileLink({ ctrlKey: false, metaKey: true, isMac: true })).toBe(true);
  });

  it('extracts Windows, UNC, and POSIX path forms with line metadata', () => {
    expect(extractTerminalFileLinks('error at C:\\repo\\src\\app.ts:12:3')[0]).toMatchObject({
      path: 'C:\\repo\\src\\app.ts',
      line: 12,
      column: 3,
    });
    expect(extractTerminalFileLinks('\\\\server\\share\\src\\app.ts:7')[0]).toMatchObject({
      path: '\\\\server\\share\\src\\app.ts',
      line: 7,
    });
    expect(extractTerminalFileLinks('/workspace/src/app.ts:9')[0]).toMatchObject({
      path: '/workspace/src/app.ts',
      line: 9,
    });
  });

  it('extracts quoted, parenthesized, python traceback, and file URI forms', () => {
    expect(extractTerminalFileLinks('"src/my file.ts":14:2')[0]).toMatchObject({
      path: 'src/my file.ts',
      line: 14,
      column: 2,
    });
    expect(extractTerminalFileLinks('"README.md"')[0]).toMatchObject({
      path: 'README.md',
    });
    expect(extractTerminalFileLinks('`src/App.tsx:14:2`')[0]).toMatchObject({
      path: 'src/App.tsx',
      line: 14,
      column: 2,
    });
    expect(extractTerminalFileLinks('(src/app.ts:20:4)')[0]).toMatchObject({
      path: 'src/app.ts',
      line: 20,
      column: 4,
    });
    expect(extractTerminalFileLinks('main.rs(3,8)')[0]).toMatchObject({
      path: 'main.rs',
      line: 3,
      column: 8,
    });
    expect(extractTerminalFileLinks('File "/tmp/app.py", line 27, in main')[0]).toMatchObject({
      path: '/tmp/app.py',
      line: 27,
    });
    expect(extractTerminalFileLinks('file:///C:/repo/src/app.ts:5:1')[0]).toMatchObject({
      path: 'file:///C:/repo/src/app.ts',
      line: 5,
      column: 1,
    });
  });

  it('extracts range and anchor based file references', () => {
    expect(extractTerminalFileLinks('src/App.tsx:4-8')[0]).toMatchObject({
      path: 'src/App.tsx',
      line: 4,
    });
    expect(extractTerminalFileLinks('src-tauri/src/config.rs:20-26')[0]).toMatchObject({
      path: 'src-tauri/src/config.rs',
      line: 20,
    });
    expect(extractTerminalFileLinks('src/App.tsx:4,120-122')[0]).toMatchObject({
      path: 'src/App.tsx',
      line: 4,
    });
    expect(extractTerminalFileLinks('src/App.tsx#L12C3')[0]).toMatchObject({
      path: 'src/App.tsx',
      line: 12,
      column: 3,
    });
    expect(extractTerminalFileLinks('src/App.tsx#L12-L18')[0]).toMatchObject({
      path: 'src/App.tsx',
      line: 12,
    });
    expect(extractTerminalFileLinks('src/App.tsx#L12C3-L18C2')[0]).toMatchObject({
      path: 'src/App.tsx',
      line: 12,
      column: 3,
    });
    expect(extractTerminalFileLinks('docs/plan.md#L18')[0]).toMatchObject({
      path: 'docs/plan.md',
      line: 18,
    });
  });

  it('avoids treating domains, ports, and versions as file links', () => {
    expect(extractTerminalFileLinks('visit https://example.com/docs')).toEqual([]);
    expect(extractTerminalFileLinks('server started at example.com:443')).toEqual([]);
    expect(extractTerminalFileLinks('listening on 127.0.0.1:3000')).toEqual([]);
    expect(extractTerminalFileLinks('current version is 1.2.3')).toEqual([]);
    expect(extractTerminalFileLinks('see README.md for more info')).toEqual([]);
  });

  it('handles Chinese prose and punctuation around paths', () => {
    expect(
      extractTerminalFileLinks(
        '服务端入口是 ros_it_mgt_serv_pkg/it_mgt_serv_node/App.py，全局配置在 ros_it_mgt_serv_pkg/it_mgt_serv_node/settings.py，总路由在 ros_it_mgt_serv_pkg/it_mgt_serv_node/config/urls.py。',
      ),
    ).toEqual([
      expect.objectContaining({
        text: 'ros_it_mgt_serv_pkg/it_mgt_serv_node/App.py',
        path: 'ros_it_mgt_serv_pkg/it_mgt_serv_node/App.py',
      }),
      expect.objectContaining({
        text: 'ros_it_mgt_serv_pkg/it_mgt_serv_node/settings.py',
        path: 'ros_it_mgt_serv_pkg/it_mgt_serv_node/settings.py',
      }),
      expect.objectContaining({
        text: 'ros_it_mgt_serv_pkg/it_mgt_serv_node/config/urls.py',
        path: 'ros_it_mgt_serv_pkg/it_mgt_serv_node/config/urls.py',
      }),
    ]);
  });

  it('reconstructs wrapped buffer text and maps offsets back to a multi-line range', () => {
    const wrapped = collectWrappedBufferText(
      {
        length: 2,
        getLine(index) {
          return [createBufferLine('src/compo', false), createBufferLine('nents/App.tsx:12:3', true)][index];
        },
      },
      2,
    );

    expect(wrapped).toMatchObject({
      text: 'src/components/App.tsx:12:3',
      startLineNumber: 1,
      endLineNumber: 2,
    });

    const match = wrapped ? extractTerminalFileLinks(wrapped.text)[0] : null;
    const range = wrapped && match ? createBufferRangeFromOffsets(wrapped, match.startIndex, match.endIndex) : null;

    expect(range).toEqual({
      start: { x: 1, y: 1 },
      end: { x: 18, y: 2 },
    });
  });

  it('resolves absolute paths before cwd and workspace roots', async () => {
    const probeFile = vi.fn(async (path: string) => path === 'C:\\repo\\src\\app.ts');

    const resolved = await resolveTerminalFileLink(
      {
        text: 'C:\\repo\\src\\app.ts:8',
        startIndex: 0,
        endIndex: 20,
        path: 'C:\\repo\\src\\app.ts',
        line: 8,
      },
      {
        cwd: 'C:\\other',
        workspaceRootPaths: ['C:\\workspace'],
        probeFile,
      },
    );

    expect(resolved).toEqual({
      path: 'C:\\repo\\src\\app.ts',
      line: 8,
      column: undefined,
    });
    expect(probeFile).toHaveBeenCalledTimes(1);
    expect(probeFile).toHaveBeenCalledWith('C:\\repo\\src\\app.ts');
  });

  it('resolves dot-relative paths against cwd only', async () => {
    const probeFile = vi.fn(async (path: string) => path === 'D:\\repo\\src\\app.ts');

    const resolved = await resolveTerminalFileLink(
      {
        text: './src/app.ts:11',
        startIndex: 0,
        endIndex: 14,
        path: './src/app.ts',
        line: 11,
      },
      {
        cwd: 'D:\\repo',
        workspaceRootPaths: ['D:\\workspace'],
        probeFile,
      },
    );

    expect(resolved).toEqual({
      path: 'D:\\repo\\src\\app.ts',
      line: 11,
      column: undefined,
    });
    expect(probeFile.mock.calls).toEqual([['D:\\repo\\src\\app.ts']]);
  });

  it('falls back from cwd to workspace roots for non-dot relative paths', async () => {
    const probeFile = vi.fn(async (path: string) => path === 'D:\\workspace-a\\src\\app.ts');

    const resolved = await resolveTerminalFileLink(
      {
        text: 'src/app.ts:12:4',
        startIndex: 0,
        endIndex: 16,
        path: 'src/app.ts',
        line: 12,
        column: 4,
      },
      {
        cwd: 'D:\\cwd',
        workspaceRootPaths: ['D:\\workspace-a', 'D:\\workspace-b'],
        probeFile,
      },
    );

    expect(resolved).toEqual({
      path: 'D:\\workspace-a\\src\\app.ts',
      line: 12,
      column: 4,
    });
    expect(probeFile.mock.calls).toEqual([
      ['D:\\cwd\\src\\app.ts'],
      ['D:\\workspace-a\\src\\app.ts'],
    ]);
  });

  it('searches ancestor directories for repo-relative paths outside the current cwd', async () => {
    const probeFile = vi.fn(async (path: string) => path === 'D:\\code\\ros_it_mgt_serv_pkg\\it_mgt_serv_node\\App.py');

    const resolved = await resolveTerminalFileLink(
      {
        text: 'ros_it_mgt_serv_pkg/it_mgt_serv_node/App.py',
        startIndex: 0,
        endIndex: 44,
        path: 'ros_it_mgt_serv_pkg/it_mgt_serv_node/App.py',
      },
      {
        cwd: 'D:\\code\\JavaScript\\mini-term',
        workspaceRootPaths: ['D:\\code\\JavaScript\\mini-term'],
        probeFile,
      },
    );

    expect(resolved).toEqual({
      path: 'D:\\code\\ros_it_mgt_serv_pkg\\it_mgt_serv_node\\App.py',
      line: undefined,
      column: undefined,
    });
    expect(probeFile).toHaveBeenCalledWith('D:\\code\\ros_it_mgt_serv_pkg\\it_mgt_serv_node\\App.py');
  });
});
