# brainstorm: file tree move and sorting

## Goal

Add file tree interactions for moving files/directories into other directories and clarify sorting behavior, so the file panel works more like a lightweight project file manager.

## What I Already Know

* User wants files in the file panel to be draggable for moving to another directory and sorting.
* Current file tree drag behavior is only for inserting a file path into the terminal.
* README documents "File drag & drop" as dragging from file tree or system explorer onto the terminal to insert a quoted path.
* Current backend file commands include create, rename, delete, read, list, watch, and filter directories; there is no move command.
* Current file listing sorts directories first, ignored entries later, then natural name order.

## Assumptions (Temporary)

* Moving means drag a file or directory from the file tree and drop it onto a directory in the same project.
* Sorting may mean changing the file tree sort mode, not arbitrary manual ordering on disk, because real filesystems do not preserve custom per-directory order.

## Open Questions

* None for MVP.

## Requirements (Evolving)

* Preserve the existing FileTree-to-terminal path insertion behavior.
* Add a safe move operation that keeps moves inside the active project root.
* Refresh affected file tree directories after a successful move.
* Support dragging a file or directory onto another directory in the same file tree to move it.

## Acceptance Criteria (Evolving)

* [x] Dragging a file onto a folder in the file tree moves it into that folder.
* [x] Dragging a folder onto a folder moves it without allowing self/descendant moves.
* [x] Dragging onto empty file tree space can move an entry back to the project root.
* [x] Hovering a collapsed directory while dragging auto-expands it.
* [x] Moving outside the project root is rejected by the backend.
* [x] Existing drag-to-terminal path insertion still works.
* [x] Sorting behavior is explicit and unchanged.

## Definition of Done (Team Quality Bar)

* Tests added/updated where appropriate.
* Typecheck/test suite passes.
* Docs/notes updated if behavior changes.
* Rollout/rollback considered if risky.

## Out of Scope (Explicit)

* Sorting changes; keep the current directories-first + natural-name ordering.
* Cross-project moves unless explicitly included later.
* Dragging files from Mini-Term to the OS desktop/explorer unless explicitly included later.
* Persisted manual file ordering.

## Decision (ADR-lite)

**Context**: The user wants file tree dragging for move and sorting, but sorting has multiple meanings and manual ordering would require persisted metadata unrelated to filesystem order.
**Decision**: MVP includes only drag-to-directory moving. Sorting remains unchanged.
**Consequences**: The implementation can stay focused on safe filesystem moves and UI feedback, without adding a new ordering persistence layer.

## Technical Notes

* Existing drag state: `src/utils/fileDragState.ts`.
* Existing file tree component: `src/components/FileTree.tsx`.
* Existing terminal drop receiver: `src/components/TerminalInstance.tsx`.
* Existing backend file commands and safety checks: `src-tauri/src/fs.rs`.
* Current sorting is implemented in backend `list_directory` with directories-first + ignored-last + natural name order.

## Technical Approach

* Added backend `move_entry(project_root, source_path, target_dir)` with project-root verification, target-directory validation, destination conflict rejection, and self/descendant move guards.
* Reused the existing custom file drag state for file-tree moves so WebView2/Tauri drag limitations are handled consistently.
* Added directory-row hover/drop handling in `FileTree.tsx`; dropping onto a valid directory invokes `move_entry`, then refreshes the root and expanded directories.
* Added empty file tree space as a root drop target and collapsed-directory auto-expand while dragging.
* Kept sorting unchanged and documented it as out of scope.

## Verification

* `npm run build`
* `npm run test`
* `cargo test --manifest-path "src-tauri/Cargo.toml"`
* `cargo fmt --manifest-path "src-tauri/Cargo.toml" --check`
* `git diff --check`
