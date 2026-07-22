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

To determine which is set up, run `cat package.json | grep issues` to check for a script, then `which issues` for a global install. If neither check succeeds, fall back to npx (or bunx depending on project setup).

1. If the repo has an `issues` script: `npm run issues -- <cmd>` (npm needs `--` to
   pass flags) or `bun run issues <cmd>`.
2. If installed globally: `issues <cmd>`.
3. Otherwise run it straight from GitHub (no install; Node-only, no bun required):
   `npx github:elucidata/issues <cmd>` (or `bunx github:elucidata/issues <cmd>`).

The tool finds `ISSUES.md` by walking **up** from the current directory. Set
`ISSUES_FILE=/path/to/ISSUES.md` to target a specific file.

If no `ISSUES.md` is found, run `issues add` which will create the file automatically, or inform the user and ask if they want to initialize one.

## Commands

```
issues <command> [args]

Reads (add --json for the machine contract; -q silences advisories):
  list [--all|--closed|--deferred|--wontfix] [filters]   list issues (default: open)
  next   [filters]                                       the topmost takeable issue
  ready  [filters] [--limit N]                           the whole takeable frontier
  show <id> [--children]                                 full resolved dossier
  tree [--all|--closed|--deferred|--wontfix] [filters]   containment forest (default: open)
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

IDs are forgiving: `1`, `001`, `m1`, `M001` all resolve to the same canonical id.

## The model — two orthogonal axes plus a claim

Beyond open/closed sections, issues carry inline metadata on the tail of the line:

- **`blocked-by:<id[,id]>`** — an issue is *blocked* while any listed blocker is still
  open (direct, non-transitive; closing a blocker unblocks it). Manage with
  `block`/`unblock`. Self-reference is rejected; unknown/cyclic blockers warn but write.
- **`part-of:<id>`** — pure containment (a parent/child tree), **no** lifecycle or
  blocking flow. Shown by `tree` / `show --children`.
- **`@assignee`** — the claim; a claimed issue leaves the default `next`/`ready`
  frontier. Manage with `assign`/`unassign`.
- **`status:<value>`** and **`#label`** — a freeform workflow scalar (open-only; voided
  on close) and category sigils. `set`/`unset` for `status:` + any custom `key:value`
  UDA; `label`/`unlabel` for labels.

`next`/`ready` are always the **takeable frontier** (open ∩ unblocked ∩ unclaimed);
filters only narrow it. Reads and writes derive **findings** in two tiers — **errors**
(the file does not mean what it says: a dangling/self blocker, a cycle, a malformed
line, an undeclared status) and **advisories** (nothing is wrong, but an assumption
may not hold: a won't-fix/deferred blocker, a closed-with-open-blocker, a `schema:`
mismatch). They ride stderr at exit 0; `-q` thresholds that channel at **error** — it
drops advisories and keeps errors, it never empties the channel. `doctor` is the CI
gate: it exits **1 iff any finding is an error**, otherwise 0 (so an advisory-only file
is a green pass), and `doctor --json` is `{ "findings": [...] }` — read the exit code,
or `.findings | any(.severity == "error")`, never a text scrape.

The optional `schema:` frontmatter key is **reserved** for a future file-format
version and is written only when the format actually changes (ADR 0007). A file with
no `schema:` is the current/legacy format and always reads; a `schema:` newer than
your `issues` build warns and proceeds — never rejects. Nothing writes it today.

## The `--json` contract

Every read (`list`/`next`/`ready`/`show`/`tree`) takes `--json` and emits the machine
contract; human text is the default. Read emptiness **structurally** (`null`/`[]`), never
from the exit code — an empty frontier is a normal exit 0.

**`--json` is the only stable read surface — always use it.** The human-readable
rendering (the state gutter, colour, `--plain`) is explicitly unstable and may change
in any release; `--plain` gives you the absence of escape codes for `grep`/`wc`/`fzf`,
not a parsing contract. Never scrape the text output.

Each issue is an object:

```json
{ "id": "003", "title": "Docs", "section": "Issues",
  "status": null, "assignee": null, "labels": ["docs"],
  "blockedBy": [], "partOf": "002", "blocked": false, "takeable": true }
```

- `list` / `tree` → an **array** of these (`tree` nests each child under `"children": [...]`).
- `next` → `{ "issue": <obj>|null, "reason": <string>|null }`.
- `ready` → `{ "issues": [<obj>], "reason": <string>|null }`.
- `show` → the object plus `parent`, `blockers` (each `{id,title,section,open,found}`),
  `detail` (note lines), and `findings` (an array of `Finding` objects — the anomalies
  about this issue, each with `severity`, `code`, `subjects`, `mentions`).

`blocked` and `takeable` are **derived at read time, never stored**. On `next`/`ready`,
`reason` is `null` when the frontier is non-empty and otherwise diagnoses the empty state
(drained / all blocked / all claimed / no filter match) so an agent loop can decide
stop-vs-wait without treating empty as an error.

## Examples

```sh
issues list                                  # open issues only, with the state gutter
issues list --all                            # every section
issues add "Login button misaligned on iOS"  # -> Added 007: ...
issues add "Wire parser" --blocked-by 4 --status wip --label parser,ui
issues block 7 --by 4                         # 7 is now blocked by 4
issues assign 7 matt                          # claim it
issues ready --status ready-for-agent --json  # machine-readable takeable frontier
issues next                                   # the topmost takeable issue
issues tree                                   # containment forest (open by default)
issues tree --all                             # every section
issues tree --label parser                    # filtered; ancestors kept as scaffolding
issues show 7 --children                      # dossier + subtree
issues doctor                                 # lint; exit 1 on any error finding
issues done 7                                 # -> Completed, datestamped (status voided)
```

## The ISSUES.md format (for hand edits / context)

Optional `---` frontmatter with `next_id` and `pattern` (ID shape, e.g. `CP##` →
`CP01`; default `###`). Four fixed sections in order: `## Issues` (open),
`## Completed`, `## Deferred`, `## Won't Fix`. Issue lines are
`- [ ] <id>: <title>` with an optional ` (YYYY-MM-DD)` datestamp; indented lines
beneath an issue are its notes. The file round-trips byte-for-byte, so the CLI
and hand-edits coexist safely — but let the CLI manage IDs and datestamps.
