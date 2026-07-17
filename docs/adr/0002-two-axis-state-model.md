# ADR 0002 — Two-axis state model: physical section = lifecycle, `status:` = workflow

- **Status:** Accepted
- **Ticket:** [#4 State model](https://github.com/elucidata/issues/issues/4)
- **Spec:** [Nested issues & agentic-flow support §2](../design/nested-issues-agentic-flow.md#2-state-model)

## Context

Today "state" *is* the physical section: `Issues` / `Completed` / `Deferred` /
`Won't Fix`. The agentic flow wants richer workflow states (needs-info,
ready-for-agent, ready-for-human, in-progress). The question: extend the section
set, add a state field/label axis, or hybrid — and how does the new notion map to
the open/closed distinction the frontier query depends on?

## Decision

**Two orthogonal axes.**

1. **Lifecycle = physical section** (unchanged, source of truth for open/closed):
   `Issues` = open; `Completed`/`Deferred`/`Won't Fix` = closed (the section names
   the *reason*). This is the **only** input to open/closed. `status:` never affects
   it.
2. **Workflow = inline `status:` field** (open-only refinement, per ADR 0001):
   canonical set `needs-info` / `ready-for-agent` / `ready-for-human`.
   - **Absent = untriaged default.** `add` writes no `status:`; metadata-free files
     stay byte-identical; absent subsumes "needs-triage".
   - **`in-progress` is derived, not stored:** open + `@assignee` = in progress.
   - **Freeform by default** — any value round-trips (UDA rule). A project *may*
     declare an allowed set via frontmatter `statuses:` to drive **warnings only**;
     round-trip is never lossy.
   - **Void once closed** — close commands clear `status:`; the parser preserves any
     status a human hand-leaves on a closed issue.

`category` (`bug`/`enhancement`) is **not** state — it rides `#label`; `type:`
survives only as a UDA.

## Alternatives considered

- **Extend the section set** with more physical sections (e.g. an `In Progress`
  section) — rejected: conflates lifecycle with workflow, forces line-moves for a
  workflow change, and `in-progress` is better derived from the claim than stored.
- **State as a first-class validated enum** — rejected: violates the "freeform,
  never lossy" posture; a project can opt into validation via `statuses:` without the
  tool imposing a vocabulary.

## Consequences

- The frontier query reads a single, simple open/closed signal (the section);
  `status:` is pure annotation + a filter dimension (ADR 0004).
- No stored value can contradict the claim (`in-progress` can't drift out of sync).
- Hand-edits and CLI edits stay symmetric: freeform status + preserve-on-read means
  neither clobbers the other.
