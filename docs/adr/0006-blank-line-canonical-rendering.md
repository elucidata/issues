# ADR 0006 — Blank-line canonical rendering and the restated round-trip invariant

- **Status:** Accepted
- **Ticket:** [#9 Blank-line separation](https://github.com/elucidata/issues/issues/9)
- **Spec:** [Nested issues & agentic-flow support §7](../design/nested-issues-agentic-flow.md#7-rendering--the-round-trip-invariant)

## Context

With document order now the sole priority signal (ADR 0003) and reordering being a
hand-edit (ADR 0005), the `ISSUES.md` file itself must be easy to eyeball, select,
copy-paste, and rearrange. Today `renderSection` joins entries with a single `\n`,
which packs them tightly. Adding a blank line between entries brushes the
**load-bearing byte-for-byte round-trip invariant** (`serialize(parse(x)) === x`) —
so this is a serialization decision, not a CLI one.

## Decision

**Blank-line separation between rendered entries: YES — one enforced canonical
form.**

1. **Rendering rule.** `renderSection` joins entry-blocks with **`\n\n`** instead of
   a single `\n`; `renderIssue` is untouched. An entry-block = the issue line + its
   indented detail; detail stays **tight** under its parent, so blank lines fall
   **only between top-level entries** (a blank before an indented detail line would
   risk the parser — which skips blanks — detaching the note). Concretely
   `.join('\n')` → `.join('\n\n')` in `renderSection`, nothing else.
2. **Scope: serialized file only.** `cmdList`/`cmdShow` have independent render paths
   and are **unchanged** — terminal output is not double-spaced.
3. **The invariant is restated, not broken.** `serialize(parse(x)) === x` never held
   for arbitrary `x` — the parser already skips hand-added blanks and re-emits, so a
   hand-spaced file never round-tripped; the guard only ever ran against the canonical
   `ISSUES.md`. The precise invariant becomes:

   > **A file in canonical (blank-separated) form is a fixed point; single-`\n` input
   > is accepted on read and normalized to blank-separated on write.**

   Reflow of a tight file on its first CLI write is **defined behavior, not a bug**.
4. **One-time migration.** The repo's own `ISSUES.md` and every single-`\n` test
   fixture migrate once to blank-separated so the guard stays green.
5. **No prototype.** One-line mechanism; round-trip verified by inspection (blank
   skipped on parse, `lastIssue` persists harmlessly, next `- [ ]` resets it).

## Alternatives considered

- **Keep single-`\n`** — rejected: the file is now the primary reorder/scan surface;
  packed entries are hard to eyeball and hand-move.
- **Preserve inter-entry spacing as formatting** (rather than regenerate it) —
  rejected: complicates the "section bodies are regenerated deterministically" model
  and re-opens per-file style tracking.

## Consequences

- One legible canonical form; hand-added blank lines are no longer clobbered.
- **The single behavioural change to existing files**: a tight file reflows to
  blank-separated on first CLI write (defined, §3).
- The build's only residual risk here is catching **every** affected fixture during
  the one-time migration — not whether the approach works.
