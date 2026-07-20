# Prior art: single-file / plain-text issue trackers

**Question:** How do existing plain-text / single-file issue trackers represent dependencies, parent/child nesting, labels, assignees, and per-issue metadata — and which of those primitives are worth borrowing for a single-file, human-editable `ISSUES.md` Markdown tracker?

The constraints that shape the answer (from this repo): the database is ONE hand-editable `ISSUES.md`; issues render as `- [ ] 007: Title` list items with indented note lines beneath; byte-for-byte round-trip is load-bearing (a metadata-free file must serialize back identically); zero runtime dependencies; must stay greppable and read at a glance. So we want conventions that are **optional, additive, inline, and greppable** — never a structural rewrite of the line grammar.

---

## todo.txt

The [todo.txt format spec](https://github.com/todotxt/todo.txt) is the canonical "one task per line, plain text" grammar. Everything is inline on a single line; there is no separate metadata block.

- **Priority:** an uppercase letter in parens, first on the line: `(A) Call Mom`. Lowercase or non-leading is not a priority.
- **Completion:** a leading lowercase `x ` marks done, optionally followed by a completion date then the creation date: `x 2011-03-03 2011-03-01 Review report`.
- **Creation date:** optional `YYYY-MM-DD` after the priority: `(A) 2011-03-02 Call Mom`.
- **Projects / contexts:** `+project` and `@context` tags appear anywhere after the priority, space-delimited, and there can be many: `(A) Call Mom +Family @phone @iphone`. These are the "label" primitive.
- **Custom metadata:** free-form `key:value` pairs with no whitespace and a single colon, e.g. `due:2010-01-02`, `pri:A`. This is the extensibility escape hatch — any tool-specific field rides along as `key:value` and is preserved by conformant tools.
- **Ordering:** the spec deliberately does **not** mandate storage order; ordering is a client concern (sort by priority, project, etc.). The file is a set of lines.

**What to borrow:** the `+tag` / `@tag` sigils for cheap labels, and especially the `key:value` inline-field convention — it is the single most portable, greppable, round-trip-friendly metadata primitive in the wild. It is additive (a line with no `key:value` is unchanged) and trivially `grep`-able (`grep 'blocked-by:' ISSUES.md`).

## Backlog.md

[Backlog.md](https://github.com/MrLesk/Backlog.md) (the `backlog` CLI) is Git-native and stores **one Markdown file per task** in a `backlog/` folder (e.g. `task-10 - Add core search functionality.md`), not a single file. Each file is YAML frontmatter + Markdown body ([README](https://raw.githubusercontent.com/MrLesk/Backlog.md/main/README.md)):

```yaml
---
id: task-1
title: Parent Test task
status: To Do
assignee: []
created_date: '2025-08-23 14:20'
labels:
  - test
dependencies: []
---
## Description
...
## Acceptance Criteria
- [ ] ac1
```

- **Status:** a string frontmatter field (`To Do`, `In Progress`, `Done`) that maps to Kanban columns.
- **Labels / assignees:** YAML arrays (`labels: [...]`, `assignee: [...]`).
- **Dependencies:** a `dependencies:` array of task IDs.
- **Parent/child:** sub-tasks are expressed with dotted IDs (`task-1.1` under `task-1`) rather than a `parent_id` field — hierarchy is encoded in the identifier and the filename.
- **Acceptance criteria:** nested Markdown checklists (`- [ ] ac1`) inside the body.

**Relevance:** confirms that dependencies-as-an-ID-list and labels/assignee-as-lists are the mainstream model. But its file-per-task + YAML frontmatter shape is the *opposite* of our single-file constraint — YAML arrays across many files don't survive as one hand-editable list. The transferable idea is the **field vocabulary** (`status`, `assignee`, `labels`, `dependencies`) and the **dotted-ID hierarchy** convention, not the storage layout.

## Taskwarrior

[Taskwarrior's data model](https://taskwarrior.org/docs/task/) is a structured record per task (stored as JSON-ish lines), not Markdown, but its relationship semantics are the most rigorously specified.

- **Dependencies:** a `depends` attribute holding a comma-separated set of task UUIDs. Semantics: if task 2 `depends` on task 1, task 1 is the **blocking** task and must complete first; task 2 is **blocked**. Taskwarrior surfaces `+BLOCKED` / `+BLOCKING` virtual tags and de-prioritizes blocked tasks in urgency scoring.
- **Projects:** a single `project` string (supports dotted hierarchy like `Home.Garden`).
- **Tags:** a set of labels.
- **UDAs (User Defined Attributes):** the extensibility model — [any unrecognized key is stored, displayed, sorted, and filtered faithfully](https://taskwarrior.org/docs/udas/) even though Taskwarrior can't interpret it. UDAs can declare a type (string/date/duration/numeric), allowable values, and defaults.

**What to borrow:** the crisp **blocking vs. blocked** vocabulary (depends → the depended-on task blocks the depender), and the **UDA principle** — unknown fields must be preserved verbatim, never dropped. That principle maps directly onto our round-trip invariant: an unrecognized `key:value` on an issue line should survive serialization untouched.

## GitHub

- **Sub-issues** ([docs](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues)): true parent/child hierarchy, up to **8 levels deep** and **100 children per parent**. Parents show a **progress bar** of completed children. Crucially, closing all sub-issues does **not** auto-close the parent — containment is informational, and the human still closes the parent deliberately. There is no automatic cascade in either direction.
- **Task lists** ([docs](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/about-task-lists)): the familiar `- [ ]` / `- [x]` Markdown checkboxes. Progress is counted and shown on the issue. If a task line *references another issue*, closing that issue auto-checks the box — but checking all boxes never closes the parent. (GitHub has since **retired Tasklist blocks** in favor of sub-issues.)
- **Dependencies:** GitHub's newer issue "dependencies" (blocked-by / blocking) are advisory links; they warn but do not hard-gate closing.

**Behavioural takeaways:** GitHub deliberately keeps containment **non-cascading and non-auto-closing** — parents are closed by humans, children are just tracked. This is the safest default for a hand-edited file where a cascade could silently rewrite lines the author didn't touch.

## GitLab

[GitLab related/blocking issues](https://docs.gitlab.com/ee/user/project/issues/related_issues.html) offer three link types: **relates to**, **blocks**, and **is blocked by**.

- Blocking is **advisory, not enforced**: trying to close a blocked issue pops a **confirmation/warning**, but the user can still close it. Blocked issues show a blocker icon in lists/boards that clears once the blocker closes.
- The docs do **not** define transitive cascade (A blocks B, B blocks C ⇒ A blocks C is not asserted); each link is a direct pairwise relation.
- Ordering is not derived from dependencies; it's a separate manual/board concern.

**Behavioural takeaway:** like GitHub, GitLab treats blocking as a **soft gate** (warn, don't forbid) and keeps it **pairwise/non-transitive**. Two independent, mature trackers converging on "advisory, direct, non-cascading" is a strong signal for a plain-text tracker to do the same.

## Other greppable / single-file trackers

- **dstask** ([repo](https://github.com/naggie/dstask)) — Taskwarrior-like, terminal-based, one Markdown note page per task, Git-synced. Inherits Taskwarrior's `project` + `tags` + priority model; dependencies are lightweight.
- **git-bug** ([repo](https://github.com/git-bug/git-bug)) — distributed tracker storing bugs as objects *in Git* (not a browsable text file); labels/assignees are structured metadata, not inline text. Not hand-editable, so weak fit.
- **git-issues / issuer / trackdown** (from the [survey search](https://github.com/mgoellnitz/trackdown)) — "one Markdown file per issue with YAML frontmatter" is the dominant community pattern; the same frontmatter caveat as Backlog.md applies (great per-file, poor as one greppable list).
- **todo.md conventions** — informal; reuse GitHub's `- [ ]` checkbox + todo.txt-style inline tags. No standardized dependency syntax, which is exactly the gap this repo can fill with a small, explicit convention.

**Pattern across the field:** trackers split into two camps — (1) **structured frontmatter, one file per issue** (Backlog.md, git-issues, dstask) which gives rich fields but breaks single-file greppability, and (2) **one line per task with inline tags** (todo.txt) which is greppable and additive but historically has *no* dependency/hierarchy convention. The opportunity for `ISSUES.md` is to keep camp (2)'s inline greppability while borrowing camp (1)'s field vocabulary via inline `key:value` fields.

---

## Recommendations

### (a) Field / tag syntax for scalar + label metadata

Adopt todo.txt's **inline `key:value`** convention for scalars and its **sigil tags** for labels, placed on the issue line after the title (or on an indented note line). This is additive (metadata-free lines are untouched → round-trip holds), greppable, and reads at a glance.

```
- [ ] 007: Wire up the parser         blocked-by:004 part-of:002 type:bug status:in-progress @alice #parser #round-trip
```

Recommended vocabulary (all optional, all lowercase, single colon, no internal whitespace):

| Concern      | Syntax                    | Notes |
|--------------|---------------------------|-------|
| Blocked by   | `blocked-by:004` (repeatable, or `blocked-by:004,006`) | mirrors Taskwarrior `depends` + GitLab "is blocked by" |
| Part of      | `part-of:002`             | containment / parent pointer, one value |
| Assignee     | `@alice`                  | todo.txt `@context` sigil; unambiguous for people |
| Labels       | `#parser` `#round-trip`   | free-form tags; `#` reads as a label and avoids `+` collisions |
| Type         | `type:bug`                | enum-ish scalar |
| Status       | `status:in-progress`      | for states the `[ ]`/`[x]` checkbox can't express (deferred, blocked) |

Design rules that protect the invariant:
- **Fields are pointers by ID, not restructuring.** `blocked-by:004` references issue `004`; the line's `- [ ] id: title` grammar is unchanged.
- **Unknown keys are preserved verbatim** (the Taskwarrior UDA principle). The serializer must never drop a `key:value` it doesn't recognize.
- **Order-insensitive and idempotent.** Serialize fields in a fixed canonical order so re-serialization is stable, but parse them in any order so hand edits survive.
- Choose sigils that don't already appear in prose: `@` for people and `#` for labels are safest; avoid `+` if titles commonly contain it.

### (b) Expressing parent/child nesting in one Markdown file

Three options, with tradeoffs:

1. **Field-line (`part-of:002`)** — a scalar pointer on the child.
   - *Pros:* survives round-trip trivially; nesting is data, not layout, so reflowing/sorting the file never corrupts it; greppable (`grep part-of:002`); a child can move without moving lines.
   - *Cons:* hierarchy isn't visually obvious when reading top-to-bottom; deep trees need tooling to render.

2. **List-indentation** — nest children as indented `- [ ]` items under the parent (GitHub sub-issue feel).
   - *Pros:* immediately legible; matches the existing "indented note lines" grammar and Markdown intuition.
   - *Cons:* **hostile to round-trip** — indentation is now load-bearing structure, so any reflow, sort, or ID-based regeneration risks reparenting or flattening; ambiguous against existing indented *note* lines; a child can only have one location, so it can't be both nested and independently listed.

3. **Hybrid (recommended): field-line is the source of truth, indentation is optional presentation.** Store parentage as `part-of:002`; *allow but don't require* indenting a child under its parent for readability, and never let the serializer infer parentage from indentation.
   - *Pros:* keeps the data robust (option 1's round-trip safety) while permitting option 2's legibility where an author wants it; degrades gracefully — a flat file and an indented file carry identical meaning.
   - *Cons:* two representations can drift (indentation says one thing, `part-of` another); resolve by making `part-of` authoritative and treating indentation as a pure display hint.

Also worth stealing: Backlog.md's **dotted IDs** (`002.1` under `002`) as an *alternative* legible convention — but it bakes hierarchy into identity, so re-parenting means renumbering; prefer `part-of:` pointers for a hand-edited file.

### (c) Behavioural rules worth adopting for blocking + containment

Both GitHub and GitLab independently converge here, and a hand-edited file amplifies the reasons to stay conservative:

- **Blocking is advisory (soft gate), not enforced.** Warn when closing an issue that is `blocked-by:` something still open (GitLab's confirmation model), but never refuse. A text tracker must never block a human's edit.
- **Blocking is direct/pairwise, not transitive.** `blocked-by:` names direct blockers only; do not compute or materialize transitive chains into the file (matches GitLab). Tooling may *display* the transitive closure, but the stored data stays direct — otherwise the file churns whenever a distant dependency changes, breaking round-trip.
- **Containment does not auto-close and does not cascade** (GitHub's rule): closing every `part-of:002` child does **not** auto-close `002`, and closing `002` does not close its children. Show a progress indicator if you like, but leave the checkbox state to the human. Auto-mutation is the enemy of byte-for-byte round-trip.
- **A closed blocker unblocks passively.** "Blocked" is derived at read time from `blocked-by:` pointing at open issues — never a stored flag that must be flipped. This keeps state consistent with zero write-back and no cascade.
- **Ordering is not derived from dependencies.** Keep file order author-controlled (todo.txt's stance); at most, tooling offers a non-destructive sorted *view*.

The through-line: every relationship is an **optional inline pointer that is read, not written back**. Nothing in this design mutates lines the author didn't touch, so the load-bearing round-trip guarantee holds even as the relationship graph grows.

---

## Sources

- todo.txt format spec — https://github.com/todotxt/todo.txt
- Backlog.md (MrLesk/Backlog.md) — https://github.com/MrLesk/Backlog.md and README https://raw.githubusercontent.com/MrLesk/Backlog.md/main/README.md
- Taskwarrior task representation — https://taskwarrior.org/docs/task/
- Taskwarrior User Defined Attributes (UDAs) — https://taskwarrior.org/docs/udas/
- GitHub sub-issues — https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues
- GitHub task lists — https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/about-task-lists
- GitLab related & blocking issues — https://docs.gitlab.com/ee/user/project/issues/related_issues.html
- dstask — https://github.com/naggie/dstask
- git-bug — https://github.com/git-bug/git-bug
- trackdown (plain-Markdown ticketing) — https://github.com/mgoellnitz/trackdown
