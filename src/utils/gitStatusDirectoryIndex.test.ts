import { describe, expect, it } from 'vitest';
import {
  buildDirectoryStatusIndex,
  getGitStatusLabelPriority,
  listAncestorDirectories,
} from './gitStatusDirectoryIndex';

describe('gitStatusDirectoryIndex', () => {
  it('lists ancestor directories from root to leaf parent', () => {
    expect(listAncestorDirectories('src/components/FileTree.tsx')).toEqual([
      '.',
      'src',
      'src/components',
    ]);
  });

  it('normalizes windows-style separators and keeps root-only files at dot', () => {
    expect(listAncestorDirectories('src\\main.ts')).toEqual(['.', 'src']);
    expect(listAncestorDirectories('README.md')).toEqual(['.']);
  });

  it('builds a directory status index using the highest-priority status label', () => {
    const index = buildDirectoryStatusIndex([
      { path: 'src/components/FileTree.tsx', statusLabel: 'M' },
      { path: 'src/utils/runtimeErrorFilter.ts', statusLabel: 'D' },
      { path: 'README.md', statusLabel: '?' },
    ]);

    expect(index.get('.')).toBe('D');
    expect(index.get('src')).toBe('D');
    expect(index.get('src/components')).toBe('M');
    expect(index.get('src/utils')).toBe('D');
  });

  it('ignores unknown labels when building the directory status index', () => {
    const index = buildDirectoryStatusIndex([
      { path: 'docs/guide.md', statusLabel: 'X' },
      { path: 'docs/setup.md', statusLabel: 'A' },
    ]);

    expect(index.get('.')).toBe('A');
    expect(index.get('docs')).toBe('A');
  });

  it('exposes stable label priorities for performance-sensitive callers', () => {
    expect(getGitStatusLabelPriority('C')).toBeGreaterThan(getGitStatusLabelPriority('D'));
    expect(getGitStatusLabelPriority('D')).toBeGreaterThan(getGitStatusLabelPriority('M'));
    expect(getGitStatusLabelPriority('')).toBe(0);
  });
});
