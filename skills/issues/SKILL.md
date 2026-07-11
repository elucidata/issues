---
name: issues
description: Manage a project's issue log stored in an ISSUES.md file — list, add, close, defer, reopen, edit, or annotate issues. Use when the user mentions ISSUES.md, wants to track a bug/task/follow-up, or asks to add/close/list issues in this repo.
---

# Issues — ISSUES.md issue tracker

`@elucidata/issues` is a tiny CLI whose "database" **is** a human-editable
`ISSUES.md` Markdown file at (or above) the working directory. Use it to keep
issue IDs, datestamps, and section moves consistent instead of hand-editing.

## Invoking it

Prefer whichever is already set up, in this order:

1. If the repo has an `issues` script: `npm run issues -- <cmd>` (npm needs `--` to
   pass flags) or `bun run issues <cmd>`.
2. If installed globally: `issues <cmd>`.
3. Otherwise run it straight from GitHub (no install; Node-only, no bun required):
   `npx github:elucidata/issues <cmd>` (or `bunx github:elucidata/issues <cmd>`).

The tool finds `ISSUES.md` by walking **up** from the current directory. Set
`ISSUES_FILE=/path/to/ISSUES.md` to target a specific file.

## Commands

```
issues <command> [args]

  list [--all] [--closed] [--deferred] [--wontfix]   list issues (default: open)
  add "<title>" [--note "<text>"]                     add a new open issue
  done <id> [--defer] [--wontfix]                     close / defer / wontfix an issue
  reopen <id>                                         move an issue back to open
  show <id>                                           print an issue with its note
  edit <id> "<title>"                                 replace an issue's title
  note <id> "<text>"                                  append a line to an issue's note
  help                                               show usage
```

IDs are forgiving: `1`, `001`, `m1`, `M001` all resolve to the same canonical id.

## Examples

```sh
issues list                                  # open issues only
issues list --all                            # every section
issues add "Login button misaligned on iOS"  # -> Added 007: ...
issues add "Flaky test" --note "Fails ~1 in 5 on CI"
issues done 7                                # -> Completed, datestamped
issues done 7 --defer                        # -> Deferred instead
issues show 7
```

## The ISSUES.md format (for hand edits / context)

Optional `---` frontmatter with `next_id` and `pattern` (ID shape, e.g. `CP##` →
`CP01`; default `###`). Four fixed sections in order: `## Issues` (open),
`## Completed`, `## Deferred`, `## Won't Fix`. Issue lines are
`- [ ] <id>: <title>` with an optional ` (YYYY-MM-DD)` datestamp; indented lines
beneath an issue are its notes. The file round-trips byte-for-byte, so the CLI
and hand-edits coexist safely — but let the CLI manage IDs and datestamps.
