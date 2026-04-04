import { describe, expect, it } from 'vitest';
import {
  createEmptyCompletionUsage,
  getArgumentUsageBoost,
  getCommandUsageBoost,
  getOptionUsageBoost,
  getSubcommandUsageBoost,
  listArgumentUsageSuggestions,
  normalizeCompletionUsage,
  recordCompletionUsage,
} from './usage';

describe('terminalCompletion usage tracking', () => {
  it('records command, subcommand, option, and argument usage from executed commands', () => {
    const usage = recordCompletionUsage(undefined, 'git fetch origin --all --prune', 'bash');

    expect(usage.commands.git).toBe(1);
    expect(usage.subcommands['git fetch']).toBe(1);
    expect(usage.options['git fetch --all']).toBe(1);
    expect(usage.options['git fetch --prune']).toBe(1);
    expect(usage.arguments['git fetch origin']).toBe(1);
  });

  it('records scoped usage separately from the global fallback bucket', () => {
    const usage = recordCompletionUsage(undefined, 'git fetch --all', 'bash', '/workspace/project-a');

    expect(usage.commands.git).toBeUndefined();
    expect(usage.scopes?.['/workspace/project-a']?.commands.git).toBe(1);
    expect(usage.scopes?.['/workspace/project-a']?.options['git fetch --all']).toBe(1);
  });

  it('normalizes missing maps to empty records', () => {
    const usage = normalizeCompletionUsage(undefined);

    expect(usage).toEqual(createEmptyCompletionUsage());
  });

  it('converts recorded counts into bounded priority boosts', () => {
    const usage = recordCompletionUsage(
      recordCompletionUsage(undefined, 'npm run dev', 'bash'),
      'npm run dev',
      'bash',
    );

    expect(getCommandUsageBoost(usage, 'npm')).toBeGreaterThan(0);
    expect(getSubcommandUsageBoost(usage, 'npm', 'run')).toBeGreaterThan(0);
    expect(getArgumentUsageBoost(usage, 'npm', 'dev', 'run')).toBeGreaterThan(0);
    expect(getOptionUsageBoost(usage, 'git', '--all', 'fetch')).toBe(0);
  });

  it('reads boosts from the matching scope only', () => {
    const usage = recordCompletionUsage(undefined, 'git fetch --all', 'bash', '/workspace/project-a');

    expect(getSubcommandUsageBoost(usage, 'git', 'fetch', '/workspace/project-a')).toBeGreaterThan(0);
    expect(getSubcommandUsageBoost(usage, 'git', 'fetch', '/workspace/project-b')).toBe(0);
  });

  it('lists scoped argument suggestions ordered by usage frequency', () => {
    let usage = recordCompletionUsage(undefined, 'git switch main', 'bash');
    usage = recordCompletionUsage(usage, 'git switch develop', 'bash');
    usage = recordCompletionUsage(usage, 'git switch main', 'bash');

    expect(listArgumentUsageSuggestions(usage, 'git', 'switch')).toEqual([
      { value: 'main', count: 2 },
      { value: 'develop', count: 1 },
    ]);
  });

  it('trims oversized usage buckets to keep config bounded', () => {
    const commands = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`cmd-${index}`, index + 1]));
    const usage = normalizeCompletionUsage({
      commands,
      subcommands: {},
      options: {},
      arguments: {},
      scopes: {
        '/workspace/project': {
          commands,
          subcommands: {},
          options: {},
          arguments: {},
        },
      },
    });

    expect(Object.keys(usage.commands)).toHaveLength(240);
    expect(usage.commands['cmd-299']).toBe(300);
    expect(usage.commands['cmd-0']).toBeUndefined();
    expect(Object.keys(usage.scopes?.['/workspace/project']?.commands ?? {})).toHaveLength(240);
  });
});
