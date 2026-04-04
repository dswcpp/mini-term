export type ProjectTreeItem = string | ProjectGroup;

export interface ProjectGroup {
  id: string;
  name: string;
  collapsed: boolean;
  children: ProjectTreeItem[];
}

export interface LegacyProjectConfig {
  id: string;
  name: string;
  path: string;
  savedLayout?: SavedProjectLayout;
  expandedDirs?: string[];
}

export type SettingsPage = 'terminal' | 'theme' | 'system' | 'shortcuts' | 'about';
export type PreviewMode = 'source' | 'preview';
export type InteractionDialogMode = 'alert' | 'confirm' | 'prompt';
export type InteractionDialogTone = 'neutral' | 'warning' | 'danger';

export interface CompletionUsageBucket {
  commands: Record<string, number>;
  subcommands: Record<string, number>;
  options: Record<string, number>;
  arguments: Record<string, number>;
}

export interface CompletionUsageStats extends CompletionUsageBucket {
  scopes?: Record<string, CompletionUsageBucket>;
}

export type ThemePresetId = 'warm-carbon' | 'ghostty-dark' | 'ghostty-light';
export type ThemeWindowEffect = 'auto' | 'mica' | 'acrylic' | 'blur' | 'none';

export interface ThemeConfig {
  preset: ThemePresetId;
  windowEffect: ThemeWindowEffect;
}

export type WorkspaceRootRole = 'primary' | 'member';

export interface WorkspaceRootConfig {
  id: string;
  name: string;
  path: string;
  role: WorkspaceRootRole;
}

export interface WorkspaceConfig {
  id: string;
  name: string;
  roots: WorkspaceRootConfig[];
  pinned: boolean;
  accent?: string;
  savedLayout?: SavedProjectLayout;
  expandedDirsByRoot?: Record<string, string[]>;
  createdAt: number;
  lastOpenedAt: number;
}

export interface RecentWorkspaceEntry {
  id: string;
  name: string;
  rootPaths: string[];
  accent?: string;
  lastOpenedAt: number;
  savedLayout?: SavedProjectLayout;
  expandedDirsByRoot?: Record<string, string[]>;
}

export interface AppConfig {
  workspaces: WorkspaceConfig[];
  recentWorkspaces: RecentWorkspaceEntry[];
  lastWorkspaceId?: string;
  projects?: LegacyProjectConfig[];
  projectTree?: ProjectTreeItem[];
  projectGroups?: { id: string; name: string; collapsed: boolean; projectIds: string[] }[];
  projectOrdering?: string[];
  defaultShell: string;
  availableShells: ShellConfig[];
  uiFontSize: number;
  terminalFontSize: number;
  layoutSizes?: number[];
  theme: ThemeConfig;
  middleColumnSizes?: number[];
  workspaceSidebarSizes?: number[];
  completionUsage?: CompletionUsageStats;
}

export interface ShellConfig {
  name: string;
  command: string;
  args?: string[];
}

export interface SavedPane {
  shellName: string;
  runCommand?: string;
  runProfile?: RunProfile;
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

export interface RunProfile {
  savedCommand?: string;
  lastRunAt?: number;
  lastExitCode?: number;
  usageScope?: string;
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
  usageScope?: string;
  runProfile?: RunProfile;
  commands: CommandBlock[];
  activeCommand?: CommandBlock;
  createdAt: number;
  updatedAt: number;
}

export interface TerminalSessionState extends TerminalSessionMeta {}

export interface TerminalViewState {
  viewId: string;
  paneId: string;
  tabId?: string;
  workspaceId?: string;
  sessionId: string;
  isVisible: boolean;
  isFocused: boolean;
  cols?: number;
  rows?: number;
  mountedAt: number;
  updatedAt: number;
}

export interface TerminalUiState {
  runProfileInspectorPaneId: string | null;
}

export type TerminalOrchestratorAction =
  | { type: 'open-session'; sessionId: string; ptyId: number }
  | { type: 'restart-session'; sessionId: string; ptyId: number; previousPtyId?: number }
  | { type: 'close-session'; sessionId: string; ptyId?: number }
  | { type: 'write-input'; sessionId: string; bytes: number }
  | { type: 'resize-session'; sessionId: string; cols: number; rows: number }
  | { type: 'run-command'; sessionId: string; command: string };

export interface WorkspaceState {
  id: string;
  tabs: WorkspaceTab[];
  activeTabId: string;
}

export interface PaneLayoutState {
  id: string;
  sessionId: string;
  shellName: string;
  runCommand?: string;
  runProfile?: RunProfile;
  mode: SessionMode;
  ptyId: number;
}

export interface PaneRuntimeState {
  ptyId: number;
  paneId: string;
  tabId: string;
  workspaceId: string;
  status: PaneStatus;
  phase: SessionPhase;
  isFocused: boolean;
}

export interface WorkspaceExplorerRuntime {
  dirtyPaths: string[];
  lastFsChangeAt?: number;
  lastGitDirtyAt?: number;
  gitDirtyToken: number;
}

export interface TerminalTab {
  kind: 'terminal';
  id: string;
  customTitle?: string;
  splitLayout: SplitNode;
  status: PaneStatus;
}

export interface FileNavigationTarget {
  line: number;
  column?: number;
  requestId: number;
}

export interface FileViewerTab {
  kind: 'file-viewer';
  id: string;
  filePath: string;
  mode: PreviewMode;
  navigationTarget?: FileNavigationTarget;
  status: PaneStatus;
}

export interface WorktreeDiffTab {
  kind: 'worktree-diff';
  id: string;
  projectPath: string;
  status: GitFileStatus;
}

export interface CommitDiffTab {
  kind: 'commit-diff';
  id: string;
  repoPath: string;
  commitHash: string;
  commitMessage: string;
  files: CommitFileInfo[];
}

export type WorkspaceTab = TerminalTab | FileViewerTab | WorktreeDiffTab | CommitDiffTab;

export type SplitNode =
  | { type: 'leaf'; pane: PaneState }
  | { type: 'split'; direction: 'horizontal' | 'vertical'; children: SplitNode[]; sizes: number[] };

export interface PaneState extends PaneLayoutState {
  status: PaneStatus;
  phase: SessionPhase;
}

export interface AiSession {
  id: string;
  sessionType: 'claude' | 'codex';
  title: string;
  timestamp: string;
  projectPath?: string;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  ignored?: boolean;
  children?: FileEntry[];
}

export interface PtyOutputPayload {
  sessionId?: string;
  ptyId: number;
  data: string;
}

export interface PtyExitPayload {
  sessionId?: string;
  ptyId: number;
  exitCode: number;
}

export interface PtyStatusChangePayload {
  sessionId?: string;
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
  sessionId?: string;
  ptyId: number;
  phase: SessionPhase;
  lastExitCode?: number;
  updatedAt: number;
}

export interface PtySessionCommandPayload {
  sessionId?: string;
  ptyId: number;
  command: string;
  usageScope?: string;
  updatedAt: number;
}

export interface PtySessionCwdPayload {
  sessionId?: string;
  ptyId: number;
  cwd: string;
  updatedAt: number;
}

export interface FsChangePayload {
  projectPath: string;
  path: string;
  kind: string;
}

export type GitStatusType = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export interface GitFileStatus {
  path: string;
  oldPath?: string;
  status: GitStatusType;
  statusLabel: string;
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

export interface FileContentResult {
  content: string;
  isBinary: boolean;
  tooLarge: boolean;
}

export interface FileViewerOpenOptions {
  initialMode?: PreviewMode;
  navigationTarget?: FileNavigationTarget;
}

export interface GitRepoInfo {
  name: string;
  path: string;
}

export interface GitCompletionData {
  repoRoot: string;
  currentBranch?: string;
  localBranches: string[];
  remoteBranches: string[];
  remotes: string[];
  tags: string[];
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

export type UiDialog =
  | { kind: 'settings'; page: SettingsPage }
  | {
      kind: 'interaction-dialog';
      dialogId: string;
      mode: InteractionDialogMode;
      title: string;
      message?: string;
      detail?: string;
      placeholder?: string;
      initialValue?: string;
      confirmLabel?: string;
      cancelLabel?: string;
      tone?: InteractionDialogTone;
      readOnly?: boolean;
    };

export type ProjectConfig = LegacyProjectConfig;
export type ProjectState = WorkspaceState;


