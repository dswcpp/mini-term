import { describe, expect, it } from 'vitest';
import { createCompletionContext, parseCommandLine } from './parser';

describe('terminalCompletion parser', () => {
  it('identifies subcommand context after a trailing space', () => {
    const context = createCompletionContext({
      inputText: 'git ',
      cursor: 4,
      shellKind: 'bash',
      cwd: '/workspace',
    });

    expect(context.mode).toBe('subcommand');
    expect(context.activeToken.synthetic).toBe(true);
    expect(context.activeToken.index).toBe(1);
  });

  it('identifies path context for quoted paths', () => {
    const context = createCompletionContext({
      inputText: 'cd "my fi',
      cursor: 'cd "my fi'.length,
      shellKind: 'powershell',
      cwd: 'D:/code/JavaScript/mini-term',
    });

    expect(context.mode).toBe('path');
    expect(context.activeToken.leadingQuote).toBe('"');
    expect(context.activeToken.openQuote).toBe('"');
    expect(context.activeToken.valuePrefix).toBe('my fi');
  });

  it('tracks single-quoted tokens without losing the active range', () => {
    const context = createCompletionContext({
      inputText: "cd 'my fo",
      cursor: "cd 'my fo".length,
      shellKind: 'bash',
      cwd: '/workspace',
    });

    expect(context.mode).toBe('path');
    expect(context.activeToken.leadingQuote).toBe("'");
    expect(context.activeToken.openQuote).toBe("'");
    expect(context.activeToken.start).toBe(3);
  });

  it('keeps token boundaries when the cursor is in the middle of a token', () => {
    const parsed = parseCommandLine('git sttus --short', 'git st'.length, 'bash');

    expect(parsed.activeToken.raw).toBe('sttus');
    expect(parsed.activeToken.rawPrefix).toBe('st');
    expect(parsed.activeToken.rawSuffix).toBe('tus');
    expect(parsed.activeToken.start).toBe(4);
    expect(parsed.activeToken.end).toBe(9);
  });

  it('classifies command options separately from arguments', () => {
    const context = createCompletionContext({
      inputText: 'git --ver',
      cursor: 'git --ver'.length,
      shellKind: 'bash',
      cwd: '/workspace',
    });

    expect(context.mode).toBe('option');
  });
});
