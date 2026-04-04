import type { CompletionUsageBucket, CompletionUsageStats, ShellKind } from '../../types';
import { parseCommandLine } from './parser';
import { normalizePath } from './path';

const MAX_USAGE_COUNT = 999;
const MAX_USAGE_ITEMS_PER_BUCKET = 240;

function normalizeToken(value: string) {
  return value.trim().toLowerCase();
}

function cloneUsageMap(source?: Record<string, number>) {
  return { ...(source ?? {}) };
}

function trimUsageMap(source: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(source)
      .sort((left, right) => {
        if (left[1] !== right[1]) {
          return right[1] - left[1];
        }
        return left[0].localeCompare(right[0], undefined, { sensitivity: 'base' });
      })
      .slice(0, MAX_USAGE_ITEMS_PER_BUCKET),
  );
}

function createEmptyUsageBucket(): CompletionUsageBucket {
  return {
    commands: {},
    subcommands: {},
    options: {},
    arguments: {},
  };
}

export function createEmptyCompletionUsage(): CompletionUsageStats {
  return {
    ...createEmptyUsageBucket(),
    scopes: {},
  };
}

function normalizeUsageBucket(bucket?: CompletionUsageBucket): CompletionUsageBucket {
  return {
    commands: trimUsageMap(cloneUsageMap(bucket?.commands)),
    subcommands: trimUsageMap(cloneUsageMap(bucket?.subcommands)),
    options: trimUsageMap(cloneUsageMap(bucket?.options)),
    arguments: trimUsageMap(cloneUsageMap(bucket?.arguments)),
  };
}

export function normalizeCompletionUsage(usage?: CompletionUsageStats): CompletionUsageStats {
  return {
    ...normalizeUsageBucket(usage),
    scopes: Object.fromEntries(
      Object.entries(usage?.scopes ?? {}).map(([scopeKey, bucket]) => [normalizeUsageScopeKey(scopeKey) ?? scopeKey, normalizeUsageBucket(bucket)]),
    ),
  };
}

export function normalizeUsageScopeKey(scopeKey?: string) {
  const trimmed = scopeKey?.trim();
  if (!trimmed) return undefined;
  return normalizePath(trimmed);
}

function bumpCounter(target: Record<string, number>, key: string | undefined) {
  if (!key) return;
  target[key] = Math.min(MAX_USAGE_COUNT, (target[key] ?? 0) + 1);
}

function buildScopedKey(parts: Array<string | undefined>) {
  return parts
    .map((part) => (part ? normalizeToken(part) : ''))
    .filter(Boolean)
    .join(' ');
}

export function recordCompletionUsage(
  usage: CompletionUsageStats | undefined,
  commandLine: string,
  shellKind: ShellKind,
  scopeKey?: string,
): CompletionUsageStats {
  const tokens = parseCommandLine(commandLine, commandLine.length, shellKind).tokens
    .map((token) => token.value.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    return normalizeCompletionUsage(usage);
  }

  const nextUsage = normalizeCompletionUsage(usage);
  const normalizedScopeKey = normalizeUsageScopeKey(scopeKey);
  const scopeBucket = normalizedScopeKey
    ? (nextUsage.scopes?.[normalizedScopeKey] ?? createEmptyUsageBucket())
    : nextUsage;
  const commandName = normalizeToken(tokens[0] ?? '');
  const subcommandName = tokens[1] && !tokens[1].startsWith('-') ? normalizeToken(tokens[1]) : undefined;

  bumpCounter(scopeBucket.commands, commandName);

  if (subcommandName) {
    bumpCounter(scopeBucket.subcommands, buildScopedKey([commandName, subcommandName]));
  }

  const optionStartIndex = subcommandName ? 2 : 1;
  for (let index = optionStartIndex; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (!token) continue;

    if (token.startsWith('-')) {
      bumpCounter(scopeBucket.options, buildScopedKey([commandName, subcommandName, token]));
      continue;
    }

    const previous = tokens[index - 1] ?? '';
    if (previous.startsWith('-')) {
      continue;
    }

    bumpCounter(scopeBucket.arguments, buildScopedKey([commandName, subcommandName, token]));
  }

  if (normalizedScopeKey) {
    nextUsage.scopes = {
      ...(nextUsage.scopes ?? {}),
      [normalizedScopeKey]: normalizeUsageBucket(scopeBucket),
    };
  }

  return nextUsage;
}

function getUsageBucket(usage: CompletionUsageStats | undefined, scopeKey?: string) {
  const normalizedScopeKey = normalizeUsageScopeKey(scopeKey);
  if (!normalizedScopeKey) {
    return usage;
  }

  return usage?.scopes?.[normalizedScopeKey];
}

function getUsageCount(target: Record<string, number> | undefined, key: string) {
  return target?.[normalizeToken(key)] ?? 0;
}

function toUsageBoost(count: number) {
  return Math.min(24, count * 4);
}

export function getCommandUsageBoost(usage: CompletionUsageStats | undefined, commandName: string, scopeKey?: string) {
  return toUsageBoost(getUsageCount(getUsageBucket(usage, scopeKey)?.commands, commandName));
}

export function getSubcommandUsageBoost(
  usage: CompletionUsageStats | undefined,
  commandName: string,
  subcommandName: string,
  scopeKey?: string,
) {
  return toUsageBoost(getUsageCount(getUsageBucket(usage, scopeKey)?.subcommands, buildScopedKey([commandName, subcommandName])));
}

export function getOptionUsageBoost(
  usage: CompletionUsageStats | undefined,
  commandName: string,
  optionName: string,
  subcommandName?: string,
  scopeKey?: string,
) {
  return toUsageBoost(getUsageCount(getUsageBucket(usage, scopeKey)?.options, buildScopedKey([commandName, subcommandName, optionName])));
}

export function getArgumentUsageBoost(
  usage: CompletionUsageStats | undefined,
  commandName: string,
  argumentValue: string,
  subcommandName?: string,
  scopeKey?: string,
) {
  return toUsageBoost(getUsageCount(getUsageBucket(usage, scopeKey)?.arguments, buildScopedKey([commandName, subcommandName, argumentValue])));
}

export function listArgumentUsageSuggestions(
  usage: CompletionUsageStats | undefined,
  commandName: string,
  subcommandName?: string,
  scopeKey?: string,
) {
  const scopedPrefix = buildScopedKey([commandName, subcommandName]);
  if (!scopedPrefix) return [];

  return Object.entries(getUsageBucket(usage, scopeKey)?.arguments ?? {})
    .filter(([key]) => key.startsWith(`${scopedPrefix} `))
    .map(([key, count]) => ({
      value: key.slice(scopedPrefix.length + 1),
      count,
    }))
    .filter((item) => item.value.length > 0)
    .sort((left, right) => {
      if (left.count !== right.count) {
        return right.count - left.count;
      }
      return left.value.localeCompare(right.value, undefined, { sensitivity: 'base' });
    });
}
