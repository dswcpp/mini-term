# Runtime Core

This document condenses the book's runtime spine:

- Chapter 2: startup flow
- Chapter 3: query engine and query lifecycle
- Chapter 4: tool system
- Chapter 5: permission model

## 1. Startup Design

The book argues that startup design is a first-class architecture problem because Claude Code is not one program with one mode. It is a family of entry behaviors:

- interactive REPL
- non-interactive pipeline mode
- MCP server mode
- SDK-controlled mode
- bridge and remote modes
- background or daemon-like modes

### 1.1 Layered Router

The startup path is intentionally layered so low-cost requests exit early.

The book describes a staged route similar to:

1. environment pre-processing
2. zero-dependency fast paths
3. mode-level dispatch
4. full CLI startup only when necessary

The key consequence is that startup cost becomes proportional to the chosen mode rather than the total application size.

### 1.2 Dynamic Import As A Performance Tool

Instead of eagerly importing everything, startup uses on-demand loading.

Implications:

- `--version` can return almost immediately
- MCP mode does not have to load full terminal rendering code
- interactive mode alone pays the React/Ink cost

Trade-off:

- runtime routing becomes less obvious in static analysis
- IDE navigation and dead-code reasoning get worse

The book treats that as acceptable because CLI startup latency is user-facing product quality.

### 1.3 Initialization Hub

The initialization layer is described as an "init hub" with three major concerns:

- idempotence
  - side-effectful init should not run repeatedly
- trust layering
  - untrusted configuration must not influence security-critical setup too early
- parallelism
  - noncritical work should not block the hot path

The important idea is that initialization order is a security and correctness concern, not merely bootstrapping boilerplate.

### 1.4 Global State Anchor

The book pays unusual attention to the global state anchor module.

Its design principles:

- many modules may read it
- it should import as little as possible
- ideally it should behave like a leaf in the dependency DAG

This prevents a globally referenced state container from becoming the hidden center of circular dependencies.

### 1.5 Multi-Entry Adaptation

One runtime core is exposed through multiple adapters. The adapters vary mainly in:

- transport
- permission strategy
- statefulness
- UI responsibility

The contrast the book emphasizes most is:

- REPL mode
  - full UI
  - dialogs
  - complex state
- MCP mode
  - no interactive permission dialogs
  - reduced or empty permission context
  - bounded caches instead of app-scale state

The architectural point is that entry adapters should absorb interface differences so the core engine stays mode-agnostic.

## 2. Query Engine

The book treats the query engine as the heart of the runtime.

### 2.1 QueryEngine Versus `query.ts`

One of the main structural decisions is a two-part split:

- `QueryEngine`
  - manages session-level state and long-lived coordination concerns
- `query()` or equivalent loop logic
  - handles one round or one execution flow

The book likes this split because the two parts live on different time scales:

- session scope persists
- round scope is disposable

That makes debugging and refactoring easier than letting one object own every lifetime.

### 2.2 `while(true)` As An Implicit State Machine

The book explicitly defends a simple loop rather than a more explicit graph engine.

Why this works in the book's framing:

- the agent cycle is fundamentally repetitive
- the transition space is still mostly linear
- extra abstraction would add indirection without adding clarity

To compensate for the apparent simplicity, the runtime keeps track of "why control returned here" through transition tags or similar metadata.

The core principle is:

- if the behavior is cyclic and mostly linear, a plain loop may be the most honest representation

### 2.3 `AsyncGenerator` As The Streaming Primitive

The query loop yields events progressively instead of returning one large final result.

This matches the nature of agent execution:

- model output arrives as a stream
- tool calls can interleave with text
- UI wants partial progress
- cancellation and backpressure matter

The book highlights three benefits:

- streaming is natural
- intermediate states are observable
- multi-agent composition becomes easier because each agent can expose a stream

The cost is operational:

- stack traces are harder to read
- generator boundaries complicate error handling
- mental models are more subtle than plain promises

### 2.4 Configuration Snapshotting

Before a long query run starts, the runtime freezes or snapshots the relevant configuration.

The reason is reproducibility:

- long-running work should not silently drift because settings changed mid-flight
- behavior should stay stable for the duration of one query

This is a recurring book theme:

- prefer predictable execution inside one unit of work
- apply changes at safe boundaries rather than continuously

### 2.5 Query Lifecycle

The book describes the message submission path as a staged pipeline. A useful condensed view is:

1. reset or prepare transient session state
2. wrap permissions with rejection tracking
3. assemble the effective system prompt
4. preprocess user input and attachments
5. persist transcript input
6. enter the query loop
7. stream model output and tool results
8. decide whether to stop, retry, compress, or continue

Two notable details:

- permission denials are tracked as data, not merely shown in UI
- system prompt construction is treated as runtime assembly work, not static text

### 2.6 Compression Pipeline

The book presents context compression as a multi-stage ladder rather than one summarization feature.

The broad order is:

1. provider-native or low-cost compression
2. lightweight local compaction
3. session memory based compaction
4. full compact as the expensive fallback

The architecture principle is:

- try the cheapest, least lossy intervention first
- escalate only when cheaper methods no longer preserve enough room

This is one of the book's most reusable design patterns.

### 2.7 Error Recovery Inside The Query Loop

The book rejects one-size-fits-all retry logic. Different errors demand different remedies.

Examples it highlights:

- reduce input when request payload is too large
- allow more output when max-output ceilings are the issue
- switch models or degrade capability for availability problems
- strip media or reduce attachment burden for media-specific failures

The lesson is that retry logic should be typed by failure semantics.

### 2.8 Narrow Dependency Injection

The book notes that the runtime does not embrace broad inversion-of-control machinery. Instead, it injects a small number of essential boundaries.

This keeps the API surface narrow:

- important I/O is explicit
- test seams still exist
- the system avoids full-framework DI complexity

The pattern is best read as "inject only what truly crosses a boundary."

## 3. Tool System

The book treats tools as the agent's "hands and feet."

### 3.1 Capability Taxonomy

The internal tool set is grouped by effect and risk.

| Tool Class | Typical Behavior | Risk Profile |
|---|---|---|
| File tools | read, write, edit, notebook changes | read is lower risk, write is sensitive |
| Search tools | grep, glob, discovery | mostly read-only |
| Shell tools | command execution, task control | highest attack surface |
| Agent tools | spawn or coordinate sub-agents | cross-process and cross-role risk |
| Network tools | fetch, web, MCP tools | external boundary and SSRF exposure |
| Auxiliary tools | todo, ask-user, bookkeeping | low side-effect |

The system formalizes this through tool properties like read-only, destructive, and concurrency-safe. The point is to make safety and scheduling mechanically inspectable.

### 3.2 Tool Description As Prompt

One of the book's more subtle insights is that a tool description is not just documentation. It is part of the model's control plane.

That means tool descriptions affect:

- whether the model chooses the tool
- whether it uses the right tool for the job
- whether it takes a safer or more direct path

This creates a prompt-engineering dimension inside the tool registry itself.

### 3.3 Fail-Closed Registry Design

The book repeatedly praises the registry for failing closed:

- if a safety attribute is omitted, the safer behavior wins
- new tools should not become permissive by accident
- registration is explicit, not implicit directory scanning

Why the book likes explicit registration:

- feature flags may govern availability
- names may need collision handling
- tool descriptions and metadata matter to runtime behavior

### 3.4 Execution Pipeline

The source book describes tool execution as a nine-step pipeline. The most important architectural takeaway is not the exact count but the decomposition:

- each tool call passes through discrete, inspectable stages
- each stage is a potential interception point
- validation, permissioning, execution, normalization, and cleanup are not collapsed into one opaque call

That decomposition supports:

- auditability
- hookability
- safety insertion points
- testable boundaries

### 3.5 Concurrency And Cancellation

The book highlights a three-layer `AbortController` structure.

The practical point is that not all cancellations mean the same thing:

- user cancellation
- parent cancellation
- internal timeout or orchestration cancellation

Representing these separately makes cascading behavior easier to reason about and simplifies error classification.

### 3.6 Bash Tool Safety

The shell tool is treated as the most dangerous built-in capability. The book's high-level safety strategy is layered:

- parse commands structurally where possible
- analyze semantics, not only syntax
- verify path boundaries
- sandbox execution at the OS level
- cap output
- enforce timeout
- log behavior for reviewability

This is important because it shows the design refuses to trust one guardrail. Shell execution is too powerful for single-point validation.

### 3.7 File Edit Safety

The book emphasizes two editing concerns:

- atomicity
- dirty-write avoidance

The preferred behavior is not "best effort write." It is "write only when the world still matches the assumptions you read from."

This is why timestamp checks, deterministic write behavior, and read-before-write logic matter so much.

## 4. Permission Model

The permission system is a full architecture in its own right.

### 4.1 Four Trust Modes

The book organizes runtime trust into four broad decisions:

- allow
- ask
- deny
- auto

The key role of `auto` is to permit semantic risk judgment rather than just static allowlists.

### 4.2 Eight Rule Sources

The book describes permissions as being influenced by multiple rule layers, from highly immediate overrides to more persistent settings.

The point is not just precedence. It is governance:

- CLI intent
- user preference
- project-level norms
- organization policy

must all coexist without ambiguity.

The system therefore uses ordered rule sources and gives denial rules stronger authority than permissive ones at the safety boundary.

### 4.3 Decision Tree

The main permission path is described as a multi-step decision tree with three broad phases:

1. negative checks
2. positive checks
3. fallback behavior

The book particularly stresses that some safety checks remain in force even when a mode is permissive. This blocks self-escalation through configuration tricks.

### 4.4 Matching Engine

Rule matching is not one-dimensional. The book covers:

- exact shell command matching
- prefix matching
- wildcard matching
- gitignore-like file path patterns
- Windows-specific path bypass defenses

That matters because real command risk is often hidden in path and argument shape, not just the first token.

### 4.5 AI Classifier

The permission engine contains an LLM-based classifier for ambiguous actions.

The design is intentionally staged:

- fast path for easy cases
- deeper reasoning only when ambiguity remains

The book likes this because pure deterministic rules are too blunt, but full reasoning on every request would be too slow and expensive.

### 4.6 Decision Traceability

Permission outcomes are treated as structured results carrying cause information. This is important for:

- user explanation
- auditability
- debugging
- post-hoc rule refinement

The broader principle is that permission systems should return reasoning data, not just booleans.

### 4.7 Circuit Breakers And Rejection Tracking

The book points out two resilience details:

- repeated classifier failure should trip a fallback path
- denied tool attempts are worth collecting as session data

This turns permission behavior into something the runtime can learn from and degrade gracefully around.

### 4.8 Progressive Trust UX

The approval experience is not treated as cosmetic. It is part of the control model.

Important UX choices highlighted by the book:

- tool-specific approval UI
- editable rule prefixes
- user-visible explanation
- diff-oriented review where possible
- badges when a request originates from a worker agent

The system aims to move the user from constant prompting toward informed delegation rather than binary "always ask" fatigue.

## 5. What The Runtime Core Teaches

Across startup, querying, tools, and permissions, the book keeps returning to the same design habits:

1. Split by lifetime, not only by feature.
2. Make expensive work lazy.
3. Let safety defaults be strict.
4. Decompose actions into observable stages.
5. Prefer progressively more expensive logic instead of doing maximum work up front.
6. Keep the infrastructure simpler than the model behavior it surrounds.
