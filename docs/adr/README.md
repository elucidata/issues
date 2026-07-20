# Architecture Decision Records

Decisions that shape `@elucidata/issues`. Each ADR records one decision's context,
alternatives, and consequences; the executable synthesis lives in
[`docs/design/`](../design/).

## Nested issues & agentic-flow support

Compiled from [Wayfinder map #1](https://github.com/elucidata/issues/issues/1). The
normative build spec is
[`docs/design/nested-issues-agentic-flow.md`](../design/nested-issues-agentic-flow.md).

- [0001 — Inline trailing fields as the metadata representation](0001-inline-trailing-fields.md)
- [0002 — Two-axis state model: section = lifecycle, `status:` = workflow](0002-two-axis-state-model.md)
- [0003 — Read-time-derived graph semantics](0003-read-time-derived-graph-semantics.md)
- [0004 — Frontier query: one predicate, two projections, no auto-claim](0004-frontier-query.md)
- [0005 — CLI surface: hybrid mutation model, JSON reads, advisory warnings](0005-cli-surface.md)
- [0006 — Blank-line canonical rendering and the restated round-trip invariant](0006-blank-line-canonical-rendering.md)

## Versioning

- [0007 — `--version` and the file-format schema compatibility contract](0007-version-flag-and-schema-compat-contract.md)

## Terminal output

Compiled from [Wayfinder map #19](https://github.com/elucidata/issues/issues/19). The
normative build spec is
[`docs/design/terminal-output.md`](../design/terminal-output.md).

- [0008 — Terminal output: state gutter, colour, `--plain`, and read filtering](0008-terminal-output-state-gutter-colour-plain.md)
