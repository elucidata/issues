# Design spec — Terminal output: state gutter, colour, `--plain`, read filtering

**Status:** **Locked — not yet implemented.** Every design decision below is settled
and a build session can execute this document with no open questions, but no code has
been written against it. §9's checklist is unticked; the last item is to flip this
line to **Implemented** and tick the rest.

No production code shipped in the effort that produced this spec — the spec +
[ADR 0008](../adr/0008-terminal-output-state-gutter-colour-plain.md) *are* the
deliverable.

**Scope.** How the **human-readable** read surface of `@elucidata/issues` renders
state: a leading state glyph on compact rows, terminal colour, a `--plain` escape
hatch, filtering on `tree`, and a redesigned `show` dossier. The `--json` contract
(design §6 of the nested-issues spec) is untouched.

**Source.** Compiled from the resolved decisions on
[Wayfinder map #19](https://github.com/elucidata/issues/issues/19):

| Subsystem | Ticket |
|---|---|
| Glyph/font support (research) | [#21](https://github.com/elucidata/issues/issues/21) → [`docs/research/glyph-terminal-support.md`](../research/glyph-terminal-support.md) |
| Colour scheme + scaffolding (prototype) | [#20](https://github.com/elucidata/issues/issues/20) |
| `--plain` contract | [#22](https://github.com/elucidata/issues/issues/22) |
| Output compatibility posture | [#23](https://github.com/elucidata/issues/issues/23) |
| `show` dossier | [#25](https://github.com/elucidata/issues/issues/25) |

All of it is recorded as one decision in
[ADR 0008](../adr/0008-terminal-output-state-gutter-colour-plain.md).

---

## 0. Hard constraints (settled — not re-litigated by the build)

- **The core stays pure.** `src/index.ts` does no I/O, reads no `process.env`, and
  probes no TTY. All terminal detection lives in `src/bin.ts` (CLAUDE.md).
- **Zero runtime dependencies.** No `chalk`, no `supports-color`, no width table.
  ANSI codes are written by hand.
- **`--json` is unchanged and is never colourized.** It remains the only stable read
  surface (§7).
- **8/16-colour only** — no 256-colour, no truecolor, no bright-white/bright-black,
  so output holds on light and dark backgrounds.
- **The byte-for-byte round-trip invariant is untouched.** This effort changes only
  terminal rendering; `serialize` and the file format are not in scope.

---

## 1. The state vocabulary

Six states, one leading glyph each, on every compact row:

| Glyph | State | Gutter colour |
|---|---|---|
| `-` | Open | none |
| `~` | Open + claimed | yellow |
| `⊘` | Open + blocked | red |
| `✓` | Completed | green |
| `»` | Deferred | dim |
| `×` | Won't Fix | dim |

**Precedence — `closed > blocked > claimed > open`.** One slot; the highest
applicable state wins. Blocked *and* claimed shows `⊘`, and the claim is carried by
the existing `@who` marker.

Precedence is **semantic, not merely compression**: closed **subsumes** the derived
axis. `isBlocked` (`src/index.ts`) does not consult the issue's own section, so a
Completed issue with a reopened blocker is `blocked === true` — but a finished issue
is not *blocked*, and its assignee is provenance, not a claim (nested-issues spec §5,
decision 15). The build must not "fix" this by surfacing the derived axis on closed
issues; §4 depends on it too.

The postfix `[Completed]` / `[Deferred]` / `[Won't Fix]` tags are **removed** in
glyph mode — the gutter carries the section. They return under `--plain` (§5).

### 1.1 Applies to every human-readable read

`list`, `tree`, `next`, `ready`, and `show --children` all render compact rows and
all use this vocabulary. `show`'s subject line does not (§4).

### 1.2 The glyph set carries an accepted risk

`⊘` U+2298 is missing from Cascadia Mono, SF Mono, and Fira Code (measured — see the
research doc). The failure mode is an **off-metric fallback glyph, never tofu**;
`blocked` still reads because the gutter is red. **Do not change the set** as part of
this build.

**Revisit trigger:** a report of misrendering or column misalignment on the gutter
glyph. Standing candidate: set A — `-` `~` `!` `✓` `»` `×`.

---

## 2. Colour assignment

The **gutter is the state channel** (glyph *and* colour, §1). Everything right of it
is **element-typed** — the same field is the same colour on every row, so the eye
learns fixed columns.

| Element | Colour |
|---|---|
| state glyph (gutter) | per §1 |
| id | cyan |
| title | default; **dim when the issue is closed** |
| `status:` value | yellow |
| `@assignee` | magenta |
| `#label` | blue |
| field keys, relationship suffixes, note body, `!` warnings | default |

Colour and glyph double-encode *state* **in the gutter and only there**; colour
encodes *element type* everywhere else. Two channels, one job each.

---

## 3. `tree` — filters and scaffolding

### 3.1 The same flags as `list`

`tree` accepts the section flags `--all` / `--closed` / `--deferred` / `--wontfix`
and the filters `--status <s>` / `--label <n>` / `--parent <id>` /
`--assignee <who>`, with the same AND-across-dimensions / OR-within-a-dimension
semantics as `list`.

**`tree` defaults to open.** This is a **breaking change** — `cmdTree` currently takes
no options and renders every section. It ships unannounced (§7).

### 3.2 Non-matching ancestors are kept as scaffolding

An ancestor on the path to a match is **rendered, not dropped and not moved**, so
containment reads identically to an unfiltered tree.

| Mode | Scaffolding treatment |
|---|---|
| colour | **the whole row dims** — glyph, id, title and markers all intact, receding on contrast alone |
| `--plain` | **a trailing `/`** — the colour channel is unavailable, so the marker must be structural |

Nothing is stripped and nothing moves in either mode. Under `--plain`, `/` connotes
"has children" and a *matching* row can have children too — an accepted, known
misread, taken over letting the filter become invisible.

Scaffolding **never reaches `show`**, which renders all children unfiltered (§4.4).

---

## 4. `show` — the dossier

`show` does **not** import the gutter. A gutter is a column device, and a subject
line has no column to form. What carries across is the **row shape**: the dossier
reads as *a row, opened up*.

### 4.1 Header — one line

```
ISS-042  Parser drops trailing detail lines on reserialize (2026-01-14)
```

`id  title (date)`. Today's two-line split (`id — Section [x] (date) ⊘ blocked` /
title) existed only to give the section suffix somewhere to sit; once state is a
field, the split is vestigial. The date stays **inline** — `serializeIssue` stores it
inline, and every other line in the field block corresponds to a real `key:` in
`ISSUES.md`; a `date:` field would fabricate a key the format does not have.

Accepted cost: a long title plus a date can wrap on a narrow terminal.

### 4.2 A unified `state:` field — no precedence collapse

State is one field naming **every** state that applies. This is the case the
single-slot gutter structurally could not serve.

```
state: Open
state: Open, blocked
state: Open, claimed
state: Open, blocked, claimed
state: Completed
state: Deferred
state: Won't Fix
```

- Derived terms appear in **gutter-precedence order** (`blocked` before `claimed`).
- The **derived axis is suppressed once the section is closed** (§1) — so genuine
  co-occurrence is only ever `Open` + `blocked` + `claimed`. Nothing is lost: a stale
  blocker stays fully visible on its `blocked-by:` line with an `— Open` suffix, and
  the assignee is still shown, just not relabelled as a claim.
- The header sheds **both** `— Section` and `⊘ blocked`. `state:` is the single home
  for state; keeping them in the header alongside the field would be triple-encoding
  and strictly worse than today.

### 4.3 Colour is confined to the `state:` field

The `state:` field is the dossier's structural equivalent of the gutter — the one
designated place state is spoken. Each token takes its own colour: `Open` uncoloured,
`blocked` red, `claimed` yellow, `Completed` green, `Deferred` / `Won't Fix` dim.

The **title is never state-coloured**; a title can only be one colour, so colouring it
reintroduces the precedence collapse the field exists to escape. It dims when closed
(§2) — dim reads as de-emphasis, not as a state claim competing with the field.
Everything else is element-typed per §2, ids inside `part-of:` / `blocked-by:`
included.

**Named double-encoding, accepted:** `claimed` is state-yellow while `status:` is
element-yellow on an adjacent line, and `claimed` restates magenta `@who`. On a row
these sit in different regions so position disambiguates; stacked as fields they do
not. This is the real cost of the unified field.

### 4.4 One capitalized vocabulary for the section axis

Two existing inconsistencies are fixed:

- **Relationship suffixes capitalize.** `resolveRef` currently lowercases the
  target's section (`— completed`). Under §5's semantic casing that is now actively
  wrong — lowercase claims a token is *derived*. They become `— Open`, `— Completed`,
  `— Deferred`, `— Won't Fix`, so the token in `state:` and the token on `blocked-by:`
  are the same word.
- **The `Issues` section renders as `Open`** wherever state is named. `state: Issues`
  does not parse as English, and the glyph vocabulary has said "open" throughout.
  `resolveRef` already performs this mapping, so this ratifies existing behaviour.

**Seam:** `Open` is the one capitalized token that is not verbatim from the file. The
casing rule is about *which axis* a token belongs to, not about being a literal quote.

`cmdShow` renders all children unconditionally with no filters, so §3.2's scaffolding
treatment has **no analogue here**. Stated because it is an absence.

### 4.5 Rendered result

Default (TTY, colour):

```
ISS-042  Parser drops trailing detail lines on reserialize (2026-01-14)
  state: Open, blocked, claimed
  status: doing
  assignee: @matt
  labels: #bug #parser
  part-of: ISS-030 (Round-trip fidelity) — Open
  blocked-by: ISS-041 (Land the tokenizer rewrite) — Open
  blocked-by: ISS-039 (Pin the detail-line grammar) — Completed
  spike: 2d
    Reproduces only when the note body ends without a blank line.
  children:
    ~ ISS-044  Add regression fixture @jo #parser
    ⊘ ISS-045  Backfill the round-trip corpus #parser
  ! ISS-042 is blocked by ISS-039, which is closed
```

`--plain` — **byte-identical down to `children:`**; only the rows change:

```
ISS-042  Parser drops trailing detail lines on reserialize (2026-01-14)
  state: Open, blocked, claimed
  status: doing
  assignee: @matt
  labels: #bug #parser
  part-of: ISS-030 (Round-trip fidelity) — Open
  blocked-by: ISS-041 (Land the tokenizer rewrite) — Open
  blocked-by: ISS-039 (Pin the detail-line grammar) — Completed
  spike: 2d
    Reproduces only when the note body ends without a blank line.
  children:
    ISS-044  Add regression fixture @jo #parser
    ISS-045  Backfill the round-trip corpus #parser [blocked]
  ! ISS-042 is blocked by ISS-039, which is closed
```

Choosing a field over a glyph made the dossier **plain-native** — `--plain` only
removes colour from it.

---

## 5. `--plain`

The **colour-free rendering of the new design**. Explicitly *not* today's output
preserved, and *not* a compatibility promise (§7).

### 5.1 Row shape

```
indent + id + title + markers + [tags]
```

No colour, no gutter, state as postfix tags at the **end of the row**, grouped after
markers / date / note, so `list` and `tree` agree and the leading columns stay
parseable.

### 5.2 Tags, and the casing rule

| Tag | Source |
|---|---|
| `[Completed]` `[Deferred]` `[Won't Fix]` | **stored** — the physical section |
| `[blocked]` | **derived** from `blocked-by:` at read time |

**Capitalized = stored, lowercase = derived.** This mirrors ADR 0003 in the rendering
itself and is **load-bearing** — do not normalize the casing.

- Of the six states, five already had plain representations (three section tags,
  `@who` for claimed, nothing for open). `[blocked]` is the one addition; `~` needs no
  tag because `@who` already carries the claim.
- A row that is closed **and** blocked shows **both** tags (`[Completed] [blocked]`).
  Verbose but honest — `--plain` has room the single-slot gutter does not, so §1's
  precedence order does not apply here.

Today *both* `cmdList` and `treeLines` express blocked as a `⊘ ` prefix — so
"restore today's postfix labels" would have restored the exact character `--plain`
exists to escape.

### 5.3 The `state:` field keeps bare words

On `show`, `--plain` renders `state: Open, blocked, claimed` — **bare, not
bracketed** — while a child row in the same output shows `[blocked]`. Not a dialect
split: a bracket is a **delimiter**, needed on a row where a derived tag abuts
free-form title and marker text; a field has `key:` doing that job. **Brackets where
there is no structure, none where there is.**

### 5.4 Flag composition

1. `--plain` is the **strongest** presentation flag on the human-readable path.
   `--plain --color` renders plain — **silently**, no error. This also lets a script
   pass `--color` unconditionally and stay `--plain`-able.
2. **`--plain` ≠ `--no-color`.** `--no-color` keeps the gutter and glyphs. The middle
   mode is deliberate — the remedy for a terminal that mangles colour but renders
   glyphs fine.
3. `--json --plain` is a **no-op**, not an error.
4. `NO_COLOR` is a colour signal only; it **never** implies `--plain`.

### 5.5 Coarse on purpose

`--plain` drops colour **and** glyphs **and** restores postfix tags. Someone whose
only complaint is one off-metric glyph loses the whole visual layer — and §5.4.2 does
not help them, since `--no-color` gives glyphs-without-colour, the *opposite* of what
they need. There is **no colour-without-glyphs mode**.

**No `--no-glyphs` flag, no `ISSUES_PLAIN` env var, no frontmatter key.** The remedy
for a bad glyph is a better glyph (§1.2) — swapping one character fixes it for
everyone silently; a flag fixes it only for those who find the flag, and would
downgrade an *accepted* risk to a falsely *solved* one.

Accepted cost: a permanently-mangled terminal pays a small tax forever and cannot fix
it for scripts it does not control. A shell alias covers the persistent case at zero
cost to the tool.

---

## 6. The colour/plain boundary

### 6.1 Resolution happens in the shell

`src/bin.ts` resolves the tri-state down to two booleans and hands the core:

```ts
{ color: boolean, plain: boolean }
```

Resolution order for `color`:

1. `--plain` present → `false`.
2. `--no-color` present → `false`. **Wins over `--color`** when both are passed.
3. `--color` present → `true`.
4. `NO_COLOR` set to any value → `false`.
5. Otherwise → `process.stdout.isTTY`.
6. `--json` → always `false`, regardless of the above.

`--no-color` beating `--color` is **forced, not preferred**: `parseArgs` stores
boolean flags as separate keys, so argument order is not recoverable and "last one
wins" is unimplementable without changing the parser. It is also the safer failure.

### 6.2 The core never sees `auto`

The core takes the two booleans and nothing else — four combinations, no environment,
trivially testable. Colour is emitted as hand-written ANSI SGR codes from the
8/16-colour range.

---

## 7. Output compatibility posture

**`--json` is the only stable read surface. Human-readable output is explicitly
unstable and may change in any release.**

- ADR 0007 is silent on output *by scope* — it covers the tool's `--version` and the
  file's `schema:` key. ADR 0005 already pinned `--json`; this makes the asymmetry
  normative, and that is what permits the gutter, the colour, and `tree`'s flip.
- **One posture across all human output, including `--plain`.** `--plain` delivers
  the *absence of escape codes*, which is what piping to `grep` / `wc` / `fzf` needs;
  piping to a *parser* wants `--json`. No "designated lane" language, no stability
  clause for `--plain`.
- **`0.2.0` → `0.3.0`.** Minor is the breaking lane pre-1.0.
- **No deprecation path, no stderr advisory, no `CHANGELOG.md`** for `tree`'s default
  flip. An advisory punishes every future user to inform the handful present at the
  flip.

State this plainly in the docs: at 0.x the declaration buys **permission**, not
protection.

---

## 8. Back-compat summary

- **`ISSUES.md` is untouched.** No format change, no parser change, no round-trip
  impact.
- **`--json` output is unchanged**, including the absence of a `state` field.
- **`tree` shows less by default** — the one user-visible regression-shaped change.
  `--all` restores today's behaviour and is documented in `--help`.
- **`show`'s header collapses** from two lines to one, and its section suffix moves
  into `state:`.
- **`resolveRef`'s suffixes capitalize** — `— completed` becomes `— Completed`.
- Postfix `[Completed]` / `[Deferred]` / `[Won't Fix]` tags **disappear from default
  output** (the gutter carries them) and **return under `--plain`**.

---

## 9. Build checklist (execution order for the next session)

The design is closed; this is a suggested implementation order, not new decisions.
Tick each box as it lands, with the commit that carried it.

- [ ] 1. **Shell** (`src/bin.ts`) — parse `--plain` / `--color` / `--no-color`;
      resolve `{ color, plain }` per §6.1; thread it into every read command.
- [ ] 2. **Rendering primitives** (`src/index.ts`) — the state resolver (§1
      precedence), the glyph table, an ANSI helper gated on the `color` boolean (§2).
- [ ] 3. **Compact rows** — `cmdList`, `treeLines`, `next` / `ready`: gutter +
      element colours; drop the section tags in glyph mode; restore them as `--plain`
      postfix tags with the casing rule (§5.2).
- [ ] 4. **`tree` filters** — reuse `list`'s flag set and predicate; default to open;
      implement ancestor scaffolding, dim in colour and trailing `/` in plain (§3).
- [ ] 5. **`show`** — one-line header; the `state:` field with
      suppression-when-closed; confined state colour; capitalized relationship
      suffixes and `Issues` → `Open` (§4).
- [ ] 6. **Tests** — the four `{color, plain}` combinations across each read command;
      the precedence table; closed-and-blocked suppression on `show` and
      co-occurrence under `--plain`; a filtered `tree` with scaffolding in both modes.
- [ ] 7. **Docs** — regenerate `help`; update `skills/issues/SKILL.md` and `README` to
      teach the new flags and the glyph vocabulary; state §7's posture where `--json`
      is documented (§9.1).
- [ ] 8. **Version** — bump `package.json` to `0.3.0`.
- [ ] 9. **Rebuild & commit `dist/`** per repo policy (CLAUDE.md) — consumers run
      `dist/` straight from GitHub.
- [ ] 10. **Mark this spec `Implemented`** — flip the header's Status line, tick this
      checklist with commit refs, and record any deviations from the spec as an
      **Implementation notes** subsection here.

Item 10 is not ceremony. Its predecessor spec
([`nested-issues-agentic-flow.md`](nested-issues-agentic-flow.md)) was fully built and
still read `Locked` afterward, with nothing in the document to tell a reader it had
shipped — because nothing in the document asked to be updated. Record deviations
rather than silently correcting the spec to match the code; the gap between the two is
the useful information.

### 9.1 Doc surface — what each one owes

- **`--help`** — the three new flags, and `--all` on `tree` (load-bearing given the
  default flip). **A glyph legend is optional**, not required: the vocabulary is six
  characters and the colour carries the meaning; add it only if it fits without
  crowding.
- **`skills/issues/SKILL.md`** — agents should be told to use `--json`, and that the
  human rendering is unstable. This is the doc where §7's posture matters most.
- **`README`** — the glyph vocabulary and `--plain`, in the read-commands section.

---

## 10. Explicitly out of scope (this effort)

- **Implementing the feature in `src/` and rebuilding `dist/`** — the destination was
  a spec, not code. §9 is the *handoff* to that build session.
- **Configurable palette / theming** (frontmatter `colors:`, env overrides) — a
  config-surface design effort of its own; nothing here needs it.
- **A `--json` `state` field** exposing the six-state vocabulary to machines — it
  duplicates derived `blocked` + `assignee` + section, and this effort is about
  presentation, not the machine contract.
- **A cascade advisory on `reopen`** ([#26](https://github.com/elucidata/issues/issues/26))
  — warning that issues closed while blocked by a reopened blocker may need reopening
  too. Surfaced by §4.2's suppression rule, but it adds an advisory to a **write**
  command with its own questions (transitivity, a symmetric `close` warning, `--json`,
  exit code) that are not about rendering.

---

## 11. Deferred (fog — addable later without disturbing this spec)

- **Swapping the glyph set to set A** — dormant behind §1.2's revisit trigger. The
  research doc is the ready-made input.
- **Closing the two research gaps** — Consolas coverage of U+2298 (VS Code on
  Windows), and what a legacy non–Windows Terminal console does with UTF-8 bytes from
  Node. Neither blocks the build; both would sharpen a revisit.
- **A hardened, promised scripting surface** — if a real scripting need for text output
  appears, that is a fresh ticket with a real use case to design against, not
  speculative machinery bolted onto `--plain`.
