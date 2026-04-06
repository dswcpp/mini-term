import { describe, expect, it } from 'vitest';
import { collectAffectedLoadedDirectories } from './fileTreeRefresh';

describe('collectAffectedLoadedDirectories', () => {
  it('reloads only ancestor directories for modify events', () => {
    const affected = collectAffectedLoadedDirectories(
      'D:/repo',
      ['D:/repo', 'D:/repo/src', 'D:/repo/src/components', 'D:/repo/docs'],
      [
        {
          projectPath: 'D:/repo',
          path: 'D:/repo/src/components/FileTree.tsx',
          kind: 'Modify',
        },
      ],
    );

    expect(affected).toEqual([
      'D:/repo',
      'D:/repo/src',
      'D:/repo/src/components',
    ]);
  });

  it('reloads descendant loaded directories for structural events', () => {
    const affected = collectAffectedLoadedDirectories(
      'D:/repo',
      ['D:/repo', 'D:/repo/src', 'D:/repo/src/components', 'D:/repo/src/utils'],
      [
        {
          projectPath: 'D:/repo',
          path: 'D:/repo/src',
          kind: 'Remove',
        },
      ],
    );

    expect(affected).toEqual([
      'D:/repo',
      'D:/repo/src',
      'D:/repo/src/components',
      'D:/repo/src/utils',
    ]);
  });

  it('ignores events outside the tracked root', () => {
    const affected = collectAffectedLoadedDirectories(
      'D:/repo',
      ['D:/repo', 'D:/repo/src'],
      [
        {
          projectPath: 'D:/repo',
          path: 'D:/other/file.ts',
          kind: 'Modify',
        },
      ],
    );

    expect(affected).toEqual([]);
  });

  it('deduplicates overlapping affected directories while preserving loaded order', () => {
    const affected = collectAffectedLoadedDirectories(
      'D:/repo',
      ['D:/repo', 'D:/repo/src', 'D:/repo/src/components', 'D:/repo/src/utils'],
      [
        {
          projectPath: 'D:/repo',
          path: 'D:/repo/src/components/Button.tsx',
          kind: 'Modify',
        },
        {
          projectPath: 'D:/repo',
          path: 'D:/repo/src',
          kind: 'Modify',
        },
      ],
    );

    expect(affected).toEqual([
      'D:/repo',
      'D:/repo/src',
      'D:/repo/src/components',
    ]);
  });
});
