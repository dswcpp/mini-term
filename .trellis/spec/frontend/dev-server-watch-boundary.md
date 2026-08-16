# Dev Server Watch Boundary

## Problem

Mini-Term often runs AI tools such as Claude Code and Codex inside its own
terminal panes while the app itself is running under `npm run tauri dev`.
Those tools and their hooks write project-local runtime files under directories
such as `.claude/`, `.codex/`, `.trellis/.runtime/`, `.agents/`, and
`.run-logs/`.

In dev mode, these files are not application source. A change to them must not
reload the WebView or restart the Tauri app. Otherwise sending a prompt to an AI
process inside the terminal can look like Mini-Term crashed or restarted.

## Contract

`vite.config.ts` and `src/styles.css` jointly define the dev-watch boundary.

- `vite.config.ts` must keep AI/runtime/tooling directories in
  `server.watch.ignored`.
- `src/styles.css` must import Tailwind with `source(none)`.
- `src/styles.css` must explicitly add only the frontend source directory with
  `@source ".";`.

Tailwind v4 is part of the boundary. The `@tailwindcss/vite` plugin scans source
files and registers scanned files as Vite watch dependencies. Therefore
`server.watch.ignored` alone is not sufficient. If Tailwind is allowed to scan
the repo root, Markdown, JSON, hook output, and generated runtime files can still
cause full page reloads.

## Required Ignored Directories

Keep these directories ignored unless they become real frontend source:

- `.agents/`
- `.claude/`
- `.codex/`
- `.qwen/`
- `.run-logs/`
- `.spec-workflow/`
- `.tmp-tests/`
- `.trellis/`
- `dist/`
- `src-tauri/`

`src-tauri/` is also watched by the Tauri CLI for Rust rebuilds. Frontend Vite
must not watch it.

## Regression Test

`tests/viteWatchBoundary.test.cjs` checks that:

- Tailwind uses `source(none)`.
- Tailwind explicitly sources `src/` via `@source ".";`.
- Vite uses the shared ignore list for `server.watch.ignored`.
- The known AI/runtime directories remain ignored.

Update that test whenever a new AI platform directory or runtime output
directory is introduced.

## Good

```css
@import "tailwindcss" source(none);
@source ".";
```

```ts
const devWatchIgnored = [
  "**/.claude/**",
  "**/.codex/**",
  "**/.trellis/**",
  "**/src-tauri/**",
];

server: {
  watch: { ignored: devWatchIgnored },
}
```

## Bad

```css
@import "tailwindcss";
```

This lets Tailwind auto-detect the repo root and can make runtime files reload
the app.

```ts
server: {
  watch: { ignored: ["**/src-tauri/**"] },
}
```

This only covers Tauri rebuild noise. It does not protect the WebView from
project-local AI runtime writes.
