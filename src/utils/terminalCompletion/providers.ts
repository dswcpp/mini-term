import type { ShellKind } from '../../types';
import { buildPathCandidateText, createPathQuery } from './path';
import {
  getArgumentUsageBoost,
  getCommandUsageBoost,
  getOptionUsageBoost,
  getSubcommandUsageBoost,
  listArgumentUsageSuggestions,
} from './usage';
import type { CompletionCandidate, CompletionContext, CompletionProvider } from './types';

const COMMON_COMMANDS: Record<ShellKind, string[]> = {
  powershell: ['Get-ChildItem', 'Set-Location', 'Get-Content', 'git', 'npm', 'cargo', 'codex'],
  pwsh: ['Get-ChildItem', 'Set-Location', 'Get-Content', 'git', 'npm', 'cargo', 'codex'],
  cmd: ['dir', 'cd', 'type', 'git', 'npm', 'cargo', 'codex'],
  bash: ['ls', 'cd', 'cat', 'git', 'npm', 'cargo', 'codex'],
  zsh: ['ls', 'cd', 'cat', 'git', 'npm', 'cargo', 'codex'],
  unknown: ['git', 'npm', 'cargo', 'codex'],
};

const GIT_SUBCOMMANDS = [
  'add',
  'apply',
  'archive',
  'bisect',
  'branch',
  'checkout',
  'cherry-pick',
  'clean',
  'clone',
  'commit',
  'diff',
  'fetch',
  'grep',
  'init',
  'log',
  'merge',
  'mv',
  'pull',
  'push',
  'rebase',
  'reflog',
  'remote',
  'reset',
  'restore',
  'rm',
  'show',
  'stash',
  'status',
  'switch',
  'tag',
  'worktree',
];

const GIT_NESTED_SUBCOMMANDS: Record<string, string[]> = {
  bisect: ['bad', 'good', 'log', 'next', 'reset', 'skip', 'start', 'terms', 'visualize'],
  reflog: ['delete', 'exists', 'expire', 'show'],
  remote: ['add', 'get-url', 'prune', 'remove', 'rename', 'set-head', 'set-url', 'show', 'update'],
  stash: ['apply', 'branch', 'clear', 'drop', 'list', 'pop', 'push', 'show'],
  worktree: ['add', 'list', 'lock', 'move', 'prune', 'remove', 'repair', 'unlock'],
};

const GIT_GLOBAL_OPTIONS = [
  '--help',
  '--version',
  '--paginate',
  '--no-pager',
  '--git-dir',
  '--work-tree',
  '-C',
  '-c',
];

const GIT_SUBCOMMAND_OPTIONS: Record<string, string[]> = {
  add: ['--all', '--patch', '--update'],
  branch: ['--all', '--delete', '--move', '--verbose'],
  checkout: ['--detach', '--ours', '--theirs', '--track'],
  clean: ['--dry-run', '--force', '-d', '-x'],
  clone: ['--branch', '--depth', '--recurse-submodules'],
  commit: ['--all', '--amend', '--message', '--no-verify', '--signoff'],
  diff: ['--cached', '--name-only', '--staged', '--stat'],
  fetch: ['--all', '--depth', '--dry-run', '--force', '--prune', '--tags'],
  log: ['--decorate', '--graph', '--oneline', '--patch', '--stat'],
  merge: ['--abort', '--no-ff', '--squash'],
  pull: ['--all', '--ff-only', '--prune', '--rebase', '--tags'],
  push: ['--all', '--dry-run', '--follow-tags', '--force', '--set-upstream', '--tags'],
  rebase: ['--abort', '--continue', '--interactive', '--onto'],
  reset: ['--hard', '--mixed', '--soft'],
  restore: ['--source', '--staged', '--worktree'],
  show: ['--name-only', '--oneline', '--stat'],
  status: ['--branch', '--porcelain', '--short', '--untracked-files'],
  switch: ['--create', '--detach', '--force-create', '--track'],
  tag: ['--annotate', '--delete', '--list', '--message'],
};

const NPM_SUBCOMMANDS = ['run', 'install', 'test', 'exec', 'create'];
const CARGO_SUBCOMMANDS = ['build', 'run', 'test', 'check', 'fmt', 'clippy'];
const GIT_ARGUMENT_SUBCOMMANDS = new Set(['branch', 'checkout', 'fetch', 'merge', 'pull', 'push', 'rebase', 'switch', 'tag']);
const GIT_REMOTE_ARGUMENT_SUBCOMMANDS = new Set(['fetch', 'pull', 'push']);
const GIT_REF_ARGUMENT_SUBCOMMANDS = new Set(['branch', 'checkout', 'merge', 'rebase', 'switch', 'tag']);
const GIT_REMOTE_TARGET_ACTIONS = new Set(['get-url', 'prune', 'remove', 'rename', 'set-head', 'set-url', 'show']);

function startsWithIgnoreCase(value: string, prefix: string) {
  return value.toLowerCase().startsWith(prefix.toLowerCase());
}

function createBasicCandidate(args: {
  id: string;
  label: string;
  detail: string;
  kind: CompletionCandidate['kind'];
  source: string;
  priority: number;
  replaceStart: number;
  replaceEnd: number;
  commitSuffix?: string;
}): CompletionCandidate {
  return {
    id: args.id,
    label: args.label,
    insertText: args.label,
    detail: args.detail,
    kind: args.kind,
    source: args.source,
    priority: args.priority,
    replaceStart: args.replaceStart,
    replaceEnd: args.replaceEnd,
    commitSuffix: args.commitSuffix,
  };
}

function createGitArgumentCandidate(args: {
  id: string;
  label: string;
  detail: string;
  source: string;
  priority: number;
  replaceStart: number;
  replaceEnd: number;
  commitSuffix?: string;
  kind?: CompletionCandidate['kind'];
}): CompletionCandidate {
  return createBasicCandidate({
    id: args.id,
    label: args.label,
    detail: args.detail,
    kind: args.kind ?? 'argument',
    source: args.source,
    priority: args.priority,
    replaceStart: args.replaceStart,
    replaceEnd: args.replaceEnd,
    commitSuffix: args.commitSuffix ?? ' ',
  });
}

const historyProvider: CompletionProvider = {
  id: 'history',
  priority: 20,
  supports: (context) =>
    context.mode === 'command' && context.cursor === context.inputText.length && context.activeToken.index === 0,
  getCandidates: async (context, runtime) => {
    const prefix = context.inputText.trimStart();
    if (!prefix) return [];

    const values = Array.from(
      new Set([...runtime.sessionCommands.slice().reverse(), runtime.lastCommand].filter(Boolean) as string[]),
    ).filter((command) => startsWithIgnoreCase(command, prefix));

    return values.slice(0, 4).map((command, index) => ({
      id: `history-${index}-${command}`,
      label: command,
      insertText: command,
      detail: 'History command',
      kind: 'history',
      priority: 20,
      replaceStart: 0,
      replaceEnd: context.inputText.length,
      source: 'history',
    }));
  },
};

const commandProvider: CompletionProvider = {
  id: 'command',
  priority: 100,
  supports: (context) => context.mode === 'command',
  getCandidates: async (context, runtime) => {
    const prefix = context.activeToken.valuePrefix || context.activeToken.value;
    if (!prefix) return [];

    const commands = COMMON_COMMANDS[context.shellKind] ?? COMMON_COMMANDS.unknown;
    return commands
      .filter((command) => startsWithIgnoreCase(command, prefix))
      .map((command, index) =>
        createBasicCandidate({
          id: `command-${index}-${command}`,
          label: command,
          detail: 'Common command',
          kind: 'command',
          source: 'command',
          priority: 100 + getCommandUsageBoost(runtime.completionUsage, command, runtime.usageScopeKey),
          replaceStart: context.activeToken.start,
          replaceEnd: context.activeToken.end,
          commitSuffix: ' ',
        }),
      );
  },
};

const gitProvider: CompletionProvider = {
  id: 'git',
  priority: 90,
  supports: (context) => context.commandName?.toLowerCase() === 'git',
  getCandidates: async (context, runtime) => {
    const prefix = context.activeToken.valuePrefix || context.activeToken.value;
    const subcommand = context.subcommandName?.toLowerCase() ?? '';
    const repoData = await runtime.readGitCompletionData(context.cwd);
    const usageScopeKey = repoData?.repoRoot ?? runtime.usageScopeKey;

    if (context.mode === 'subcommand' && context.activeToken.index === 1) {
      return GIT_SUBCOMMANDS.filter((item) => startsWithIgnoreCase(item, prefix)).map((item, index) =>
        createBasicCandidate({
          id: `git-subcommand-${index}-${item}`,
          label: item,
          detail: 'Git subcommand',
          kind: 'subcommand',
          source: 'git',
          priority: 90 + getSubcommandUsageBoost(runtime.completionUsage, 'git', item, usageScopeKey),
          replaceStart: context.activeToken.start,
          replaceEnd: context.activeToken.end,
          commitSuffix: ' ',
        }),
      );
    }

    if (context.mode === 'option') {
      const optionPool = Array.from(
        new Set([...GIT_GLOBAL_OPTIONS, ...(GIT_SUBCOMMAND_OPTIONS[subcommand] ?? [])]),
      );

      return optionPool
        .filter((item) => startsWithIgnoreCase(item, prefix))
        .map((item, index) =>
          createBasicCandidate({
            id: `git-option-${index}-${item}`,
            label: item,
            detail: subcommand ? `Git ${subcommand} option` : 'Git option',
            kind: 'option',
            source: 'git',
            priority: 85 + getOptionUsageBoost(runtime.completionUsage, 'git', item, subcommand || undefined, usageScopeKey),
            replaceStart: context.activeToken.start,
            replaceEnd: context.activeToken.end,
            commitSuffix: ' ',
          }),
        );
    }

    if (context.mode === 'argument') {
      const nestedSubcommands = GIT_NESTED_SUBCOMMANDS[subcommand];
      const nestedAction = context.tokens[2]?.value.toLowerCase();

      if (nestedSubcommands && context.activeToken.index === 2) {
        return nestedSubcommands
          .filter((item) => startsWithIgnoreCase(item, prefix))
          .map((item, index) =>
            createGitArgumentCandidate({
              id: `git-nested-${subcommand}-${index}-${item}`,
              label: item,
              detail: `Git ${subcommand} action`,
              kind: 'subcommand',
              source: 'git',
              priority: 83,
              replaceStart: context.activeToken.start,
              replaceEnd: context.activeToken.end,
            }),
          );
      }

      const candidates: CompletionCandidate[] = [];

      if (repoData) {
        if (GIT_REMOTE_ARGUMENT_SUBCOMMANDS.has(subcommand) && context.activeToken.index === 2) {
          candidates.push(
            ...repoData.remotes
              .filter((item) => startsWithIgnoreCase(item, prefix))
              .map((item, index) =>
                createGitArgumentCandidate({
                  id: `git-remote-${subcommand}-${index}-${item}`,
                  label: item,
                  detail: 'Git remote',
                  source: 'git',
                  priority: 86 + getArgumentUsageBoost(runtime.completionUsage, 'git', item, subcommand, usageScopeKey),
                  replaceStart: context.activeToken.start,
                  replaceEnd: context.activeToken.end,
                }),
              ),
          );
        }

        if (subcommand === 'remote' && nestedAction && GIT_REMOTE_TARGET_ACTIONS.has(nestedAction) && context.activeToken.index === 3) {
          candidates.push(
            ...repoData.remotes
              .filter((item) => startsWithIgnoreCase(item, prefix))
              .map((item, index) =>
                createGitArgumentCandidate({
                  id: `git-remote-target-${nestedAction}-${index}-${item}`,
                  label: item,
                  detail: 'Git remote',
                  source: 'git',
                  priority: 86,
                  replaceStart: context.activeToken.start,
                  replaceEnd: context.activeToken.end,
                }),
              ),
          );
        }

        const shouldSuggestRefs =
          GIT_REF_ARGUMENT_SUBCOMMANDS.has(subcommand)
          || (GIT_REMOTE_ARGUMENT_SUBCOMMANDS.has(subcommand) && context.activeToken.index >= 3);

        if (shouldSuggestRefs) {
          candidates.push(
            ...repoData.localBranches
              .filter((item) => startsWithIgnoreCase(item, prefix))
              .map((item, index) =>
                createGitArgumentCandidate({
                  id: `git-local-branch-${subcommand}-${index}-${item}`,
                  label: item,
                  detail: repoData.currentBranch === item ? 'Current branch' : 'Git branch',
                  source: 'git',
                  priority: 85 + getArgumentUsageBoost(runtime.completionUsage, 'git', item, subcommand, usageScopeKey),
                  replaceStart: context.activeToken.start,
                  replaceEnd: context.activeToken.end,
                }),
              ),
          );

          candidates.push(
            ...repoData.remoteBranches
              .filter((item) => startsWithIgnoreCase(item, prefix))
              .map((item, index) =>
                createGitArgumentCandidate({
                  id: `git-remote-branch-${subcommand}-${index}-${item}`,
                  label: item,
                  detail: 'Git remote branch',
                  source: 'git',
                  priority: 84 + getArgumentUsageBoost(runtime.completionUsage, 'git', item, subcommand, usageScopeKey),
                  replaceStart: context.activeToken.start,
                  replaceEnd: context.activeToken.end,
                }),
              ),
          );

          candidates.push(
            ...repoData.tags
              .filter((item) => startsWithIgnoreCase(item, prefix))
              .map((item, index) =>
                createGitArgumentCandidate({
                  id: `git-tag-${subcommand}-${index}-${item}`,
                  label: item,
                  detail: 'Git tag',
                  source: 'git',
                  priority: 82 + getArgumentUsageBoost(runtime.completionUsage, 'git', item, subcommand, usageScopeKey),
                  replaceStart: context.activeToken.start,
                  replaceEnd: context.activeToken.end,
                }),
              ),
          );
        }
      }

      if (GIT_ARGUMENT_SUBCOMMANDS.has(subcommand)) {
        candidates.push(
          ...listArgumentUsageSuggestions(runtime.completionUsage, 'git', subcommand, usageScopeKey)
            .filter((item) => startsWithIgnoreCase(item.value, prefix))
            .map((item, index) =>
              createGitArgumentCandidate({
                id: `git-argument-${subcommand}-${index}-${item.value}`,
                label: item.value,
                detail: `Git ${subcommand} target`,
                source: 'git',
                priority: 84 + getArgumentUsageBoost(runtime.completionUsage, 'git', item.value, subcommand, usageScopeKey),
                replaceStart: context.activeToken.start,
                replaceEnd: context.activeToken.end,
              }),
            ),
        );
      }

      return candidates;
    }

    return [];
  },
};

const npmProvider: CompletionProvider = {
  id: 'npm',
  priority: 88,
  supports: (context) => context.commandName?.toLowerCase() === 'npm',
  getCandidates: async (context, runtime) => {
    const prefix = context.activeToken.valuePrefix || context.activeToken.value;

    if (context.mode === 'subcommand' && context.activeToken.index === 1) {
      return NPM_SUBCOMMANDS.filter((item) => startsWithIgnoreCase(item, prefix)).map((item, index) =>
        createBasicCandidate({
          id: `npm-subcommand-${index}-${item}`,
          label: item,
          detail: 'npm subcommand',
          kind: 'subcommand',
          source: 'npm',
          priority: 88 + getSubcommandUsageBoost(runtime.completionUsage, 'npm', item, runtime.usageScopeKey),
          replaceStart: context.activeToken.start,
          replaceEnd: context.activeToken.end,
          commitSuffix: ' ',
        }),
      );
    }

    if (context.subcommandName?.toLowerCase() === 'run' && context.activeToken.index === 2) {
      const scripts = await runtime.readPackageScripts(context.cwd);
      return scripts
        .filter((item) => startsWithIgnoreCase(item, prefix))
        .map((item, index) =>
          createBasicCandidate({
            id: `npm-script-${index}-${item}`,
            label: item,
            detail: 'npm script',
            kind: 'argument',
            source: 'npm',
            priority: 86 + getArgumentUsageBoost(runtime.completionUsage, 'npm', item, 'run', runtime.usageScopeKey),
            replaceStart: context.activeToken.start,
            replaceEnd: context.activeToken.end,
            commitSuffix: ' ',
          }),
        );
    }

    return [];
  },
};

const cargoProvider: CompletionProvider = {
  id: 'cargo',
  priority: 87,
  supports: (context) => context.commandName?.toLowerCase() === 'cargo',
  getCandidates: async (context, runtime) => {
    if (!(context.mode === 'subcommand' && context.activeToken.index === 1)) {
      return [];
    }

    const prefix = context.activeToken.valuePrefix || context.activeToken.value;
    return CARGO_SUBCOMMANDS.filter((item) => startsWithIgnoreCase(item, prefix)).map((item, index) =>
      createBasicCandidate({
        id: `cargo-subcommand-${index}-${item}`,
        label: item,
        detail: 'Cargo subcommand',
        kind: 'subcommand',
        source: 'cargo',
        priority: 87 + getSubcommandUsageBoost(runtime.completionUsage, 'cargo', item, runtime.usageScopeKey),
        replaceStart: context.activeToken.start,
        replaceEnd: context.activeToken.end,
        commitSuffix: ' ',
      }),
    );
  },
};

const pathProvider: CompletionProvider = {
  id: 'path',
  priority: 60,
  supports: (context) => context.mode === 'path',
  getCandidates: async (context, runtime) => {
    const query = createPathQuery(context.cwd, context.activeToken);
    const entries = await runtime.readDirectory(query.directoryPath);

    return entries
      .filter((entry) => startsWithIgnoreCase(entry.name, query.basenamePrefix))
      .map((entry, index) => {
        const built = buildPathCandidateText({
          activeToken: context.activeToken,
          entry,
          shellKind: context.shellKind,
          displayPrefix: query.displayPrefix,
          separator: query.separator,
        });

        return {
          id: `path-${index}-${entry.path}`,
          label: built.label,
          insertText: built.insertText,
          detail: entry.isDir ? 'Directory' : 'File',
          kind: 'path' as const,
          source: 'path',
          priority: entry.isDir ? 70 : 60,
          replaceStart: context.activeToken.start,
          replaceEnd: context.activeToken.end,
          commitSuffix: built.commitSuffix,
          isDir: entry.isDir,
        };
      });
  },
};

const PROVIDERS: CompletionProvider[] = [
  historyProvider,
  commandProvider,
  gitProvider,
  npmProvider,
  cargoProvider,
  pathProvider,
];

export async function collectCompletionCandidates(
  context: CompletionContext,
  runtime: Parameters<CompletionProvider['getCandidates']>[1],
) {
  const candidates = await Promise.all(
    PROVIDERS.filter((provider) => provider.supports(context)).map((provider) =>
      provider.getCandidates(context, runtime),
    ),
  );

  return candidates.flat();
}
