# ADR 0007 — `--version` and the file-format schema compatibility contract

- **Status:** Accepted
- **Ticket:** none — charted via a `/wayfinder` grilling that surfaced no fog
  (single-session scope), so no map was raised. This ADR is normative on its own.
- **Extended by:** [ADR 0009](0009-finding-model-severity-and-emission.md) — the `schema:`
  compat codes (`schema-unparseable`, `schema-too-new`) join `doctor` as **advisories**;
  0007's forward "advisory, never a gate" contract survives **intact** (it is not
  superseded). ADR 0009 also names the second compat contract 0007 left implicit: the
  library's **TypeScript surface**, governed by package semver, is distinct from this file
  format's `schema:` contract.

## Context

Two version questions arrived together and had to be untangled — they only share
the word "version":

1. **The tool has no `--version`.** A CLI ought to report its own version; `issues`
   couldn't.
2. **`ISSUES.md` has no format version.** Is that a latent backward-compat problem?
   Should a version be embedded in the frontmatter now, before it's needed?

These are unrelated: (1) is about the *program*, (2) is about the *data file*. The
data-file question is the load-bearing one, because the whole premise of this tool
is that the file is **plain, hand-editable Markdown you always own** (ADR 0006) —
any versioning scheme must not betray that.

The current format is unchanged, so **every file in the wild is still valid as-is**.
The real decision is not "add a version" but "lock a contract now that makes it safe
to *defer* adding one until the format actually breaks."

## Decision

### 1 — `--version` ships, sourced from the manifest, inlined at build

`issues version` and `issues --version` print the package version and exit 0,
**before** `ISSUES.md` is even resolved (it reports the *tool*, not the file). The
string comes from `package.json` via a JSON import in the **shell** (`src/bin.ts`),
which the bundler **inlines at build time** — so `dist/cli.js` carries the literal
and prints it with **zero runtime file I/O**. The pure core (`src/index.ts`) stays
import-free (per CLAUDE.md); only the shell knows the version. `package.json` remains
the single source of truth — no second place to bump.

### 2 — Reserve `schema:`, embed nothing yet

`schema:` is **reserved** as the frontmatter key for a future file-format version
(chosen over `version` — ambiguous with the tool/project version — and over
`format_version` — verbose). It is **written for the first time only when a breaking
format change ships**. Until then no file carries it; existing files stay valid
untouched. The parser already preserves any frontmatter `key: raw` line verbatim, so
a hand-authored `schema:` round-trips today.

### 3 — The compatibility contract

- **Backward (absent key ⇒ legacy).** A file with **no `schema:` key** is the
  original format (`SUPPORTED_SCHEMA = 1`) and is **never rejected**. The *absence*
  is the version signal — that's what makes deferral safe: the day a breaking change
  lands, the new writer starts emitting `schema:`, and old unversioned files remain
  unambiguously "legacy."
- **Forward (unknown ⇒ advisory, never a gate).** A `schema:` **newer** than this
  build understands (or non-numeric) surfaces an **advisory warning and proceeds** —
  it never rejects, never changes an exit code. Consistent with ADR 0005's
  warn-but-write posture and ADR 0006's "the file is always yours": a version field
  is **advisory, never a hard gate**.

### 4 — Where the advisory surfaces

`compatWarnings(doc)` derives the advisory read-time from the frontmatter and rides
the **existing `RunResult.warnings` channel** (ADR 0005 §3) — stderr, non-fatal,
exit 0, silenced by `-q`. It **leads** both the read-command advisories
(`list`/`next`/`ready`/`tree`) and the edge-mutation advisories, so an older build
reading *or writing* a newer file always says so first. The logic is **dormant**
until a v2 file exists, but it is implemented and tested now — that is what "lock the
contract" means: executable, not vapor.

## Alternatives considered

- **Embed `schema: 1` in every file now** — rejected: writes to every file for zero
  present benefit (churns the round-trip, §5-style reflow) and buys nothing the
  "absent ⇒ legacy" rule doesn't already give for free.
- **Hard-reject an unknown/newer schema** — rejected: breaks the "it's just Markdown,
  always yours" premise; a stale global install would refuse a file a newer teammate
  touched. Advisory preserves access; the user decides.
- **Read `package.json` at runtime for `--version`** — rejected: an extra file read
  to print a constant, and it pulls I/O toward the version path; build-time inlining
  is free and keeps the core pure.
- **Key named `version` / `format_version`** — rejected: `version` is ambiguous about
  *what* is versioned; `format_version` is verbose. `schema` reads as "the shape of
  this file."

## Consequences

- The tool reports its version in three invocation modes (dev via Bun, built
  `dist/cli.js` under Node, and `npx github:…`) with no runtime I/O and no second
  source of truth.
- `ISSUES.md` needs **no change** and stays backward-compatible; the compat door is
  provably safe to open later.
- A `schema:` bump is now a *designed* future move, not a lucky one: absent ⇒ legacy,
  newer ⇒ warn-and-proceed. Implementing the mismatch *migration* is future work that
  begins the day the first breaking format change is specified.
- The dormant advisory does not fire for any file that exists today, so behaviour of
  the current corpus is unchanged.
