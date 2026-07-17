# CLAUDE.md

Guidance for working on `@elucidata/issues` with Claude Code (or any coding agent).

## Overview

A tiny, **dependency-free** issue tracker whose "database" **is** a human-editable
`ISSUES.md` Markdown file — no service, no SQLite, no web UI. It ships as both a
CLI (the `issues` command) and a library (`import { run, parse, serialize } from '@elucidata/issues'`).
It runs under **Node 22+** (which strips TS types) and Bun.

## Architecture

Two layers, deliberately split:

- **`src/index.ts` — pure, filesystem-free core** (the `.` export). Parses,
  serializes, and runs commands over the `ISSUES.md` *text*. Does **no I/O**.
- **`src/bin.ts` — thin CLI shell** (the `issues` bin). The only layer that
  touches disk: resolves `ISSUES.md` by walking up from the cwd (or `ISSUES_FILE`),
  reads it, calls `run(text, argv)`, writes back if the result is `mutated`.

**Load-bearing invariant — byte-for-byte round-trip.** Frontmatter and preamble
prose are preserved verbatim; only section bodies are regenerated
deterministically. An untouched file serialized back out must be identical to the
input, so hand-edits and CLI edits coexist without churn. The
`serialize(parse(x)) === x` test in `src/index.test.ts` is the key guard — never
break it.

## Commands

- `bun run build` — bundle `dist/cli.js` + `dist/index.js` and emit `dist/index.d.ts`.
- `bun run test` — vitest (the round-trip guard lives here).
- `bun run check` — `tsc --noEmit`.

## Rules

- **All-green:** `bun run check` and `bun run test` must be green **before and
  after** every change. A red test is work to do, never a footnote.
- **Rebuild and commit `dist/` whenever `src/` changes.** `dist/` is committed on
  purpose — consumers run it straight from GitHub (`npx github:elucidata/issues …`)
  and via global install with **no install-time build**. Stale `dist/` ships stale
  behavior.
- **Zero runtime dependencies.** The core imports nothing; the shell imports only
  Node built-ins. Keep it that way — new deps need a strong justification.
- **Keep it Node-first.** The built bin carries a `#!/usr/bin/env node` shebang and
  must run under plain Node without Bun. Bun is only this repo's dev/build tool.

## Style

Tabs, single quotes, no trailing commas — match the existing source.

## Distribution

- CLI (any runtime): `npx github:elucidata/issues <cmd>` (or `bunx`), or global
  install `npm i -g github:elucidata/issues` → `issues <cmd>`.
- Cross-agent skill (skills.sh): `npx skills add elucidata/issues` — the skill
  lives at `skills/issues/SKILL.md`. Update it when the CLI surface changes.

## Agent skills

### Issue tracker

Issues live in the repo's GitHub Issues (`elucidata/issues`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label named as its role (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
