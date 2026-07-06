# Git / SVN 版本控制兼容层

## Scenario: `vcs_*` commands for mixed Git and SVN projects

### 1. Scope / Trigger

Use this spec whenever adding version-control functionality that should work for
both Git and SVN projects. The UI may still contain historical `Git*` component
names, but new cross-layer calls should prefer the `vcs_*` compatibility
commands.

### 2. Signatures

Backend commands exposed by `src-tauri/src/vcs.rs`:

```rust
discover_vcs_repos(project_path: String) -> Result<Vec<VcsRepoInfo>, String>
get_vcs_status(project_path: String) -> Result<Vec<GitFileStatus>, String>
get_vcs_changes_status(repo_path: String, vcs_kind: Option<VcsKind>) -> Result<Vec<ChangeFileStatus>, String>
get_vcs_diff(project_path: String, file_path: String, staged: Option<bool>, vcs_kind: Option<VcsKind>) -> Result<GitDiffResult, String>
vcs_commit(repo_path: String, vcs_kind: VcsKind, message: String) -> Result<String, String>
vcs_stage(repo_path: String, vcs_kind: VcsKind, files: Vec<String>) -> Result<(), String>
vcs_stage_all(repo_path: String, vcs_kind: VcsKind, include_untracked: Option<bool>) -> Result<(), String>
vcs_update(repo_path: String, vcs_kind: VcsKind) -> Result<String, String>
vcs_discard_file(repo_path: String, vcs_kind: VcsKind, files: Vec<String>) -> Result<(), String>
```

Frontend contract in `src/types.ts`:

```ts
export type VcsKind = 'git' | 'svn';
export interface VcsRepoInfo {
  name: string;
  path: string;
  vcsKind: VcsKind;
  currentBranch?: string;
}
```

### 3. Contracts

- `VcsKind` is serialized as camelCase enum variants: `git` / `svn`.
- Backend code is split by responsibility:
  - `src-tauri/src/git.rs`: Git-only discovery, status, diff, staging,
    history, commit, pull, and push.
  - `src-tauri/src/svn.rs`: SVN CLI execution, working-copy discovery,
    status parsing, diff, add/delete scheduling, and revert support.
  - `src-tauri/src/vcs.rs`: shared VCS data types, common diff helpers,
    discovery constants, process helpers, and `vcs_*` compatibility commands.
- Git keeps the existing libgit2-backed behavior, including staging, unstaging,
  history, branch labels, pull, and push.
- SVN support is CLI-backed through `svn.exe` / `svn` on `PATH`.
- SVN has no staging area. Frontend must treat all versioned changes as
  committable. It may expose "add / prepare" actions, but must not label SVN as
  having a Git-style index.
- `vcs_stage` means:
  - Git: add files to the Git index.
  - SVN: schedule an existing unversioned path with `svn add --parents`, or a
    missing versioned path with `svn delete --force`.
- `vcs_stage_all(include_untracked)` means:
  - Git: stage all; `include_untracked` is ignored.
  - SVN: schedule missing files for delete; also schedule `?` files for add only
    when `include_untracked == true`.
- `vcs_update` means Git pull for Git and `svn update` for SVN.
- SVN status maps into the existing `GitStatus` frontend shape to reuse file
  badges and diff UI:
  - `M` / `~` -> `modified`
  - `A` -> `added`
  - `D` / `!` -> `deleted`
  - `R` -> `renamed`
  - `?` -> `untracked`
  - `C` -> `conflicted`
- `get_vcs_diff` returns the existing `GitDiffResult` shape for both systems.

### 4. Validation & Error Matrix

| Condition | Behavior |
|---|---|
| `svn` CLI missing | SVN discovery returns no SVN repo or command returns `启动 svn 失败:<error>` |
| Path is not an SVN working copy | SVN-specific commands return `不是 SVN 工作副本:<path>` or normal CLI stderr |
| SVN untracked file is discarded | Delete the file/directory from disk |
| SVN versioned file is discarded | Run `svn revert --depth infinity <file>` |
| SVN `svn status` property-only line (` M`) | Treat as `modified`; path starts at status column 8 |
| SVN `vcs_stage_all(..., includeUntracked=false)` | Schedule missing files for delete without adding `?` files |
| SVN binary file diff | Return `GitDiffResult { isBinary: true }` |
| Diff input > 1 MiB | Return `GitDiffResult { tooLarge: true }` |

### 5. Good / Base / Bad Cases

- Good: New shared version-control UI calls `discover_vcs_repos`,
  `get_vcs_changes_status`, `get_vcs_diff`, `vcs_commit`, and
  `vcs_discard_file`, branching only on `vcsKind` for UI affordances.
- Base: Git-only history features continue calling `get_git_log`,
  `get_repo_branches`, `git_pull`, and `git_push`.
- Bad: Adding new SVN behavior by invoking `svn` directly from React components
  or by pretending SVN has Git staging semantics.

### 6. Tests Required

- Unit test SVN status parsing for common status characters and ignored metadata
  lines, including property-only modifications and raw `?` / `!` extraction.
- Type-check frontend calls so `vcsKind` remains `git | svn`, not arbitrary
  strings.
- Smoke test with a real SVN working copy when changing CLI invocation:
  discovery, status, diff, commit, and discard.
- Regression test Git projects after shared VCS changes: status, diff, stage,
  unstage, commit.

### 7. Wrong vs Correct

#### Wrong

```ts
// SVN has no staging area; this creates a fake model users cannot reason about.
await invoke('git_stage', { repoPath, files });
```

#### Correct

```ts
await invoke('get_vcs_changes_status', { repoPath, vcsKind });

if (vcsKind === 'svn') {
  // Hide stage / unstage controls; commit versioned changes directly.
  await invoke('vcs_commit', { repoPath, vcsKind, message });
}
```
