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
    carry a prefix: `M##` → `M01`, `BZ###` → `BZ007`, or just `###` → `007`.
    If there's no frontmatter, the default pattern is the generic `###`.
- **Four fixed sections**, always in this order: `## Issues` (open), `##
  Completed`, `## Deferred`, `## Won't Fix`. `Completed` items render checked
  (`[x]`); the rest stay `[ ]`.
- **Issue line:** `- [ ] <id>: <title>`, with an optional ` (YYYY-MM-DD)`
  datestamp appended when an issue is closed/deferred.
- **Notes:** indented continuation lines beneath an issue.

You never have to write this by hand — but you can, and the CLI will keep it tidy.

## CLI

```
issues <command> [args]

  list [--all] [--closed] [--deferred] [--wontfix]   list issues (default: open)
  add "<title>" [--note "<text>"]                     add a new open issue
  done <id> [--defer] [--wontfix]                     close / defer / wontfix an issue
  reopen <id>                                         move an issue back to open
  show <id>                                           print an issue with its note
  edit <id> "<title>"                                 replace an issue's title
  note <id> "<text>"                                  append a line to an issue's note
  help                                               show this message
```

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
