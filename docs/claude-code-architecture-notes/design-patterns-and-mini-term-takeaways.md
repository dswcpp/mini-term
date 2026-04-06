# Design Patterns And Mini-Term Takeaways

This file gathers the book's recurring patterns into a shorter reference and then maps the most relevant lessons onto Mini-Term.

## 1. Pattern Clusters

The book's appendix enumerates 22 design patterns. Grouped by problem type, they become easier to remember.

### 1.1 Startup And Runtime Shaping

| Pattern | Short Meaning |
|---|---|
| Layered Router | route requests through progressively heavier startup layers |
| Progressive Bootstrap | load only the code and initialization needed for the chosen mode |
| Memoized Singleton Init | run side-effectful init only once |
| Trust-Layered Initialization | let trusted and untrusted config influence different startup phases |

### 1.2 Query And Orchestration

| Pattern | Short Meaning |
|---|---|
| Generator-Driven Query Loop | use `AsyncGenerator` for streaming, cancellation, and retries |
| Query/Session Split | separate round execution from long-lived engine state |
| Config Snapshot | freeze relevant config at work-unit start |
| Tiered Error Recovery | choose recovery path by error semantics |

### 1.3 Tooling And Safety

| Pattern | Short Meaning |
|---|---|
| Fail-Closed Defaults | omitted safety metadata should not make behavior permissive |
| Partitioned Batch Orchestration | group tool work by concurrency and safety constraints |
| Three-Layer Cancellation Semantics | do not collapse all abort reasons into one category |
| Tool Sandboxing | bound powerful capabilities by isolated execution envelopes |

### 1.4 Permissions And Control

| Pattern | Short Meaning |
|---|---|
| Decision Trace With Typed Result | return not just a verdict but its reason structure |
| Layered Config Merge | merge rule sources with precedence and explicit override behavior |
| Two-Stage Classifier | use cheap judgment first and expensive reasoning second |
| Progressive Trust UX | move from friction to informed delegation instead of permanent prompts |

### 1.5 Multi-Agent And Memory

| Pattern | Short Meaning |
|---|---|
| Fork-And-Delegate | spawn bounded workers that inherit stable context |
| Agent Type Registry | describe agent roles explicitly rather than ad hoc |
| Scoped Memory | keep memory at the right lifetime and authority scope |
| Context Cache Sharing | stabilize shared prompt prefixes for cache reuse |

### 1.6 State, Persistence, And Views

| Pattern | Short Meaning |
|---|---|
| Minimal Imperative Store | keep state logic direct when concurrency model allows it |
| Selector-Driven Subscription | re-render or react only to the exact state slice used |
| State Change Side-Effect Gate | centralize external effects behind one diff point |
| Layered Persistence With Memory Buffer | combine memory speed with durable flush behavior |

### 1.7 Extension And Remote Control

| Pattern | Short Meaning |
|---|---|
| Layered Hook Event Bus | expose lifecycle interception points systematically |
| Heterogeneous Transport Adapter | normalize different protocol types behind one interface |
| Circuit-Breaker Connection Cache | reuse connections but degrade safely when failures cluster |
| Synthetic Message Unification | reuse one UX path for events from different origins |

## 2. Cross-Cutting Design Rules

The patterns above collapse into a smaller set of strategic rules.

### 2.1 Prefer Progressive Strategies

The book almost always chooses stair-step escalation instead of maximum work immediately.

Examples:

- startup layers
- compression ladder
- permission classification
- failure recovery

### 2.2 Separate By Lifetime, Not Only By Feature

Many of the book's best splits come from asking:

- does this state live for one action, one session, one project, or one installation?

This is how it separates:

- query-round logic from engine state
- session memory from durable overlays
- ephemeral hook memory from persistent config

### 2.3 Let Authority Be Explicit

The strongest designs in the book start by naming the owner:

- who owns the state
- who can approve
- who can execute
- who can remember

Once authority is explicit, interfaces become simpler.

### 2.4 Keep Safety Layered

The book consistently avoids single-point trust:

- shell safety is not only parsing
- remote safety is not only transport
- permission safety is not only a prompt

That mindset is more important than any one implementation detail.

### 2.5 Optimize For Stable Prefixes

Prompt cache sharing, prompt layering, and startup optimization all reflect one habit:

- keep the large stable prefix stable
- move variability to the smallest suffix possible

This principle is useful well beyond prompts. It also applies to transport snapshots, UI state, and protocol messages.

## 3. Mini-Term: What Already Aligns Well

Mini-Term is not Claude Code, but some architectural directions are already aligned.

### 3.1 Runtime Observation Over Filesystem Redundancy

Mini-Term's own `AGENTS.md` correctly positions MCP value around:

- runtime observation
- PTY control
- UI control
- task management

That matches the book's broader lesson that transports and host protocols should focus on what only the runtime can know, not duplicate generic file access.

### 3.2 Host-Backed Tool Boundary

Mini-Term already distinguishes host-backed tools from snapshot-only tools. That fits the book's emphasis on:

- authority boundaries
- capability metadata
- explicit availability conditions

This is the same class of idea as state ownership and adapter isolation.

### 3.3 Approval And Task Surfaces

Mini-Term already has:

- approval request listing and decisions
- tracked tasks
- inbox-like UI surfaces

That aligns well with the book's insistence that control UX is part of the runtime architecture, not an afterthought.

### 3.4 Multiple Entry Modes

Mini-Term also lives in multiple interfaces:

- desktop app
- MCP server
- HTTP wrapper

That makes the book's entry-adapter and mode-routing lessons directly relevant.

## 4. Mini-Term: High-Value Takeaways

These are the most actionable ideas from the book for Mini-Term specifically.

### 4.1 Treat State Ownership As A First-Class Remote Design Decision

Mini-Term already has both local desktop state and MCP-facing runtime snapshots. The book suggests making the ownership model even more explicit:

- which state is authoritative only inside the desktop host
- which state is snapshot material
- which actions can be replayed safely
- which remote requests must be rejected when authority is absent

This can sharpen semantics for host-backed tools and future remote-control behavior.

### 4.2 Tighten Capability Metadata

The book's tool system benefits from machine-readable safety metadata. Mini-Term could continue moving in the same direction by making tool contracts clearer around:

- host requirement
- approval requirement
- idempotence
- destructive potential
- concurrency safety

That would make both UI presentation and external agent planning more reliable.

### 4.3 Unify Reviewable Side Effects

The book repeatedly centralizes side-effect gates. For Mini-Term, similar value exists in ensuring that:

- PTY lifecycle effects
- task-state transitions
- host snapshot writes
- approval status changes

flow through a small number of reviewable synchronization points.

This reduces hidden divergence between UI truth, MCP truth, and persisted truth.

### 4.4 Reuse Synthetic Message Patterns

The book's remote approval bridge is useful for Mini-Term whenever one source of truth must be presented in multiple client contexts.

Potential uses:

- presenting approval requests uniformly across desktop UI and MCP consumers
- surfacing host-side events through one consistent event envelope
- keeping task attention events transport-neutral

### 4.5 Prefer Progressive Degradation

Mini-Term already has good examples of this, but the book suggests pushing it further:

- if host connection is missing, degrade to snapshot-only observation
- if approval cannot complete yet, keep the request durable and inspectable
- if transport is unstable, preserve observation capability before control capability

That ordering preserves operator trust.

### 4.6 Separate Stable Prefix From Dynamic Tail

For any future prompt-policy or task-policy system inside Mini-Term, the book's prompt architecture offers a useful template:

- static policy layer
- runtime-detected dynamic layer
- user or task specific tail

This supports caching, explainability, and easier policy review.

### 4.7 Think In Lifecycles

Mini-Term already has PTYs, tasks, approvals, tabs, and workspaces. The book suggests treating each one as an explicit lifecycle with:

- states
- transitions
- cleanup rules
- persistence boundaries

That becomes increasingly important as host-backed and remote-assisted flows grow.

## 5. Mini-Term: Concrete Questions Worth Exploring

If these notes are later converted into ADRs or implementation work, these are good next questions:

1. Which Mini-Term tool groups should advertise stronger machine-readable safety semantics?
2. Is there a single side-effect gate for runtime snapshot publication, or are updates still too scattered?
3. Which remote or MCP-facing actions should degrade gracefully to read-only rather than fail hard?
4. Can approval requests, task attention, and host-backed failures share one synthetic event envelope?
5. Are task and PTY lifecycles explicit enough to support retries, recovery, and remote observers consistently?

## 6. Practical Use Of This Note Set

This note set can support at least four kinds of follow-up work:

- architecture review
  - compare Mini-Term modules to the book's layer and ownership model
- ADR drafting
  - turn repeated themes into explicit repository decisions
- MCP contract refinement
  - improve tool metadata and failure semantics
- future task/runtime work
  - use the book's lifecycle and state-ownership thinking when extending host-backed control

If needed, the next useful step would be a direct module-by-module mapping between these notes and the current Mini-Term codebase.
