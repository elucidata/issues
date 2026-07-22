# ADR 0008 — Terminal output: state gutter, colour, `--plain`, and read filtering

- **Status:** Accepted
- **Map:** [#19 Terminal output design](https://github.com/elucidata/issues/issues/19)
- **Tickets:** [#20](https://github.com/elucidata/issues/issues/20) (prototype),
  [#21](https://github.com/elucidata/issues/issues/21) (research),
  [#22](https://github.com/elucidata/issues/issues/22) (`--plain`),
  [#23](https://github.com/elucidata/issues/issues/23) (compat),
  [#25](https://github.com/elucidata/issues/issues/25) (`show`)
- **Spec:** [Terminal output](../design/terminal-output.md)
- **Built by:** [#27](https://github.com/elucidata/issues/issues/27)–[#31](https://github.com/elucidata/issues/issues/31),
  shipped in `0.3.0`. Departures from the spec are recorded in its §9.0.
- **Amends:** [ADR 0005](0005-cli-surface.md) — `tree` gains `list`'s filters and
  defaults to open; the read commands gain `--plain` / `--color` / `--no-color`.
- **Amended by:** [ADR 0009](0009-finding-model-severity-and-emission.md) — the finding
  model extends the output posture to findings: `doctor` now takes the `color` render
  option (§9.0's "`doctor` does not take the render options" is superseded), findings
  colour by severity (`error` → red, `advisory` → dim) on stdout, and the stderr channel
  stays uncoloured with severity carried by glyphs (`!` / `·` / `→`), adding no second
  `isTTY` probe.

## Context

The read surface (`list`, `tree`, `next`, `ready`, `show`) renders a six-state model
in monochrome text. State reaches the reader unevenly: *blocked* is a `⊘ ` prefix on
`list` and `tree` and a `⊘ blocked` suffix on `show`; the closed sections are postfix
`[Completed]` / `[Deferred]` / `[Won't Fix]` tags; *claimed* is only inferable from
`@who`. `tree` has no filters at all and prints every section unconditionally, so
there is no way to see the shape of just the open work.

Two constraints bound the design. `src/index.ts` is the **pure, filesystem-free
core** — no I/O, no `process.env`, no TTY probing (CLAUDE.md); `src/bin.ts` is the
only layer that may look at the terminal. And the whole surface must stay
**dependency-free**, so there is no `chalk`, no `supports-color`, and no width table
to lean on.

The open question underneath all of it: *is human-readable CLI output something we
are allowed to change?* Nothing in the repo had ever answered that, so every
rendering decision was blocked on a compatibility ruling that did not exist.

## Decision

### 1 — A single-slot state gutter, precedence-ordered

Every compact row carries **one leading character** naming its state:

| Glyph | State |
|---|---|
| `-` | Open |
| `~` | Open + claimed |
| `⊘` | Open + blocked |
| `✓` | Completed |
| `»` | Deferred |
| `×` | Won't Fix |

Precedence is **closed > blocked > claimed > open**. Co-occurring state
(blocked *and* claimed) falls back to the existing `@who` / `status:` markers rather
than widening the gutter to a second slot. The postfix `[Completed]` / `[Deferred]` /
`[Won't Fix]` tags are **dropped** in glyph mode — the gutter now says it.

The precedence rule turned out to be **semantics, not compression** (#25): *closed
subsumes the derived axis*. `isBlocked` never consults the issue's own section, so a
Completed issue whose blocker is later reopened is `blocked === true` — but calling a
finished issue *blocked*, or its assignee a *claim*, contradicts the design's
classification of a post-close assignee as **provenance, not state**. That reading
survives being given more room, which is the test for whether a rule was ever really
about space.

### 2 — Colour: the gutter is the state channel, everything else is element-typed

| Element | Colour |
|---|---|
| state glyph (gutter) | blocked red · claimed yellow · Completed green · Deferred / Won't Fix dim · open uncoloured |
| id | cyan |
| title | default; **dim when closed** |
| `status:` | yellow |
| `@assignee` | magenta |
| `#label` | blue |

8/16-colour only — no bright-white or bright-black — so it holds on light and dark
backgrounds. Glyph and colour **double-encode state in the gutter and only there**;
right of the gutter, colour encodes *element type*, the same field the same colour on
every row, so the eye learns fixed columns. Two channels, one job each.

### 3 — `tree` filters like `list`, and non-matching ancestors survive as scaffolding

`tree` takes the same section flags (`--all` / `--closed` / `--deferred` /
`--wontfix`) and the same filters (`--status` / `--label` / `--parent` /
`--assignee`) as `list`, and **defaults to open** — a breaking change, since `tree`
shows everything today.

An ancestor that does not match the filter is **kept as context scaffolding**, so
containment is never distorted. It renders **dim in colour mode** — glyph, id, title
and markers all intact, receding purely on contrast — and with a **trailing `/` under
`--plain`**, where there is no contrast channel. One concept, two channels.

### 4 — `show` inherits the row *shape*, not the gutter

A gutter is a column device; its value is a vertical run of rows readable at one
character position, and a dossier's subject line has no column to form. So `show`
reads as **a row, opened up**:

- The header collapses to a single **`id  title (date)`** line. The date stays
  inline because `serializeIssue` stores it inline — a `date:` field would have
  `show` fabricating a key `ISSUES.md` does not have.
- State moves into a unified **`state:` field with no precedence collapse** — the
  case the single-slot gutter structurally could not serve. `blocked` and `claimed`
  are both true and both shown. The redundancy against `assignee:` and the section is
  paid for by making the field the *single* home for state: the header sheds both
  `— Section` and `⊘ blocked`.
- The derived axis is **suppressed once the section is closed** (per §1), so genuine
  co-occurrence narrows to `Open` + `blocked` + `claimed`.
- **State colour is confined to the `state:` field** — the dossier's gutter
  equivalent. The title is never state-coloured; one colour would reintroduce the
  precedence collapse the field exists to escape. It only dims when closed.
- The glyph vocabulary stays visible in the `--children` block, which renders real
  rows.

The section axis speaks **one capitalized vocabulary**: relationship suffixes
capitalize (`— Completed`, not today's lowercased `— completed`, which under §5's
casing rule would falsely claim the token is derived), and the `Issues` section
renders as **`Open`** wherever state is named. `Open` is the one capitalized token
not verbatim from the file — the casing rule is about *which axis* a token belongs
to, not about literal quotation.

### 5 — `--plain`: one coarse escape hatch, forward-anchored

`--plain` is the **colour-free rendering of the new design** — explicitly *not*
today's output preserved, and not a compatibility promise. No colour, no gutter,
state as postfix tags:

```
indent + id + title + markers + [tags]
```

- **Blocked renders as a `[blocked]` postfix tag.** Of the six states, five already
  had plain representations (the three section tags, `@who`, and nothing for open);
  blocked was the only one without.
- **Casing is semantic and load-bearing.** Capitalized `[Completed]` / `[Deferred]` /
  `[Won't Fix]` are *sections* — facts stored in the file. Lowercase `[blocked]` is
  *derived* at read time. This mirrors ADR 0003 in the rendering itself, and is
  exactly the kind of thing a later implementer "tidies up" without knowing it means
  something.
- **Composition:** `--plain` is the strongest presentation flag and conflicts resolve
  **silently** (`--plain --color` renders plain; the worst moment to hand someone a
  usage error is when they are already fighting a broken terminal). `--plain` ≠
  `--no-color`, which keeps the glyphs — a deliberate middle mode for a terminal that
  mangles colour but renders glyphs fine. `--json --plain` is a no-op, not an error.
  `NO_COLOR` is a colour signal only and never implies `--plain`.
- **`--plain` changes nothing above `children:` on `show`.** Choosing a field over a
  glyph made the dossier plain-native, so output is byte-identical down to that line.
  The `state:` field keeps **bare words**, not bracket tags: a bracket is a
  *delimiter*, needed on a row where a derived tag abuts free text, and `key:`
  already does that job. Brackets where there is no structure, none where there is.
- **`--plain` is coarse on purpose.** It drops colour *and* glyphs *and* restores
  postfix tags — someone whose only complaint is one off-metric glyph loses the whole
  visual layer. There is **no `--no-glyphs`** and **no `ISSUES_PLAIN`**. The remedy
  for a bad glyph is a better glyph (§7), which fixes it for everyone silently; a
  flag fixes it only for those who discover the flag.

### 6 — Colour is decided in the shell, never in the core

`bin.ts` resolves TTY detection, `NO_COLOR`, and `--color` / `--no-color` down to a
single boolean and hands the pure core:

```ts
{ color: boolean, plain: boolean }
```

Colour is **off unless stdout is a TTY**; `NO_COLOR` (any value) forces it off;
explicit flags override; `--json` is **never** colourized. The core never sees
`auto` — two booleans, four combinations, no environment. **`--no-color` wins when
both flags are passed**: `parseArgs` stores booleans as separate keys, so argument
order is not recoverable and "last one wins" is unimplementable without changing the
parser. It is also the right tiebreak — quieter output is the safer failure.

Spelling is **`--color` / `--no-color`**, not `--color=auto|always|never`:
`--no-color` is what people type first, the CLI surface is boolean-shaped, and with
`--plain` in play a tri-valued flag adds a second axis of ceremony.

### 7 — The glyph set stands, with a named and accepted risk

Research (#21) **inverted the set's assumed risk model**. `»` and `×` — assumed
risky — have universal Latin-1 + WGL4 coverage and are the *safest* non-ASCII
characters in the set. `⊘` U+2298 — assumed the proven-safe baseline — is in neither,
and is missing from **Cascadia Mono** (Windows Terminal's default), SF Mono and Fira
Code; it works today only because Terminal.app and iTerm2 default to Menlo. Only `×`
is East_Asian_Width=Ambiguous, and no target terminal renders it double-width by
default.

The set is kept unchanged. The measured failure mode is an **off-metric fallback
glyph, never tofu** — fallback is universal — so output stays legible everywhere, and
§2's red gutter carries *blocked* even when the glyph degrades. The residual exposure
is possible column misalignment, unverified and unreported.

**Revisit trigger:** a report of misrendering or column misalignment on the gutter
glyph. Set A — `-` `~` `!` `✓` `»` `×` — is the standing candidate.

### 8 — CLI output is not a compatibility contract; `0.2.0` → `0.3.0`

**`--json` is the only stable read surface. Human-readable output is explicitly
unstable and may change in any release.** ADR 0007 is silent on output *by scope* —
it covers the tool's `--version` and the file's `schema:` key, nothing else — while
ADR 0005 already pinned `--json`. This makes the existing asymmetry normative, and
that is what permits the gutter, the colour, and `tree`'s default flip.

**One posture across all human output, including `--plain`.** A stricter rule for
`--plain` was rejected despite #22's "pipe-to-tooling" framing: that describes what
the flag is good for, not a promise. Piping to `grep` / `wc` / `fzf` needs the
absence of escape codes, which is what `--plain` delivers; piping to a *parser* wants
`--json`. And `--plain` is anchored forward, to a rendering that has never met a
user — pinning it in the release that invents it would make the first ergonomic fix
breaking.

The version goes **`0.2.0` → `0.3.0`** (minor is the breaking lane pre-1.0), with
**no deprecation path and no release note** for `tree`'s default flip.

At 0.x this declaration buys little **protection** — 0.x already means anything can
break. Its value is **permission**: a documented answer to "am I allowed to change
this?", so a future session gets a ruling instead of re-deriving a judgment call.

## Alternatives considered

**Gutter and glyphs**

- **A multi-slot gutter** encoding co-occurring state — rejected: widening a column
  every row pays for, to serve a case the `@who` marker already covers.
- **Alternative glyph sets** (`!` or `#` for blocked, pure-ASCII, WGL4-strict) —
  rendered and evaluated after #21's research reopened the question, then declined:
  nobody is excluded by the current set, and scheme C's colour covers the meaning
  when the glyph degrades. Held as the standing candidate behind a revisit trigger
  instead of spent now.
- **Keeping `⊘` under `--plain`** — rejected as self-defeating: it re-emits the exact
  character the mode exists to escape. **An ASCII prefix (`! `)** — rejected: it
  re-creates a gutter column by another name and reintroduces the alignment question
  in the one mode whose job is to be unsurprising.

**Colour**

- **Double-encoding state across the whole row** (tinting the title) — rejected: it
  makes a blocked row shout and costs readability on the thing you actually read.
- **Pure divide-labour** (colour for element type only, never state) — rejected: it
  wastes the strongest signal available, so blocked work does not pop — wrong for a
  tool whose frontier model is about what is takeable.
- **The core reading `NO_COLOR` / `isTTY` itself** — rejected: it breaks the
  filesystem-free-core invariant and makes the core untestable without a fake
  environment.
- **`--color=auto|always|never`** — rejected: see §6.

**Filtering**

- **Reparenting** non-matching subtrees onto the nearest matching ancestor — rejected:
  it distorts containment, which is the one thing `tree` exists to show.
- **Subtree pruning** (drop non-matching ancestors outright) — rejected: it hides the
  path to a match, so a filtered tree lies about where the work sits.
- **Blanking the gutter on scaffolding rows** — rejected: it makes the glyph column
  mean "is a result", overloading a column that already means "state".
- **Stripping markers on scaffolding rows** — rejected in both modes: it deletes real
  information (`@who`, `status:`) to signal a rendering fact.
- **Accepting the collapse under `--plain`** (no scaffolding treatment at all) —
  rejected: a filtered tree whose results are unmarked is just a smaller tree. That
  is data loss, not degradation.

**Modes and contract**

- **`--no-state` / `--no-glyphs`** as a separate dial — rejected: it would quietly
  downgrade §7's *accepted* risk to a *solved* one, which is false, and makes the
  mode space quadratic to explain in a tool whose pitch is that it is small.
- **`ISSUES_PLAIN` env var or a frontmatter `display:` block** — rejected: that is
  the config surface this effort ruled out of scope; once it exists, `ISSUES_COLOR`
  and `ISSUES_GLYPHS` have the same argument behind them. `NO_COLOR` is not a
  counter-example — it is honoured precisely because it is a cross-tool standard this
  repo did not invent; there is no equivalent standard for "plain".
- **Anchoring `--plain` to the pre-glyph rendering** — rejected: it does not survive
  the filtered `tree`, where scaffolding is a net-new concept with no legacy shape, so
  new plain behaviour would be designed anyway while having promised not to. It would
  also settle the compat question as a side effect.
- **A `--json` `state` field** exposing the six-state vocabulary to machines —
  rejected: it duplicates derived `blocked` + `assignee` + section, and this effort is
  about presentation, not the machine contract.
- **A one-time stderr advisory on `tree`, or starting a `CHANGELOG.md`** — rejected:
  an advisory punishes every future user to inform the handful present at the flip,
  and would need its own removal ticket.

## Consequences

- The six-state model reaches the reader in **one vocabulary across the whole read
  surface** — `list`, `tree`, `next`, `ready`, `show` — where it previously leaked
  through three inconsistent devices.
- **`tree` shows less by default than it does today.** This is the effort's one
  user-visible regression-shaped change, and it ships unannounced by design (§8) with
  `--all` documented in `--help`.
- **Two existing inconsistencies are fixed as a side effect**: `resolveRef`'s
  lowercased section suffixes capitalize, and `show`'s two-line header collapses to
  one.
- The core stays pure and gains **four testable rendering combinations**
  (`{color, plain}`) with no environment to fake.
- A **named, live risk** now sits in the repo rather than in someone's memory: `⊘`'s
  fallback, with set A standing by and a stated trigger. Two research gaps are
  recorded rather than papered over — Consolas coverage of U+2298, and the Windows
  legacy console code page.
- One question surfaced and was deliberately pushed out of scope: a **cascade
  advisory on `reopen`** ([#26](https://github.com/elucidata/issues/issues/26)), since
  suppressing `blocked` on closed issues means the moment it matters is the write, not
  the read.
