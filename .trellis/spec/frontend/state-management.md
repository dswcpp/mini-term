# State Management

> How state is managed in this project.

---

## Overview

Global state lives in a single Zustand store (`useAppStore` in `src/store.ts`).
Its `config: AppConfig` field is the persisted configuration: loaded from
`config.json` on startup via the `load_config` Tauri command, and written back
via `save_config` after any change. Components subscribe with selectors
(`useAppStore((s) => s.xxx)`); non-component code reads the latest value with
`useAppStore.getState()`.

---

## State Categories

<!-- Local state, global state, server state, URL state -->

(To be filled by the team)

---

## When to Use Global State

<!-- Criteria for promoting state to global -->

(To be filled by the team)

---

## Server State

<!-- How server data is cached and synchronized -->

(To be filled by the team)

---

## Common Mistakes

<!-- State management mistakes your team has made -->

(To be filled by the team)

---

## Extending AppConfig

### Convention: Adding a field to the AppConfig schema

**What**: Adding a field to the global `AppConfig` requires synchronized edits in
**four** places across two languages. Missing any one causes a compile error or a
silent inconsistency.

**Why**: `AppConfig` is the persistence contract shared between the Rust backend
and the frontend (`config.json`), carried by the `load_config` / `save_config`
Tauri commands. The four spots live in different files and languages, so a miss is
not caught by reviewing any single file.

**The four spots**:

1. `src-tauri/src/config.rs` — add the field to the `AppConfig` struct, with
   `#[serde(default ...)]` so old `config.json` files still deserialize
2. `src-tauri/src/config.rs` — add the field's default to `impl Default for
   AppConfig` (Rust will not compile without it)
3. `src/types.ts` — add the same field to the frontend `AppConfig` interface
4. `src/store.ts` — add the field to the store's initial `config` literal
   (TypeScript will not compile — the literal would be missing a required property)

**Naming**: Rust uses snake_case, the frontend uses camelCase. The struct's
`#[serde(rename_all = "camelCase")]` maps them automatically — no per-field
`#[serde(rename)]` needed.

**Example** (the `smartCopyPaste` field):

```rust
// config.rs — struct
#[serde(default)]
pub smart_copy_paste: bool,

// config.rs — impl Default for AppConfig
smart_copy_paste: false,
```

```typescript
// types.ts — AppConfig interface
smartCopyPaste: boolean;

// store.ts — initial config literal
smartCopyPaste: false,
```

**Optional fields**: if the field is semantically nullable, use `Option<T>` +
`#[serde(default, skip_serializing_if = "Option::is_none")]` on the Rust side and
`field?: T` on the frontend.

**Collection fields**: if the field is a list/map whose empty state should not
pollute `config.json`, use `Vec<T>` (or `HashMap<K, V>`) +
`#[serde(default, skip_serializing_if = "Vec::is_empty")]` on the Rust side and
`field?: T[]` on the frontend. Old configs auto-default to empty; new empty
configs do not write the field. Example: `ProjectConfig.env_vars`.

### Convention: Optimistic update with rollback on save failure

**What**: When a modal writes to `AppConfig` via `save_config`, do **optimistic
update + rollback on failure**, never "await save then setConfig". The pattern:

```ts
const prevConfig = useAppStore.getState().config;
const newConfig = { ...prevConfig, /* changes */ };
useAppStore.getState().setConfig(newConfig);  // optimistic
try {
  await invoke('save_config', { config: newConfig });
  onClose();
} catch (e) {
  useAppStore.getState().setConfig(prevConfig);  // rollback
  setBusy(false);
  await showAlert('保存失败', e instanceof Error ? e.message : String(e));
}
```

**Why**:

1. **Responsiveness**: UI reflects change immediately; the disk write happens in
   background.
2. **Consistency invariant**: store and `config.json` must agree at rest. If
   `save_config` rejects after we set the store but before we rolled back, the
   next startup loads the on-disk (old) value while the runtime store has the
   new value — user sees their change "silently lost" on next launch.
3. **User feedback**: `showAlert` makes the failure visible; silent
   `console.error` leaves users thinking they saved when they didn't.

**Existing followers**: `SshAssocModal.tsx`, `ProjectEnvVarsModal.tsx`.

**Don't**:

```ts
// ❌ Wrong: store updated but disk not, and user gets no feedback.
useAppStore.getState().setConfig(newConfig);
try {
  await invoke('save_config', { config: newConfig });
} catch (e) {
  console.error(e);  // user thinks save succeeded; store and disk diverge
}
```

### Convention: cc-connect frontend boundary

**What**: cc-connect frontend code is split into two thin utility layers:

1. `src/utils/ccConnectConfig.ts` owns frontend defaults, path normalization, and
   optimistic `save_config` with rollback for `config.ccConnect`.
2. `src/utils/ccConnectApi.ts` owns all `cc_connect_*` Tauri command names and
   payload shapes.

**Why**: cc-connect spans App startup, polling hooks, modals, Dashboard iframe,
project import utilities, and Rust commands. Letting each caller hand-roll
`configPath || undefined`, default executable fallback, or `invoke('cc_connect_*')`
duplicates cross-layer contracts and makes future command signature changes risky.

**Rules**:

- Components and hooks call `probeCcConnect`, `startCcConnect`, etc. from
  `ccConnectApi.ts`; they should not invoke `cc_connect_*` commands directly.
- Code that needs default `CcConnectConfig` uses `normalizeCcConnectConfig`.
- Code that persists `config.ccConnect` uses `saveCcConnectConfigPatch`, so failed
  disk writes roll back the store.
- UI components decide when to show messages; utility functions own only data
  normalization and command boundaries.

### Convention: Workspace Overview derived snapshot

**What**: Cross-project summary data lives in `store.workspaceOverview` as a
derived runtime snapshot, not as persisted config. The snapshot is refreshed by
`useWorkspaceOverview` on app load, every 60 seconds, when the Overview panel is
opened, and through the panel refresh button.

**Why**: Overview data aggregates multiple volatile sources: project runtime
state, terminal pane status, Git status, cc-connect remote project list, and
notifications. Persisting it would make stale data look authoritative on next
launch.

**Rules**:

- Build the snapshot through `buildWorkspaceOverviewSnapshot` in
  `src/utils/workspaceOverview.ts`; UI components should not reimplement
  cross-project aggregation.
- Use `refreshWorkspaceOverview` from `src/hooks/useWorkspaceOverview.ts` for
  manual refreshes so the in-flight guard prevents overlapping Git / cc-connect
  requests.
- Git and cc-connect failures should degrade the affected project or summary
  section, not fail the whole Overview panel.
- `config.overviewVisible` is the only persisted field for the feature; the
  actual snapshot remains runtime-only.
