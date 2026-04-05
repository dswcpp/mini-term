import type { DiffLine, GitDiffResult } from '../types';

export type DiffSegmentKind = 'unchanged' | 'added' | 'removed';

export interface DiffTextSegment {
  value: string;
  kind: DiffSegmentKind;
}

export interface DiffRenderRow {
  left?: DiffLine;
  right?: DiffLine;
  leftSegments: DiffTextSegment[];
  rightSegments: DiffTextSegment[];
  leftLineIndex?: number;
  rightLineIndex?: number;
}

export interface DiffInlineEntry {
  line: DiffLine;
  segments: DiffTextSegment[];
  lineIndex: number;
}

function createSegment(value: string, kind: DiffSegmentKind): DiffTextSegment {
  return { value, kind };
}

function createFullSegments(value: string, kind: DiffSegmentKind): DiffTextSegment[] {
  if (!value) {
    return [];
  }

  return [createSegment(value, kind)];
}

function tokenizeLine(line: string) {
  return line.match(/(\s+|[\p{L}\p{N}_]+|[^\s])/gu) ?? [];
}

function mergeAdjacentSegments(segments: DiffTextSegment[]) {
  const merged: DiffTextSegment[] = [];

  for (const segment of segments) {
    if (!segment.value) {
      continue;
    }

    const previous = merged[merged.length - 1];
    if (previous && previous.kind === segment.kind) {
      previous.value += segment.value;
    } else {
      merged.push({ ...segment });
    }
  }

  return merged;
}

export function buildPairedDiffSegments(leftValue?: string, rightValue?: string) {
  if (!leftValue && !rightValue) {
    return {
      leftSegments: [] as DiffTextSegment[],
      rightSegments: [] as DiffTextSegment[],
    };
  }

  if (leftValue == null) {
    return {
      leftSegments: [] as DiffTextSegment[],
      rightSegments: createFullSegments(rightValue ?? '', 'added'),
    };
  }

  if (rightValue == null) {
    return {
      leftSegments: createFullSegments(leftValue, 'removed'),
      rightSegments: [] as DiffTextSegment[],
    };
  }

  if (leftValue === rightValue) {
    return {
      leftSegments: createFullSegments(leftValue, 'unchanged'),
      rightSegments: createFullSegments(rightValue, 'unchanged'),
    };
  }

  const leftTokens = tokenizeLine(leftValue);
  const rightTokens = tokenizeLine(rightValue);
  const matrix = Array.from({ length: leftTokens.length + 1 }, () =>
    Array.from<number>({ length: rightTokens.length + 1 }).fill(0),
  );

  for (let leftIndex = 1; leftIndex <= leftTokens.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= rightTokens.length; rightIndex += 1) {
      if (leftTokens[leftIndex - 1] === rightTokens[rightIndex - 1]) {
        matrix[leftIndex][rightIndex] = matrix[leftIndex - 1][rightIndex - 1] + 1;
      } else {
        matrix[leftIndex][rightIndex] = Math.max(matrix[leftIndex - 1][rightIndex], matrix[leftIndex][rightIndex - 1]);
      }
    }
  }

  const leftSegments: DiffTextSegment[] = [];
  const rightSegments: DiffTextSegment[] = [];
  let leftIndex = leftTokens.length;
  let rightIndex = rightTokens.length;

  while (leftIndex > 0 && rightIndex > 0) {
    const leftToken = leftTokens[leftIndex - 1];
    const rightToken = rightTokens[rightIndex - 1];

    if (leftToken === rightToken) {
      leftSegments.push(createSegment(leftToken, 'unchanged'));
      rightSegments.push(createSegment(rightToken, 'unchanged'));
      leftIndex -= 1;
      rightIndex -= 1;
      continue;
    }

    if (matrix[leftIndex - 1][rightIndex] >= matrix[leftIndex][rightIndex - 1]) {
      leftSegments.push(createSegment(leftToken, 'removed'));
      leftIndex -= 1;
    } else {
      rightSegments.push(createSegment(rightToken, 'added'));
      rightIndex -= 1;
    }
  }

  while (leftIndex > 0) {
    leftSegments.push(createSegment(leftTokens[leftIndex - 1], 'removed'));
    leftIndex -= 1;
  }

  while (rightIndex > 0) {
    rightSegments.push(createSegment(rightTokens[rightIndex - 1], 'added'));
    rightIndex -= 1;
  }

  return {
    leftSegments: mergeAdjacentSegments(leftSegments.reverse()),
    rightSegments: mergeAdjacentSegments(rightSegments.reverse()),
  };
}

export function buildSideBySideRows(hunks: GitDiffResult['hunks']) {
  const rows: DiffRenderRow[] = [];

  for (const hunk of hunks) {
    let index = 0;

    while (index < hunk.lines.length) {
      const line = hunk.lines[index];

      if (line.kind === 'context') {
        rows.push({
          left: line,
          right: line,
          leftSegments: createFullSegments(line.content, 'unchanged'),
          rightSegments: createFullSegments(line.content, 'unchanged'),
          leftLineIndex: index,
          rightLineIndex: index,
        });
        index += 1;
        continue;
      }

      if (line.kind === 'delete') {
        const deletes: Array<{ line: DiffLine; lineIndex: number }> = [];
        while (index < hunk.lines.length && hunk.lines[index].kind === 'delete') {
          deletes.push({
            line: hunk.lines[index],
            lineIndex: index,
          });
          index += 1;
        }

        const adds: Array<{ line: DiffLine; lineIndex: number }> = [];
        while (index < hunk.lines.length && hunk.lines[index].kind === 'add') {
          adds.push({
            line: hunk.lines[index],
            lineIndex: index,
          });
          index += 1;
        }

        const maxLen = Math.max(deletes.length, adds.length);
        for (let rowIndex = 0; rowIndex < maxLen; rowIndex += 1) {
          const left = deletes[rowIndex];
          const right = adds[rowIndex];
          const { leftSegments, rightSegments } = buildPairedDiffSegments(left?.line.content, right?.line.content);
          rows.push({
            left: left?.line,
            right: right?.line,
            leftSegments,
            rightSegments,
            leftLineIndex: left?.lineIndex,
            rightLineIndex: right?.lineIndex,
          });
        }
        continue;
      }

      rows.push({
        left: undefined,
        right: line,
        leftSegments: [],
        rightSegments: createFullSegments(line.content, 'added'),
        rightLineIndex: index,
      });
      index += 1;
    }
  }

  return rows;
}

export function buildInlineEntries(hunks: GitDiffResult['hunks']) {
  const entries: DiffInlineEntry[] = [];

  for (const hunk of hunks) {
    let index = 0;

    while (index < hunk.lines.length) {
      const line = hunk.lines[index];

      if (line.kind === 'context') {
        entries.push({
          line,
          segments: createFullSegments(line.content, 'unchanged'),
          lineIndex: index,
        });
        index += 1;
        continue;
      }

      if (line.kind === 'delete') {
        const deletes: Array<{ line: DiffLine; lineIndex: number }> = [];
        while (index < hunk.lines.length && hunk.lines[index].kind === 'delete') {
          deletes.push({
            line: hunk.lines[index],
            lineIndex: index,
          });
          index += 1;
        }

        const adds: Array<{ line: DiffLine; lineIndex: number }> = [];
        while (index < hunk.lines.length && hunk.lines[index].kind === 'add') {
          adds.push({
            line: hunk.lines[index],
            lineIndex: index,
          });
          index += 1;
        }

        const maxLen = Math.max(deletes.length, adds.length);
        const deleteSegments: DiffTextSegment[][] = deletes.map((item) =>
          createFullSegments(item.line.content, 'removed'),
        );
        const addSegments: DiffTextSegment[][] = adds.map((item) => createFullSegments(item.line.content, 'added'));

        for (let rowIndex = 0; rowIndex < maxLen; rowIndex += 1) {
          const { leftSegments, rightSegments } = buildPairedDiffSegments(
            deletes[rowIndex]?.line.content,
            adds[rowIndex]?.line.content,
          );

          if (deletes[rowIndex]) {
            deleteSegments[rowIndex] = leftSegments;
          }
          if (adds[rowIndex]) {
            addSegments[rowIndex] = rightSegments;
          }
        }

        deletes.forEach((item, rowIndex) => {
          entries.push({
            line: item.line,
            segments: deleteSegments[rowIndex],
            lineIndex: item.lineIndex,
          });
        });

        adds.forEach((item, rowIndex) => {
          entries.push({
            line: item.line,
            segments: addSegments[rowIndex],
            lineIndex: item.lineIndex,
          });
        });
        continue;
      }

      entries.push({
        line,
        segments: createFullSegments(line.content, 'added'),
        lineIndex: index,
      });
      index += 1;
    }
  }

  return entries;
}
