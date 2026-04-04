import type { CompletionUsageStats, FileEntry, GitCompletionData, ShellKind } from '../../types';

export type CompletionMode =
  | 'command'
  | 'subcommand'
  | 'option'
  | 'argument'
  | 'path'
  | 'unknown';

export type CompletionCandidateKind =
  | 'command'
  | 'subcommand'
  | 'option'
  | 'argument'
  | 'path'
  | 'history';

export interface ParsedToken {
  index: number;
  start: number;
  end: number;
  raw: string;
  value: string;
  leadingQuote?: '"' | "'";
  openQuote?: '"' | "'";
  closedQuote: boolean;
}

export interface ActiveToken {
  index: number;
  start: number;
  end: number;
  raw: string;
  value: string;
  rawPrefix: string;
  rawSuffix: string;
  valuePrefix: string;
  valueSuffix: string;
  leadingQuote?: '"' | "'";
  openQuote?: '"' | "'";
  closedQuote: boolean;
  synthetic: boolean;
}

export interface CompletionContext {
  inputText: string;
  cursor: number;
  shellKind: ShellKind;
  cwd: string;
  unsafe: boolean;
  endsWithWhitespace: boolean;
  tokens: ParsedToken[];
  activeToken: ActiveToken;
  mode: CompletionMode;
  commandName?: string;
  subcommandName?: string;
  commandChain: string[];
}

export interface CompletionCandidate {
  id: string;
  label: string;
  insertText: string;
  kind: CompletionCandidateKind;
  detail: string;
  priority: number;
  replaceStart: number;
  replaceEnd: number;
  commitSuffix?: string;
  source: string;
  isDir?: boolean;
}

export interface CompletionEdit {
  replaceStart: number;
  replaceEnd: number;
  newText: string;
  nextCursor?: number;
}

export interface CompletionResult {
  candidates: CompletionCandidate[];
  commonPrefixEdit?: CompletionEdit;
}

export interface ProviderRuntime {
  projectPath: string;
  usageScopeKey?: string;
  sessionCommands: string[];
  lastCommand?: string;
  completionUsage?: CompletionUsageStats;
  readDirectory: (directoryPath: string) => Promise<FileEntry[]>;
  readPackageScripts: (cwd: string) => Promise<string[]>;
  readGitCompletionData: (cwd: string) => Promise<GitCompletionData | null>;
}

export interface CompletionProvider {
  id: string;
  priority: number;
  supports: (context: CompletionContext) => boolean;
  getCandidates: (
    context: CompletionContext,
    runtime: ProviderRuntime,
  ) => Promise<CompletionCandidate[]>;
}
