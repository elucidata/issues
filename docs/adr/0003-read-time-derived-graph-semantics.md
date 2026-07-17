# ADR 0003 — Read-time-derived graph semantics: advisory non-transitive blocking, zero-state-flow containment

- **Status:** Accepted
- **Ticket:** [#5 Graph semantics](https://github.com/elucidata/issues/issues/5)
- **Spec:** [Nested issues & agentic-flow support §3](../design/nested-issues-agentic-flow.md#3-graph-semantics)

## Context

`ISSUES.md` now carries two relationship types (ADR 0001): `blocked-by:` and
`part-of:`. Their semantics must be pinned down — is blocking transitive? Can you
block on a closed issue? Does closing all children close the parent? Does a blocked
parent gate its children? — while keeping the file a round-trippable text document
with **no stored derived state**.

## Decision

Two axes, **fully orthogonal**, all state **derived at read time (nothing stored)**.

**Blocking (`blocked-by:`, many-valued):**

- **Direct blockers only — non-transitive.** Chains clear one link at a time.
- **Any closed section satisfies the gate** (Completed/Deferred/Won't Fix) — exactly
  the `isOpen` test.
- **Dangling blocker → fail-open + warn** (never silently freezes downstream work).
- **Reopen auto-reactivates** (a consequence of read-time derivation).
- **Cycles → warn, members stay blocked** — never auto-broken, never rejected; the
  file round-trips verbatim; a human breaks the cycle by editing an edge.
- **Self-reference → edge ignored + warn.**

**Containment (`part-of:`, single-valued):**

- **Pure grouping — zero state flow.** All children closed never auto-closes the
  parent; closing/deleting a parent never touches children; a blocked/closed parent
  never gates children. A child's takeability depends **solely on its own
  `blocked-by`**. "Child needs parent first" is modelled as an explicit `blocked-by`
  edge.
- **Single parent** (a tree, anchoring the GitHub sub-issue model; indentation ↔
  containment 1:1).
- **Dangling `part-of:` → child renders top-level, fail-open + warn.**

**Ordering:** author-controlled **document order** (line position); no `order:`
field, no numeric prefix; a *total* order.

## Alternatives considered

- **Transitive blocking** (compute the closure for the gate) — rejected: stores/relies
  on implied edges, obscures which single blocker to clear next, and complicates
  reopen. Closure is computed only for *display*, never the gate.
- **Containment with lifecycle flow** (auto-close parent when children done; parent
  gates children) — rejected: couples the two axes, surprises hand-editors, and
  re-introduces stored/cascading state. GitHub/GitLab prior art converges on "no
  cascade; show a progress indicator."
- **Multiple parents (DAG)** — rejected: breaks the 1:1 indentation correspondence
  and the sub-issue anchor; cross-cutting links are `#label`/`blocked-by`.

## Consequences

- The file is the whole truth; there is nothing to keep in sync, so hand-edits and
  CLI edits never disagree about derived state.
- Three warning behaviours (dangling ref, cycle, won't-fix blocker) become inputs to
  the CLI's reject-vs-warn presentation (ADR 0005) — the governing rule is **warn,
  never block a write**.
- The frontier query (ADR 0004) is a thin predicate over these derivations.
