# ADR 0009 — The finding model: structured findings, severity tiers, and scoped emission

- **Status:** Accepted
- **Map:** [#32 The finding model](https://github.com/elucidata/issues/issues/32)
- **Tickets:** [#33](https://github.com/elucidata/issues/issues/33) (what a finding is),
  [#34](https://github.com/elucidata/issues/issues/34) (the severity taxonomy),
  [#35](https://github.com/elucidata/issues/issues/35) (the emission rule),
  [#36](https://github.com/elucidata/issues/issues/36) (`doctor`'s output & exit contract)
- **Spec:** [Findings](../design/findings.md)
- **Extends:** [ADR 0007](0007-version-flag-and-schema-compat-contract.md) — the `schema:`
  compat codes join `doctor` as advisories; 0007's file-format contract is one of **two**
  compat contracts, the other being the library's TypeScript surface under package semver.
- **Amends:** [ADR 0005](0005-cli-surface.md) — refines decisions 7 (a declared-status
  mismatch is an **error**, not a bare warn-but-write), 8 (emission is a scoped filter,
  not a fixed command list), 10 (`doctor`'s exit code is a threshold-shaped **contract**),
  and 19 (`doctor` groups by severity). [ADR 0008](0008-terminal-output-state-gutter-colour-plain.md)
  — `doctor` now takes the `color` render option; findings render with severity colour on
  stdout and an uncoloured glyph channel on stderr.
- **Origin:** [#26](https://github.com/elucidata/issues/issues/26) — the reopen advisory
  that motivated the map is the **first instance** of the advisory tier, `closed-with-open-blocker`,
  not the subject of this ADR.

## Context

`ISSUES.md` derives a handful of anomalies at read time (ADR 0003 — nothing is stored):
a dangling `blocked-by:`, a cycle, a won't-fix blocker, a malformed line, a
declared-status mismatch, a `schema:` the build cannot read. Today each is a **string**,
produced by one of three separate functions (`graphWarnings`, `doctorFindings`,
`compatWarnings`), surfaced by an ad-hoc list of commands, and rendered as a bare line on
stderr. The word "warning" spans all of it.

Three faults compound. **The strings are load-bearing** — `warningsFor` scopes findings to
an issue with a substring match (`w.includes(id)`), so the prose *is* the data model, and
tests assert on `/banana/`. **There is no severity axis**, so `compatWarnings` was kept out
of `doctor` by hand and a won't-fix blocker drives `doctor` to exit **1 on a healthy file**
— design §3.1 calls that finding "an implementation nicety, not a hard rule" while it gates
CI. And **the substring scope returns the wrong answer** on the one case the map was raised
to serve: `ISS-039` closed while blocked by `ISS-041`, which is later reopened. `w.includes(id)`
cannot tell the issue a finding is *about* from an id it merely *implicates*, so it cannot
say that a plain `list` should stay quiet while `reopen ISS-041` should speak.

The reopen advisory of #26 exposed all three, but #26 is only the **first instance** of a
tier that does not yet exist. The decision is the tier — and, underneath it, what a finding
*is*.

## Decision

A finding is **structured data with a formatter**; severity is a field, classified in an
exhaustive table; every surface is a **filter** over one producer; and `doctor`'s exit code
becomes a contract. Nine faces of one decision.

### 1 — A finding is structured data, not a string

`Finding` carries no baked message. The core exports a producer that returns data and a
formatter that renders it, parameterized by the `color` boolean the core never resolves
itself — exactly the house pattern `paint` / `cmdShow` already follow (ADR 0008 §6: the
`isTTY` probe is the shell's, rendering is the core's).

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

A finding renders at **two densities**, which is why a single baked string was never viable:

- **inline** — one line, for `show` / `list` / write-time findings, sitting in a dossier;
- **report** — the three-part `doctor` form: **where** · **why it matters** · **`Fix:`**.

The core **cannot wrap** — ADR 0008 forbids a width table and the core cannot probe the TTY —
so explanatory prose is authored short (~72 cols) and never reflowed at runtime.

### 2 — `subjects` is a set, and its cardinality is the model

A finding names its **subjects** (the ids it is *about*) and its **mentions** (ids
implicated). The map's charting notes said *subject, singular*; sharpened here, `subjects`
is a **set**, and its size is the whole model:

| `subjects.length` | means | examples |
|---|---|---|
| 0 | about the **file** — always in scope, every read | malformed line, `schema:` compat |
| 1 | about **one issue** | dangling blocker, closed-with-open-blocker |
| n | about a **knot** — every member equally | cycle |

`subjects` is not a scoping mechanism that happens to be plural — **it is the answer to
*where do I look*.** When it is empty a file location (`line`) fills that slot, so every
finding says where, uniformly. This is what frees `mentions` to mean *ids implicated, scoped
at write time*: a cycle's ordered member list lives in `subjects`, not `mentions`.

Rejected: **`subject: string | null`, one finding per cycle** — the cycle's subject is
`null`, so a read scoping by subject goes silent on the deadlock an issue is *in*, a
regression against today's substring match. **One finding per cycle member** — `show` works,
but one knot prints as three errors, inflating both `doctor`'s header count and its exit-code
tally, and misleading a reader who removes one edge and watches two unrelated-looking errors
vanish.

### 3 — The severity taxonomy: `error` / `advisory`, eleven codes, governed by a test

The tiers are **`error`** and **`advisory`**; `finding` is the genus (ADR 0008's stderr
"warning" channel, renamed); and **`warning` is reserved**. `Severity` is an *ordered scale
with a deliberately empty middle*, so a future middle tier takes the reserved word without a
rename.

- Rejected **`error`/`warning`** as the tiers: in eslint/tsc a warning means *this might be a
  bug*; our lower tier means *nothing is wrong*. `WARNINGS — nothing is wrong` is a header
  arguing with itself.
- Rejected **`error`/`note`**: `note` is already a first-class file concept (indented note
  lines, load-bearing in `malformedLines`).
- **No `SEVERITY_ORDER` constant ships.** On a two-member union the order is total and
  obvious, and the exhaustive `Record<FindingCode, Severity>` already guards additions. The
  scale is recorded here; the code gains the constant the day a third tier lands.

The classification, an exhaustive table (`FINDING_SEVERITY: Record<FindingCode, Severity>` —
adding a code without classifying it is a **compile error**):

| Code | Tier | |
|---|---|---|
| `malformed-line` | error | a line the parser discards |
| `dangling-blocker` | error | a `blocked-by:` id that resolves to nothing |
| `dangling-part-of` | error | a `part-of:` id that resolves to nothing |
| `self-blocker` | error | an issue blocked by itself |
| `cycle` | error | a mutual block — a gate that can never open |
| `undeclared-status` | error | a `status:` outside the declared `statuses:` set |
| `wontfix-blocker` | advisory | unblocked by a won't-fix, not by completion |
| `deferred-blocker` | advisory | unblocked by a postponement, not by completion |
| `closed-with-open-blocker` | advisory | closed, but a blocker it waited on is open |
| `schema-unparseable` | advisory | a non-numeric `schema:` — read as legacy |
| `schema-too-new` | advisory | a `schema:` newer than this build understands |

**Eleven codes: six errors, five advisories.** Two amendments to the ten shapes charting
listed: `closed-while-blocked` is renamed `closed-with-open-blocker` (§ below), and the
admission test (§ below) admitted an eleventh, `deferred-blocker` — a blocker in `Deferred`
silently unblocks its dependents today, flagged by nothing.

The catalogue is **governed, neither open nor closed**:

> A candidate is a **finding** iff it is **derived** from the file at read time (ADR 0003 —
> nothing is stored) and it names **an assumption that may not hold** — a gate satisfied by
> something other than completion, a closure that may be undone, a write that may not
> round-trip — rather than a judgment about how the file is *written*. It is an **error** if
> the file is already wrong; an **advisory** if the state is one a maintainer may rationally
> leave in place forever.

The second clause is the gatekeeper against proliferation: it refuses *no labels*, *no
assignee*, *title too long*, *empty section* — conformance opinions about authorship, not
consequences you rely on. Growth is bounded by the test; the exhaustive table keeps a growing
catalogue honest.

### 4 — Severity grades whether the *file* is wrong, not how bad the damage is

The operational test that decided every arguable row: **can this be left alone
indefinitely?** A won't-fix blocker can, permanently and correctly; a `closed-with-open-blocker`
issue can — it may be entirely right. A dropped line, a dangling ref, a cycle cannot.

The principle produces two deliberate inversions:

- **`undeclared-status` is an error with zero derived consequence.** `statuses:` makes a
  claim *about other lines*, and those lines falsify it — two statements in the file, one
  false. It is the one finding a project **opts into** (absent the key it never fires), and
  enforcement is the only reason to declare it. As an error you can always opt back out —
  delete the key, widen the set. As an advisory there is no route *in*: `doctor` exits 0, CI
  stays green, the typo ships. (This does not contradict ADR 0005 decision 7's *warn-but-write*
  at write time — decision 7 governs writes and never spoke to severity; `block ISS-007 ISS-099`
  already warns and writes at exit 0 for a *dangling blocker*, an error too. `doctor` is a
  separately-invoked act.)
- **`schema-too-new` is an advisory with real round-trip risk.** A newer-format file is
  *completely correct*; the defect is on our side of the fence, and failing a repo's lint for
  a stale toolchain misattributes the fault. The real protection is the write-time advisory
  that already leads every command (ADR 0007 §4). ADR 0007 lines 54–56 name this case
  explicitly — "surfaces an advisory warning and proceeds — it never rejects, **never changes
  an exit code**" — so an error here would supersede a written contract. Both compat codes are
  advisories, and **they join `doctor`**: `doctor` already reports build-relative facts
  (`malformed-line` means *lines this parser would drop*), and under §2's model the compat
  codes are `subjects: []`, identical in kind. This ADR therefore **extends** ADR 0007 rather
  than superseding it — 0007's exit-code sentence survives intact.

**This tier is a fix, not just a feature.** `wontfix-blocker` and `deferred-blocker` as
advisories mean a file whose only finding is one of them **now exits 0**; today it exits 1.
The green build is the correct one.

### 5 — The emission rule: one producer, two scope relations

Every surface is a **filter over `findings(doc, text)`**, and **nothing anywhere names a
`FindingCode`**. `warningsFor`, `advisories()`, `edgeAdvisories()` and the three producers do
not survive; scoping is a relation expressed at the call site.

```ts
// read — `view` is the set of ids the command printed
f.subjects.length === 0 || f.subjects.some(id => view.has(id))

// write — `id` is the id the command touched
f.subjects.length === 0 || f.subjects.includes(id) || f.mentions.includes(id)

// -q, composed onto either
f.severity >= 'error'
```

- **In view means *printed*.** `view` is every id the command put on screen, `tree`'s
  scaffolding ancestors included (`treeView().visible` already computes `matched ∪ scaffold`).
  This needs no new per-command state and makes the map's anti-nag goal *exact* rather than
  aspirational: nagging about something invisible is structurally impossible when *visible* is
  the definition. Rejected: **scope by the ids the command is *about*** (excluding
  scaffolding) — it costs a second hand-maintained declaration per command and hides an error
  about a line two rows up the screen behind a "1 error elsewhere" pointer.
- **File-level findings speak everywhere.** `subjects: []` is applied literally, so
  `malformed-line` joins the read and write channels — `issues note` currently destroys stray
  lines in **total silence**. Consequence taken deliberately: a file with 20 stray lines prints
  20 lines on every read. Allowed — it is an error, the fix is deleting or indenting a line,
  and the alternative is silent data loss.
- **Writes scope by *names this id at all*** (`subjects ∪ mentions`), **not by mentions
  alone.** Literal mention-only scoping is a *regression against today*: `warningsFor`'s
  substring match already matches an id wherever it appears, so `block ISS-041 --by ISS-098`
  prints the dangling-blocker warning now, and mention-only scoping would silence the very edge
  the command just created.
- **A write emits iff it writes a field the finding model reads** — `blocked-by`, `part-of`,
  `status`, or section membership. This is a **property, not a list**: a new command classifies
  itself by what it writes. **Emits:** `add`, `block`, `unblock`, `set`, `unset`, `done`,
  `reopen`. **Silent:** `assign`, `unassign`, `label`, `unlabel`, `edit`, `note` (file-level
  findings still speak on these — every write rewrites the whole file). Rejected: **every
  mutation emits** — it breaks the tier's own definition (*a state left in place forever*) by
  reprinting an unfixable advisory on every `note` in a journaling loop. The symmetric `close`
  warning the map anticipated **dissolves** — closing `ISS-039` while `ISS-041` is open *creates*
  the flagged state, the same finding at a different write, falling out of the rule rather than
  written as a feature.

### 6 — The discovery pointer counts out-of-view **errors** only

Where errors exist about issues *outside* the current view, a read emits **one** scope-aware
line pointing at `doctor`:

```
→ 1 error elsewhere — run `issues doctor`
```

- **Errors only.** An all-severity pointer prints `→ 1 advisory elsewhere` on *every* `list`
  for the rest of the project's life about a `closed-with-open-blocker` you have already judged
  correct — the blanket nag the map explicitly rejected, with a count attached. An error means
  the file *does not mean what it says*, a state nobody rationally leaves forever, so an
  error-only pointer is **self-extinguishing**.
- **It counts, and names the command** — the map barred *a count of things you can see*; this
  counts only what is hidden, the one number a scoped read genuinely cannot show, and routes
  the reader (and makes `doctor` discoverable to an agent that has only run `list`).
- **Reads only.** A read is an act of looking, so "elsewhere" has a referent. A write is not
  looking; it already speaks about the id it touched (§5).

### 7 — `doctor`: a grouped report, `{ findings }` JSON, and an exit code that is a contract

- **The exit code is a compatibility contract**, threshold-shaped: **`doctor` exits 1 iff any
  finding's severity is `error` or above; otherwise 0.** Stable alongside `--json`; human
  output stays unstable (ADR 0008 §8). Threshold-shaped, not enumerated, so a future `warning`
  is automatically non-breaking. Three files already promise a nonzero exit in writing (ADR
  0005:43, `SKILL.md`, `README`), and this map breaks that promise for won't-fix/deferred
  files — silence would read as an oversight, so the contract is stated. The **classification**
  stays semver-governed: moving a code between tiers changes a gate's verdict and is a breaking
  change (the contract is *the threshold holds*, not *the catalogue is frozen*).
- **`--json` is `{ findings: Finding[] }`, and `ok` is dropped.** Once the exit code is the
  gate, `ok` is a second encoding of the same predicate — and a second encoding is where drift
  lives. "Clean" is `.findings == []`; a JSON reader who insists on a gate uses
  `.findings | any(.severity == "error")`. No count fields (derivable). An object wrapper, not
  a bare array, so it can grow a field later.
- **The human report is grouped by severity, prose tier headers, count as a footer:**

  ```
  $ issues doctor

  ERRORS — the file does not mean what it says

    ISS-007  blocked-by ISS-099 — no such issue
      ISS-099 is nowhere in this file, so the edge is ignored and
      ISS-007 counts as unblocked.
      Fix: correct the id, or drop `blocked-by:ISS-099` from the line.

  ADVISORIES — nothing is wrong, but something you rely on may not hold

    ISS-039  closed, but blocker ISS-041 is open
      ISS-039 was completed, and ISS-041 — which it waited on — is
      not. Whether that undoes ISS-039 depends on why ISS-041 is
      open; the tool can't know.
      Fix: reopen ISS-039 if the work is genuinely undone.

  1 error, 1 advisory
  ```

  The prose headers are the one place `doctor` **teaches** the taxonomy — the surface a junior
  or an agent meets the error/advisory distinction on, so two naming lines are earned at report
  density (they were rejected on the *inline* channel, where one or two lines do not earn a
  header). `No findings.` when clean. `-q` **does not apply to `doctor`**: its report is a
  stdout payload, not the stderr noise-channel `-q` governs. No severity flags — a two-value
  axis whose CI half the exit code already covers, and the reserved tier would force any flag
  cut today to be recut later.

### 8 — Rendering: a stderr block, glyphs not colour; `doctor` and `show` colour on stdout

Findings render as a **block**, not bare lines: one blank line, two-space indent, errors
first, `!` error · `·` advisory · `→` pointer.

- **The stderr channel is never coloured, and no `process.stderr.isTTY` probe is added.**
  ADR 0008 rejected a second colour-resolution surface; the glyphs carry severity there. The
  blank line rides stderr, so a redirect is unaffected — the separation exists only where both
  streams share a terminal, which is where it is needed.
- **`error` → red, `advisory` → dim, wherever the stream is coloured at all.** `show`'s dossier
  and `doctor`'s report ride **stdout**, where colour is in use; their findings colour by
  severity. `dim` is this codebase's established "recede" (deferred/won't-fix glyphs, closed
  titles); `red` double-books `blocked`'s gutter colour but never shares its column. Uniform
  and mechanical — **findings colour by severity wherever the stream is coloured** — so #36's
  `doctor` inherits the palette rather than inventing one, and `formatFinding`'s `color`
  parameter is not vestigial.
- **`-q` shows `error` and above.** Today it empties the channel wholesale; that conceals *the
  file does not mean what it says*. `-q` is a noise control (stderr-only on every command but
  `show`), never a safety control. The help text's "`-q` silences advisories" becomes *exactly
  true* under #34's re-minting of "advisory" as one tier — the same threshold shape as the exit
  rule, so the reserved tier stays free.

### 9 — Two compatibility contracts, and only one was written down

Replacing the three string producers is a **breaking change to the library**. The sentence
this ADR adds:

> ADR 0007's `schema:` contract governs the **file format**. The library's TypeScript surface
> is governed by **package semver**, independently. A file written by any build stays readable;
> an exported type may change in a minor while the package is pre-1.0.

Nothing in the repo said this; ADR 0007 reads like *the* compat contract when it is one of two.
Given it: the package is pre-1.0, the three producers have zero callers outside the test file,
and a deprecating shim would have to render findings *back* into strings — the prose-as-data
pattern this whole effort exists to kill. The producers are removed in **0.4.0**, no
deprecation path, no release note (0.x is the flux series; notes wait for 1.0). The breaking
facts land in Consequences, below.

## The three truths no single ticket had to write down

The map delegated these to the spec because each is a *load-bearing rationale* a later
maintainer could "tidy away" without knowing it means something. Recorded here in the register
ADR 0008 used for its casing rule and its glyph risk.

- **Advisories and errors are different *speech acts*, not different loudnesses.** An error says
  *the file is malformed or the graph is incoherent*; an advisory says *nothing is wrong, but
  your edit may imply more work*. Diagnostic versus consequential. `doctor`'s exit code is
  calibrated for the first kind only; the pointer routes only the first kind; `-q` conceals
  neither but thresholds on the boundary between them. A future session tempted to "unify" the
  two tiers into one severity scale of *loudness* would break all three.
- **Transitivity is one hop, by consequence not by cheapness.** The derived predicate flags only
  a closed issue whose *own* blocker is open; acting on the advisory re-derives the next hop
  automatically. This is ADR 0003's "chains clear one link at a time" — not a shortcut to be
  "fixed" into a full graph walk. A closure walk would store implied edges (ADR 0003 rejects
  this) and report a knot the maintainer cannot act on in one move.
- **Substring scoping was a model, not a shortcut.** `warningsFor`'s `w.includes(id)` did not
  approximate subject/mention scoping cheaply — it *could not express it at all*, and returned
  the wrong answer on the reopen case that raised the map. `subjects`/`mentions` is the model
  the string channel never had; the substring match is not a fast path to preserve.

## Alternatives considered

- **Keep three producers, add a severity field to each** — rejected: their split was never
  severity, it was the *absence* of a severity axis. Once severity is a field, `compatWarnings`
  is a filter; three producers freeze the workaround into the public API at the moment the thing
  it worked around is fixed, and their names keep saying *warning* in a model whose point is that
  most of them are errors.
- **A baked plain-text `message` on each finding** — rejected: it makes `doctor` the one stdout
  surface unable to participate in ADR 0008's colour, and a finding renders at two densities, so
  one string was never viable.
- **A second top-level `lint` command** — rejected while charting: `doctor`/`lint` are synonyms
  in the wild and unguessable, and the text-vs-graph seam is orthogonal to error-vs-advisory, so
  a command boundary would have to drop one axis. The severity axis lives inside `doctor`.
- **Auto-cascading reopen** (#26's tempting shape) — rejected by #26 itself: whether reopening a
  blocker undoes its dependents depends entirely on *why* it reopened, which the tool cannot
  know. Advisory only, never automatic.
- **Per-finding suppression / an `ignore:` config** — out of scope: a config-surface effort of
  its own. The error-only pointer (§6) leans on its absence — the pointer is safe to make
  permanent *because* there is no advisory to dismiss.

## Consequences

- **The seven-plus anomalies reach every surface through one vocabulary and one producer**,
  where they previously leaked through three functions, an ad-hoc command list, and load-bearing
  prose. A new command classifies its emission by what it writes; a new code classifies its tier
  in one exhaustive table.
- **`doctor --json` is reshaped and `ok` is removed** — a breaking change to ADR 0005 decision
  9's stable contract, permitted because the `findings` reshape breaks it loudly regardless.
- **`doctor`'s exit code flips 1 → 0** on files whose only finding is a won't-fix or deferred
  blocker. The intended fix, not a surprise; the classification is semver-governed so the flip
  is declared here rather than shipped silently.
- **The error tier begins firing on rows it is currently blind to.** `graphWarnings` walks only
  the open `Issues` section, so `dangling-blocker`, `self-blocker`, `wontfix-blocker` and
  `dangling-part-of` **never fire on a closed, deferred, or won't-fix issue today** — `doctor`
  reports a file with a dangling blocker under `## Completed` as clean. The finding model forces
  the walk to broaden (a closed issue *is* `closed-with-open-blocker`'s subject), so files that
  pass `doctor` today may report errors. A behaviour change worth stating.
- **`deferred-blocker` is new**: a blocker in `Deferred` silently unblocks its dependents today,
  flagged by nothing.
- **The three string producers are removed at `0.4.0`**, no deprecation path — a breaking change
  to the library surface, governed by package semver (§9), independent of ADR 0007's file-format
  contract, which is untouched.
- **`ISSUES.md` is not touched.** No format change, no parser change, no round-trip impact — the
  finding model is entirely read-time derivation and rendering.
- **The reserved `warning` tier** now sits in the repo as a named empty slot, so the exit rule,
  `-q`, and the pointer are all threshold-shaped and a future middle tier is non-breaking to add.
- **Implementation is a separate handoff** — this map produces no code. The build is a set of
  `ready-for-agent` tickets, exactly as ADR 0008 handed off to #27–#31. The normative spec and
  its build checklist live in [`docs/design/findings.md`](../design/findings.md).
