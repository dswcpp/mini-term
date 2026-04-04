import { describe, expect, it } from 'vitest';
import { buildPathCandidateText, createPathQuery, joinPath, normalizePath } from './path';
import { createCompletionContext } from './parser';

describe('terminalCompletion path utilities', () => {
  it('resolves relative paths from the current session cwd', () => {
    const context = createCompletionContext({
      inputText: 'cd sub/fi',
      cursor: 'cd sub/fi'.length,
      shellKind: 'bash',
      cwd: '/workspace/packages/app',
    });

    const query = createPathQuery(context.cwd, context.activeToken);
    expect(query.directoryPath).toBe('/workspace/packages/app/sub');
    expect(query.basenamePrefix).toBe('fi');
  });

  it('preserves windows absolute paths instead of rebasing them to project root', () => {
    const context = createCompletionContext({
      inputText: 'cd C:\\Users\\ds',
      cursor: 'cd C:\\Users\\ds'.length,
      shellKind: 'powershell',
      cwd: 'D:\\code\\JavaScript\\mini-term',
    });

    const query = createPathQuery(context.cwd, context.activeToken);
    expect(query.directoryPath).toBe('C:/Users');
    expect(query.basenamePrefix).toBe('ds');
  });

  it('keeps open-quote context without duplicating the quote', () => {
    const context = createCompletionContext({
      inputText: 'cd "my fi',
      cursor: 'cd "my fi'.length,
      shellKind: 'powershell',
      cwd: 'D:/code/JavaScript/mini-term',
    });

    const candidate = buildPathCandidateText({
      activeToken: context.activeToken,
      entry: {
        name: 'my file.txt',
        path: 'D:/code/JavaScript/mini-term/my file.txt',
        isDir: false,
      },
      shellKind: 'powershell',
      displayPrefix: '',
      separator: '\\',
    });

    expect(candidate.insertText).toBe('"my file.txt');
    expect(candidate.commitSuffix).toBe('');
  });

  it('escapes unquoted spaces for bash paths', () => {
    const context = createCompletionContext({
      inputText: 'cat my\\ fi',
      cursor: 'cat my\\ fi'.length,
      shellKind: 'bash',
      cwd: '/workspace',
    });

    const candidate = buildPathCandidateText({
      activeToken: context.activeToken,
      entry: {
        name: 'my file.txt',
        path: '/workspace/my file.txt',
        isDir: false,
      },
      shellKind: 'bash',
      displayPrefix: '',
      separator: '/',
    });

    expect(candidate.insertText).toBe('my\\ file.txt');
    expect(candidate.commitSuffix).toBe(' ');
  });

  it('quotes unquoted powershell paths that contain spaces', () => {
    const context = createCompletionContext({
      inputText: 'cd My Fo',
      cursor: 'cd My Fo'.length,
      shellKind: 'powershell',
      cwd: 'D:/code/JavaScript/mini-term',
    });

    const candidate = buildPathCandidateText({
      activeToken: context.activeToken,
      entry: {
        name: 'My Folder',
        path: 'D:/code/JavaScript/mini-term/My Folder',
        isDir: true,
      },
      shellKind: 'powershell',
      displayPrefix: '',
      separator: '\\',
    });

    expect(candidate.insertText).toBe('"My Folder\\"');
    expect(candidate.commitSuffix).toBe('');
  });

  it('normalizes dot segments when joining paths', () => {
    expect(joinPath('/workspace/project', './src/../tests')).toBe('/workspace/project/tests');
    expect(normalizePath('C:/Users/demo/../temp')).toBe('C:/Users/temp');
  });
});
