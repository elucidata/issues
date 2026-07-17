# ADR 0001 — Inline trailing fields as the metadata representation

- **Status:** Accepted
- **Ticket:** [#3 Keystone](https://github.com/elucidata/issues/issues/3) (prior art [#2](https://github.com/elucidata/issues/issues/2))
- **Spec:** [Nested issues & agentic-flow support §1](../design/nested-issues-agentic-flow.md#1-grammar--the-metadata-primitive)

## Context

`@elucidata/issues` stores every issue as one Markdown line —
`- [ ] <id>: <title>` — with indented free-text detail beneath, in a single
`ISSUES.md`. The agentic flow needs to attach **relationships** (blocked-by,
parent/child) and **metadata** (assignee/claim, labels, status) to each issue,
without breaking the load-bearing **byte-for-byte round-trip** invariant
(`serialize(parse(x)) === x`) and without a service or database.

A prior-art survey ([#2](https://github.com/elucidata/issues/issues/2),
`docs/research/prior-art-single-file-trackers.md`) found todo.txt's inline
`key:value` fields + sigil tags to be the only widely-used convention that is
optional, additive, and greppable — so metadata-free lines stay byte-identical.
Taskwarrior contributes the principle that unrecognized attributes are preserved
verbatim.

## Decision

Relationships and metadata ride as **inline trailing fields and sigils on the
existing issue line**, which is the **source of truth**:

```
- [ ] 007: Wire up the parser. part-of:002 blocked-by:004 type:bug status:in-progress @matt #parser
```

- Fields **peel off the tail** of the line, so a metadata-free line is untouched.
- `key:value` fields: `part-of:` (single), `blocked-by:` (comma-multi), `status:`,
  and any unknown key. Sigils: `@assignee` (single), `#label` (multi).
- Relationship values are **read-only ID pointers** — parsed, never rewritten;
  derived state is computed at read time (see ADR 0003).
- **Unknown `key:value` tokens are preserved verbatim** (Taskwarrior UDA principle).
- **List-indentation is a display hint the parser ignores** — never a source of
  parentage.

## Alternatives considered

- **Field detail-lines** (`Blocked by: 007` as a recognized detail line) —
  round-trips fine and reads well, but verbose and lower-density. Kept only as a
  documented fallback concept, not the primitive.
- **Nested-list as source of truth** (indentation ⇒ parentage) — **rejected**. Under
  the current grammar indented `- [ ]` children get swallowed as the parent's detail
  notes; making nesting authoritative forces a line-grammar rewrite and makes genuine
  indented notes ambiguous — a direct round-trip hazard.

## Consequences

- Zero line-grammar change; metadata-free files stay byte-identical — the invariant
  holds (proven in the `prototype/keystone-representation` prototype, commit
  `9b4199a`: all encodings round-trip byte-for-byte incl. the metadata-free control).
- The escape-hatch file split is **not** triggered — the in-file design is not
  gnarly.
- Everything downstream (state model, graph semantics, frontier query, CLI) builds on
  this single representation.
- Greppability is preserved: `grep 'blocked-by:' ISSUES.md` just works.
