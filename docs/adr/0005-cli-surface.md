# ADR 0005 — CLI surface: hybrid mutation model, JSON reads, advisory warnings

- **Status:** Accepted
- **Ticket:** [#7 CLI surface & command set](https://github.com/elucidata/issues/issues/7)
- **Spec:** [Nested issues & agentic-flow support §5](../design/nested-issues-agentic-flow.md#5-cli-surface--command-set)
- **Supersedes:** two sub-points of [ADR 0004](0004-frontier-query.md) (`--mine`, frontier-`--all`)

## Context

With the representation (ADR 0001), state model (ADR 0002), graph semantics
(ADR 0003), and frontier query (ADR 0004) settled, the CLI must expose them: how to
mutate the new fields, how agents consume reads, and how the ADR 0003 warnings
surface — Node-first, dependency-free, consistent with the existing
`add`/`done`/`edit`/`note`/`list` dispatch.

## Decision

A **hybrid mutation model** plus a machine-readable read layer. Full command surface
and the 19 numbered decisions are normative in
[spec §5](../design/nested-issues-agentic-flow.md#5-cli-surface--command-set). The
load-bearing choices:

- **Verbs for relational/many-valued fields** (`block`/`unblock`, `assign`/`unassign`,
  `label`/`unlabel`) — they want validation + a natural inverse. **Generic `set`/
  `unset`** for flat scalars (`status`) + any UDA. No bespoke `type`/`status` verbs.
- **`add` gains optional field flags** mapping 1:1 onto the verbs — byte-identical
  output; multi-values comma-separated.
- **Claim = explicit string** — `assign <id> <who>` / `unassign` only. **No `claim`,
  no identity source, no magic "me"** (the file has no real users). This retires
  ADR 0004's `--mine`; the explicit `--assignee <who>` filter carries its substance.
- **`--json` on all reads** (`list`/`next`/`ready`/`show`/`tree`) — a stable contract
  incl. derived `blocked`/`takeable`/frontier-reason. Human text stays default. JSON
  is a Node built-in — no dependency.
- **Warnings are advisory:** stderr, non-fatal, **exit 0**, silenceable with `-q`.
  Validation is **warn-but-write** everywhere (unknown blocker, cycle, declared-status
  mismatch, `set status:` on a closed issue). Self-reference on `block` is the one
  hard **reject**.
- **Exit codes:** 0 = ran fine (incl. empty frontier), 1 = error. The **one
  exception** is **`doctor`** — a read-only linter that exits **nonzero on findings**
  so it is CI/pre-commit gate-able.
- **Each read command has one job:** `next`/`ready` are *always* the live takeable
  frontier (block gate always on; flags only narrow) — retiring ADR 0004's
  frontier-`--all`; browsing blocked/closed work is `list`/`tree`. `show` = full
  dossier; `list` = compact info-dense markers; `tree` = containment-only forest.
- **No reorder command** — document order is hand-edited (ADR 0003); a `move`/
  `add --top` verb is deferred fog.
- **Close voids `status:` only**; assignee/relationships/labels persist as facts.

## Alternatives considered

- **All-generic `set`/`unset`** (no verbs) — rejected: loses validation and natural
  inverses for the many-valued/relational fields, and makes `block --by` /
  `unblock`-style ergonomics clumsy.
- **A `claim` verb with an implicit identity** ("me") — rejected: the file has no
  users; a magic "me" would lie, since agent and human edits are indistinguishable.
- **`--for agent|human` sugar** — rejected: hard-codes a status vocabulary the tool
  disclaimed (ADR 0002); use explicit `--status <value>`.
- **Overloading exit status** to signal "empty frontier" — rejected: empty is a
  normal state (ADR 0004); read it structurally from `--json`/text. `doctor` is the
  sole, principled exit-code exception.

## Consequences

- The full agentic surface exists without a single runtime dependency.
- Blank-line rendering surfaced during this grilling as a round-trip-touching concern
  and was split into its own decision (ADR 0006) rather than resolved here.
- The build gets an unambiguous command table (spec §5.1) and behaviour list
  (§5.2–5.3).
