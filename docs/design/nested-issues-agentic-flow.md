# Design spec — Nested issues & agentic-flow support

**Status:** Locked. Every design decision below is settled; a build session can
execute this document with no open questions. No production code ships in the
effort that produced it — this spec + its ADRs *are* the deliverable.

**Scope.** How `@elucidata/issues` grows to support **nested issues** and the
**agentic dev flow** (blocking, parent/child nesting, claim/assignee, labels,
richer states, a frontier query, and a CLI to drive them) — all inside a single
human-editable `ISSUES.md`, with the byte-for-byte round-trip invariant preserved.

**Source.** Compiled from the resolved decisions on
[Wayfinder map #1](https://github.com/elucidata/issues/issues/1). Each subsystem
cites the ticket it came from and the ADR that records the *why*:

| Subsystem | Ticket | ADR |
|---|---|---|
| Metadata representation (grammar) | [#3](https://github.com/elucidata/issues/issues/3) (prior art [#2](https://github.com/elucidata/issues/issues/2)) | [0001](../adr/0001-inline-trailing-fields.md) |
| State model | [#4](https://github.com/elucidata/issues/issues/4) | [0002](../adr/0002-two-axis-state-model.md) |
| Graph semantics | [#5](https://github.com/elucidata/issues/issues/5) | [0003](../adr/0003-read-time-derived-graph-semantics.md) |
| Frontier query | [#6](https://github.com/elucidata/issues/issues/6) | [0004](../adr/0004-frontier-query.md) |
| CLI surface | [#7](https://github.com/elucidata/issues/issues/7) | [0005](../adr/0005-cli-surface.md) |
| Rendering / round-trip | [#9](https://github.com/elucidata/issues/issues/9) | [0006](../adr/0006-blank-line-canonical-rendering.md) |

---

## 0. Hard constraints (settled — not re-litigated by the build)

- **Single-file `ISSUES.md` is the default.** An escape-hatch split into multiple
  files is *allowed to be proposed* only if the in-file design ever proves too
  gnarly. It did **not** here — the keystone fits with zero grammar change — so the
  build ships single-file.
- **Byte-for-byte round-trip is load-bearing.** See §7 for the precise, restated
  invariant. Frontmatter and preamble prose are preserved verbatim; only section
  bodies are regenerated deterministically. A metadata-free file must stay
  byte-identical.
- **Zero runtime dependencies.** Core imports nothing; the CLI shell imports only
  Node built-ins (`JSON` included — that is what `--json` rides on).
- **Node-first.** `#!/usr/bin/env node`; runs under plain Node 22+ (which strips TS
  types). Bun is dev/build only.
- **Representation anchors to prior art**, not green-field invention (todo.txt inline
  fields; Taskwarrior UDA preservation; GitHub/GitLab behavioural rules).
- **Style:** tabs, single quotes, no trailing commas — match existing source.

---

## 1. Grammar — the metadata primitive

*(ADR [0001](../adr/0001-inline-trailing-fields.md) — from ticket
[#3](https://github.com/elucidata/issues/issues/3))*

Relationships and metadata ride as **inline trailing fields and sigils on the
existing issue line** — the source of truth. Nothing new above the line grammar:

```
- [ ] 007: Wire up the parser. part-of:002 blocked-by:004 type:bug status:in-progress @matt #parser #round-trip
      free-text notes still survive verbatim beneath
```

### 1.1 Where fields live

- Fields **peel off the tail** of the existing `- [ ] <id>: <title>` line. A
  metadata-free line is therefore **untouched** — the round-trip control holds.
- Indented text beneath an entry is still free-text **detail**, preserved verbatim.
- **List-indentation is a display hint the parser ignores** — never a source of
  parentage (see §3.2). Parentage comes only from the `part-of:` field.

### 1.2 The token vocabulary

Two lexical shapes, both borrowed from todo.txt:

| Kind | Shape | Tokens |
|---|---|---|
| **`key:value` field** | `key:value` (no spaces) | `part-of:`, `blocked-by:`, `status:`, `type:` (a UDA — see below), plus any unknown key |
| **Sigil** | leading sigil char | `@assignee`, `#label` |

- **`blocked-by:`** is **many-valued** — comma-separated ids, `blocked-by:004,006`.
- **`part-of:`** is **single-valued** — exactly one id (a tree; §3.2).
- **`@assignee`** — a single claim string (§2.3). One `@` token.
- **`#label`** — many-valued; repeat the sigil, `#bug #ready`.
- **`status:`** — single scalar (§2.2).
- Relationship values (`part-of:`, `blocked-by:`) are **read-only ID pointers**:
  parsed, never rewritten or restructured. All derived state (blocked, frontier,
  in-progress) is computed at read time; **nothing is stored back** (ADR 0003).

### 1.3 Unknown fields (UDA rule)

Any unrecognized `key:value` token — e.g. `type:bug`, `severity:high` — is a
**User-Defined Attribute**: **preserved verbatim** by the serializer, round-trips
untouched, settable via the generic `set` verb (§5). The CLI **asserts nothing**
about a UDA's meaning. (`type:` is specifically a UDA — see §2.4.)

### 1.4 Rejected encodings (do not build these)

- **Field detail-lines** (`Blocked by: 007` as a recognized detail line) —
  round-trips fine and reads well, but verbose. Kept only as a *documented fallback
  concept*, never the primitive.
- **Nested-list as source of truth** (indentation = parentage) — **rejected**. Under
  the current grammar, indented `- [ ]` children get swallowed as the parent's
  detail notes; making nesting authoritative forces a line-grammar rewrite and makes
  genuine indented notes ambiguous. Round-trip hazard.

---

## 2. State model

*(ADR [0002](../adr/0002-two-axis-state-model.md) — from ticket
[#4](https://github.com/elucidata/issues/issues/4))*

**Two orthogonal axes.** Lifecycle and workflow never collapse into one field.

### 2.1 Lifecycle axis = physical section (source of truth for open/closed)

Unchanged from today. The **section a line sits in** is the *only* thing that
decides open vs. closed:

| Section | Lifecycle | Checkbox |
|---|---|---|
| `Issues` | **open** | `[ ]` |
| `Completed` | closed | `[x]` |
| `Deferred` | closed | `[ ]` |
| `Won't Fix` | closed | `[ ]` |

- The closed sections name the *reason* closed. Only `Completed` renders checked.
- The frontier query (§4) and the blocking gate (§3.1) read **only** this axis for
  open/closed. `status:` **never** affects open/closed.

### 2.2 Workflow axis = inline `status:` field (open-only refinement)

- **Canonical set:** `needs-info`, `ready-for-agent`, `ready-for-human`.
- **Absent = untriaged / default.** `add` writes **no** `status:` — so metadata-free
  files stay byte-identical, and absent subsumes any "needs-triage" state (there is
  no explicit triage value).
- **`status:` is freeform by default.** Any value round-trips; unknown values are
  preserved (§1.3). A project *may* declare an allowed set via **frontmatter**
  (recommended key `statuses:`) to drive **warnings only** — round-trip is never
  lossy either way. CLI enforcement of a declared set is **warn-but-write** (§5,
  decision 7).
- **`status:` is semantically void once closed.** Close commands (`done` and its
  `--defer`/`--wontfix` variants) **clear `status:` on close**; the parser still
  **preserves** any status a human hand-leaves on a closed issue.

### 2.3 `@assignee` = the claim; `in-progress` is derived

- A single `@assignee` token is the **claim** (§5, decision 4). It is an explicit
  string (`agent`, a name) — there is **no identity source and no magic "me"** (the
  file has no real users; an agent's edits and a human's are indistinguishable).
- **`in-progress` is derived, never stored:** open + has `@assignee` = in progress.
  No stored value can contradict the claim.
- On close, `@assignee` **persists** as provenance (who resolved it). The claim gate
  is open-only (§4), so a retained assignee on a closed issue never pollutes the
  frontier.

### 2.4 `category` is not state

`bug`/`enhancement` and similar categories are **not** a lifecycle or workflow
state. Category rides the `#label` sigil (`#bug`). `type:` survives only as a UDA
(§1.3) — settable via `set`, asserted-about by nothing. Out of scope as a
first-class field.

---

## 3. Graph semantics

*(ADR [0003](../adr/0003-read-time-derived-graph-semantics.md) — from ticket
[#5](https://github.com/elucidata/issues/issues/5))*

Two axes, **fully orthogonal**. `blocked-by:` and `part-of:` share no semantics.
Both are read-only ID pointers; **all state is derived at read time, nothing
stored.**

### 3.1 Blocking (`blocked-by:`, many-valued)

- **Direct blockers only — non-transitive.** `blocked(A)` = any id in `A.blocked-by`
  still sits in the open `Issues` section. Chains clear **one link at a time** (close
  C → B becomes takeable → close B → A becomes takeable).
- **Any closed section satisfies the gate.** Completed, Deferred, *or* Won't Fix all
  lift the block — it is exactly the `isOpen` test ("not in the open `Issues`
  section").
- **Dangling blocker → fail-open + warn.** An id found nowhere in the file does not
  block; emit an advisory warning. A typo or deletion never silently freezes
  downstream work.
- **Reopen auto-reactivates.** Move a blocker back into `Issues` and the gate
  re-derives — a consequence of read-time derivation, not a separate rule.
- **Cycles → warn, members stay blocked.** Detected at read time (DFS). A mutual
  cycle is a real deadlock; **never auto-broken, never rejected** — the file
  round-trips verbatim; a human breaks it by editing an edge.
- **Self-reference** (`A blocked-by A`) → the edge is **ignored** + warn.
- **Won't-Fix blocker** satisfies the gate (per "any closed section") but *may*
  deserve an advisory warning ("downstream unblocked by a won't-fix"). Implementation
  nicety, not a hard rule.

### 3.2 Containment (`part-of:`, single-valued)

- **Pure grouping — zero state flow.** `part-of:` carries **no** lifecycle or
  blocking semantics:
  - all children closed → parent is **never** auto-closed;
  - closing/deleting a parent → **never** touches children;
  - a blocked or closed parent → **never** gates children.

  A child's takeability depends **solely on its own `blocked-by`**. If "child needs
  parent done first" is ever real, model it as an explicit `blocked-by` edge — that
  is the axis for it.
- **Single parent.** `part-of:` holds exactly one id (a tree, not a DAG). Anchors to
  the GitHub sub-issue model and keeps the indentation↔containment correspondence
  1:1. Cross-cutting linkage is a `#label` or a `blocked-by` edge, not containment.
- **Dangling `part-of:`** (parent id not found) → child renders **top-level**,
  fail-open + warn. No lifecycle effect.

### 3.3 Ordering

- **Author-controlled document order.** Order = **line position** in `ISSUES.md`. A
  parent's children order by their appearance (they need not be physically contiguous
  — `part-of:`, not indentation, is the source of truth).
- **No `order:` field, no numeric prefix.** Reorder by moving lines; survives
  round-trip for free. It is a **total** order (no two lines share a position), so
  frontier tie-breaking is moot (§4).

### 3.4 The three warnings feed the CLI

Dangling ref, cycle, and won't-fix-blocker are **inputs to the CLI surface** (§5),
which decides their reject-vs-warn *presentation*. The rule across the board:
**warn, never block a write** (§5, decision 7–8).

---

## 4. Frontier query

*(ADR [0004](../adr/0004-frontier-query.md) — from ticket
[#6](https://github.com/elucidata/issues/issues/6))*

The command an agent (or human) runs to pick up work. **One predicate, two
read-only projections, layered filters** — all derived at read time (§3), nothing
stored, nothing auto-claimed.

### 4.1 Base predicate — `next` / `ready` (no flags)

```
frontier(doc) = issues in the open `Issues` section        # open      (§2.1)
              ∩ every `blocked-by:` id is closed            # unblocked (§3.1)
              ∩ no `@assignee`                              # unclaimed (§2.3)
              ordered by line position                      # document order (§3.3)
```

- The **claim gate** (`no @assignee`) is the one gate this query adds over §3's
  "topmost takeable": a claimed issue is someone's active work and leaves the default
  frontier.

### 4.2 Two projections (read-only, no auto-claim)

- **`ready`** → the whole ordered frontier list (0..n rows); optional `--limit N`.
- **`next`** → `ready[0]` (the topmost), or the empty-diagnosis (§4.5).
- `next ≡ ready[0]`; both take identical flags; **neither mutates** — claiming stays
  an explicit act (§5, decision 4).

### 4.3 Orthogonality (settled)

- **`status:` never gates the frontier.** Annotation + a `--status` filter only.
  Takeability depends *solely* on `blocked-by` (§3.1); untriaged (status-absent)
  issues still surface. If something truly can't proceed, model it as a `blocked-by`
  edge, not a status.
- **Audience-agnostic.** The tool never guesses who is asking. Default returns **all**
  takeable work; an agent narrows explicitly (`--status ready-for-agent`). No hidden
  env/config changes what `next` means.

### 4.4 Filters and gate-relaxers

- **Filters** (narrow the base frontier, all optional):
  `--status <s>` · `--label <l>` · `--parent <id>` (direct children of one map) ·
  `--assignee <who>`.
  **Different dimensions AND together; a repeated dimension ORs within it**
  (`--label a --label b` = a OR b).
- **`--assignee <who>`** drops the *unclaimed* gate and requires `assignee == who`
  (keeps open + unblocked) → "ready work owned by who".
- On `next`/`ready` the **block gate is always on** — browsing blocked/closed work is
  `list`/`tree`'s job, not the frontier's (§5, decision 12; supersedes #6's
  frontier-`--all` and `--mine`).

### 4.5 Empty frontier — a normal state, diagnosed (not an error)

Count the open section and report which gate emptied it, so an agent loop can decide
stop-vs-wait:

- `0` open → **"No open issues."** (drained — work is done)
- open but all blocked → **"N open, all blocked — waiting on `<ids>`."**
- open but all claimed → **"N open, all in progress — `<@who>`."**
- a mix → summarize the counts.

Empty is **exit 0** (§5, decision 10) — read emptiness structurally from `--json`
(`null`/`[]`) or the diagnostic text, never from the exit code.

### 4.6 Warnings

The query **fails open and emits the §3 advisories** as it derives (dangling
`blocked-by:`/`part-of:`, cycle, won't-fix blocker). These never change frontier
membership beyond §3's rules; presentation is §5's.

---

## 5. CLI surface & command set

*(ADR [0005](../adr/0005-cli-surface.md) — from ticket
[#7](https://github.com/elucidata/issues/issues/7))*

A **hybrid mutation model**: ergonomic verbs for relational/many-valued fields
(validation + a natural inverse), and a generic `set`/`unset` escape hatch for flat
scalars + UDAs. Reads gain `--json`; the human format stays pretty because agents
consume JSON. Warnings are advisory (stderr, non-fatal, **exit 0**) everywhere
except `doctor`.

### 5.1 The command surface

```
add "<title>" [--note <t>] [--part-of <id>] [--blocked-by <id[,id]>] [--status <s>] [--assignee <who>] [--label <name[,name]>]
block <id> --by <blocker>          unblock <id> [--by <blocker>]      # no --by clears all blockers
assign <id> <who>                  unassign <id>
label <id> <name[,name]>           unlabel <id> <name[,name]>
set <id> <key>:<value>             unset <id> <key>
next   [filters] [--json]          ready [filters] [--limit N] [--json]
tree   [--json]                    show <id> [--children] [--json]
list   [section flags] [filters] [--json]
done <id> [--defer|--wontfix]      reopen <id>
edit <id> "<title>"                note <id> "<text>"
doctor [--json]                    help
global: -q/--quiet, --json (reads)
filters (list/next/ready): --status <s> | --label <n> | --parent <id> | --assignee <who>
         (AND across dimensions, OR within a repeated dimension)
```

### 5.2 Decisions (numbered as grilled — normative)

1. **Mutation model — hybrid.** Verbs manage collections and pointers; `set` replaces
   a scalar. Verbs for relational/many-valued fields (they want validation + an
   inverse); generic `set`/`unset` for flat scalars + UDAs.
2. **`add` takes optional field flags** mapping 1:1 onto the verb logic —
   **byte-identical output** to the equivalent verb sequence. Multi-values are
   **comma-separated** to mirror the inline grammar (`--blocked-by 004,006`). Bare
   `add "title"` is unchanged.
3. **`block <id> --by <blocker>` / `unblock <id> [--by <blocker>]`** (no `--by`
   clears all). **Reject self-ref**; **warn-but-write** on unknown blocker / cycle
   (honors §3 fail-open; cycles are never auto-broken).
4. **`assign <id> <who>` / `unassign <id>` only — no `claim`, no identity source.**
   Claimant is an explicit string. **Supersedes #6's `--mine`** — substance survives
   as the explicit `--assignee <who>` filter/relaxer; the claim *gate* is untouched.
5. **`label` / `unlabel`** (comma-list), additive/targeted — labels are the one
   many-valued sigil, so a verb pair (not `set`-as-replace) fits.
6. **`set <id> <key>:<value>` / `unset <id> <key>`** for flat scalars (`status`) +
   any UDA. **No bespoke `type`/`status` verbs** — they are plain scalar replaces.
7. **Declared-status validation — warn-but-write.** If frontmatter declares
   `statuses:` and a written value is outside it, warn to stderr but write. Governing
   rule: **warnings → stderr, never block a write, exit 0.**
8. **§3 warnings emit on graph-reading commands** (`list`/`next`/`ready`/`show`/
   `tree`) + write-time on `block`/`set` when the touched edge is the problem.
   Silenceable with **`-q`/`--quiet`**.
9. **`--json` on the read/query commands** (`list`/`next`/`ready`/`show`/`tree`) — a
   stable machine contract including derived fields (`blocked`, `takeable`, frontier
   reason). Human text stays default. JSON is a Node built-in — no dependency.
10. **Exit codes: 0 = ran fine (incl. empty frontier), 1 = error** (not found /
    usage / bad args). Empty `next`/`ready` is normal → exit 0. The **one exception**
    is `doctor` (decision 19).
11. **`--for agent|human` dropped.** It would hard-code `ready-for-agent`/
    `ready-for-human`, but §2 made `status:` freeform + project-declarable — the CLI
    must not assert a vocabulary it disclaimed. Use explicit `--status <value>`.
12. **`--all` reconciliation — each command has one job.** `next`/`ready` are
    *always* the live takeable frontier (block gate always on; flags only narrow).
    Browsing wider (blocked/closed) is `list`/`tree`'s job. **Retires #6's
    frontier-`--all`.**
13. **`tree`** (full containment forest, state-annotated) **+ `show <id> --children`**
    (one subtree), both pure reads with `--json`. `tree` is **containment-only** —
    blocking is a node annotation (`⊘`), never drawn as tree structure (§3
    orthogonality — blockers are not children).
14. **`type` is not first-class; categorization rides `#label`** (§2.4). Drops the
    `--type` flag. `type:` remains a valid UDA settable via `set`; the CLI asserts
    nothing about it.
15. **Close voids `status:` only** (§2.2). `@assignee` (provenance), `blocked-by:`,
    `part-of:`, `#label` all **persist** (facts, not lifecycle state).
16. **No reorder command — order is hand-edited.** Document order is the sole
    priority signal (§3.3); moving a line is trivial for a human and scriptable for an
    agent (it edits `ISSUES.md` directly). A `move`/`add --top` verb is **deferred
    fog**, addable later without disturbing anything.
17. **`show` = full resolved dossier** (relationships expanded with titles +
    open/closed state, assignee, labels, status, warnings). **`list` = compact
    info-dense markers** (`⊘` blocked, `@assignee`, `#labels`, `status:`),
    single-line-per-issue — the open list is the triage surface, so gating state must
    be visible.
18. **One shared filter vocabulary across `list`/`next`/`ready`** (`--status` /
    `--label` / `--parent` (direct children) / `--assignee`; AND across dims, OR
    within). Commands differ only in default gate: `list` → a section, `next`/`ready`
    → the takeable frontier.
19. **`doctor` — a read-only linter.** Scans the whole file and reports every anomaly
    (all §3 warnings + malformed lines + unknown-status-vs-declared-set) in one
    grouped list; `--json` for LLM consumption. **Exits 0 clean / nonzero on
    findings** — the one principled exception to decision 10, because "findings exist"
    is precisely its actionable signal (CI / pre-commit gate-able). Never mutates.

### 5.3 Minor spec defaults (confirmed)

- **Idempotent removals** — `unset`/`unblock`/`unlabel`/`unassign` on an absent
  field/edge = **no-op + informative message, exit 0**.
- **Mutations work on any section**, but `set status:` on a *closed* issue **warns**
  (status is open-only per §2.2) and still writes.
- **`edit` preserves trailing fields** — the keystone (§1) parses fields off the tail
  into the model, so replacing the title never disturbs them.
- **Arg-parser extension** — new value-taking flags (`--by`, `--part-of`,
  `--blocked-by`, `--status`, `--assignee`, `--label`) join `VALUE_FLAGS`; `set`
  reads a `key:value` positional; `help` is regenerated to document the full set.

---

## 6. `--json` read contract

Every read/query command (`list`/`next`/`ready`/`show`/`tree`) accepts `--json` and
emits a **stable machine contract** that includes the **derived** fields an agent
needs without re-deriving them:

- Per issue: `id`, `title`, `section` (lifecycle), `status`, `assignee`, `labels[]`,
  `blockedBy[]`, `partOf`, plus derived `blocked` (bool), `takeable` (bool), and —
  for `next`/`ready` — the frontier reason when empty (§4.5).
- `next` output leads with the canonical **id** so text output stays greppable /
  scriptable.

The exact JSON field names are an implementation detail the build fixes once and then
holds stable; the contract above is the required content.

---

## 7. Rendering & the round-trip invariant

*(ADR [0006](../adr/0006-blank-line-canonical-rendering.md) — from ticket
[#9](https://github.com/elucidata/issues/issues/9))*

### 7.1 Canonical rendering — blank-line separated

- `renderSection` joins entry-blocks with **`\n\n`** (was a single `\n`);
  `renderIssue` is **untouched**. An *entry-block* = the issue line + its indented
  detail. Detail stays **tight** under its parent; blank lines fall **only between
  top-level entries** (a blank before an indented detail line would risk the parser —
  which skips blanks — detaching the note). Concretely: `.join('\n')` →
  `.join('\n\n')` in `renderSection`, nothing else in the render path.
- **Serialized file only.** `cmdList` / `cmdShow` have independent render paths and
  are **unchanged** — terminal output is **not** double-spaced.

### 7.2 The restated invariant (carry these words)

`serialize(parse(x)) === x` never held for *arbitrary* `x` — the parser already
skips hand-added blank lines and re-emits, so a hand-spaced file never round-tripped.
The guard only ever ran against the canonical `ISSUES.md`. The precise invariant is:

> **A file in canonical (blank-separated) form is a fixed point; single-`\n` input is
> accepted on read and normalized to blank-separated on write.**

Reflow of a tight (single-`\n`) file on its first CLI write is **defined behavior,
not a bug** — it is how the two coexistence goals are met at once: stop clobbering
hand-added blanks, and keep one legible canonical form.

### 7.3 One-time migration (the only residual build risk)

The repo's own `ISSUES.md` and **every** single-`\n` test fixture migrate once to
blank-separated so `serialize(parse(x)) === x` stays green. The build must state this
and catch **every** affected fixture — that (not "does the approach work") is the
sole residual risk. No prototype was needed: the mechanism is one line; the blank is
skipped on parse, `lastIssue` persists harmlessly, the next `- [ ]` resets it, so
blank-separated-with-detail round-trips exactly.

---

## 8. Back-compat summary

- **Metadata-free files stay byte-identical** — fields peel off the tail; `add`
  writes no `status:` (§1.1, §2.2).
- **Section-based lifecycle unchanged** — existing `Issues`/`Completed`/`Deferred`/
  `Won't Fix` semantics are the same; the new axes are additive (§2.1).
- **The single behavioural change to existing files** is blank-line reflow on first
  write (§7). Defined, and reconciled with the (restated) round-trip guard.

---

## 9. Build checklist (execution order for the next session)

The design is closed; this is a suggested implementation order, not new decisions.

1. **Parser** — peel trailing `key:value` fields and `@`/`#` sigils off the issue
   line into the model; preserve unknown keys (UDA); `part-of:` single, `blocked-by:`
   /`#label` multi (§1).
2. **Serializer** — re-emit fields on the tail deterministically; **`renderSection`
   join `\n\n`** (§7.1). Migrate `ISSUES.md` + fixtures; keep `serialize(parse(x))`
   green under the restated invariant (§7.2–7.3).
3. **Derivation** (read-time, pure) — `isOpen`, `blocked`, cycle/dangling/self-ref
   detection with warnings, `takeable`, frontier + empty-diagnosis (§3–§4).
4. **CLI verbs & flags** — `block`/`unblock`, `assign`/`unassign`, `label`/`unlabel`,
   `set`/`unset`, `add` field flags, `next`/`ready`, `list`/`show`/`tree`, `doctor`,
   `--json`, `-q`; wire warnings → stderr, exit codes per decision 10/19 (§5).
5. **Docs** — regenerate `help`; update `skills/issues/SKILL.md` and `docs/agents/*`
   to teach the new surface (tracked as fog on the map; downstream of this spec).
6. **Rebuild & commit `dist/`** per repo policy (CLAUDE.md) — consumers run `dist/`
   straight from GitHub.

---

## 10. Explicitly out of scope (this effort)

- Implementing the feature in `src/` and rebuilding/shipping `dist/` — the
  destination was a **spec**, not code. (§9 is the *handoff* to that build session.)
- Web UI, service, SQLite, or any networked backend.
- Building full alternate storage backends beyond *discussing* the escape-hatch
  threshold (untriggered — §0).

## 11. Deferred (fog — addable later without disturbing this spec)

- **Escape-hatch file split** — dormant; revisit only if a later feature makes the
  in-file design gnarly.
- **Reorder verb** (`move`/`add --top`) — order is hand-edited in v1 (§5, decision
  16).
- **Multi-agent concurrency hardening** — whether assignee-claim suffices or
  file-level races need locking / optimistic writes.
- **Agent-facing docs** (`SKILL.md`, `docs/agents/*`) — specified enough to write;
  downstream of the build.
