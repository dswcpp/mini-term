# brainstorm: support source file preview for C and C++

## Goal

Ensure the file viewer reliably opens and displays common C and C++ source/header files from the file tree, including extensions users naturally expect in C/C++ projects.

## What I Already Know

* The user expects C and C++ source files to be supported by the file viewer.
* `FileTree` opens non-directory entries through `onViewFile(entry.path)`.
* `FileViewerModal` displays ordinary non-image text files with line numbers.
* The backend `read_file_content` currently accepts files up to 1MB and only decodes strict UTF-8.
* There is no current source-extension allowlist; display is based on "can read as text".

## Assumptions

* MVP support means previewing C/C++ files as text with line numbers, not full editor behavior.
* Common Windows C/C++ projects may contain GBK/ANSI encoded files, so strict UTF-8 alone is too narrow.
* Syntax highlighting is useful later, but not required to make the files viewable.

## Requirements

* Support common C source/header extensions: `.c`, `.h`.
* Support common C++ source/header extensions: `.cpp`, `.cc`, `.cxx`, `.c++`, `.hpp`, `.hh`, `.hxx`, `.h++`, `.ipp`, `.inl`, `.tpp`.
* Continue to display supported source files in the existing file viewer instead of launching an external app.
* Avoid weakening project-root path validation.
* Keep binary and over-large file handling explicit.

## Acceptance Criteria

* [x] Clicking a `.c` file in the file tree opens the file viewer.
* [x] Clicking a `.cpp` file in the file tree opens the file viewer.
* [x] Clicking common C/C++ header/template include extensions opens the file viewer.
* [x] UTF-8 C/C++ files render with line numbers.
* [x] Common non-UTF-8 C/C++ text files do not get incorrectly blocked as binary when they can be decoded safely.
* [x] Existing image, Markdown, HTML, binary, and too-large file behavior remains intact.

## Definition of Done

* Tests added or updated where practical.
* Typecheck/build verification passes.
* Behavior stays scoped to file preview.
* No git commit is created unless the user explicitly asks.

## Out of Scope

* Full code editor behavior.
* Editing/saving source files.
* Large-file streaming viewer.
* Broad syntax-highlighting dependency unless needed for reliable preview.

## Technical Notes

* Relevant files:
  * `src/components/FileTree.tsx`
  * `src/components/FileViewerModal.tsx`
  * `src-tauri/src/fs.rs`
  * `src/types.ts`
* Current likely gap is backend text decoding rather than file-extension routing, because the frontend already renders any readable text file.
