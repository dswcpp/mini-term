# enhance SVN repository discovery

## Goal

Make SVN working copies easier to discover and use in the existing VCS panel, matching Git discovery behavior where practical.

## Requirements

* `discover_vcs_repos` should discover SVN working copies nested under the active project directory, not only when the active project itself is inside an SVN working copy.
* SVN discovery must remain CLI-backed and degrade silently when `svn` is unavailable.
* Git history features remain Git-only.
* If a project has SVN repositories but no Git repositories, the VCS panel should default to the Changes tab instead of showing an empty History tab.
* The repository dropdown should include SVN repositories in Changes.

## Acceptance Criteria

* [x] Backend returns nested SVN repositories from `discover_vcs_repos`.
* [x] Duplicate SVN roots are de-duplicated.
* [x] Git repositories continue to be returned as before.
* [x] Only-SVN projects default to Changes tab.
* [x] Existing `vcs_*` frontend contracts remain unchanged.

## Out of Scope

* SVN log/history support.
* Replacing the `svn` CLI with a native SVN library.
* Full parity with Git branch/history UI.

## Technical Notes

* Existing spec: `.trellis/spec/backend/vcs-git-svn-compat.md`.
* Backend implementation:
  * Git-only: `src-tauri/src/git.rs`.
  * SVN-only: `src-tauri/src/svn.rs`.
  * Shared VCS contracts and compatibility commands: `src-tauri/src/vcs.rs`.
* Frontend VCS container: `src/components/GitHistory.tsx`.
