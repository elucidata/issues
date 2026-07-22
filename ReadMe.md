# @elucidata/issues

A tiny, dependency-free issue tracker whose database **is** a human-editable
`ISSUES.md` file. No service, no SQLite, no web UI — just a Markdown log you can
read, hand-edit, and commit alongside your code, plus a CLI that keeps the IDs,
datestamps, and section moves consistent for you.

It's designed to be used from **any project, in any agent or runtime**: run it
straight from GitHub with `npx`, install it once globally, `import` its core as a
library, or add it as a cross-agent skill. It hardcodes no path to its own
location, carries no project-specific ID prefix, and runs under both Node (22+,
which strips TS types) and Bun.

## Quick start

```sh
# Run straight from GitHub — no install, no bun required (bunx works too):
npx github:elucidata/issues list
npx github:elucidata/issues add "Sidebar overflows on narrow viewports" --note "Repro: < 360px"

# Or install once, globally, and use the `issues` command everywhere:
npm i -g github:elucidata/issues        # or: bun add -g github:elucidata/issues
issues list
issues done 3
```

The CLI resolves `ISSUES.md` by walking **up** from the current working directory
to the nearest one (so it works from any subdirectory), then reads, mutates, and
writes it. If none exists, `add` creates one where you run it.

## Why a Markdown file?

- **It diffs.** Every change to the issue log is a normal line-based diff in your
  PRs and `git blame`.
- **It round-trips byte-for-byte.** Frontmatter and preamble prose are preserved
  verbatim; only the section bodies are regenerated, deterministically. An
  untouched file serialized back out is identical to the input — so hand-edits
  and CLI edits coexist without churn.
- **It has no moving parts.** The "database" is one file you already version.

## The `ISSUES.md` format

```markdown
---
next_id: 7
pattern: "M##"
---
# Issue Tracker

Any prose here (the preamble) is preserved verbatim. Use it to explain the log.

## Issues

- [ ] M06: New note styles
      Indented lines under an issue are its note. They can span
      multiple lines and are shown by `issues show <id>`.

## Completed

- [x] M01: Promote issue-tracker.ts to packages/issues (2026-06-09)

## Deferred

## Won't Fix
```

How it's read:

- **Frontmatter** (optional, fenced by `---`):
  - `next_id` — the number the next `add` will use; the CLI bumps it for you.
  - `pattern` — the ID shape. `#` runs are zero-padded to their width and may
    carry a prefix: `M##` → `M01`, `BZ###` → `BZ007`, `ISS-###` → `ISS-042`, or
    just `###` → `007`. If there's no frontmatter, the default is the generic
    `###`. A file is read with *its own* pattern, so a line whose id carries some
    other prefix is a malformed line, not an issue — `doctor` reports it.
- **Four fixed sections**, always in this order: `## Issues` (open), `##
  Completed`, `## Deferred`, `## Won't Fix`. `Completed` items render checked
  (`[x]`); the rest stay `[ ]`.
- **Issue line:** `- [ ] <id>: <title>`, with an optional ` (YYYY-MM-DD)`
  datestamp appended when an issue is closed/deferred. Optional inline metadata
  rides the **tail** of the line and is peeled off on read: `blocked-by:<id[,id]>`
  and `part-of:<id>` (relationships), `status:<value>` (workflow), `@assignee`
  (claim), `#label` (category), plus any custom `key:value` (a user-defined
  attribute, preserved verbatim). A line with no tail metadata is left
  byte-identical, so a metadata-free file in canonical form round-trips unchanged.
- **Notes:** indented continuation lines beneath an issue.

You never have to write this by hand — but you can, and the CLI will keep it tidy.

## CLI

```
issues <command> [args]

Reads (add --json for the machine contract; -q silences advisories):
  list [--all|--closed|--deferred|--wontfix] [filters]   list issues (default: open)
  next   [filters]                                       the topmost takeable issue
  ready  [filters] [--limit N]                           the whole takeable frontier
  show <id> [--children]                                 full resolved dossier
  tree [id] [--all|--closed|--deferred|--wontfix] [filters]   containment forest (id roots the subtree; default: open)
  doctor                                                 lint the file (exit 1 on any error finding)

Mutations:
  add "<title>" [--note <t>] [--part-of <id>] [--blocked-by <id[,id]>]
                [--status <s>] [--assignee <who>] [--label <name[,name]>]
  block <id> --by <blocker>        unblock <id> [--by <blocker>]   (no --by clears all)
  assign <id> <who>                unassign <id>
  label <id> <name[,name]>         unlabel <id> <name[,name]>
  set <id> <key>:<value>           unset <id> <key>
  done <id> [--defer|--wontfix]    reopen <id>
  edit <id> "<title>"              note <id> "<text>"
  help                                                   show this message
  version, --version                                     print the installed version

filters (list/next/ready/tree): --status <s> | --label <n> | --parent <id> | --assignee <who>
         (AND across dimensions, OR within a repeated/comma-listed dimension)

presentation (human-readable reads only; --json is never colourized):
  --plain      no colour, no state gutter — state as postfix [tags] at the row's end
               strongest of the three: --plain --color renders plain, silently
  --color      force colour on;  --no-color  force it off but keep the gutter/glyphs
               colour otherwise follows NO_COLOR and whether stdout is a terminal

state gutter:  - open   ~ claimed   ⊘ blocked   ✓ completed   » deferred   × won't fix

--json is the only stable read surface; human-readable output may change in any release.
```

### Reading the output

Every compact row leads with a **state gutter** — one glyph, coloured, carrying the
issue's state:

```
  - 001  Land the tokenizer rewrite.
  ~ 002  Parser drops trailing detail lines. status:doing @matt #bug
  ⊘ 003  Backfill the round-trip corpus. #parser
  ✓ 005  Pin the detail-line grammar. @jo (2026-06-07)
```

`-` open · `~` claimed · `⊘` blocked · `✓` completed · `»` deferred · `×` won't fix.
Precedence is `closed > blocked > claimed > open`: one slot, highest state wins, and a
blocked-and-claimed issue shows `⊘` with the claim carried by its `@who`. Right of the
gutter everything is coloured by *element* — ids cyan, `status:` values yellow,
`@assignee` magenta, `#label` blue — so the same field is the same colour on every row.

**`--plain`** is the colour-free rendering: no gutter, state as postfix tags at the end
of the row instead.

```
  001  Land the tokenizer rewrite.
  003  Backfill the round-trip corpus. #parser [blocked]
  005  Pin the detail-line grammar. @jo (2026-06-07) [Completed]
```

Capitalized tags are **stored** (the section the issue lives in); lowercase ones are
**derived** at read time. A closed *and* blocked issue shows both.

Three flags, one rule each:

- **`--plain` is the strongest** presentation flag. `--plain --color` renders plain,
  silently — so a script can pass `--color` unconditionally and stay `--plain`-able.
- **`--plain` is not `--no-color`.** `--no-color` keeps the gutter and the glyphs; it is
  the deliberate middle mode for a terminal that mangles colour but renders glyphs fine.
- **`NO_COLOR`** (any value) turns colour off and never implies `--plain`. With no flags,
  colour follows whether stdout is a terminal.

### Output stability

**`--json` is the only stable read surface. Human-readable output is explicitly
unstable and may change in any release** — the gutter, the colours, and `tree`'s
default are all free to move.

One posture covers *all* human output, `--plain` included. `--plain` gives you the
absence of escape codes, which is what piping to `grep` / `wc` / `fzf` needs; piping to
a **parser** wants `--json`. At 0.x this declaration buys **permission**, not
protection.

`next`/`ready` are the **takeable frontier** — open ∩ every blocker closed ∩
unclaimed, in document order — the one query an agent runs to pick up work;
filters only narrow it. Every read speaks `--json` (see the skill for the exact
contract); graph state (`blocked`, `takeable`) is **derived at read time, never
stored**. Anomalies surface as **findings** in two tiers: **errors** (the file does
not mean what it says) and **advisories** (nothing is wrong, but an assumption may not
hold). They ride stderr at exit 0; `-q` thresholds that channel at **error** — dropping
advisories, keeping errors. `doctor` is the CI gate: it exits **1 iff any finding is an
error** (an advisory-only file passes green), and `doctor --json` is `{ findings }`.

IDs are forgiving on input — `1`, `001`, `m1`, and `M001` all resolve to the
same canonical id under an `M##`/`###` pattern.

Invoke it however suits the project:

- Direct from GitHub: `npx github:elucidata/issues list` (or `bunx github:elucidata/issues …`)
- Globally installed: `issues list`
- As a project script, so contributors run it the same way — add to `package.json`:
  ```json
  { "scripts": { "issues": "npx github:elucidata/issues" } }
  ```
  then `npm run issues -- list` (npm needs `--` to pass flags) or `bun run issues list`.

### Environment

- `ISSUES_FILE` — absolute/relative path to the issues file, overriding the
  upward search. Useful in CI or when the file lives somewhere unusual.
- `ISSUES_DATE` — a fixed `YYYY-MM-DD` "today" for deterministic datestamps
  (used by the tests).

## Use it as a skill (any agent)

Distribute it to coding agents (Claude Code, Cursor, Codex, Copilot, Windsurf,
Gemini, and more) via [skills.sh](https://skills.sh):

```sh
npx skills add elucidata/issues
```

This installs a small skill (`skills/issues/SKILL.md`) that teaches the agent when
and how to invoke the CLI. GitHub is the source of truth; no registration needed.

## Library API

The package is split into a pure, filesystem-free core (`src/index.ts`, the `.`
export) and a thin CLI shell (`src/bin.ts`). Import the core to drive the log
programmatically or to build your own front-end:

```ts
import { parse, serialize, run, cmdAdd } from '@elucidata/issues';

// High-level: dispatch a command over file text, get back the new text.
const { text, output, mutated } = run(currentMarkdown, ['add', 'A new bug']);

// Or work with the parsed document directly.
const doc = parse(currentMarkdown);
cmdAdd(doc, 'Another bug', 'with a note');
const updated = serialize(doc); // byte-for-byte stable
```

`run(text, argv)` does no I/O — it's the same dispatcher the CLI uses, which is
why the whole command surface is testable without touching the disk.

## Development

```sh
bun install
bun run test     # vitest (the parse/serialize round-trip is the key guard)
bun run check    # tsc --noEmit
bun run build    # bundle dist/cli.js + dist/index.js and emit dist/index.d.ts
```

`dist/` is **committed on purpose** — consumers run it straight from GitHub and
via global install with no install-time build. **Rebuild and commit `dist/`
whenever you change `src/`.**
