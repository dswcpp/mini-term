import { describe, expect, it } from 'vitest';
import { buildCompletionResult, candidateToEdit } from './matcher';
import { createCompletionContext } from './parser';
import type { CompletionCandidate } from './types';

function createCandidate(overrides: Partial<CompletionCandidate>): CompletionCandidate {
  return {
    id: overrides.id ?? 'candidate',
    label: overrides.label ?? 'status',
    insertText: overrides.insertText ?? 'status',
    detail: overrides.detail ?? 'detail',
    kind: overrides.kind ?? 'subcommand',
    priority: overrides.priority ?? 50,
    replaceStart: overrides.replaceStart ?? 4,
    replaceEnd: overrides.replaceEnd ?? 7,
    source: overrides.source ?? 'test',
    commitSuffix: overrides.commitSuffix,
    isDir: overrides.isDir,
  };
}

describe('terminalCompletion matcher', () => {
  it('computes a common prefix when multiple candidates can still advance', () => {
    const context = createCompletionContext({
      inputText: 'npm ru',
      cursor: 'npm ru'.length,
      shellKind: 'bash',
      cwd: '/workspace',
    });

    const result = buildCompletionResult(context, [
      createCandidate({ insertText: 'run', label: 'run', replaceEnd: 6 }),
      createCandidate({ id: '2', insertText: 'runner', label: 'runner', replaceEnd: 6 }),
    ]);

    expect(result.commonPrefixEdit).toEqual({
      replaceStart: 4,
      replaceEnd: 6,
      newText: 'run',
    });
  });

  it('does not emit a common prefix edit when nothing advances', () => {
    const context = createCompletionContext({
      inputText: 'git c',
      cursor: 'git c'.length,
      shellKind: 'bash',
      cwd: '/workspace',
    });

    const result = buildCompletionResult(context, [
      createCandidate({ insertText: 'checkout', label: 'checkout', replaceStart: 4, replaceEnd: 5 }),
      createCandidate({ id: '2', insertText: 'commit', label: 'commit', replaceStart: 4, replaceEnd: 5 }),
      createCandidate({ id: '3', insertText: 'clone', label: 'clone', replaceStart: 4, replaceEnd: 5 }),
    ]);

    expect(result.commonPrefixEdit).toBeUndefined();
  });

  it('sorts directories before files when priorities match', () => {
    const context = createCompletionContext({
      inputText: 'cd sr',
      cursor: 'cd sr'.length,
      shellKind: 'bash',
      cwd: '/workspace',
    });

    const result = buildCompletionResult(context, [
      createCandidate({ id: 'file', label: 'src.txt', insertText: 'src.txt', kind: 'path', isDir: false }),
      createCandidate({ id: 'dir', label: 'src/', insertText: 'src/', kind: 'path', isDir: true }),
    ]);

    expect(result.candidates[0]?.id).toBe('dir');
  });

  it('creates edits that include commit suffixes for accepted candidates', () => {
    const edit = candidateToEdit(
      createCandidate({
        insertText: 'git',
        label: 'git',
        kind: 'command',
        commitSuffix: ' ',
        replaceStart: 0,
        replaceEnd: 2,
      }),
    );

    expect(edit).toEqual({
      replaceStart: 0,
      replaceEnd: 2,
      newText: 'git ',
    });
  });
});
