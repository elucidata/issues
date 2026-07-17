# ADR 0004 — Frontier query: one predicate, two read-only projections, no auto-claim

- **Status:** Accepted
- **Ticket:** [#6 Frontier-query semantics](https://github.com/elucidata/issues/issues/6)
- **Spec:** [Nested issues & agentic-flow support §4](../design/nested-issues-agentic-flow.md#4-frontier-query)

## Context

The point of the whole model is that an agent (or human) can ask "what should I pick
up next?" and get a deterministic answer. That query must compose the lifecycle axis
(ADR 0002), the graph semantics (ADR 0003), and the claim, and it must be safe to run
repeatedly in an agent loop — i.e. it must not have side effects.

## Decision

**One predicate, two read-only projections, layered filters** — all derived at read
time, nothing stored, nothing auto-claimed.

**Base predicate** (no flags):

```
frontier = open `Issues` section
         ∩ every `blocked-by:` id is closed
         ∩ no `@assignee`            # the claim gate this query adds
         ordered by line position    # document order (total)
```

**Projections:** `ready` → the whole ordered list (`--limit N`); `next` → `ready[0]`
or an empty-diagnosis. Both take identical flags; **neither mutates** — claiming is
an explicit act.

**Orthogonality:** `status:` **never gates** the frontier (annotation + a `--status`
filter only); the tool is **audience-agnostic** (default returns all takeable work;
an agent narrows explicitly, e.g. `--status ready-for-agent`).

**Filters:** `--status` / `--label` / `--parent` / `--assignee`; **AND across
dimensions, OR within a repeated dimension**. `--assignee <who>` relaxes the
*unclaimed* gate (ready work owned by who). The **block gate is always on** for
`next`/`ready`.

**Empty frontier is a normal, diagnosed state** (not an error): "No open issues" /
"N open, all blocked — waiting on …" / "N open, all in progress — @…", so a loop can
decide stop-vs-wait. Emptiness is read structurally, never from the exit code.

## Alternatives considered

- **`next` auto-claims** the returned issue — rejected: makes a read have a side
  effect, unsafe to poll, and hides the claim from the file's audit trail.
- **`status:` gates the frontier** (e.g. only `ready-for-*` surfaces) — rejected:
  couples workflow onto takeability, hides untriaged work, and duplicates what a
  `blocked-by` edge already expresses.
- **Audience inference** (`--for agent|human`, or env-based) — rejected: hard-codes a
  status vocabulary the tool disclaimed as freeform (ADR 0002). Callers filter
  explicitly.
- **A priority/`--sort` field** — rejected: document order is already a total order;
  reordering is a line-move (ADR 0003).

## Consequences

- The query is a pure function of the file — reproducible and greppable (`next` leads
  with the canonical id).
- Two later sub-points (`--mine`, frontier-`--all`) were **superseded by the CLI ADR
  0005** in favour of explicit `--assignee <who>` and pushing "browse wider" onto
  `list`/`tree`.
- Warning presentation, output format, exit codes, and `--json` were handed to
  ADR 0005.
