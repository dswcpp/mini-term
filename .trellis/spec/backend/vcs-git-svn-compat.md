# Git / SVN 版本控制兼容层

## Scenario: `vcs_*` commands for mixed Git and SVN projects

### 1. Scope / Trigger

Use this spec whenever adding version-control functionality that should work for
both Git and SVN projects. The UI may still contain historical `Git*` component
names, but new cross-layer calls should prefer the `vcs_*` compatibility
commands. Git-only history, branch, push, and worktree features may continue to
use their existing `git_*` commands.

### 2. Signatures

Backend commands exposed by `src-tauri/src/vcs.rs`:

```rust
discover_vcs_repos(project_path: String) -> Result<Vec<VcsRepoInfo>, String>
get_vcs_status(project_path: String) -> Result<Vec<VcsFileStatus>, String>
get_vcs_changes_status(repo_path: String, vcs_kind: Option<VcsKind>) -> Result<Vec<ChangeFileStatus>, String>
get_vcs_diff(project_path: String, file_path: String, staged: Option<bool>, vcs_kind: Option<VcsKind>) -> Result<GitDiffResult, String>
vcs_commit(repo_path: String, vcs_kind: VcsKind, message: String) -> Result<String, String>
vcs_stage(repo_path: String, vcs_kind: VcsKind, files: Vec<String>) -> Result<(), String>
vcs_stage_all(repo_path: String, vcs_kind: VcsKind, include_untracked: Option<bool>) -> Result<(), String>
vcs_update(repo_path: String, vcs_kind: VcsKind) -> Result<String, String>
vcs_discard_file(repo_path: String, vcs_kind: VcsKind, files: Vec<String>) -> Result<(), String>
```

`vcs_commit` and `vcs_update` are registered with `#[tauri::command(async)]` so
Git/SVN subprocess or commit work does not block the WebView event loop.

Frontend contract in `src/types.ts`:

```ts
export type VcsKind = 'git' | 'svn';

export interface GitRepoInfo {
  name: string;
  path: string;
  currentBranch?: string;
  isWorktree?: boolean;
}

export interface VcsRepoInfo extends GitRepoInfo {
  vcsKind: VcsKind;
}

export interface VcsFileStatus extends GitFileStatus {
  vcsKind: VcsKind;
}
```

### 3. Contracts

- `VcsKind` and struct fields are serialized in camelCase: `git` / `svn`,
  `vcsKind`, `currentBranch`, and `isWorktree`. Rust `VcsFileStatus` flattens its
  `GitFileStatus` with `#[serde(flatten)]`, so each status payload is the flat
  `{ path, oldPath?, status, statusLabel, vcsKind }` shape; `vcsKind` is required
  on the TypeScript `VcsFileStatus` contract.
- `VcsRepoInfo.isWorktree` preserves Git linked-worktree metadata. It is always
  `false` for SVN and uses `#[serde(default)]` so older payloads without the
  field deserialize as `false`.
- `get_vcs_changes_status` and `get_vcs_diff` default an omitted `vcsKind` to
  Git for backward compatibility. Mutating `vcs_*` commands require an explicit
  `vcsKind`.
- Backend code is split by responsibility:
  - `src-tauri/src/git.rs`: Git discovery, status, diff, staging, history,
    commit, network operations, and linked-worktree metadata/management.
  - `src-tauri/src/svn.rs`: SVN CLI execution, working-copy discovery, XML
    status parsing, repository-contained path validation, diff, add/delete
    scheduling, and revert/delete support.
  - `src-tauri/src/vcs.rs`: shared VCS data types, common diff helpers,
    discovery constants, Windows subprocess-window suppression, and `vcs_*`
    compatibility commands.
- Git preserves the existing implementation: repository/status/diff/staging/
  history/commit behavior is libgit2-backed, while pull/push and worktree
  management use the Git CLI where already implemented.
- SVN is CLI-backed through `svn.exe` / `svn` on `PATH`. Subprocess stdin is
  closed, Windows console windows are suppressed, and file operands are passed
  after `--` so option-like filenames cannot become CLI flags.
- SVN discovery uses `svn info --show-item wc-root -- <path>`, canonicalizes and
  deduplicates working-copy roots, and prefers the filesystem `.svn` root when
  Windows local-codepage output could corrupt a non-ASCII path. Discovery covers
  both a working copy containing `projectPath` and independent working copies
  nested below it, up to the shared repository-discovery depth limit.
- `get_vcs_status` returns Git and every successfully read SVN root as
  `VcsFileStatus`. SVN paths are normalized relative to `projectPath`; canonicalize
  both the working-copy root and `projectPath` before computing that relative path
  so Windows verbatim (`\\?\`) and regular drive prefixes cannot discard valid
  statuses as apparent `../` escapes. For nested working copies, the deepest
  successfully read root owns its root and all paths
  below it: parent-root entries in that subtree are suppressed and each normalized
  path is emitted at most once. If the nested status read fails, a successful
  parent entry remains as a graceful fallback; one failing SVN root never removes
  Git results or statuses from other successful SVN roots.
- SVN has no staging area. `ChangeFileStatus.stagedStatus` is always absent and
  all reported changes use `unstagedStatus`; the UI must not present a Git-style
  index or unstage action for SVN.
- `vcs_stage` means:
  - Git: add files to the Git index.
  - SVN: inspect `svn status --xml -- <path>`; schedule an unversioned path with
    `svn add --parents -- <path>`, schedule a missing path with
    `svn delete --force -- <path>`, and no-op for already versioned changes.
- `vcs_stage_all(includeUntracked)` means:
  - Git: stage all; `includeUntracked` is ignored.
  - SVN: always schedule missing files for delete; schedule unversioned files
    for add only when `includeUntracked == true`. Omission defaults to `true`.
- `vcs_update` means Git pull for Git and `svn update` for SVN.
- `vcs_discard_file` means for SVN:
  - unversioned path: delete the path from disk;
  - added path: `svn revert --depth infinity -- <path>`, then delete it from
    disk so discard does not leave the formerly added content behind;
  - other reported versioned change: recursively `svn revert` it.
  The implementation validates and deduplicates every requested path before
  performing any destructive action.
- SVN `vcs_stage` / `vcs_discard_file` file inputs are working-copy-root
  relative. `get_vcs_diff.filePath` is relative to `projectPath`; that canonical
  project directory may be inside a working copy or may contain nested working
  copies. Diff resolves existing and missing targets against all discovered roots
  and routes to the deepest containing working copy. Inputs must be non-empty and
  NUL-free. Reject absolute/drive/UNC paths, `.`, `..`, empty path segments, an
  unmanaged target, and escapes through canonicalized parent directories. Diff
  also follows an existing final target and rejects it if it escapes either the
  project or selected working copy; unversioned symlink discard removes the link
  itself instead of recursively following it.
- SVN status comes from `svn status --xml`, not fixed text columns. XML paths are
  entity-decoded and normalized to `/`, then mapped into the existing
  `GitStatus` frontend shape:
  - `modified` / `incomplete`, or property-only `modified` -> `modified`
  - `added` -> `added`
  - `deleted` / `missing` -> `deleted`
  - `replaced` -> `renamed`
  - `unversioned` -> `untracked`
  - `conflicted` / `obstructed`, or property-only `conflicted` -> `conflicted`
  - clean, ignored, and external entries -> omitted
- `get_vcs_diff` returns the existing `GitDiffResult` shape for both systems.
  For SVN, `staged` is ignored; added/unversioned files have empty old content,
  non-UTF-8 content sets `isBinary`, and either side over 1 MiB sets `tooLarge`.
  If `oldLineCount * newLineCount > 10_000_000`, use a full-replacement hunk
  instead of allocating the quadratic LCS table.

### 4. Validation & Error Matrix

| Condition | Behavior |
|---|---|
| `svn` CLI missing during discovery | Return no SVN repository; keep any Git discovery result |
| `svn` CLI missing during a direct command | Return `启动 svn 失败: <error>` |
| Repository path is not a directory | Return `不是有效目录: <path>` |
| Path is not an SVN working copy | Root-dependent helpers return `不是 SVN 工作副本: <path>`; direct CLI commands return the SVN failure detail |
| SVN exits unsuccessfully | Return `svn 命令失败(退出状态 <code>): <stderr-or-stdout>` |
| `svn status --xml` is malformed | Return a contextual `解析 svn status XML 失败: ...` error |
| `get_vcs_status` cannot read one SVN root | Keep Git and other successful SVN statuses; retain a parent-root fallback when a nested root alone fails |
| SVN diff target is outside every discovered working copy | Reject it before invoking `svn status` / `svn cat` |
| `vcsKind` omitted for changes/diff | Route to Git |
| SVN path is empty, contains NUL, is absolute, contains `.` / `..` / empty segments, or escapes through a parent/final symlink | Reject before the corresponding file operation |
| SVN filename begins with `-` | Accept it as a relative path and pass it after `--` |
| `vcs_stage_all(..., includeUntracked=false)` | Schedule missing files for delete without adding unversioned files |
| `vcs_stage_all(..., includeUntracked=null)` | Treat `includeUntracked` as `true` for SVN |
| SVN unversioned path is discarded | Delete the file, directory, or symlink from disk |
| SVN added path is discarded | Revert the add, then delete the path from disk |
| SVN versioned path is discarded | Run `svn revert --depth infinity -- <path>` |
| Requested discard path has no reported SVN change | Return `路径没有可丢弃的 SVN 更改: <path>`; perform no destructive action for the batch |
| SVN content is non-UTF-8 | Return `GitDiffResult { isBinary: true }` with empty contents/hunks |
| SVN base or working file exceeds 1 MiB | Return `GitDiffResult { tooLarge: true }` without reading the whole oversized source |
| Legacy `VcsRepoInfo` omits `isWorktree` | Deserialize it as `false`; SVN discovery also emits `false` |

### 5. Good / Base / Bad Cases

- Good: Shared version-control UI calls `discover_vcs_repos`,
  `get_vcs_changes_status`, `get_vcs_diff`, `vcs_commit`, and
  `vcs_discard_file`, passes the discovered `vcsKind`, and sends file paths
  relative to the command's documented base (`repoPath` or `projectPath`).
- Base: Git-only history, branch, push, and worktree features continue calling
  `get_git_log`, `get_repo_branches`, `git_pull`, `git_push`, and the existing
  worktree commands.
- Bad: Invoking `svn` directly from React, concatenating an unchecked file path
  onto `repoPath`, invoking a Git command for an SVN repository, or pretending
  SVN has a Git staging index.

### 6. Tests Required

- Unit-test XML status parsing for text/property states, entity-unescaped paths,
  and ignored clean/external/ignored entries.
- Unit-test nested working-copy discovery and aggregation: visit every root,
  normalize project-relative paths, let the deepest successful root own an
  overlapping subtree without duplicate paths, and retain parent/other-root
  results when one nested status read fails.
- Unit-test project-relative SVN diff resolution for an ancestor project,
  deepest-root selection, existing and missing files, unmanaged targets, and
  traversal rejection.
- Unit-test path validation for absolute, drive, UNC, `..`, `.`, empty-segment,
  outside-base, and symlink-escape inputs; keep an option-like filename case.
- Unit-test `VcsRepoInfo` mapping: preserve Git `isWorktree`, force SVN to
  `false`, serialize `isWorktree` in camelCase, and default missing legacy data.
- Unit-test the 1 MiB diff guard before whole-file reads and the non-UTF-8 binary
  result; cover the large line-product full-replacement fallback when changed.
- Integration/smoke-test a real SVN working copy when changing CLI invocation:
  discovery, XML status, diff, add/delete scheduling, commit, update, and all
  discard branches.
- Type-check frontend calls so `vcsKind` remains `git | svn`, `isWorktree`
  remains backward-compatible, and SVN never reaches Git-only controls.
- Regression-test Git projects after shared VCS changes: discovery (including
  linked-worktree metadata), status, diff, stage/unstage, commit, pull/push.

### 7. Wrong vs Correct

#### Wrong

```ts
// SVN has no Git index, and unchecked paths must not cross the backend boundary.
await invoke('git_stage', { repoPath, files: ['../outside.txt'] });
```

#### Correct

```ts
const repos = await invoke<VcsRepoInfo[]>('discover_vcs_repos', { projectPath });
const repo = repos.find((candidate) => candidate.path === repoPath);
if (!repo) throw new Error('repository not found');

await invoke('get_vcs_changes_status', {
  repoPath: repo.path,
  vcsKind: repo.vcsKind,
});

if (repo.vcsKind === 'svn') {
  // No unstage UI: commit versioned changes and explicitly add only safe,
  // repository-relative unversioned paths.
  await invoke('vcs_stage', {
    repoPath: repo.path,
    vcsKind: repo.vcsKind,
    files: ['src/new-file.ts'],
  });
  await invoke('vcs_commit', {
    repoPath: repo.path,
    vcsKind: repo.vcsKind,
    message,
  });
}
```
