# Prototype — keystone representation (wayfinder #3)

**Throwaway.** Lives on branch `prototype/keystone-representation`, never merged to
`master`. Only the *decision* it validated folds back into the design spec.

## The question

How should relationships + metadata — **blocked-by, part-of (parent/child),
assignee/claim, labels, type, status** — be *physically represented inside a
single hand-editable `ISSUES.md`*, such that:

1. a human still reads the file at a glance, and
2. a **metadata-free file round-trips byte-for-byte** (`serialize(parse(x)) === x`),
   the load-bearing invariant of `@elucidata/issues`?

Three encodings are made concrete so they can be reacted to:

| # | Encoding | Sample | Verdict |
|---|----------|--------|---------|
| ① | **Inline trailing fields** — `- [ ] 007: Title. part-of:002 blocked-by:004 type:bug @matt #parser` | `samples/inline.md` | ✓ round-trips; **no line-grammar change**; research's pick |
| ② | **Field detail-lines** — labeled `Part of: 002` / `Blocked by: 004` note lines | `samples/field-lines.md` | ✓ round-trips; most English-readable; verbose |
| ③ | **Nested list** — parent/child via `- [ ]` indentation | `samples/nested.md` | ✗ **forces a line-grammar rewrite**; indented notes become ambiguous with children — round-trip hazard |

`samples/plain.md` is the metadata-free control: it must stay byte-identical under
*every* encoding (it does).

## Run

```sh
node prototypes/keystone-representation/run.ts               # comparison report
node prototypes/keystone-representation/run.ts --interactive  # drive the frontier by hand
```

The report renders each encoding, proves round-trip, and prints the derived
relationship graph (blocked / frontier). `--interactive` lets you `close`/`open`/
`claim` issues and watch the derived `BLOCKED` / `FRONTIER` state recompute from
the inline encoding — confirming the representation carries *enough* to derive
relationships without storing any derived state (no cascade, no write-back).

## What's the portable bit

`meta.ts` is the pure module. Its inline (①) parse/serialize + `derive()` are the
candidates to fold into the real `src/index.ts`; `run.ts` is the throwaway TUI
shell. Deliberately out of scope here: the *semantics* of blocking and containment
(ticket #5) and what the frontier query returns (ticket #6). This prototype only
answers **how the bytes look**.

## Recommendation

**Hybrid, anchored on ①:** inline `key:value` + `@`/`#` sigils are the source of
truth — read as pointers, never written back or restructured — with list
indentation permitted *only* as a display hint the parser ignores. That keeps ①'s
round-trip safety and greppability while allowing ③'s legibility where an author
wants it. ② is a reasonable fallback when labeled English lines matter more than
density. ③ *as the source of truth* is rejected: load-bearing indentation breaks
byte-for-byte round-trip.
