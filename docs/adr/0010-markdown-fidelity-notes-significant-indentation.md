# ADR 0010 — Markdown-fidelity notes / significant-indentation round-trip

- **Status:** Accepted
- **Ticket:** [#43 Notes preserve Markdown fidelity](https://github.com/elucidata/issues/issues/43)
- **Amends:** [ADR 0006](0006-blank-line-canonical-rendering.md) (canonical-form
  definition), which is left as a historical record.

## Context

Issue notes are commonly Markdown — blank lines between paragraphs, relative
indentation for nested lists and fenced code blocks. But the parser **dropped
interior blank lines** (`line.trim() === '' → continue`) and **flattened relative
indentation** (per-line `trimStart` on read, flat 6-space re-emit on write), so a
multi-paragraph or nested note was silently mangled on the next CLI write.

ADR 0006 warned that "a blank before an indented detail line would risk the parser —
which skips blanks — detaching the note." That warning is the artefact this ADR
removes: once indentation is significant, a blank line no longer detaches anything.

## Decision

**A note is the run of indented-or-blank lines following an issue line**, up to the
first non-indented, non-blank line (the next `- [ ]` issue, the next `## ` heading, or
EOF) — Python-style significant indentation. Everything *relative to the note's own
indent* round-trips as exactly the Markdown that was put in.

1. **Preserve the inner shape.** Interior blank lines *and* relative indentation
   survive.
2. **Trim leading & trailing blank lines** from the note — the note owns its
   *interior*; the section owns the *separation* between entries (ADR 0006). A
   trailing blank is indistinguishable from the entry separator and carries no
   Markdown meaning.
3. **Common-prefix dedent on read.** Strip the minimum indentation across the note's
   non-blank lines (relative nesting preserved) and store dedented.
4. **Canonical base indent on write stays 6 spaces** (`DETAIL_INDENT`). Any ≥1
   leading whitespace continues the note on read; the amount is normalized to 6 on
   write.
5. **Interior blank lines re-emit as truly empty lines** (zero characters — never 6
   spaces), so no trailing whitespace and the file stays a byte-for-byte fixed point.
6. **CLI note paths share the dedent.** `note` (`cmdNote`) and `add --note`
   (`cmdAdd`) route text through the **same common-prefix dedent** (not per-line
   `trimStart`), so CLI-entered structure round-trips identically to hand-edited
   structure.
7. **Appended notes get a `---` divider.** Appending a note to an issue that
   **already has a non-empty note** inserts a blank-line-wrapped `---` thematic break
   before the new text — stored as `["", "---", ""]` then the new lines. **Suppressed
   for the first note.**

A shared `dedentNote` helper (used by `parse`, `cmdNote`, and `cmdAdd`) is the single
place that trims blank edges and applies the common-prefix dedent.

## Compatibility

**No `schema:` bump** (ADR 0007): this is additive fidelity, not a grammar change. An
old build degrades gracefully — it flattens the note exactly as it does today — and
never rejects or corrupts a fidelity-carrying file. New builds read the same files
with fidelity intact.

## Alternatives considered

- **Keep the flatten-and-reflow behaviour** — rejected: multi-paragraph and nested
  notes are the common case for agent-written detail; silent mangling on the next
  write is a data-loss bug.
- **Store notes verbatim with their original indentation** (no dedent) — rejected:
  the common-prefix dedent is what lets a hand-edited note and a CLI-entered note
  normalize to the same stored shape, so the two edit paths coexist without churn.

## Consequences

- Notes are now first-class Markdown: paragraphs, nested lists, and fenced code
  blocks round-trip byte-for-byte.
- The round-trip guard (`serialize(parse(x)) === x`) gains a fixture exercising a
  multi-paragraph note with a nested list, a fenced code block, and an appended-note
  `---` divider — locking the fidelity by test.
- ADR 0006's "blank before an indented line risks detaching the note" caveat no
  longer holds; the invariant it restated is otherwise unchanged (canonical form is a
  fixed point; single-`\n` input normalizes on write).
