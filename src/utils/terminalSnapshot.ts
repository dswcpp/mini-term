export interface SnapshotBufferLine {
  isWrapped: boolean;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

export interface SnapshotBuffer {
  getLine(index: number): SnapshotBufferLine | undefined;
}

export function getCurrentLineSnapshotFromBuffer(
  buffer: SnapshotBuffer,
  cursorLine: number,
  cursorX: number,
): string | undefined {
  let startLine = cursorLine;

  while (startLine > 0 && buffer.getLine(startLine)?.isWrapped) {
    startLine -= 1;
  }

  const parts: string[] = [];
  const endColumn = Math.max(0, cursorX);
  for (let lineIndex = startLine; lineIndex <= cursorLine; lineIndex += 1) {
    const line = buffer.getLine(lineIndex);
    if (!line) continue;
    parts.push(
      lineIndex === cursorLine
        ? line.translateToString(false, 0, endColumn)
        : line.translateToString(true),
    );
  }

  const snapshot = parts.join('').trim();
  return snapshot.length > 0 ? snapshot : undefined;
}
