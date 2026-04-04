import { describe, expect, it, vi } from 'vitest';
import { collectCompletionCandidates } from './providers';
import { createCompletionContext } from './parser';
import type { ProviderRuntime } from './types';

function createRuntime(overrides: Partial<ProviderRuntime> = {}): ProviderRuntime {
  return {
    projectPath: '/workspace/project',
    usageScopeKey: '/workspace/project',
    sessionCommands: [],
    lastCommand: undefined,
    completionUsage: undefined,
    readDirectory: overrides.readDirectory ?? vi.fn(async () => []),
    readPackageScripts: overrides.readPackageScripts ?? vi.fn(async () => []),
    readGitCompletionData: overrides.readGitCompletionData ?? vi.fn(async () => null),
  };
}

describe('terminalCompletion providers', () => {
  it('returns git option candidates for option context', async () => {
    const runtime = createRuntime();
    const context = createCompletionContext({
      inputText: 'git checkout --t',
      cursor: 'git checkout --t'.length,
      shellKind: 'bash',
      cwd: '/workspace/project',
    });

    const candidates = await collectCompletionCandidates(context, runtime);

    expect(candidates.map((candidate) => candidate.label)).toContain('--track');
  });

  it('returns npm scripts when completing npm run arguments', async () => {
    const runtime = createRuntime({
      readPackageScripts: vi.fn(async () => ['build', 'bundle', 'test']),
    });
    const context = createCompletionContext({
      inputText: 'npm run bu',
      cursor: 'npm run bu'.length,
      shellKind: 'bash',
      cwd: '/workspace/project',
    });

    const candidates = await collectCompletionCandidates(context, runtime);

    expect(candidates.map((candidate) => candidate.label)).toEqual(
      expect.arrayContaining(['build', 'bundle']),
    );
  });

  it('returns path candidates with directory suffix handling', async () => {
    const runtime = createRuntime({
      readDirectory: vi.fn(async () => [
        { name: 'src', path: '/workspace/project/src', isDir: true },
        { name: 'scripts.ts', path: '/workspace/project/scripts.ts', isDir: false },
      ]),
    });
    const context = createCompletionContext({
      inputText: 'cd s',
      cursor: 'cd s'.length,
      shellKind: 'bash',
      cwd: '/workspace/project',
    });

    const candidates = await collectCompletionCandidates(context, runtime);
    const directory = candidates.find((candidate) => candidate.label === 'src/');
    const file = candidates.find((candidate) => candidate.label === 'scripts.ts');

    expect(directory).toMatchObject({
      insertText: 'src/',
      commitSuffix: '',
      isDir: true,
    });
    expect(file).toMatchObject({
      insertText: 'scripts.ts',
      commitSuffix: ' ',
      isDir: false,
    });
  });
});
