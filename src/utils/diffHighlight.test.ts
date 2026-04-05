import { describe, expect, it } from 'vitest';
import { buildInlineEntries, buildPairedDiffSegments, buildSideBySideRows } from './diffHighlight';

describe('diffHighlight', () => {
  it('marks changed tokens inside paired lines', () => {
    const result = buildPairedDiffSegments('const value = foo;', 'const result = foo;');

    expect(result.leftSegments).toEqual([
      { value: 'const ', kind: 'unchanged' },
      { value: 'value', kind: 'removed' },
      { value: ' = foo;', kind: 'unchanged' },
    ]);
    expect(result.rightSegments).toEqual([
      { value: 'const ', kind: 'unchanged' },
      { value: 'result', kind: 'added' },
      { value: ' = foo;', kind: 'unchanged' },
    ]);
  });

  it('builds side-by-side rows with inline highlight segments', () => {
    const rows = buildSideBySideRows([
      {
        hunkKey: 'hunk-1',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        changeBlocks: [],
        lines: [
          { kind: 'delete', content: 'let count = 1;', oldLineno: 1 },
          { kind: 'add', content: 'let total = 1;', newLineno: 1 },
        ],
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].leftSegments).toEqual([
      { value: 'let ', kind: 'unchanged' },
      { value: 'count', kind: 'removed' },
      { value: ' = 1;', kind: 'unchanged' },
    ]);
    expect(rows[0].rightSegments).toEqual([
      { value: 'let ', kind: 'unchanged' },
      { value: 'total', kind: 'added' },
      { value: ' = 1;', kind: 'unchanged' },
    ]);
    expect(rows[0].leftLineIndex).toBe(0);
    expect(rows[0].rightLineIndex).toBe(1);
  });

  it('preserves delete-then-add order for inline entries', () => {
    const entries = buildInlineEntries([
      {
        hunkKey: 'hunk-2',
        oldStart: 10,
        oldLines: 2,
        newStart: 10,
        newLines: 2,
        changeBlocks: [],
        lines: [
          { kind: 'delete', content: 'first old', oldLineno: 10 },
          { kind: 'delete', content: 'second old', oldLineno: 11 },
          { kind: 'add', content: 'first new', newLineno: 10 },
          { kind: 'add', content: 'second new', newLineno: 11 },
        ],
      },
    ]);

    expect(entries.map((entry) => entry.line.kind)).toEqual(['delete', 'delete', 'add', 'add']);
    expect(entries.map((entry) => entry.lineIndex)).toEqual([0, 1, 2, 3]);
    expect(entries[0].segments.some((segment) => segment.kind === 'removed')).toBe(true);
    expect(entries[2].segments.some((segment) => segment.kind === 'added')).toBe(true);
  });

  it('falls back to full-line added or removed segments when there is no pair', () => {
    const rows = buildSideBySideRows([
      {
        hunkKey: 'hunk-3',
        oldStart: 3,
        oldLines: 0,
        newStart: 3,
        newLines: 1,
        changeBlocks: [],
        lines: [{ kind: 'add', content: 'new line', newLineno: 3 }],
      },
    ]);

    expect(rows[0].rightSegments).toEqual([{ value: 'new line', kind: 'added' }]);
    expect(rows[0].leftSegments).toEqual([]);
    expect(rows[0].rightLineIndex).toBe(0);
  });
});
