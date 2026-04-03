// === ????? ===

export type ProjectTreeItem = string | ProjectGroup;

export interface ProjectGroup {
  id: string;
  name: string;
  collapsed: boolean;
  children: ProjectTreeItem[];
}

export interface AppConfig {
  projects: ProjectConfig[];
  projectTree?: ProjectTreeItem[];
  // ???????????Rust ?????????
  projectGroups?: { id: string; name: string; collapsed: boolean; projectIds: string[] }[];
  projectOrdering?: string[];
  defaultShell: string;
  availableShells: ShellConfig[];
  uiFontSize: number;
  terminalFontSize: number;
  layoutSizes?: number[];
  theme: ThemeConfig;
  middleColumnSizes?: number[];
}

export type ThemePresetId = 'warm-carbon' | 'ghostty-dark' | 'ghostty-light';
export type ThemeWindowEffect = 'auto' | 'mica' | 'acrylic' | 'blur' | 'none';

export interface ThemeConfig {
  preset: ThemePresetId;
  windowEffect: ThemeWindowEffect;
}

export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  savedLayout?: SavedProjectLayout;
  expandedDirs?: string[];
}

export interface ShellConfig {
  name: string;
  command: string;
  args?: string[];
}

// === ????? ===

export interface SavedPane {
  shellName: string;
  runCommand?: string;
}

export type SavedSplitNode =
  | { type: 'leaf'; pane: SavedPane }
  | { type: 'split'; direction: 'horizontal' | 'vertical'; children: SavedSplitNode[]; sizes: number[] };

export interface SavedTab {
  customTitle?: string;
  splitLayout: SavedSplitNode;
}

export interface SavedProjectLayout {
  tabs: SavedTab[];
  activeTabIndex: number;
}

// === ????? ===

export type PaneStatus = 'idle' | 'ai-idle' | 'ai-working' | 'error';
export type ShellKind = 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'zsh' | 'unknown';
export type SessionMode = 'human' | 'agent' | 'task';
export type SessionPhase = 'starting' | 'ready' | 'running' | 'waiting-input' | 'error' | 'exited';

export interface CommandBlock {
  id: string;
  command: string;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  status: 'running' | 'completed' | 'success' | 'error' | 'interrupted';
}

export interface TerminalSessionMeta {
  sessionId: string;
  ptyId: number;
  shellKind: ShellKind;
  mode: SessionMode;
  phase: SessionPhase;
  cwd?: string;
  title?: string;
  lastCommand?: string;
  lastExitCode?: number;
  commands: CommandBlock[];
  activeCommand?: CommandBlock;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectState {
  id: string;
  tabs: TerminalTab[];
  activeTabId: string;
}

export interface TerminalTab {
  id: string;
  customTitle?: string;
  splitLayout: SplitNode;
  status: PaneStatus;
}

export type SplitNode =
  | { type: 'leaf'; pane: PaneState }
  | { type: 'split'; direction: 'horizontal' | 'vertical'; children: SplitNode[]; sizes: number[] };

export interface PaneState {
  id: string;
  sessionId: string;
  shellName: string;
  runCommand?: string;
  status: PaneStatus;
  mode: SessionMode;
  phase: SessionPhase;
  ptyId: number;
}

// === AI ?? ===

export interface AiSession {
  id: string;
  sessionType: 'claude' | 'codex';
  title: string;
  timestamp: string; // ISO 8601
}

// === ??? ===

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  ignored?: boolean;
  children?: FileEntry[];
}

// === Tauri ?? payload ===

export interface PtyOutputPayload {
  ptyId: number;
  data: string;
}

export interface PtyExitPayload {
  ptyId: number;
  exitCode: number;
}

export interface PtyStatusChangePayload {
  ptyId: number;
  status: PaneStatus;
}

export interface PtySessionCreatedPayload {
  sessionId: string;
  ptyId: number;
  shell: string;
  shellKind: ShellKind;
  cwd: string;
  mode: SessionMode;
  phase: SessionPhase;
  createdAt: number;
  updatedAt: number;
}

export interface PtySessionPhasePayload {
  ptyId: number;
  phase: SessionPhase;
  lastExitCode?: number;
  updatedAt: number;
}

export interface PtySessionCommandPayload {
  ptyId: number;
  command: string;
  updatedAt: number;
}

export interface FsChangePayload {
  projectPath: string;
  path: string;
  kind: string;
}

// === Git ?? ===

export type GitStatusType = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export interface GitFileStatus {
  path: string;
  oldPath?: string;
  status: GitStatusType;
  statusLabel: string; // "M", "A", "D", "R", "?", "C"
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffLine {
  kind: 'add' | 'delete' | 'context';
  content: string;
  oldLineno?: number;
  newLineno?: number;
}

export interface GitDiffResult {
  oldContent: string;
  newContent: string;
  hunks: DiffHunk[];
  isBinary: boolean;
  tooLarge: boolean;
}

// === ???? ===

export interface FileContentResult {
  content: string;
  isBinary: boolean;
  tooLarge: boolean;
}

// === Git ?? ===

export interface GitRepoInfo {
  name: string;
  path: string;
}

export interface GitCommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  timestamp: number;
}

export interface CommitFileInfo {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
}
