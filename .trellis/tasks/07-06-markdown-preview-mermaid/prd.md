# brainstorm: enhance markdown preview with code and mermaid

## Goal

Improve Markdown preview so project documentation is readable inside Mini-Term without opening an external editor: fenced code blocks should have line numbers and syntax highlighting, Mermaid diagrams should render in preview, and diagrams should support a fullscreen inspection mode with zoom and pan.

## What I Already Know

* The user explicitly requested code block line numbers, syntax highlighting, Mermaid rendering, fullscreen Mermaid display, wheel zoom, and drag/pan.
* Markdown preview currently lives in `src/components/FileViewerModal.tsx`.
* The current Markdown pipeline uses `react-markdown`, `remark-gfm`, and `rehype-raw`.
* Existing `.md-preview` styles live in `src/styles.css`.
* `package.json` currently does not include Mermaid or a syntax highlighting library.
* `FileViewerModal` already uses a portal pattern for the top-level file viewer, which matches the existing modal convention.

## Requirements

* Render fenced Markdown code blocks with line numbers.
* Highlight fenced code blocks based on language class, e.g. ```ts, ```tsx, ```rust, ```cpp.
* Allow users to copy fenced code block contents from the preview.
* Preserve plain inline code behavior.
* Render fenced `mermaid` code blocks as diagrams in Markdown preview.
* Provide a fullscreen Mermaid viewer.
* In fullscreen Mermaid viewer, support mouse wheel zoom.
* In fullscreen Mermaid viewer, zoom around the cursor when using the mouse wheel.
* In fullscreen Mermaid viewer, show explicit zoom controls and current zoom percentage.
* In fullscreen Mermaid viewer, support fitting the diagram to the current viewport.
* In fullscreen Mermaid viewer, support keyboard zoom with `+`, `-`, and reset with `0`.
* Keep Markdown rendering code separated from the generic file viewer so future Markdown enhancements are localized.
* In fullscreen Mermaid viewer, support mouse/touch dragging to pan.
* Keep the Markdown source tab available.
* Keep existing Markdown image/link behavior.
* Keep existing file viewer binary and large-file handling unchanged.

## Acceptance Criteria

* [x] A Markdown fenced code block displays line numbers.
* [x] A Markdown fenced code block displays syntax highlighting when a known language is provided.
* [x] A Markdown fenced code block can be copied from the preview.
* [x] A Markdown fenced `mermaid` block renders as a diagram, not plain code.
* [x] Mermaid render failures show the original code and an error state instead of breaking the whole preview.
* [x] Mermaid diagrams can be opened fullscreen.
* [x] Fullscreen Mermaid supports wheel zoom.
* [x] Fullscreen Mermaid wheel zoom uses the cursor position as the zoom anchor.
* [x] Fullscreen Mermaid shows zoom controls and current zoom percentage.
* [x] Fullscreen Mermaid can fit the diagram to the current viewport.
* [x] Fullscreen Mermaid supports `+`, `-`, and `0` keyboard controls.
* [x] Markdown rendering is isolated in a dedicated component instead of bloating `FileViewerModal`.
* [x] Fullscreen Mermaid supports drag/pan.
* [x] Fullscreen Mermaid can be closed by Escape and a close button.
* [x] Existing Markdown links/images still work.
* [x] `npm test` passes.

## Definition of Done

* Tests added or updated where practical.
* Typecheck/test commands pass.
* No git commit is created unless the user explicitly asks.
* Unrelated dirty worktree changes are preserved.

## Technical Approach

* Add focused Markdown renderer helpers inside or near `FileViewerModal`.
* Use a syntax highlighting library for code block HTML generation.
* Use Mermaid for diagram rendering with `startOnLoad: false`.
* Render Mermaid fullscreen overlay through `createPortal(document.body)` to avoid panel clipping.
* Keep UI state local to the file viewer and diagram components.

## Out of Scope

* Editing Markdown.
* Exporting diagrams.
* Mermaid theme customization settings.
* Search inside rendered Markdown.
* Large-file streaming Markdown preview.

## Technical Notes

* Relevant files:
  * `src/components/FileViewerModal.tsx`
  * `src/components/MarkdownPreview.tsx`
  * `src/styles.css`
  * `package.json`
  * `package-lock.json`
* Current app already uses portal modal conventions; fullscreen Mermaid should follow that pattern.
* Mermaid is dynamically imported so normal file viewing does not eagerly load the Mermaid renderer.
* `npm run build` passes, with an existing Vite chunk-size warning because `index` remains slightly above the 700KB warning threshold and Mermaid creates a large async chunk.
