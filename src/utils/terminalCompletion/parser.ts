import type { ShellKind } from '../../types';
import type { ActiveToken, CompletionContext, CompletionMode, ParsedToken } from './types';

interface ShellProfile {
  escapeChar?: '\\' | '`' | '^';
  quoteChars: Array<'"' | "'">;
}

interface DecodedToken {
  value: string;
  openQuote?: '"' | "'";
  leadingQuote?: '"' | "'";
  closedQuote: boolean;
}

const COMMAND_SUBCOMMANDS = new Set(['git', 'npm', 'cargo']);
const PATH_COMMANDS = new Set([
  'cd',
  'dir',
  'ls',
  'cat',
  'type',
  'get-content',
  'set-location',
  'gc',
]);

function getShellProfile(shellKind: ShellKind): ShellProfile {
  switch (shellKind) {
    case 'powershell':
    case 'pwsh':
      return { escapeChar: '`', quoteChars: ['"', "'"] };
    case 'cmd':
      return { escapeChar: '^', quoteChars: ['"'] };
    case 'bash':
    case 'zsh':
      return { escapeChar: '\\', quoteChars: ['"', "'"] };
    default:
      return { escapeChar: '\\', quoteChars: ['"', "'"] };
  }
}

function isEscapeActive(profile: ShellProfile, quote: '"' | "'" | undefined): boolean {
  if (!profile.escapeChar) return false;
  if (profile.escapeChar === '\\' && quote === "'") return false;
  return true;
}

export function decodeToken(raw: string, shellKind: ShellKind): DecodedToken {
  const profile = getShellProfile(shellKind);
  let value = '';
  let openQuote: '"' | "'" | undefined;
  let leadingQuote: '"' | "'" | undefined;
  let closedQuote = false;
  let escapeNext = false;

  for (let index = 0; index < raw.length; index += 1) {
    const ch = raw[index];

    if (escapeNext) {
      value += ch;
      escapeNext = false;
      continue;
    }

    if (profile.escapeChar && ch === profile.escapeChar && isEscapeActive(profile, openQuote)) {
      if (index === raw.length - 1) {
        value += ch;
      } else {
        escapeNext = true;
      }
      continue;
    }

    if (profile.quoteChars.includes(ch as '"' | "'")) {
      const quote = ch as '"' | "'";
      if (!openQuote) {
        openQuote = quote;
        if (raw[0] === quote) {
          leadingQuote = quote;
        } else {
          value += ch;
        }
        continue;
      }

      if (openQuote === quote) {
        openQuote = undefined;
        closedQuote = true;
        continue;
      }
    }

    value += ch;
  }

  return { value, openQuote, leadingQuote, closedQuote };
}

function createToken(raw: string, start: number, end: number, shellKind: ShellKind, index: number): ParsedToken {
  const decoded = decodeToken(raw, shellKind);
  return {
    index,
    start,
    end,
    raw,
    value: decoded.value,
    leadingQuote: decoded.leadingQuote,
    openQuote: decoded.openQuote,
    closedQuote: decoded.closedQuote,
  };
}

export function parseCommandLine(inputText: string, cursor: number, shellKind: ShellKind): {
  tokens: ParsedToken[];
  activeToken: ActiveToken;
  endsWithWhitespace: boolean;
} {
  const profile = getShellProfile(shellKind);
  const safeCursor = Math.max(0, Math.min(cursor, inputText.length));
  const tokens: ParsedToken[] = [];

  let currentStart = -1;
  let quote: '"' | "'" | undefined;
  let escapeNext = false;

  const finalizeToken = (end: number) => {
    if (currentStart < 0) return;
    const raw = inputText.slice(currentStart, end);
    tokens.push(createToken(raw, currentStart, end, shellKind, tokens.length));
    currentStart = -1;
    quote = undefined;
    escapeNext = false;
  };

  for (let index = 0; index < inputText.length; index += 1) {
    const ch = inputText[index];

    if (currentStart < 0) {
      if (/\s/.test(ch)) {
        continue;
      }

      currentStart = index;
      quote = undefined;
      escapeNext = false;
    }

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (profile.escapeChar && ch === profile.escapeChar && isEscapeActive(profile, quote)) {
      escapeNext = true;
      continue;
    }

    if (profile.quoteChars.includes(ch as '"' | "'")) {
      const quoteChar = ch as '"' | "'";
      if (!quote) {
        quote = quoteChar;
        continue;
      }

      if (quote === quoteChar) {
        quote = undefined;
        continue;
      }
    }

    if (!quote && /\s/.test(ch)) {
      finalizeToken(index);
    }
  }

  finalizeToken(inputText.length);

  const tokenAtCursor = tokens.find((token) => safeCursor >= token.start && safeCursor <= token.end);
  const endsWithWhitespace = safeCursor > 0 && /\s/.test(inputText[safeCursor - 1] ?? '');

  if (tokenAtCursor && !endsWithWhitespace) {
    const rawPrefix = inputText.slice(tokenAtCursor.start, safeCursor);
    const rawSuffix = inputText.slice(safeCursor, tokenAtCursor.end);
    const decodedPrefix = decodeToken(rawPrefix, shellKind);
    const decodedSuffix = decodeToken(rawSuffix, shellKind);

    return {
      tokens,
      endsWithWhitespace,
      activeToken: {
        index: tokenAtCursor.index,
        start: tokenAtCursor.start,
        end: tokenAtCursor.end,
        raw: tokenAtCursor.raw,
        value: tokenAtCursor.value,
        rawPrefix,
        rawSuffix,
        valuePrefix: decodedPrefix.value,
        valueSuffix: decodedSuffix.value,
        leadingQuote: tokenAtCursor.leadingQuote,
        openQuote: decodedPrefix.openQuote ?? tokenAtCursor.openQuote,
        closedQuote: tokenAtCursor.closedQuote,
        synthetic: false,
      },
    };
  }

  const index = tokens.filter((token) => token.end <= safeCursor).length;
  return {
    tokens,
    endsWithWhitespace,
    activeToken: {
      index,
      start: safeCursor,
      end: safeCursor,
      raw: '',
      value: '',
      rawPrefix: '',
      rawSuffix: '',
      valuePrefix: '',
      valueSuffix: '',
      closedQuote: false,
      synthetic: true,
    },
  };
}

function isPathLike(value: string, rawPrefix: string) {
  if (!value && (rawPrefix.startsWith('"') || rawPrefix.startsWith("'"))) {
    return true;
  }

  return (
    value.includes('/') ||
    value.includes('\\') ||
    value.startsWith('.') ||
    value.startsWith('~') ||
    /^[A-Za-z]:/.test(value) ||
    value.startsWith('//') ||
    rawPrefix.startsWith('"') ||
    rawPrefix.startsWith("'")
  );
}

function classifyMode(tokens: ParsedToken[], activeToken: ActiveToken): CompletionMode {
  if (activeToken.index === 0) {
    return 'command';
  }

  const commandName = tokens[0]?.value.toLowerCase();
  const subcommandName = tokens[1]?.value.toLowerCase();
  const activeValue = activeToken.valuePrefix || activeToken.value;
  const activeLower = activeValue.toLowerCase();

  if (!commandName) return 'unknown';

  if (activeLower.startsWith('-')) {
    return 'option';
  }

  if (COMMAND_SUBCOMMANDS.has(commandName) && activeToken.index === 1) {
    return 'subcommand';
  }

  if (PATH_COMMANDS.has(commandName)) {
    return 'path';
  }

  if (commandName === 'git' && ['add', 'restore', 'rm', 'diff'].includes(subcommandName ?? '')) {
    return 'path';
  }

  if (commandName === 'npm' && subcommandName === 'run' && activeToken.index === 2) {
    return 'argument';
  }

  if (isPathLike(activeValue, activeToken.rawPrefix)) {
    return 'path';
  }

  return 'argument';
}

export function createCompletionContext(args: {
  inputText: string;
  cursor: number;
  shellKind: ShellKind;
  cwd: string;
  unsafe?: boolean;
}): CompletionContext {
  const parsed = parseCommandLine(args.inputText, args.cursor, args.shellKind);
  const commandChain = parsed.tokens.slice(0, Math.max(parsed.activeToken.index, 0)).map((token) => token.value);
  const commandName = parsed.tokens[0]?.value;
  const subcommandName = parsed.tokens[1]?.value;

  return {
    inputText: args.inputText,
    cursor: Math.max(0, Math.min(args.cursor, args.inputText.length)),
    shellKind: args.shellKind,
    cwd: args.cwd,
    unsafe: Boolean(args.unsafe),
    endsWithWhitespace: parsed.endsWithWhitespace,
    tokens: parsed.tokens,
    activeToken: parsed.activeToken,
    mode: args.unsafe ? 'unknown' : classifyMode(parsed.tokens, parsed.activeToken),
    commandName,
    subcommandName,
    commandChain,
  };
}
