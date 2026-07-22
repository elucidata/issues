# Design spec — Findings: structured findings, severity tiers, scoped emission

- **Status:** Locked (design closed; not yet built)
- **ADR:** [0009](../adr/0009-finding-model-severity-and-emission.md)
- **Map:** [#32 The finding model](https://github.com/elucidata/issues/issues/32)
- **Tickets:** [#33](https://github.com/elucidata/issues/issues/33),
  [#34](https://github.com/elucidata/issues/issues/34),
  [#35](https://github.com/elucidata/issues/issues/35),
  [#36](https://github.com/elucidata/issues/issues/36)

The executable synthesis of ADR 0009. Where the ADR argues *why*, this doc says *what to
build*: the exported types, the exact scope predicates, the two render densities, and the
handoff checklist. It **extends** the graph-semantics warnings of
[`nested-issues-agentic-flow.md`](nested-issues-agentic-flow.md) §3 and the terminal
rendering of [`terminal-output.md`](terminal-output.md), unifying both under one model.

---

## 0. Hard constraints (settled — not re-litigated by the build)

- **The core is pure and filesystem-free** (`src/index.ts`): no I/O, no `process.env`, no
  TTY probing (CLAUDE.md). The producer and formatter live in the core; the `color` boolean
  and the `view` set arrive as arguments. `src/bin.ts` is the only layer that touches the
  terminal or a stream.
- **Zero runtime dependencies.** No `chalk`, no width table. Colour is hand-written ANSI SGR
  from the 8/16-colour range (ADR 0008); prose is authored short and never reflowed.
- **`ISSUES.md` is untouched.** No format change, no parser change, no round-trip impact —
  everything here is read-time derivation (ADR 0003) and rendering.
- **The library surface is public API.** Every exported type is governed by **package
  semver**, independently of ADR 0007's file-format `schema:` contract (§8). Removing the
  three string producers is a breaking library change, shipping in `0.4.0`.
- **`warning` is reserved.** `Severity` is `'error' | 'advisory'`, an ordered scale with a
  deliberately empty middle. Prior prose using "warning" for the finding channel is rewritten
  (§9.2); the word is left unused so a middle tier can take it without a rename.

---

## 1. The `Finding` type and its producer

A finding is **structured data with a formatter** (ADR 0009 §1), not a string.

```ts
export type Severity = 'error' | 'advisory'   // ordered: error > (warning) > advisory
export type FindingCode =
	| 'malformed-line' | 'dangling-blocker' | 'dangling-part-of' | 'self-blocker'
	| 'cycle' | 'undeclared-status'
	| 'wontfix-blocker' | 'deferred-blocker' | 'closed-with-open-blocker'
	| 'schema-unparseable' | 'schema-too-new'

export interface Finding {
	severity: Severity
	code: FindingCode
	subjects: string[]      // 0 = the file · 1 = an issue · n = a knot
	mentions: string[]      // implicated ids; write-time scope
	value?: string          // the one non-id scalar some codes carry
	line?: number           // file-level findings only
}

export function findings(doc: Doc, text: string): Finding[]
export function formatFinding(f: Finding, color: boolean): string
```

- `text` is available at every call site: `run(text, argv)` threads it through the whole
  dispatch, and a library consumer necessarily has it, having just called `parse`.
- **`FindingCode` is a union, not `string`** (following `IssueState`) — adding a member is
  non-breaking for consumers who read it.
- **`line?` is on findings, not `Issue`.** File-level findings (`subjects: []`) get it from
  `malformedLines` for free; the exported `Issue` interface gains **no** line number — the id
  is the locator for an issue, and adding a field is public-API churn for marginal gain.
- Scoping helpers (`view`-membership, etc.) stay **internal** — one-liners at the call site
  (§3). Exporting later is additive; un-exporting is a break.

### 1.1 Construction — severity from a total table, never typed at each site

```ts
export const FINDING_SEVERITY: Record<FindingCode, Severity> = {
	'malformed-line':           'error',
	'dangling-blocker':         'error',
	'dangling-part-of':         'error',
	'self-blocker':             'error',
	'cycle':                    'error',
	'undeclared-status':        'error',
	'wontfix-blocker':          'advisory',
	'deferred-blocker':         'advisory',
	'closed-with-open-blocker': 'advisory',
	'schema-unparseable':       'advisory',
	'schema-too-new':           'advisory'
}

const finding = (code: FindingCode, subjects: string[], mentions: string[] = [], extra = {}): Finding =>
	({ code, severity: FINDING_SEVERITY[code], subjects, mentions, ...extra })
```

`Record<FindingCode, Severity>` is **exhaustive**: adding a code to the union without
classifying it is a compile error. Same construction as `STATE_GLYPHS: Record<IssueState, …>`.
Consumers read `f.severity` unchanged; `--json` serialises it for free.

---

## 2. `subjects` is a set — cardinality is the model

A finding names its **subjects** (ids it is *about*) and its **mentions** (ids implicated).

| `subjects.length` | means | scope behaviour |
|---|---|---|
| 0 | about the **file** | always in scope — every read, every write |
| 1 | about **one issue** | in scope where that id is in view / touched |
| n | about a **knot** | in scope where *any* member is in view / touched |

- When `subjects` is empty, `line` fills the "where" slot, so **every finding says where**.
- A cycle's ordered member list lives in `subjects` (the "where"), not `mentions`. This frees
  `mentions` to mean *ids implicated, scoped at write time*.

### 2.1 The eleven codes

| Code | Tier | `subjects` | `mentions` | `value` |
|---|---|---|---|---|
| `malformed-line` | error | `[]` (file) | — | the raw line; `line` set |
| `dangling-blocker` | error | the issue | the missing id | — |
| `dangling-part-of` | error | the child | the missing parent | — |
| `self-blocker` | error | the issue | the issue id | — |
| `cycle` | error | every member, ordered | — | — |
| `undeclared-status` | error | the issue | — | the offending `status:` value |
| `wontfix-blocker` | advisory | the dependent | the won't-fix blocker | — |
| `deferred-blocker` | advisory | the dependent | the deferred blocker | — |
| `closed-with-open-blocker` | advisory | the closed issue | the open blocker | — |
| `schema-unparseable` | advisory | `[]` (file) | — | the raw `schema:` value |
| `schema-too-new` | advisory | `[]` (file) | — | the `schema:` value |

### 2.2 The admission test (governs additions)

> A candidate is a **finding** iff it is **derived** from the file at read time (nothing
> stored) and it names **an assumption that may not hold**, rather than a judgment about how
> the file is *written*. It is an **error** if the file is already wrong; an **advisory** if
> the state is one a maintainer may rationally leave in place forever.

The operational test for the tier: **can this be left alone indefinitely?** The second clause
refuses the style-linter class (*no labels*, *no assignee*, *title too long*, *empty section*).

---

## 3. Emission — every surface is a filter over `findings(doc, text)`

**Nothing anywhere names a `FindingCode`.** `warningsFor`, `advisories()`, `edgeAdvisories()`
and the three legacy producers do **not** survive. Three predicates, composed:

```ts
// read — `view` is the set of ids the command printed
f.subjects.length === 0 || f.subjects.some(id => view.has(id))

// write — `id` is the id the command touched
f.subjects.length === 0 || f.subjects.includes(id) || f.mentions.includes(id)

// -q, composed onto either
f.severity >= 'error'
```

### 3.1 Reads scope by *printed*

`view` is **every id the command put on screen**, scaffolding included:

| Command | `view` |
|---|---|
| `list` / `next` / `ready` | the rendered ids (returned from, or recomputed beside, the render) |
| `tree` | `treeView().visible` — `matched ∪ scaffold` (already computed) |
| `show <id>` | `{ id }` (plus `--children` ids) |

"Printed is in view" makes the anti-nag goal exact: a finding about an invisible row is
structurally out of scope, so it cannot nag; a finding about a visible row is always shown.

### 3.2 Writes scope by *names this id at all*

A write speaks **every finding that names the id it touched** (`subjects ∪ mentions`), not
`mentions` alone — literal mention-only scoping is a regression against today's substring
match, which already matches an id wherever it appears.

A write **emits its scoped findings iff it writes a field the finding model reads** —
`blocked-by`, `part-of`, `status`, or section membership. A **property, not a list**:

| | Commands |
|---|---|
| **Emits** | `add`, `block`, `unblock`, `set`, `unset`, `done`, `reopen` |
| **Silent** (scoped findings) | `assign`, `unassign`, `label`, `unlabel`, `edit`, `note` |

**File-level findings (`subjects: []`) still speak on every write, including the silent list** —
every write rewrites the whole file, so `note` is what actually drops a malformed line. The
command does not change that finding; it *executes* it.

`done ISS-039` and `reopen ISS-041` both surface the same `closed-with-open-blocker` finding —
the symmetric-`close` warning the map anticipated falls out of the rule, not written as a
feature.

### 3.3 The discovery pointer — out-of-view **errors** only

A read emits **one** line where errors exist about issues outside its view:

```
→ 1 error elsewhere — run `issues doctor`
```

- **Errors only** — self-extinguishing; an advisory pointer would nag permanently about an
  inspected-and-correct `closed-with-open-blocker`.
- Computed from the **complement** of the view against the full `findings()` result, counting
  only hidden errors. Names the command (routing + `doctor` discoverability).
- **Reads only.** Writes already speak about the id they touched (§3.2).

---

## 4. Rendering

### 4.1 Two densities

- **inline** — one line: `<glyph> <where>  <short reason>`. For `show`, `list`, and write-time
  findings.
- **report** — three parts, for `doctor` (§5): **where** · **why (authored prose, ~72 cols)** ·
  **`Fix:` imperative**.

The core **cannot wrap**; report prose is authored short and never reflowed at runtime.

### 4.2 The stderr block form

`list` / `next` / `ready` / `tree` and write commands surface findings as a **block on
stderr**, not bare lines:

```
$ issues list
  - ISS-007  Ship the CLI
  - ISS-012  Write the docs #docs
  - ISS-031  Wire up CI
  - ISS-041  Audit the old format

  ! ISSUES.md:8  not an issue line or an indented note — the parser drops it
  ! ISS-007  blocked-by ISS-099 not found — fails open (does not block)
  · ISS-031  blocker ISS-002 is deferred — unblocked by postponement, not completion
  → 1 error elsewhere — run `issues doctor`
```

- **one blank line** before the block; it rides **stderr**, so a redirect is unaffected — the
  separation exists only where both streams share a terminal.
- **`!` error · `·` advisory · `→` pointer.** Both glyphs are already this codebase's
  vocabulary (`show`'s `!`, `doctor`'s `·`). The glyph is load-bearing because **this channel
  is never coloured** (§4.4).
- **two-space indent**; **errors sorted first**.
- On a healthy file the block is empty.

### 4.3 `show` folds findings into the dossier (stdout), pointer on stderr

`show` is a read, so it gets a pointer; but findings about the shown issue fold into the
**dossier on stdout** and are not duplicated on stderr. The pointer is about the *rest* of the
file, so it does **not** belong in the dossier — it rides stderr, keeping `show`'s stdout
contract exactly "the dossier for this issue".

```
$ issues show ISS-007
ISS-007  Ship the CLI
  state: Open
  blocked-by: ISS-099 (not found)
  ! ISS-007  blocked-by ISS-099 not found — fails open (does not block)   ← stdout, red

  → 2 errors elsewhere — run `issues doctor`                              ← stderr
```

### 4.4 Colour — none on stderr; `error` → red, `advisory` → dim on stdout

- **The stderr channel is never coloured, and no `process.stderr.isTTY` probe is added**
  (ADR 0008 rejected a second colour-resolution surface). The glyphs carry severity there.
- **`error` → red, `advisory` → dim, wherever the stream is coloured.** `show`'s dossier and
  `doctor`'s report ride stdout; their findings colour by severity. Uniform and mechanical —
  *findings colour by severity wherever the stream is coloured at all* — so `doctor` inherits
  the palette (§5) rather than inventing one, and `formatFinding`'s `color` parameter is not
  vestigial. `red` reuses `blocked`'s gutter colour but never shares its column; `dim` is the
  established "recede".

### 4.5 `-q` shows `error` and above

`-q` is a **noise control on the stderr channel** (stderr-only on every command but `show`),
never a safety control. It thresholds the block at `error` and above — it does **not** empty
the channel. The help text's "`-q` silences advisories" is thereby *exactly* true, and the
threshold shape keeps the reserved `warning` tier free. `-q` does **not** apply to `doctor`
(§5.4).

---

## 5. `doctor`

### 5.1 The grouped report (stdout)

Grouped **by severity** (errors first), **prose tier headers**, **count as a footer**:

```
$ issues doctor

ERRORS — the file does not mean what it says

  ISS-007  blocked-by ISS-099 — no such issue
    ISS-099 is nowhere in this file, so the edge is ignored and
    ISS-007 counts as unblocked.
    Fix: correct the id, or drop `blocked-by:ISS-099` from the line.

  ISS-004, ISS-008, ISS-015  dependency cycle
    ISS-004 → ISS-008 → ISS-015 → ISS-004
    Each waits on the next, so none can ever become unblocked.
    Fix: remove one `blocked-by:` anywhere in the loop.

ADVISORIES — nothing is wrong, but something you rely on may not hold

  ISS-031  blocker ISS-002 is deferred
    ISS-031 is unblocked because ISS-002 was postponed, not because
    it was done. The work it waited on is still expected.
    Fix: nothing required — confirm ISS-031 can proceed without it.

2 errors, 1 advisory
```

- Header strings, verbatim:
  - `ERRORS — the file does not mean what it says`
  - `ADVISORIES — nothing is wrong, but something you rely on may not hold`
- The headers are the one place `doctor` **teaches** the taxonomy (earned at report density;
  rejected on the inline channel). The count is a **footer** — details first, tally last,
  where the eye lands after scrolling; the footer pluralises each tier independently.
- **Clean file:** `No findings.` (dropping today's `No issues found — clean.`).
- **Advisories-only** exits 0 (§5.3) and must *look* like a pass — the footer carries it
  without alarm (`0 errors, 1 advisory`).

### 5.2 `--json` is `{ findings: Finding[] }`, `ok` dropped

```json
{ "findings": [] }
```
```json
{
  "findings": [
    { "severity": "error",    "code": "dangling-blocker", "subjects": ["ISS-007"], "mentions": ["ISS-099"], "value": null, "line": null },
    { "severity": "advisory", "code": "wontfix-blocker",  "subjects": ["ISS-031"], "mentions": ["ISS-009"], "value": null, "line": null }
  ]
}
```

- **`ok` is gone** — once the exit code is the gate, `ok` is a second encoding where drift
  lives. "Clean" is `.findings == []`; a gate for a JSON reader is
  `.findings | any(.severity == "error")`.
- **No count fields** (derivable). **Object wrapper**, not a bare array, so it can grow.
- `show --json`'s existing `warnings: string[]` becomes **`findings: Finding[]`**. No findings
  field is added to `list`/`next`/`ready`/`tree` `--json` — that is the §6 machine contract,
  and `doctor --json` is the machine surface for findings.

### 5.3 Exit code — a threshold-shaped contract

> `doctor` exits **1** iff any finding's severity is `error` or above; otherwise **0**. A
> stable machine contract alongside `--json`. Human-readable output remains unstable.

- Computed in the shell from `findings(...).some(f => f.severity === 'error')`.
- Threshold-shaped, so a future `warning` is automatically non-breaking.
- The **rule** is stable; the **classification** is semver-governed — moving a code between
  tiers is a breaking change. The won't-fix/deferred flip from 1 → 0 is a *declared fix*.

### 5.4 No severity flags, and `-q` does not apply

No `--errors-only` / `--advisories` — a two-value axis whose CI half the exit code already
covers, and the reserved tier would force any cut to be recut. `-q` does **not** prune
`doctor`'s stdout report (its entire reason to run); extending it would overload the flag by
command. **The gap is deliberate — a future session should not "fix" it.**

---

## 6. Back-compat summary

- **`ISSUES.md` is untouched** — read-time derivation and rendering only.
- **Library (breaking, `0.4.0`, package semver):** `graphWarnings`, `doctorFindings`,
  `compatWarnings` are removed; `findings` + `formatFinding` + `Finding` + `Severity` +
  `FindingCode` + `FINDING_SEVERITY` replace them. Internal `warningsFor`, `advisories`,
  `edgeAdvisories` do not survive.
- **`doctor --json` reshaped:** `{ ok, findings: string[] }` → `{ findings: Finding[] }`.
- **`show --json`:** `warnings: string[]` → `findings: Finding[]`.
- **`doctor` exit code flips 1 → 0** on won't-fix/deferred-only files (the intended fix).
- **The error tier begins firing on closed/deferred/won't-fix rows** — `graphWarnings` walks
  only the open section today, so four error codes never fire outside it; the broadened walk
  means files that pass `doctor` today may report errors.
- **No deprecation path, no release note, no `CHANGELOG.md`** — 0.x is the flux series; the
  breaking facts live in ADR 0009's Consequences. Notes wait for 1.0.

---

## 7. Explicitly out of scope (this effort)

- **Implementing the model in `src/` and rebuilding `dist/`** — the destination is a spec.
  §9 is the handoff.
- **Auto-cascading reopen** ([#26](https://github.com/elucidata/issues/issues/26)) — the tool
  cannot know *why* a blocker reopened; advisory only, never automatic.
- **A second top-level `lint` command** — the severity axis lives inside `doctor`.
- **Per-finding suppression / an `ignore:` config** — a config-surface effort of its own; the
  error-only pointer (§3.3) leans on its absence.

---

## 8. Deferred (fog — addable later without disturbing this spec)

- **A middle `warning` tier.** `Severity` reserves the word and every threshold (`exit`, `-q`,
  the pointer) is written to admit it non-breakingly. The day a *this-might-be-wrong* finding
  exists, it slots in; `SEVERITY_ORDER` ships then.
- **Findings in `list`/`tree` `--json`.** Held back deliberately (§5.2) — reshaping the §6
  machine contract is a separate call.

---

## 9. Build checklist (execution order for the next session)

The design is closed; this is a suggested implementation order, not new decisions. This map
produces **no code** — the boxes below are the handoff to a set of `ready-for-agent` tickets,
exactly as [`terminal-output.md`](terminal-output.md) §9 handed off to #27–#31. Tick each with
the commit that carried it.

- [ ] 1. **Core types & table** (`src/index.ts`) — `Severity`, `FindingCode`, `Finding`,
      `FINDING_SEVERITY`, the `finding()` constructor (§1).
- [ ] 2. **The producer** — `findings(doc, text)`: fold `graphWarnings`, `doctorFindings`,
      `compatWarnings` into one, **broaden the graph walk to every section** (§6), add
      `deferred-blocker` beside the `wontfix.has(b)` check (`idSet(doc, DEFER_SECTION)`), emit
      `malformed-line` as a `subjects: []` finding with `line`.
- [ ] 3. **The formatter** — `formatFinding(f, color)` at both densities (§4.1): inline for the
      stderr/`show` channel, report for `doctor`. Glyphs `!`/`·`; colour `error`→red /
      `advisory`→dim only where `color` is true.
- [ ] 4. **Emission plumbing** — each read surfaces its `view` set to the dispatch
      (`tree` has `treeView().visible`; `list`/`next`/`ready` return or recompute rendered
      ids); the scope predicates (§3) at each call site; the pointer from the view complement.
      `src/bin.ts` gains the blank-line separator and writes the pre-rendered block.
- [ ] 5. **`-q`** — threshold at `error` and above on the stderr channel (§4.5); not applied to
      `doctor`.
- [ ] 6. **`doctor`** — `cmdDoctor(doc, text, color)`: group by severity, errors first, render
      each via `formatFinding` at report density, footer count, `No findings.` when empty.
      `cmdDoctorJson` → `{ findings: findings(doc, text) }` (`ok` removed). Exit code from
      `findings(...).some(f => f.severity === 'error')` in the shell (§5.3).
- [ ] 7. **`show --json`** — `warnings: string[]` → `findings: Finding[]` (§5.2).
- [ ] 8. **Tests** — rewrite the prose-asserting tests (`/banana/`, `/malformed line/`,
      `toEqual([])`) against `code`/`subjects`/`severity`; the emission scope on the reopen /
      `done` / `note` cases; the exit-code flip; the broadened walk firing on a closed row; the
      pointer's self-extinguishing count.
- [ ] 9. **Docs** (§9.2) — regenerate `--help`; update `skills/issues/SKILL.md` and `ReadMe.md`;
      add the ADR 0005 / ADR 0008 amendment pointers if not already carried.
- [ ] 10. **Version** — bump `package.json` to `0.4.0`.
- [ ] 11. **Rebuild & commit `dist/`** per CLAUDE.md — consumers run `dist/` from GitHub.
- [ ] 12. **Mark this spec `Implemented`** — flip Status, tick this checklist with commit refs,
      record any deviations as a §9.0 **Implementation notes** subsection (the terminal-output
      spec's item-10 lesson: record deviations rather than silently correcting the spec).

### 9.1 The 1 → 0 note

The exit-code flip on won't-fix/deferred-only files (§5.3, §6) is the one change a
CI-integrating consumer could feel. It is declared in ADR 0009's Consequences; no changelog
line is owed (0.x flux), but the build session should be aware it is a *fix*, not a regression.

### 9.2 Doc surface — what each one owes (edited during the build, not now)

Editing these to describe unshipped behaviour would falsify them and break the pinned `--help`
test, so they are listed here and edited **by the build session**, alongside the code:

- **`--help`** (`src/index.ts` help string, ~`:1634`, `:1640`) — the `doctor` line
  ("exit nonzero on findings") becomes the threshold contract; the `-q` line
  ("silences advisories") is now exactly true and stays.
- **`skills/issues/SKILL.md`** (`:40`, `:87`, `:139`) — the `doctor` synopsis and the
  advisory/`-q` paragraph, re-taught in error/advisory terms; agents told `doctor --json` is
  `{ findings }` and the exit code is the gate.
- **`ReadMe.md`** (`:101`, `:183`) — the `doctor` line and the advisory paragraph.
- **`docs/adr/0005-cli-surface.md`** — carry the "Amended by: ADR 0009" pointer (done by
  this spec's session).
- **`docs/design/nested-issues-agentic-flow.md`** §3.4, §5.2 decisions 7/8/10/19 and
  **`docs/design/terminal-output.md`** §7, §9.0 (the stale "`doctor` does not take the render
  options" note) — amendment pointers to ADR 0009 / this spec (done by this spec's session).
