/**
 * Issue tracker for the project's `ISSUES.md` log — pure library core.
 *
 * This module is filesystem-free: it parses, serializes, and runs commands over
 * the ISSUES.md text. The thin CLI shell that reads and writes the file lives in
 * `./bin.ts`.
 *
 * Commands (dispatched by `run`) — reads take `--json` (§6) and `-q`:
 *   list [section flags] [filters]   list issues (default: open), with ⊘/@/# markers
 *   next / ready [filters]           the takeable frontier (topmost / whole list)
 *   show <id> [--children]           full resolved dossier
 *   tree                             containment-only forest (blocking as a ⊘ annotation)
 *   doctor                           read-only linter (exit 1 on any error finding)
 *   add "<title>" [--note] [--part-of] [--blocked-by] [--status] [--assignee] [--label]
 *   block/unblock · assign/unassign · label/unlabel · set/unset   field mutations
 *   done <id> [--defer|--wontfix] · reopen · edit · note · help
 *
 * The file stays human-editable Markdown. Frontmatter and preamble prose are
 * preserved verbatim; section bodies are regenerated deterministically so an
 * untouched file round-trips byte-for-byte.
 */

// ── Configuration ──────────────────────────────────────────────────────────
// Section headings, in the order they are rendered. The first is the "open" bucket.
const SECTION_ORDER = ['Issues', 'Completed', 'Deferred', "Won't Fix"] as const;
type SectionName = (typeof SECTION_ORDER)[number];
const OPEN_SECTION: SectionName = 'Issues';
const DONE_SECTION: SectionName = 'Completed';
const DEFER_SECTION: SectionName = 'Deferred';
const WONTFIX_SECTION: SectionName = "Won't Fix";
// Sections whose items render as checked (`[x]`); the rest stay `[ ]`.
const CHECKED_SECTIONS = new Set<SectionName>([DONE_SECTION]);
// Indentation applied to an issue's note (detail) lines.
const DETAIL_INDENT = '      '; // 6 spaces, aligning under the title
// Default ID pattern when the file has no frontmatter. `#` runs are zero-padded.
// Numeric-only by default so the tool carries no project-specific prefix; a host
// repo picks its own (e.g. `M##`) via the `pattern` frontmatter key.
const DEFAULT_PATTERN = '###';

// ── File-format schema (ADR 0007) ────────────────────────────────────────────
// The ISSUES.md format is versioned by an optional `schema:` frontmatter key,
// written for the *first time* only when a breaking format change ships; until
// then no file carries it. Contract (ADR 0007): an absent key means the original
// (legacy) format — `SUPPORTED_SCHEMA` — and is **never rejected**. A `schema:`
// newer than this build understands is **advisory only** — it warns and proceeds,
// never rejects, because the file is always yours to hand-edit.
const SUPPORTED_SCHEMA = 1;

// ── Model ──────────────────────────────────────────────────────────────────
// An unrecognized `key:value` tail token — a User-Defined Attribute, preserved
// verbatim and asserted-about by nothing (§1.3).
export interface Uda {
	key: string;
	value: string;
}

export interface Issue {
	id: string; // canonical id, e.g. "007" (or "M007" under a prefixed pattern)
	num: number; // numeric portion, e.g. 7
	checked: boolean;
	title: string;
	date?: string; // ISO YYYY-MM-DD datestamp when closed/deferred
	partOf?: string; // `part-of:` single id pointer, verbatim (read-only; §1.2, §3.2)
	blockedBy: string[]; // `blocked-by:` id pointers, verbatim (read-only; §1.2)
	status?: string; // `status:` workflow scalar, freeform (§2.2)
	assignee?: string; // `@assignee` claim string, no sigil (§2.3)
	labels: string[]; // `#label` category sigils, no sigil (§2.4)
	uda: Uda[]; // unrecognized key:value tokens, in tail order (§1.3)
	detail: string[]; // note lines, stored without indentation
}

interface FrontmatterEntry {
	key: string;
	raw: string; // verbatim value text (used for keys other than next_id)
}

export interface Doc {
	frontmatter: FrontmatterEntry[];
	nextId: number;
	pattern: string;
	preamble: string; // text between frontmatter and the first section heading
	sections: Map<SectionName, Issue[]>;
}

/**
 * The issue-line shape a **given document** can contain: its own `pattern` prefix
 * (everything before the trailing `#`s, verbatim, case-insensitively) then digits — or
 * bare digits, so a `###` file that adopts a prefix still migrates on its next write.
 *
 * It is derived from `pattern` rather than fixed because the two ends have to agree:
 * `formatId` emits the prefix verbatim, so a fixed class narrower than `pattern` makes
 * the tool write lines it cannot read back, and `serialize` then drops them — silent
 * data loss (that was the `ISS-###` bug).
 *
 * Widening it to *any* prefix instead is worse than the bug. `parse` normalizes every
 * id it reads to the document's pattern, so a hand-written checklist item like
 * `- [ ] TODO-1: buy milk` in a `###` file would be absorbed, rewritten to `001`, and
 * collide with a real `001` — `done 001` would then hit the wrong issue, the
 * round-trip invariant would break on write, and `doctor` would report the file clean.
 * A prefix that does not match this document stays a malformed line and keeps its
 * `doctor` finding.
 */
function issueLineRe(pattern: string): RegExp {
	const prefix = pattern.replace(/#+$/, '');
	const esc = prefix.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
	const id = esc ? `(?:${esc})?[0-9]+` : '[0-9]+';
	return new RegExp(`^- \\[([ xX])\\] (${id}): (.*)$`, 'i');
}
const DATE_SUFFIX_RE = /^(.*?) \((\d{4}-\d{2}-\d{2})\)$/;
// The tail vocabulary (§1.2). Fields peel off the *end* of the issue line, one
// whitespace-delimited token at a time, until a token no longer looks like a
// field or sigil — everything left of that boundary is the free-text title,
// preserved verbatim (so a mid-line `see:here` or `@x` is never mistaken for
// metadata). Two lexical shapes, both from todo.txt:
const FIELD_RE = /^([A-Za-z][A-Za-z0-9_-]*):(\S+)$/; // key:value, no spaces
const ASSIGNEE_RE = /^@(\S+)$/; // @assignee (single; §2.3)
const LABEL_RE = /^#(\S+)$/; // #label (many; §2.4)
function isTailToken(tok: string): boolean {
	return FIELD_RE.test(tok) || ASSIGNEE_RE.test(tok) || LABEL_RE.test(tok);
}

// ── Parse ────────────────────────────────────────────────────────────────
export function parse(text: string): Doc {
	const lines = text.split('\n');
	let i = 0;

	// Frontmatter (optional, fenced by ---).
	const frontmatter: FrontmatterEntry[] = [];
	let nextId = 1;
	let pattern = DEFAULT_PATTERN;
	if (lines[0] === '---') {
		i = 1;
		while (i < lines.length && lines[i] !== '---') {
			const m = (lines[i] ?? '').match(/^([^:]+):\s*(.*)$/);
			if (m) {
				const key = (m[1] ?? '').trim();
				const raw = m[2] ?? '';
				frontmatter.push({ key, raw });
				if (key === 'next_id') nextId = Number(raw) || 1;
				if (key === 'pattern') pattern = raw.replace(/^["']|["']$/g, '');
			}
			i++;
		}
		i++; // skip closing ---
	}
	if (!frontmatter.length) {
		frontmatter.push({ key: 'next_id', raw: String(nextId) });
		frontmatter.push({ key: 'pattern', raw: `"${pattern}"` });
	}

	// Preamble: everything up to the first `## ` heading.
	let firstSection = lines.length;
	for (let j = i; j < lines.length; j++) {
		if (/^## /.test(lines[j] ?? '')) {
			firstSection = j;
			break;
		}
	}
	const preamble = trimBlankEdges(lines.slice(i, firstSection)).join('\n');

	// Sections. The id shape is fixed by the document's own `pattern`.
	const issueRe = issueLineRe(pattern);
	const sections = new Map<SectionName, Issue[]>();
	for (const name of SECTION_ORDER) sections.set(name, []);
	let current: Issue[] | null = null;
	let lastIssue: Issue | null = null;
	for (let j = firstSection; j < lines.length; j++) {
		const line = lines[j] ?? '';
		const head = line.match(/^## (.+?)\s*$/);
		if (head) {
			const name = head[1] as SectionName;
			if (!sections.has(name)) sections.set(name, []);
			current = sections.get(name)!;
			lastIssue = null;
			continue;
		}
		if (current === null || line.trim() === '') continue;
		const m = line.match(issueRe);
		if (m) {
			lastIssue = toIssue(m[1] !== ' ', m[2] ?? '', m[3] ?? '', pattern);
			current.push(lastIssue);
			continue;
		}
		// Indented continuation → note line for the preceding issue.
		if (/^\s+/.test(line) && lastIssue) lastIssue.detail.push(line.trimStart());
	}

	return { frontmatter, nextId, pattern, preamble, sections };
}

function toIssue(checked: boolean, id: string, rest: string, pattern: string): Issue {
	let title = rest;
	let date: string | undefined;
	const dm = rest.match(DATE_SUFFIX_RE);
	if (dm) {
		title = dm[1] ?? rest;
		date = dm[2];
	}
	// Peel the tail fields off (before the date suffix). Values are kept verbatim —
	// relationship ids are read-only pointers, normalized only at comparison.
	const { title: bareTitle, tokens } = peelTail(title);
	title = bareTitle;
	let partOf: string | undefined;
	let blockedBy: string[] = [];
	let status: string | undefined;
	let assignee: string | undefined;
	const labels: string[] = [];
	const uda: Uda[] = [];
	for (const tok of tokens) {
		const am = tok.match(ASSIGNEE_RE);
		if (am) {
			assignee = am[1];
			continue;
		}
		const lm = tok.match(LABEL_RE);
		if (lm) {
			labels.push(lm[1]!);
			continue;
		}
		const fm = tok.match(FIELD_RE)!; // isTailToken guaranteed one of the three shapes
		const key = fm[1]!;
		const value = fm[2]!;
		if (key === 'part-of') partOf = value;
		else if (key === 'blocked-by') blockedBy = value.split(',');
		else if (key === 'status') status = value;
		else uda.push({ key, value });
	}
	return {
		id: normalizeId(id, pattern),
		num: idNum(id),
		checked,
		title,
		date,
		partOf,
		blockedBy,
		status,
		assignee,
		labels,
		uda,
		detail: []
	};
}

// Peel recognized tail tokens off the *end* of `rest`, right to left, stopping at
// the first token that is not a field/sigil. Returns the remaining title (verbatim,
// never re-split — so multi-space titles and mid-line colons survive) and the
// peeled tokens in left-to-right order.
function peelTail(rest: string): { title: string; tokens: string[] } {
	let s = rest;
	const tokens: string[] = [];
	while (true) {
		const m = s.match(/^(.*\S)\s+(\S+)$/);
		if (!m || !isTailToken(m[2]!)) break;
		tokens.unshift(m[2]!);
		s = m[1]!;
	}
	return { title: s, tokens };
}

function trimBlankEdges(arr: string[]): string[] {
	let start = 0;
	let end = arr.length;
	while (start < end && (arr[start] ?? '').trim() === '') start++;
	while (end > start && (arr[end - 1] ?? '').trim() === '') end--;
	return arr.slice(start, end);
}

// ── Serialize ────────────────────────────────────────────────────────────
export function serialize(doc: Doc): string {
	const fm = doc.frontmatter
		.map((e) => `${e.key}: ${e.key === 'next_id' ? doc.nextId : e.raw}`)
		.join('\n');
	let out = `---\n${fm}\n---`;
	if (doc.preamble) out += `\n${doc.preamble}`;
	for (const name of SECTION_ORDER) {
		out += `\n\n${renderSection(name, doc.sections.get(name) ?? [])}`;
	}
	return out + '\n';
}

function renderSection(name: SectionName, issues: Issue[]): string {
	let s = `## ${name}`;
	// Blank-line-separated canonical form (§7.1 / ADR 0006): top-level entry-blocks
	// join with `\n\n`; renderIssue keeps each issue's detail tight under its parent,
	// so blanks fall only between entries — never before an indented detail line.
	if (issues.length) s += '\n\n' + issues.map(renderIssue).join('\n\n');
	return s;
}

function renderIssue(issue: Issue): string {
	const box = issue.checked ? 'x' : ' ';
	let line = `- [${box}] ${issue.id}: ${issue.title}`;
	// Tail fields re-emit after the title, before the date suffix, in canonical
	// order (§1.2 / the design example): part-of · blocked-by · UDAs · status ·
	// @assignee · #labels. Every field is empty/absent by default, so a
	// metadata-free line writes nothing after the title and stays byte-identical.
	if (issue.partOf) line += ` part-of:${issue.partOf}`;
	if (issue.blockedBy.length) line += ` blocked-by:${issue.blockedBy.join(',')}`;
	for (const u of issue.uda) line += ` ${u.key}:${u.value}`;
	if (issue.status) line += ` status:${issue.status}`;
	if (issue.assignee) line += ` @${issue.assignee}`;
	for (const l of issue.labels) line += ` #${l}`;
	if (issue.date) line += ` (${issue.date})`;
	const detail = issue.detail.map((d) => DETAIL_INDENT + d);
	return [line, ...detail].join('\n');
}

// ── ID helpers ──────────────────────────────────────────────────────────────
function idNum(input: string): number {
	const m = String(input).match(/(\d+)\s*$/);
	return m ? parseInt(m[1] ?? '', 10) : NaN;
}

export function formatId(num: number, pattern = DEFAULT_PATTERN): string {
	const hashes = pattern.match(/#+$/);
	const prefix = pattern.replace(/#+$/, '');
	const width = hashes ? hashes[0].length : 0;
	return prefix + String(num).padStart(width, '0');
}

export function normalizeId(input: string, pattern = DEFAULT_PATTERN): string {
	const num = idNum(input);
	if (Number.isNaN(num)) return String(input);
	return formatId(num, pattern);
}

export function findIssue(
	doc: Doc,
	idInput: string
): { section: SectionName; index: number; issue: Issue } | null {
	const canonical = normalizeId(idInput, doc.pattern);
	for (const name of SECTION_ORDER) {
		const issues = doc.sections.get(name) ?? [];
		const index = issues.findIndex((it) => it.id === canonical);
		const issue = issues[index];
		if (issue) return { section: name, index, issue };
	}
	return null;
}

function requireIssue(
	doc: Doc,
	idInput: string
): { section: SectionName; index: number; issue: Issue } {
	const found = findIssue(doc, idInput);
	if (!found) throw new Error(`Issue ${normalizeId(idInput, doc.pattern)} not found.`);
	return found;
}

function move(doc: Doc, from: { section: SectionName; index: number }, to: SectionName): Issue {
	const [issue] = doc.sections.get(from.section)!.splice(from.index, 1);
	if (!issue) throw new Error(`No issue at ${from.section}[${from.index}].`);
	doc.sections.get(to)!.push(issue);
	return issue;
}

export function today(): string {
	// Read live (not captured at import) so a test's `ISSUES_DATE` override,
	// set in a `beforeAll`, actually takes effect. A fixed "today"
	// (YYYY-MM-DD) makes datestamps deterministic.
	const override = process.env.ISSUES_DATE;
	if (override) return override;
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ── Commands (mutate doc in place, return a user-facing message) ─────────────
// Optional field flags for `add`, mapping 1:1 onto the mutation verbs (§5 decision
// 2). Set on the new issue directly; `serialize` re-emits them in canonical tail
// order, so `add --blocked-by X --label a,b` is byte-identical to the equivalent
// `add` + `block` + `label` verb sequence.
export interface AddFields {
	partOf?: string;
	blockedBy?: string[];
	status?: string;
	assignee?: string;
	labels?: string[];
}

export function cmdAdd(doc: Doc, title: string, note?: string, fields: AddFields = {}): string {
	const id = formatId(doc.nextId, doc.pattern);
	const detail = note ? note.split('\n').map((l) => l.trimStart()) : [];
	// A bare `add` writes no tail fields — no `status:`, no sigils — so a
	// metadata-free file stays byte-identical (§2.2, §8). Field flags (§5 decision 2)
	// are stored normalized (ids canonicalized) to match the verbs' write form.
	doc.sections.get(OPEN_SECTION)!.push({
		id,
		num: doc.nextId,
		checked: false,
		title,
		partOf: fields.partOf ? normalizeId(fields.partOf, doc.pattern) : undefined,
		blockedBy: (fields.blockedBy ?? [])
			.map((b) => normalizeId(b, doc.pattern))
			.filter((b) => b !== id),
		status: fields.status,
		assignee: fields.assignee,
		labels: fields.labels ?? [],
		uda: [],
		detail
	});
	doc.nextId += 1;
	return `Added ${id}: ${title}`;
}

export function cmdDone(doc: Doc, idInput: string, target: SectionName = DONE_SECTION): string {
	const found = requireIssue(doc, idInput);
	if (found.section === target) throw new Error(`${found.issue.id} is already in ${target}.`);
	const issue = move(doc, found, target);
	issue.checked = CHECKED_SECTIONS.has(target);
	issue.date = today();
	// Close voids `status:` only (§5 decision 15): the workflow scalar is an
	// open-only refinement (§2.2), so it clears on leaving the open section.
	// @assignee, blocked-by:, part-of:, #label persist — they are facts, not state.
	issue.status = undefined;
	return `${issue.id} → ${target} (${issue.date})`;
}

export function cmdReopen(doc: Doc, idInput: string): string {
	const found = requireIssue(doc, idInput);
	if (found.section === OPEN_SECTION) throw new Error(`${found.issue.id} is already open.`);
	const issue = move(doc, found, OPEN_SECTION);
	issue.checked = false;
	issue.date = undefined;
	return `${issue.id} reopened`;
}

export function cmdEdit(doc: Doc, idInput: string, title: string): string {
	const { issue } = requireIssue(doc, idInput);
	issue.title = title;
	return `${issue.id} title updated`;
}

export function cmdNote(doc: Doc, idInput: string, text: string): string {
	const { issue } = requireIssue(doc, idInput);
	for (const l of text.split('\n')) issue.detail.push(l.trimStart());
	return `${issue.id} note added`;
}

// ── Mutation verbs (§5.1 — the hybrid model) ─────────────────────────────────
// Relational/many-valued fields get ergonomic verbs with a natural inverse
// (validation + idempotent removal); flat scalars + UDAs go through `set`/`unset`.
// Ids are stored normalized (canonical) on write, matching `add`'s field flags.

/**
 * `block <id> --by <blocker>` — add one blocker (§5 decision 3). Self-reference is
 * the one hard **reject**; unknown-blocker / cycle are warn-but-write (surfaced by
 * the caller via `graphWarnings`). Re-blocking an existing edge is an idempotent no-op.
 */
export function cmdBlock(doc: Doc, idInput: string, byInput: string): string {
	const { issue } = requireIssue(doc, idInput);
	const by = normalizeId(byInput, doc.pattern);
	if (by === issue.id) throw new Error(`${issue.id}: cannot block on itself.`);
	const cur = issue.blockedBy.map((b) => normalizeId(b, doc.pattern));
	if (cur.includes(by)) return `${issue.id} already blocked-by ${by}`;
	issue.blockedBy = [...cur, by];
	return `${issue.id} blocked-by ${by}`;
}

/**
 * `unblock <id> [--by <blocker>]` — remove one blocker, or (no `--by`) clear all
 * (§5 decision 3). Removing an absent edge is an idempotent no-op + message (§5.3).
 */
export function cmdUnblock(doc: Doc, idInput: string, byInput?: string): string {
	const { issue } = requireIssue(doc, idInput);
	if (byInput === undefined) {
		if (!issue.blockedBy.length) return `${issue.id} has no blockers`;
		issue.blockedBy = [];
		return `${issue.id} unblocked (all)`;
	}
	const by = normalizeId(byInput, doc.pattern);
	const cur = issue.blockedBy.map((b) => normalizeId(b, doc.pattern));
	if (!cur.includes(by)) return `${issue.id} was not blocked-by ${by}`;
	issue.blockedBy = cur.filter((b) => b !== by);
	return `${issue.id} no longer blocked-by ${by}`;
}

/** `assign <id> <who>` — the claim is an explicit string; no identity magic (§5 decision 4). */
export function cmdAssign(doc: Doc, idInput: string, who: string): string {
	const { issue } = requireIssue(doc, idInput);
	issue.assignee = who;
	return `${issue.id} assigned to @${who}`;
}

/** `unassign <id>` — clear the claim; absent is an idempotent no-op (§5.3). */
export function cmdUnassign(doc: Doc, idInput: string): string {
	const { issue } = requireIssue(doc, idInput);
	if (!issue.assignee) return `${issue.id} was not assigned`;
	const who = issue.assignee;
	issue.assignee = undefined;
	return `${issue.id} unassigned (@${who})`;
}

/** `label <id> <name[,name]>` — additive, deduped (§5 decision 5). */
export function cmdLabel(doc: Doc, idInput: string, names: string[]): string {
	const { issue } = requireIssue(doc, idInput);
	const added: string[] = [];
	for (const n of names) if (n && !issue.labels.includes(n)) added.push(n);
	issue.labels.push(...added);
	if (!added.length) return `${issue.id}: no new labels`;
	return `${issue.id} labelled ${added.map((l) => '#' + l).join(' ')}`;
}

/** `unlabel <id> <name[,name]>` — targeted removal; absent names no-op (§5.3). */
export function cmdUnlabel(doc: Doc, idInput: string, names: string[]): string {
	const { issue } = requireIssue(doc, idInput);
	const removed: string[] = [];
	for (const n of names) {
		const i = issue.labels.indexOf(n);
		if (i !== -1) {
			issue.labels.splice(i, 1);
			removed.push(n);
		}
	}
	if (!removed.length) return `${issue.id}: no matching labels`;
	return `${issue.id} unlabelled ${removed.map((l) => '#' + l).join(' ')}`;
}

/**
 * `set <id> <key>:<value>` — replace a flat scalar (`status`) or any UDA (§5 decision
 * 6). Recognized relational keys route to their fields (a generic escape hatch); an
 * unknown key upserts a verbatim UDA. Returns any write-time advisories: `set status:`
 * on a closed issue, or a value outside a declared `statuses:` set — both warn-but-write
 * (§5 decisions 7, 15 / §5.3).
 */
export function cmdSet(
	doc: Doc,
	idInput: string,
	key: string,
	value: string
): { message: string; warnings: string[] } {
	const { section, issue } = requireIssue(doc, idInput);
	const warnings: string[] = [];
	switch (key) {
		case 'status': {
			issue.status = value;
			if (section !== OPEN_SECTION)
				warnings.push(`${issue.id}: status set on a closed issue — open-only per §2.2`);
			const declared = declaredStatuses(doc);
			if (declared && !declared.has(value))
				warnings.push(`${issue.id}: status:${value} is not in the declared statuses`);
			break;
		}
		case 'part-of':
			issue.partOf = normalizeId(value, doc.pattern);
			break;
		case 'assignee':
			issue.assignee = value;
			break;
		case 'blocked-by':
			issue.blockedBy = value
				.split(',')
				.map((v) => normalizeId(v.trim(), doc.pattern))
				.filter((b) => b && b !== issue.id);
			break;
		case 'label':
			issue.labels = value
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
			break;
		default: {
			const existing = issue.uda.find((u) => u.key === key);
			if (existing) existing.value = value;
			else issue.uda.push({ key, value });
		}
	}
	return { message: `${issue.id} set ${key}:${value}`, warnings };
}

/** `unset <id> <key>` — remove a scalar/UDA; absent is an idempotent no-op (§5.3). */
export function cmdUnset(doc: Doc, idInput: string, key: string): string {
	const { issue } = requireIssue(doc, idInput);
	const noop = `${issue.id}: ${key} was not set`;
	switch (key) {
		case 'status':
			if (!issue.status) return noop;
			issue.status = undefined;
			break;
		case 'part-of':
			if (!issue.partOf) return noop;
			issue.partOf = undefined;
			break;
		case 'assignee':
			if (!issue.assignee) return noop;
			issue.assignee = undefined;
			break;
		case 'blocked-by':
			if (!issue.blockedBy.length) return noop;
			issue.blockedBy = [];
			break;
		case 'label':
			if (!issue.labels.length) return noop;
			issue.labels = [];
			break;
		default: {
			const i = issue.uda.findIndex((u) => u.key === key);
			if (i === -1) return noop;
			issue.uda.splice(i, 1);
		}
	}
	return `${issue.id} unset ${key}`;
}

// The project-declared workflow vocabulary, if the frontmatter carries a `statuses:`
// key (§5 decision 7). Values are comma/whitespace separated; absent → no validation.
function declaredStatuses(doc: Doc): Set<string> | null {
	const entry = doc.frontmatter.find((e) => e.key === 'statuses');
	if (!entry) return null;
	const raw = entry.raw.replace(/^["']|["']$/g, '');
	const vals = raw
		.split(/[,\s]+/)
		.map((s) => s.trim())
		.filter(Boolean);
	return vals.length ? new Set(vals) : null;
}

// ── Terminal rendering primitives (design §1, §2, §6) ────────────────────────
// The presentation surface the human-readable reads render through. The core never
// sees the tri-state: `bin.ts` resolves `--plain` / `--color` / `--no-color`,
// `NO_COLOR` and TTY-ness down to these two booleans (§6.1) — four combinations,
// no environment, trivially testable.
export interface RenderOptions {
	color: boolean;
	plain: boolean;
}

// The default every entry point falls back to: no colour, no plain rendering — what
// a library consumer calling `cmdList(doc)` directly gets, and what the pre-flag
// behaviour was.
export const DEFAULT_RENDER: RenderOptions = { color: false, plain: false };

/**
 * The six-state vocabulary (§1). Precedence is **closed > blocked > claimed > open**:
 * the gutter has one slot, and the highest applicable state takes it.
 */
export type IssueState = 'open' | 'claimed' | 'blocked' | 'completed' | 'deferred' | 'wontfix';

const CLOSED_STATES: Partial<Record<SectionName, IssueState>> = {
	[DONE_SECTION]: 'completed',
	[DEFER_SECTION]: 'deferred',
	[WONTFIX_SECTION]: 'wontfix'
};

/**
 * Collapse an issue to the one state its gutter shows (§1). Pass `section` when the
 * caller already knows it; otherwise it is looked up.
 *
 * The precedence is **semantic, not merely compression** — closed *subsumes* the
 * derived axis. `isBlocked` does not consult the issue's own section, so a Completed
 * issue with a reopened blocker still has `blocked === true`; but a finished issue is
 * not *blocked*, and its assignee is provenance, not a claim. Do not "fix" that by
 * surfacing the derived axis on closed issues — `show`'s `state:` field suppression
 * (§4.2) depends on it reading exactly this way.
 */
export function issueState(doc: Doc, issue: Issue, section?: SectionName): IssueState {
	const closed = CLOSED_STATES[sectionOf(doc, issue, section)];
	if (closed) return closed;
	if (isBlocked(doc, issue)) return 'blocked';
	if (issue.assignee) return 'claimed';
	return 'open';
}

// The section an issue lives in: the caller's answer when it already has one (every
// read but `tree` does), otherwise a lookup. An issue that is somehow not in the file
// reads as open — the same fail-open posture the graph derivations take (§3.4).
function sectionOf(doc: Doc, issue: Issue, known?: SectionName): SectionName {
	return known ?? findIssue(doc, issue.id)?.section ?? OPEN_SECTION;
}

/** The gutter glyph and its colour, per state (§1). `null` = uncoloured. */
export const STATE_GLYPHS: Record<IssueState, { glyph: string; color: AnsiStyle | null }> = {
	open: { glyph: '-', color: null },
	claimed: { glyph: '~', color: 'yellow' },
	blocked: { glyph: '⊘', color: 'red' },
	completed: { glyph: '✓', color: 'green' },
	deferred: { glyph: '»', color: 'dim' },
	wontfix: { glyph: '×', color: 'dim' }
};

// Hand-written SGR codes — **8/16-colour only** (§0). No 256-colour, no truecolor,
// no bright-white/bright-black, so output holds on both light and dark backgrounds.
// Zero runtime dependencies: no `chalk`, no `supports-color`.
const SGR: Record<AnsiStyle, number> = {
	dim: 2,
	red: 31,
	green: 32,
	yellow: 33,
	blue: 34,
	magenta: 35,
	cyan: 36
};
const RESET = '\x1b[0m';

export type AnsiStyle = 'dim' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan';

/**
 * Wrap `text` in an SGR pair — or return it untouched when `color` is false, so the
 * colour gate is one boolean at every call site rather than a branch per line. A
 * `null` style is also a no-op (open's gutter has no colour), so a table entry can
 * be passed straight through.
 *
 * The terminator is a full reset, so styles do not nest: paint the innermost span,
 * not an outer one that a nested reset would cut short.
 */
export function paint(text: string, style: AnsiStyle | AnsiStyle[] | null, color: boolean): string {
	if (!color || style === null) return text;
	const codes = (Array.isArray(style) ? style : [style]).map((s) => SGR[s]);
	return `\x1b[${codes.join(';')}m${text}${RESET}`;
}

export interface ShowOptions {
	children?: boolean;
	quiet?: boolean; // -q: drop this issue's §3 advisories from the dossier (decision 8)
}

// The §3 advisories that name a given issue — the write-time / dossier subset of
// `graphWarnings` (decision 8). The id is normalized so a raw or padded input matches.
function warningsFor(doc: Doc, idInput: string): string[] {
	const id = normalizeId(idInput, doc.pattern);
	return graphWarnings(doc).filter((w) => w.includes(id));
}

/**
 * `show <id>` — the full resolved dossier (§5 decision 17 / §4): status/assignee/labels,
 * relationships expanded with their target's title and section, the note body, this
 * issue's §3 warnings, and (with `--children`) its containment subtree. Its own render
 * path — terminal output is never double-spaced.
 *
 * `show` does **not** import the gutter: a gutter is a column device and a subject line
 * has no column to form. What carries across is the row *shape* — the dossier reads as
 * a row, opened up.
 *
 * The header is one line, `id  title (date)` (§4.1). The old two-line split existed
 * only to give the section suffix somewhere to sit; with state a field the split is
 * vestigial, so the header sheds both `— Section` and `⊘ blocked`. The date stays
 * inline — `serializeIssue` stores it inline, and a `date:` field would fabricate a key
 * the file format does not have.
 *
 * The title is never state-coloured (§4.3): a title can only be one colour, which would
 * reintroduce the precedence collapse `state:` exists to escape. It dims when closed —
 * de-emphasis, not a state claim competing with the field.
 */
export function cmdShow(
	doc: Doc,
	idInput: string,
	opts: ShowOptions = {},
	render: RenderOptions = DEFAULT_RENDER
): string {
	const { section, issue } = requireIssue(doc, idInput);
	const color = render.color && !render.plain;
	const date = issue.date ? ` (${issue.date})` : '';
	const title = section === OPEN_SECTION ? issue.title : paint(issue.title, 'dim', color);
	const lines = [`${paint(issue.id, 'cyan', color)}  ${title}${date}`];
	lines.push(`  state: ${stateField(doc, issue, section, color)}`);
	if (issue.status) lines.push(`  status: ${paint(issue.status, 'yellow', color)}`);
	if (issue.assignee) lines.push(`  assignee: ${paint('@' + issue.assignee, 'magenta', color)}`);
	if (issue.labels.length)
		lines.push(`  labels: ${issue.labels.map((l) => paint('#' + l, 'blue', color)).join(' ')}`);
	if (issue.partOf) lines.push(`  part-of: ${resolveRef(doc, issue.partOf, undefined, color)}`);
	for (const b of issue.blockedBy)
		lines.push(`  blocked-by: ${resolveRef(doc, b, issue.id, color)}`);
	for (const u of issue.uda) lines.push(`  ${u.key}: ${u.value}`);
	for (const d of issue.detail) lines.push(`    ${d}`);
	if (opts.children) {
		const kids = childrenOf(doc, issue.id);
		if (kids.length) {
			lines.push('  children:');
			// No view — `show` renders every child unconditionally, so scaffolding has
			// no analogue here (§4.4). Stated because it is an absence.
			for (const k of kids) lines.push(...treeLines(doc, k, 1, render, undefined));
		}
	}
	if (!opts.quiet) for (const w of warningsFor(doc, issue.id)) lines.push(`  ! ${w}`);
	return lines.join('\n');
}

/**
 * The section axis in one capitalized vocabulary (§4.4). `Issues` is spoken as `Open`
 * wherever state is named — `state: Issues` does not parse as English, and the glyph
 * vocabulary has said "open" throughout — while the three closed sections keep their
 * stored names verbatim.
 *
 * Capitalized = stored, lowercase = derived (§5.2 / ADR 0003). `Open` is the one
 * capitalized token not verbatim from the file: the casing rule is about *which axis*
 * a token belongs to, not about being a literal quote.
 */
function sectionLabel(section: SectionName): string {
	return section === OPEN_SECTION ? 'Open' : section;
}

/**
 * The `state:` field (§4.2) — one field naming **every** state that applies, which is
 * the case the single-slot gutter structurally could not serve. Derived terms follow
 * gutter precedence (`blocked` before `claimed`) and are **suppressed once the section
 * is closed** (§1): a finished issue is not blocked, and its assignee is provenance,
 * not a claim. So genuine co-occurrence is only ever `Open` + `blocked` + `claimed`.
 *
 * Nothing is lost by the suppression — a stale blocker stays fully visible on its
 * `blocked-by:` line with an `— Open` suffix, and the assignee is still rendered.
 *
 * This field is the dossier's structural equivalent of the gutter: the one designated
 * place state is spoken, and so the only place state colour appears (§4.3). The tokens
 * take their gutter colours, which is why they read off `STATE_GLYPHS`.
 */
function stateField(doc: Doc, issue: Issue, section: SectionName, color: boolean): string {
	const token = (label: string, state: IssueState) =>
		paint(label, STATE_GLYPHS[state].color, color);
	// Closed is one token: the section subsumes the derived axis.
	if (section !== OPEN_SECTION)
		return token(sectionLabel(section), issueState(doc, issue, section));
	// Open is a list, in gutter-precedence order.
	const tokens = [token(sectionLabel(section), 'open')];
	if (isBlocked(doc, issue)) tokens.push(token('blocked', 'blocked'));
	if (issue.assignee) tokens.push(token('claimed', 'claimed'));
	return tokens.join(', ');
}

// Resolve a relationship pointer to a human-legible `id (title) — Section` string, or
// `id (not found)` when it dangles (§3.1/§3.2). `selfId` flags a self-reference edge.
// The id is element-typed cyan (§4.3); the suffix stays default — state colour lives
// in `state:` and nowhere else.
function resolveRef(doc: Doc, rawId: string, selfId: string | undefined, color: boolean): string {
	const id = normalizeId(rawId, doc.pattern);
	const shown = paint(id, 'cyan', color);
	if (selfId && id === selfId) return `${shown} (self-reference — ignored)`;
	const found = findIssue(doc, id);
	if (!found) return `${shown} (not found)`;
	return `${shown} (${found.issue.title}) — ${sectionLabel(found.section)}`;
}

export interface ListOptions {
	all?: boolean;
	closed?: boolean;
	deferred?: boolean;
	wontfix?: boolean;
}

// The compact info-dense markers that ride an issue on the triage surface (§5
// decision 17): `status:`, `@assignee`, `#labels`. A metadata-free issue adds none.
// Element-typed, per §2: the same field is the same colour on every row, so the eye
// learns fixed columns. The `status:` key stays default — only its value is yellow.
function markers(issue: Issue, color: boolean): string {
	let s = '';
	if (issue.status) s += ` status:${paint(issue.status, 'yellow', color)}`;
	if (issue.assignee) s += ` ${paint('@' + issue.assignee, 'magenta', color)}`;
	for (const l of issue.labels) s += ` ${paint('#' + l, 'blue', color)}`;
	return s;
}

// What a given read puts on a row besides the gutter, id and title. Each command
// keeps its own answer (`ready` stays sparse, `tree` carries no datestamp); the
// gutter, the element colours and the `--plain` tags are what they now share.
interface RowFields {
	indent: string;
	section?: SectionName; // known by the caller on most paths; looked up otherwise
	markers?: boolean;
	date?: boolean;
	note?: boolean; // the ` …` "has a note" ellipsis
	// Not a field but a role: this row is a non-matching ancestor kept as the path to
	// a match (§3.2), which changes how the whole row renders rather than what it shows.
	scaffold?: boolean;
}

/**
 * The one compact-row renderer behind `list`, `next`, `ready`, `tree` and
 * `show --children` (§1.1). Two renderings, chosen by `--plain`:
 *
 *   glyph mode   `indent + glyph + id + title + markers` — the gutter is the state
 *                channel (glyph *and* colour, §1); everything right of it is
 *                element-typed (§2). The section tags are gone: the gutter carries
 *                the section now.
 *   `--plain`    `indent + id + title + markers + [tags]` (§5.1) — no colour, no
 *                gutter, state as postfix tags at the *end* so the leading columns
 *                stay parseable and `list` and `tree` agree.
 *
 * `--plain` is the strongest presentation flag (§5.4.1), so it forces colour off
 * here rather than trusting the caller to have resolved it that way.
 */
function compactRow(doc: Doc, issue: Issue, fields: RowFields, render: RenderOptions): string {
	// Is the colour channel open at all? `--plain` is the strongest presentation flag
	// (§5.4.1), so it closes the channel here rather than trusting the caller.
	const ansi = render.color && !render.plain;
	// A scaffolding row recedes on contrast alone (§3.2), so nothing inside it is
	// element-coloured — the row dims as a single span instead.
	const elementColor = ansi && !fields.scaffold;
	const section = sectionOf(doc, issue, fields.section);
	const tail =
		(fields.markers ? markers(issue, elementColor) : '') +
		(fields.date && issue.date ? ` (${issue.date})` : '') +
		(fields.note && issue.detail.length ? ' …' : '');
	// §3.2 gives scaffolding a structural marker under `--plain` because the colour
	// channel is unavailable there. The same is true of `--no-color` and of a piped
	// stdout — where a dimmed row is byte-identical to a matching one — so the marker
	// follows the *channel*, not the flag. Anything else lets the filter go invisible,
	// which is the one outcome §3.2 rules out.
	const scaffoldMark = fields.scaffold && !ansi ? ' /' : '';
	if (render.plain) {
		const tags = plainTags(doc, issue, section);
		return `${fields.indent}${issue.id}  ${issue.title}${tail}${tags}${scaffoldMark}`;
	}
	const { glyph, color: gutter } = STATE_GLYPHS[issueState(doc, issue, section)];
	if (fields.scaffold) {
		// Glyph, id, title and markers all intact — the whole row just recedes (§3.2).
		const row = `${glyph} ${issue.id}  ${issue.title}${tail}${scaffoldMark}`;
		return fields.indent + paint(row, 'dim', ansi);
	}
	// The title dims when the issue is closed (§2) — de-emphasis, never a state claim.
	const title = section === OPEN_SECTION ? issue.title : paint(issue.title, 'dim', elementColor);
	const id = paint(issue.id, 'cyan', elementColor);
	return `${fields.indent}${paint(glyph, gutter, elementColor)} ${id}  ${title}${tail}`;
}

/**
 * The `--plain` postfix state tags (§5.2). **Capitalized = stored** (the physical
 * section), **lowercase = derived** (`blocked`, computed from `blocked-by:` at read
 * time) — this mirrors ADR 0003 in the rendering itself and is load-bearing, so do
 * not normalize the casing.
 *
 * A closed *and* blocked row shows **both** tags: `--plain` has room the single-slot
 * gutter does not, so §1's precedence does not apply here. Claimed needs no tag —
 * `@who` already carries it.
 */
function plainTags(doc: Doc, issue: Issue, section: SectionName): string {
	let s = '';
	if (section !== OPEN_SECTION) s += ` [${section}]`;
	if (isBlocked(doc, issue)) s += ' [blocked]';
	return s;
}

// Does an issue pass the §4.4 status/label/parent filters? (AND across dimensions,
// OR within a repeated one.) The block/claim gates are the frontier's job, not this —
// shared by `frontier` and `list` so the vocabulary is one thing (§5 decision 18).
function passesFilters(doc: Doc, it: Issue, filters: FrontierFilters): boolean {
	if (filters.status?.length && (!it.status || !filters.status.includes(it.status))) return false;
	if (filters.label?.length && !it.labels.some((l) => filters.label!.includes(l))) return false;
	if (filters.parent?.length) {
		const p = it.partOf ? normalizeId(it.partOf, doc.pattern) : undefined;
		const want = filters.parent.map((x) => normalizeId(x, doc.pattern));
		if (!p || !want.includes(p)) return false;
	}
	return true;
}

// On `list`, `--assignee` is a plain filter (open-work-owned-by narrowing is the
// frontier's relaxer, §4.4); here it just matches the claim string.
function listFilter(doc: Doc, it: Issue, filters: FrontierFilters): boolean {
	if (!passesFilters(doc, it, filters)) return false;
	if (filters.assignee?.length && (!it.assignee || !filters.assignee.includes(it.assignee)))
		return false;
	return true;
}

// Which sections `list` shows for a given flag set: `--all` → every section;
// `--closed`/`--deferred`/`--wontfix` → the named closed buckets; default → open.
function listSections(opts: ListOptions): SectionName[] {
	if (opts.all) return [...SECTION_ORDER];
	const set = new Set<SectionName>();
	if (opts.closed) [DONE_SECTION, DEFER_SECTION, WONTFIX_SECTION].forEach((s) => set.add(s));
	if (opts.deferred) set.add(DEFER_SECTION);
	if (opts.wontfix) set.add(WONTFIX_SECTION);
	return set.size ? SECTION_ORDER.filter((n) => set.has(n)) : [OPEN_SECTION];
}

export function cmdList(
	doc: Doc,
	opts: ListOptions = {},
	filters: FrontierFilters = {},
	render: RenderOptions = DEFAULT_RENDER
): string {
	const names = listSections(opts);
	const blocks: string[] = [];
	for (const name of names) {
		const issues = (doc.sections.get(name) ?? []).filter((it) => listFilter(doc, it, filters));
		if (!issues.length) continue;
		const header = names.length > 1 ? `${name}:` : '';
		const rows = issues.map((it) =>
			compactRow(
				doc,
				it,
				{ indent: '  ', section: name, markers: true, date: true, note: true },
				render
			)
		);
		blocks.push((header ? header + '\n' : '') + rows.join('\n'));
	}
	if (!blocks.length) return 'No issues.';
	return blocks.join('\n\n');
}

// ── Graph derivation (read-time, nothing stored) ─────────────────────────────
// The set of ids currently sitting in the open `Issues` section. A blocker
// counts as "resolved" the moment it leaves this set — any closed section
// (Completed/Deferred/Won't Fix) satisfies the gate (§3.1).
function openIdSet(doc: Doc): Set<string> {
	return idSet(doc, OPEN_SECTION);
}

// The canonical ids currently in one section.
function idSet(doc: Doc, section: SectionName): Set<string> {
	const ids = new Set<string>();
	for (const it of doc.sections.get(section) ?? []) ids.add(it.id);
	return ids;
}

// Every id in the file, across all sections — the "known universe" against which a
// pointer is dangling (§3.1/§3.2).
function allIdSet(doc: Doc): Set<string> {
	const ids = new Set<string>();
	for (const name of SECTION_ORDER) for (const it of doc.sections.get(name) ?? []) ids.add(it.id);
	return ids;
}

// An issue's effective blocker ids: normalized to canonical form, with the
// self-reference edge dropped (§3.1). The one place the blocked-by tail becomes a
// list of ids that actually gate — shared by every derivation that walks the edge.
function blockerIds(doc: Doc, issue: Issue): string[] {
	return issue.blockedBy
		.map((b) => normalizeId(b, doc.pattern))
		.filter((b) => b !== issue.id);
}

/**
 * Is `issue` blocked? True iff any of its `blocked-by:` ids still sits in the
 * open `Issues` section — direct-only, non-transitive (§3.1). A dangling id
 * (found nowhere) is not open, so it fails open and does not block. Purely
 * derived; nothing is written back.
 */
export function isBlocked(doc: Doc, issue: Issue): boolean {
	if (!issue.blockedBy.length) return false;
	const open = openIdSet(doc);
	return blockerIds(doc, issue).some((b) => open.has(b));
}

/**
 * The §3 advisory warnings, derived read-time as the graph is walked over the open
 * `Issues` section. Every anomaly fails open (§3.4 / §4.6) — these change nothing
 * about frontier membership, they only inform. Five kinds:
 *   · self-reference     — `A blocked-by A`: edge ignored (§3.1)
 *   · dangling blocker   — id found nowhere: fails open (§3.1)
 *   · won't-fix blocker  — gate satisfied by a rejected issue (§3.1, advisory)
 *   · dangling part-of   — parent found nowhere: child renders top-level (§3.2)
 *   · cycle              — mutual deadlock: members stay blocked, never broken (§3.1)
 * Exported for focused unit tests and reused by the read commands.
 */
export function graphWarnings(doc: Doc): string[] {
	const warnings: string[] = [];
	const all = allIdSet(doc);
	const wontfix = idSet(doc, WONTFIX_SECTION);
	for (const it of doc.sections.get(OPEN_SECTION) ?? []) {
		for (const raw of it.blockedBy) {
			const b = normalizeId(raw, doc.pattern);
			if (b === it.id) {
				warnings.push(`${it.id}: blocked-by ${b} is a self-reference — edge ignored`);
			} else if (!all.has(b)) {
				warnings.push(`${it.id}: blocked-by ${b} not found — fails open (does not block)`);
			} else if (wontfix.has(b)) {
				warnings.push(`${it.id}: blocker ${b} is won't-fix — gate satisfied by a rejected issue`);
			}
		}
		if (it.partOf) {
			const p = normalizeId(it.partOf, doc.pattern);
			if (!all.has(p)) {
				warnings.push(`${it.id}: part-of ${p} not found — rendered top-level`);
			}
		}
	}
	for (const cycle of detectCycles(doc)) {
		warnings.push(`blocked-by cycle: ${cycle.join(' → ')} → ${cycle[0]} — members stay blocked`);
	}
	return warnings;
}

/**
 * The ADR 0007 file-format compat advisory. A file may carry an optional `schema:`
 * frontmatter key naming its format version. This build understands
 * `SUPPORTED_SCHEMA`; anything newer (or non-numeric) is surfaced as an advisory
 * and **never blocks** the read or write — the file is always yours to hand-edit.
 * An absent key is the original/legacy format: silent, never rejected. Dormant
 * until a breaking format change first writes the key.
 */
export function compatWarnings(doc: Doc): string[] {
	const entry = doc.frontmatter.find((e) => e.key === 'schema');
	if (!entry) return []; // absent ⇒ legacy format ⇒ silent, never rejected
	const raw = entry.raw.trim().replace(/^["']|["']$/g, '');
	const n = Number(raw);
	if (raw === '' || !Number.isFinite(n)) {
		return [`schema:${raw} is not a recognized format version — proceeding, the file may not round-trip cleanly`];
	}
	if (n > SUPPORTED_SCHEMA) {
		return [
			`file declares schema ${n}; this build understands schema ${SUPPORTED_SCHEMA} — proceeding, it may not round-trip cleanly (upgrade \`issues\`)`
		];
	}
	return []; // recognized (≤ supported) ⇒ silent
}

// Cycle detection (§3.1) over the open-section `blocked-by` graph — only edges to
// still-open issues matter (a closed blocker satisfies the gate and cannot be part
// of a live deadlock). Self-edges are skipped (reported separately). Classic
// three-colour DFS; each distinct cycle is reported once, rotated to start at its
// smallest id so the same loop found from different entry points de-dupes.
function detectCycles(doc: Doc): string[][] {
	const openIds = openIdSet(doc);
	const adj = new Map<string, string[]>();
	for (const it of doc.sections.get(OPEN_SECTION) ?? []) {
		adj.set(it.id, blockerIds(doc, it).filter((b) => openIds.has(b)));
	}
	const WHITE = 0;
	const GRAY = 1;
	const BLACK = 2;
	const color = new Map<string, number>();
	for (const id of adj.keys()) color.set(id, WHITE);
	const stack: string[] = [];
	const cycles: string[][] = [];
	const seen = new Set<string>();
	const visit = (u: string): void => {
		color.set(u, GRAY);
		stack.push(u);
		for (const v of adj.get(u) ?? []) {
			if (color.get(v) === GRAY) {
				const cycle = rotateToMin(stack.slice(stack.indexOf(v)));
				const key = cycle.join(',');
				if (!seen.has(key)) {
					seen.add(key);
					cycles.push(cycle);
				}
			} else if (color.get(v) === WHITE) {
				visit(v);
			}
		}
		stack.pop();
		color.set(u, BLACK);
	};
	for (const id of adj.keys()) if (color.get(id) === WHITE) visit(id);
	return cycles;
}

// Rotate a cycle's id list so its lexicographically-smallest id leads, giving one
// canonical representation regardless of where the DFS entered the loop.
function rotateToMin(cycle: string[]): string[] {
	let min = 0;
	for (let i = 1; i < cycle.length; i++) if ((cycle[i] ?? '') < (cycle[min] ?? '')) min = i;
	return [...cycle.slice(min), ...cycle.slice(0, min)];
}

// The frontier filters (§4.4). Every dimension is optional; a repeated dimension
// arrives as a multi-element array (OR within), distinct dimensions AND across.
export interface FrontierFilters {
	status?: string[];
	label?: string[];
	parent?: string[];
	assignee?: string[];
	limit?: number;
}

/**
 * The takeable frontier (§4.1): open issues whose every blocker is closed and which
 * are **unclaimed**, in document order — then narrowed by the §4.4 filters. The
 * block gate is always on (§4.4); `status:` never gates (§4.3), it is only a filter.
 * `--assignee <who>` relaxes the unclaimed gate and instead requires `assignee == who`.
 * Pure; nothing stored.
 */
export function frontier(doc: Doc, filters: FrontierFilters = {}): Issue[] {
	const wantAssignee = filters.assignee && filters.assignee.length ? filters.assignee : undefined;

	let items = (doc.sections.get(OPEN_SECTION) ?? []).filter((it) => {
		if (isBlocked(doc, it)) return false; // block gate always on (§4.4)
		// Claim gate (§4.1), relaxed by --assignee (§4.4): with the flag, keep only
		// issues owned by one of the named claimants; without it, keep only unclaimed.
		if (wantAssignee) {
			if (!it.assignee || !wantAssignee.includes(it.assignee)) return false;
		} else if (it.assignee) return false;
		return passesFilters(doc, it, filters); // shared status/label/parent narrowing
	});

	if (filters.limit !== undefined && filters.limit >= 0) items = items.slice(0, filters.limit);
	return items;
}

/**
 * Is `issue` (living in `section`) takeable — the base frontier predicate as a
 * per-issue boolean for the `--json` contract (§6): open, unblocked, and unclaimed.
 * Closed issues are never takeable.
 */
export function isTakeable(doc: Doc, issue: Issue, section: SectionName): boolean {
	return section === OPEN_SECTION && !issue.assignee && !isBlocked(doc, issue);
}

// The frontier stays sparse — no markers, no datestamp (§4.2): every row is open and
// unclaimed by construction, so the columns that would carry state are the ones it has
// nothing to say about. It still renders through the shared row (§1.1), for the gutter
// and the element colours.
function frontierRow(doc: Doc, it: Issue, render: RenderOptions): string {
	return compactRow(doc, it, { indent: '  ', note: true }, render);
}

/** `ready` — the whole ordered takeable frontier (§4.2); empty is diagnosed (§4.5). */
export function cmdReady(
	doc: Doc,
	filters: FrontierFilters = {},
	render: RenderOptions = DEFAULT_RENDER
): string {
	const items = frontier(doc, filters);
	if (!items.length) return diagnoseEmpty(doc, filters);
	return items.map((it) => frontierRow(doc, it, render)).join('\n');
}

/** `next` — the topmost takeable issue (`ready[0]`), or the same empty-diagnosis. */
export function cmdNext(
	doc: Doc,
	filters: FrontierFilters = {},
	render: RenderOptions = DEFAULT_RENDER
): string {
	const top = frontier(doc, { ...filters, limit: undefined })[0];
	return top ? frontierRow(doc, top, render) : diagnoseEmpty(doc, filters);
}

// An empty frontier is a normal, diagnosed state — never an error (§4.5). When any
// filter is in play, an empty result is a filter miss (not "no work"), so it says so
// plainly. Otherwise it reports which base gate emptied the open section so an agent
// loop can decide stop-vs-wait: drained, all-blocked (naming the open blockers),
// all-claimed (naming the assignees), or a mix (counts).
function diagnoseEmpty(doc: Doc, filters: FrontierFilters): string {
	const open = doc.sections.get(OPEN_SECTION) ?? [];
	if (!open.length) return 'No open issues.';
	const filtered =
		(filters.status?.length ?? 0) +
		(filters.label?.length ?? 0) +
		(filters.parent?.length ?? 0) +
		(filters.assignee?.length ?? 0);
	if (filtered) return 'No takeable issues match the filter.';

	const blocked = open.filter((it) => isBlocked(doc, it));
	const claimed = open.filter((it) => !isBlocked(doc, it) && it.assignee);
	if (blocked.length === open.length) {
		const waiting = openBlockersOf(doc, blocked);
		return `${open.length} open, all blocked — waiting on ${waiting.join(', ')}.`;
	}
	if (claimed.length === open.length) {
		const who = [...new Set(claimed.map((it) => `@${it.assignee}`))];
		return `${open.length} open, all in progress — ${who.join(', ')}.`;
	}
	return `${open.length} open — ${blocked.length} blocked, ${claimed.length} in progress.`;
}

// The still-open blocker ids the given blocked issues are waiting on, de-duplicated,
// in first-encounter order (self-refs and dangling/closed ids already excluded).
function openBlockersOf(doc: Doc, blocked: Issue[]): string[] {
	const open = openIdSet(doc);
	const waiting: string[] = [];
	const seen = new Set<string>();
	for (const it of blocked) {
		for (const b of blockerIds(doc, it)) {
			if (open.has(b) && !seen.has(b)) {
				seen.add(b);
				waiting.push(b);
			}
		}
	}
	return waiting;
}

// ── Containment forest (`tree`, `show --children`) ───────────────────────────
// Every issue across every section, in document order — the flat universe the
// containment forest is built over.
function allEntries(doc: Doc): { section: SectionName; issue: Issue }[] {
	const out: { section: SectionName; issue: Issue }[] = [];
	for (const name of SECTION_ORDER)
		for (const it of doc.sections.get(name) ?? []) out.push({ section: name, issue: it });
	return out;
}

// An issue's effective parent id: its `part-of:` normalized, but only if that parent
// actually exists — a dangling `part-of:` renders the child top-level (§3.2).
function validParentId(doc: Doc, issue: Issue): string | undefined {
	if (!issue.partOf) return undefined;
	const p = normalizeId(issue.partOf, doc.pattern);
	return findIssue(doc, p) ? p : undefined;
}

// The direct children of `parentId` (§3.2 containment), in document order.
function childrenOf(doc: Doc, parentId: string): Issue[] {
	const pid = normalizeId(parentId, doc.pattern);
	return allEntries(doc)
		.filter((e) => validParentId(doc, e.issue) === pid)
		.map((e) => e.issue);
}

// The containment-forest roots: every issue with no valid parent (top-level, or a
// dangling `part-of:` that renders top-level — §3.2), in document order.
function rootsOf(doc: Doc): Issue[] {
	return allEntries(doc)
		.filter((e) => !validParentId(doc, e.issue))
		.map((e) => e.issue);
}

// One issue's forest lines: the shared compact row (§1.1 — gutter and colour, or the
// `--plain` postfix tags), then its subtree indented. Blocking stays a node annotation,
// never drawn as structure (§5 decision 13). `seen` guards a pathological `part-of:`
// cycle from recursing forever — that guard's line is the one row in the forest that
// does not go through `compactRow`, because it stands in for a row rather than being one.
/**
 * Which issues a filtered `tree` renders (§3.2). `visible` is every match plus every
 * ancestor on the path to one; `scaffold` is the difference — the ancestors that did
 * not match themselves. An absent view means "render everything", which is what
 * `show --children` wants (§4.4: scaffolding never reaches `show`).
 */
interface TreeView {
	visible: Set<string>;
	scaffold: Set<string>;
}

// Build the view: match on exactly `list`'s section + filter vocabulary (§3.1), then
// walk each match's `part-of:` chain upward, keeping every ancestor. An ancestor is
// kept whatever section it lives in — the path has to survive for containment to read
// identically to an unfiltered tree, so a closed parent of an open match stays.
function treeView(doc: Doc, opts: ListOptions, filters: FrontierFilters): TreeView {
	const sections = new Set(listSections(opts));
	const matched = new Set<string>();
	const hits: Issue[] = [];
	for (const { section, issue } of allEntries(doc))
		if (sections.has(section) && listFilter(doc, issue, filters)) {
			matched.add(issue.id);
			hits.push(issue);
		}

	const visible = new Set(matched);
	for (const hit of hits) {
		let cur: Issue | undefined = hit;
		const guard = new Set<string>([hit.id]); // a pathological part-of cycle terminates
		for (;;) {
			const parent: string | undefined = cur ? validParentId(doc, cur) : undefined;
			if (!parent || guard.has(parent)) break;
			guard.add(parent);
			visible.add(parent);
			cur = findIssue(doc, parent)?.issue;
		}
	}
	const scaffold = new Set([...visible].filter((id) => !matched.has(id)));
	return { visible, scaffold };
}

function treeLines(
	doc: Doc,
	issue: Issue,
	depth: number,
	render: RenderOptions,
	view?: TreeView,
	seen = new Set<string>()
): string[] {
	if (view && !view.visible.has(issue.id)) return [];
	const indent = '  '.repeat(depth + 1);
	if (seen.has(issue.id)) return [`${indent}${issue.id} (part-of cycle)`];
	seen.add(issue.id);
	const scaffold = view?.scaffold.has(issue.id);
	const out = [compactRow(doc, issue, { indent, markers: true, scaffold }, render)];
	for (const k of childrenOf(doc, issue.id))
		out.push(...treeLines(doc, k, depth + 1, render, view, seen));
	return out;
}

/**
 * `tree` — the containment-only forest (§5 decision 13), state-annotated. Roots are
 * issues with no valid parent (top-level or dangling `part-of:`); children nest by
 * `part-of:`. Blocking is carried by the row's state gutter (or a `[blocked]` tag under
 * `--plain`), never by tree structure.
 *
 * Filtered by exactly `list`'s vocabulary — the same section flags and the same
 * predicate, so there is one filter language, not two (§3.1). **It defaults to open**;
 * `--all` restores every section. Non-matching ancestors are kept as scaffolding,
 * rendered in place and never moved (§3.2).
 */
export function cmdTree(
	doc: Doc,
	opts: ListOptions = {},
	filters: FrontierFilters = {},
	render: RenderOptions = DEFAULT_RENDER
): string {
	const view = treeView(doc, opts, filters);
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const r of rootsOf(doc)) lines.push(...treeLines(doc, r, 0, render, view, seen));
	if (!lines.length) return 'No issues.';
	return lines.join('\n');
}

// ── The finding model (ADR 0009 / design findings.md §1–§5) ──────────────────
// A finding is structured data with a formatter, not a string: one producer
// (`findings`) folds every read-time anomaly, and one formatter (`formatFinding`)
// renders it at two densities. The three legacy string producers above stay in
// place for the surfaces not yet migrated (tickets #39–#42).

/** Ordered severity scale (findings.md §1): error > (warning, reserved) > advisory. */
export type Severity = 'error' | 'advisory';

/** The eleven finding codes (findings.md §2.1). A union, not `string` — adding a
 * member is non-breaking for consumers who read it. */
export type FindingCode =
	| 'malformed-line' | 'dangling-blocker' | 'dangling-part-of' | 'self-blocker'
	| 'cycle' | 'undeclared-status'
	| 'wontfix-blocker' | 'deferred-blocker' | 'closed-with-open-blocker'
	| 'schema-unparseable' | 'schema-too-new';

export interface Finding {
	severity: Severity;
	code: FindingCode;
	subjects: string[]; // 0 = the file · 1 = an issue · n = a knot
	mentions: string[]; // implicated ids; write-time scope
	value?: string; // the one non-id scalar some codes carry
	line?: number; // file-level findings only
}

/**
 * The severity of every code, in one exhaustive table (findings.md §1.1). Adding a
 * `FindingCode` without classifying it here is a **compile error** — the same guard
 * `STATE_GLYPHS: Record<IssueState, …>` gives the gutter.
 */
export const FINDING_SEVERITY: Record<FindingCode, Severity> = {
	'malformed-line': 'error',
	'dangling-blocker': 'error',
	'dangling-part-of': 'error',
	'self-blocker': 'error',
	'cycle': 'error',
	'undeclared-status': 'error',
	'wontfix-blocker': 'advisory',
	'deferred-blocker': 'advisory',
	'closed-with-open-blocker': 'advisory',
	'schema-unparseable': 'advisory',
	'schema-too-new': 'advisory'
};

// Construct a finding, taking severity from the table so no site types it twice.
const finding = (
	code: FindingCode,
	subjects: string[],
	mentions: string[] = [],
	extra: Partial<Pick<Finding, 'value' | 'line'>> = {}
): Finding => ({ code, severity: FINDING_SEVERITY[code], subjects, mentions, ...extra });

/**
 * Every anomaly the file carries at read time (ADR 0003 — nothing stored), as
 * structured findings. Folds the logic of `graphWarnings` + `doctorFindings` +
 * `compatWarnings` into one producer, with two behaviour changes the string
 * channel never had (ADR 0009 §6):
 *   · the graph walk **broadens to every section** — a dangling / self / won't-fix
 *     blocker or dangling part-of on a *closed* row now fires, not only on `Issues`;
 *   · **`deferred-blocker`** joins `wontfix-blocker` — a blocker in `Deferred`
 *     silently unblocks its dependents today, flagged by nothing.
 * `text` is the raw file, needed only for the file-level `malformed-line` scan.
 */
export function findings(doc: Doc, text: string): Finding[] {
	const out: Finding[] = [];
	const all = allIdSet(doc);
	const wontfix = idSet(doc, WONTFIX_SECTION);
	const deferred = idSet(doc, DEFER_SECTION);
	// Graph edges over **every** section (§6): the walk no longer stops at `Issues`.
	for (const { issue } of allEntries(doc)) {
		for (const raw of issue.blockedBy) {
			const b = normalizeId(raw, doc.pattern);
			if (b === issue.id) out.push(finding('self-blocker', [issue.id], [issue.id]));
			else if (!all.has(b)) out.push(finding('dangling-blocker', [issue.id], [b]));
			else if (wontfix.has(b)) out.push(finding('wontfix-blocker', [issue.id], [b]));
			else if (deferred.has(b)) out.push(finding('deferred-blocker', [issue.id], [b]));
		}
		if (issue.partOf) {
			const p = normalizeId(issue.partOf, doc.pattern);
			if (!all.has(p)) out.push(finding('dangling-part-of', [issue.id], [p]));
		}
	}
	// Cycles among still-open issues (a closed blocker satisfies its gate, so it can
	// never be part of a live deadlock) — every member is a subject, ordered.
	for (const cycle of detectCycles(doc)) out.push(finding('cycle', cycle, []));
	// A `status:` outside the declared `statuses:` set — the one opt-in error.
	const declared = declaredStatuses(doc);
	if (declared)
		for (const { issue } of allEntries(doc))
			if (issue.status && !declared.has(issue.status))
				out.push(finding('undeclared-status', [issue.id], [], { value: issue.status }));
	// Lines the parser discards — file-level, located by `line`.
	out.push(...findMalformed(doc, text));
	// ADR 0007 `schema:` compat — file-level advisories.
	out.push(...schemaFindings(doc));
	return out;
}

// Lines inside a section that are neither an issue line, an indented note, nor
// blank — content the parser silently drops. Scanned off the raw text (the model
// has already discarded them), carrying a 1-indexed `line` for the "where" slot.
function findMalformed(doc: Doc, text: string): Finding[] {
	const issueRe = issueLineRe(doc.pattern);
	const out: Finding[] = [];
	let inSection = false;
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		if (/^## /.test(line)) {
			inSection = true;
			continue;
		}
		if (!inSection || line.trim() === '') continue;
		if (issueRe.test(line) || /^\s+/.test(line)) continue;
		out.push(finding('malformed-line', [], [], { line: i + 1, value: line }));
	}
	return out;
}

// The ADR 0007 `schema:` compat findings, as structured data. Mirrors
// `compatWarnings` (which stays for the un-migrated channels): an absent key is
// legacy and silent; a non-numeric one is `schema-unparseable`; one newer than this
// build is `schema-too-new`. Both advisory, both file-level (`subjects: []`).
function schemaFindings(doc: Doc): Finding[] {
	const entry = doc.frontmatter.find((e) => e.key === 'schema');
	if (!entry) return [];
	const raw = entry.raw.trim().replace(/^["']|["']$/g, '');
	const n = Number(raw);
	if (raw === '' || !Number.isFinite(n)) return [finding('schema-unparseable', [], [], { value: raw })];
	if (n > SUPPORTED_SCHEMA) return [finding('schema-too-new', [], [], { value: raw })];
	return [];
}

// The "where" slot (findings.md §2): the subject ids when there are any, else the
// file location — a line when the finding has one, the file name otherwise.
function findingWhere(f: Finding): string {
	if (f.subjects.length) return f.subjects.join(', ');
	return f.line != null ? `ISSUES.md:${f.line}` : 'ISSUES.md';
}

interface FindingProse {
	headline: string; // the inline/report one-line reason head
	why: string[]; // report body, authored short (~72 cols), never reflowed
	fix: string; // report `Fix:` imperative
	inline: string; // the inline one-line reason tail
}

// The authored prose for each code, at both densities (findings.md §4.1). The core
// cannot wrap (ADR 0008), so report prose is authored short and split by hand. The
// switch is exhaustive: a new code without a branch is a compile error.
function findingProse(f: Finding): FindingProse {
	const s = f.subjects[0] ?? ''; // the primary subject (single-subject codes)
	const m = f.mentions[0] ?? ''; // the implicated id
	const v = f.value ?? '';
	switch (f.code) {
		case 'malformed-line':
			return {
				headline: 'malformed line — not an issue or an indented note',
				why: [
					`Line ${f.line} sits in a section but is neither an issue line`,
					'nor an indented note, so the parser drops it on read.'
				],
				fix: 'Fix: delete the line, or indent it to attach it as a note.',
				inline: 'not an issue line or an indented note — the parser drops it'
			};
		case 'dangling-blocker':
			return {
				headline: `blocked-by ${m} — no such issue`,
				why: [
					`${m} is nowhere in this file, so the edge is ignored and`,
					`${s} counts as unblocked.`
				],
				fix: `Fix: correct the id, or drop \`blocked-by:${m}\` from the line.`,
				inline: `blocked-by ${m} not found — fails open (does not block)`
			};
		case 'dangling-part-of':
			return {
				headline: `part-of ${m} — no such issue`,
				why: [
					`${m} is nowhere in this file, so ${s} has no container and`,
					'renders top-level.'
				],
				fix: `Fix: correct the id, or drop \`part-of:${m}\` from the line.`,
				inline: `part-of ${m} not found — rendered top-level`
			};
		case 'self-blocker':
			return {
				headline: 'blocked-by itself',
				why: [
					`${s} lists itself as a blocker, so the edge is ignored.`,
					'An issue cannot gate its own completion.'
				],
				fix: `Fix: drop \`blocked-by:${s}\` from the line.`,
				inline: `blocked-by ${s} is a self-reference — edge ignored`
			};
		case 'cycle':
			return {
				headline: 'dependency cycle',
				why: [
					`${f.subjects.join(' → ')} → ${s}`,
					'Each waits on the next, so none can ever become unblocked.'
				],
				fix: 'Fix: remove one `blocked-by:` anywhere in the loop.',
				inline: `dependency cycle: ${f.subjects.join(' → ')} → ${s} — members stay blocked`
			};
		case 'undeclared-status':
			return {
				headline: `status:${v} — not in the declared statuses`,
				why: [
					`${s} carries a status the file's \`statuses:\` set does not`,
					'declare, so the set claims something the file falsifies.'
				],
				fix: `Fix: correct the status, or add \`${v}\` to \`statuses:\`.`,
				inline: `status:${v} is not in the declared statuses`
			};
		case 'wontfix-blocker':
			return {
				headline: `blocker ${m} is won't-fix`,
				why: [
					`${s} is unblocked because ${m} was rejected, not because it`,
					'was done — the gate is satisfied by a won\'t-fix.'
				],
				fix: `Fix: nothing required — confirm ${s} can proceed without it.`,
				inline: `blocker ${m} is won't-fix — gate satisfied by a rejected issue`
			};
		case 'deferred-blocker':
			return {
				headline: `blocker ${m} is deferred`,
				why: [
					`${s} is unblocked because ${m} was postponed, not because`,
					'it was done. The work it waited on is still expected.'
				],
				fix: `Fix: nothing required — confirm ${s} can proceed without it.`,
				inline: `blocker ${m} is deferred — unblocked by postponement, not completion`
			};
		case 'closed-with-open-blocker':
			return {
				headline: `closed, but blocker ${m} is open`,
				why: [
					`${s} was completed, and ${m} — which it waited on — is not.`,
					`Whether that undoes ${s} depends on why ${m} is open; the`,
					'tool can\'t know.'
				],
				fix: `Fix: reopen ${s} if the work is genuinely undone.`,
				inline: `closed, but blocker ${m} is open`
			};
		case 'schema-unparseable':
			return {
				headline: `schema:${v} — not a recognized format version`,
				why: [
					'The `schema:` value is not numeric, so this build reads the',
					'file as legacy format. It may not round-trip cleanly.'
				],
				fix: 'Fix: set `schema:` to a version this build writes, or remove it.',
				inline: `schema:${v} is not a recognized format version — may not round-trip`
			};
		case 'schema-too-new':
			return {
				headline: `schema ${v} is newer than this build understands`,
				why: [
					`This build understands schema ${SUPPORTED_SCHEMA}; the file declares a`,
					'newer one, so it may not round-trip cleanly.'
				],
				fix: `Fix: upgrade \`issues\` to a build that understands schema ${v}.`,
				inline: `file declares schema ${v}; this build understands ${SUPPORTED_SCHEMA} — may not round-trip`
			};
		default: {
			const _exhaustive: never = f.code;
			throw new Error(`unhandled finding code: ${String(_exhaustive)}`);
		}
	}
}

/**
 * Render a finding at one of two densities (findings.md §4.1), coloured by severity
 * only where `color` is true (ADR 0008: `error`→red, `advisory`→dim):
 *   · **inline** (default) — one line `<glyph> <where>  <reason>`, for the stderr
 *     block and `show`'s dossier (later tickets #39/#40);
 *   · **report** — the three-part `doctor` form: where · why (authored prose) · `Fix:`.
 * The core never wraps — report prose is authored short and split by hand.
 */
export function formatFinding(f: Finding, color: boolean, density: 'inline' | 'report' = 'inline'): string {
	const prose = findingProse(f);
	const style: AnsiStyle = f.severity === 'error' ? 'red' : 'dim';
	if (density === 'inline') {
		const glyph = f.severity === 'error' ? '!' : '·';
		return paint(`${glyph} ${findingWhere(f)}  ${prose.inline}`, style, color);
	}
	const lines = [
		`  ${findingWhere(f)}  ${prose.headline}`,
		...prose.why.map((l) => `    ${l}`),
		`    ${prose.fix}`
	];
	return paint(lines.join('\n'), style, color);
}

// ── doctor (read-only linter, §5 decision 19) ────────────────────────────────
// Every anomaly the file carries, in one flat list: the §3 graph advisories, any
// status outside a declared `statuses:` set, and structurally malformed lines.
export function doctorFindings(doc: Doc, text: string): string[] {
	const out = [...graphWarnings(doc)];
	const declared = declaredStatuses(doc);
	if (declared)
		for (const { issue } of allEntries(doc))
			if (issue.status && !declared.has(issue.status))
				out.push(`${issue.id}: status:${issue.status} is not in the declared statuses`);
	out.push(...malformedLines(text, doc.pattern));
	return out;
}

// Lines inside a section that are neither an issue line, an indented note, nor blank —
// content the parser would silently drop. Scanned off the raw text (the model has
// already discarded them).
function malformedLines(text: string, pattern: string): string[] {
	const issueRe = issueLineRe(pattern);
	const out: string[] = [];
	let inSection = false;
	for (const line of text.split('\n')) {
		if (/^## /.test(line)) {
			inSection = true;
			continue;
		}
		if (!inSection || line.trim() === '') continue;
		if (issueRe.test(line) || /^\s+/.test(line)) continue;
		out.push(`malformed line (not an issue or note): ${line.trim()}`);
	}
	return out;
}

/**
 * `doctor` — the grouped report (findings.md §5.1): findings grouped by severity
 * (errors first), prose tier headers, a footer tally. `No findings.` when clean.
 * Findings ride stdout, so they colour by severity where `color` is true (§4.4).
 * The exit code is the caller's job (§5.3).
 */
export function cmdDoctor(doc: Doc, text: string, color = false): string {
	const all = findings(doc, text);
	if (!all.length) return 'No findings.';
	const errors = all.filter((f) => f.severity === 'error');
	const advisories = all.filter((f) => f.severity === 'advisory');
	const blocks: string[] = [];
	const group = (header: string, fs: Finding[]): void => {
		if (!fs.length) return;
		blocks.push(header, '');
		for (const f of fs) blocks.push(formatFinding(f, color, 'report'), '');
	};
	group('ERRORS — the file does not mean what it says', errors);
	group('ADVISORIES — nothing is wrong, but something you rely on may not hold', advisories);
	blocks.push(doctorFooter(errors.length, advisories.length));
	return blocks.join('\n');
}

// The report footer (findings.md §5.1): both tiers, each pluralised independently,
// so an advisories-only pass reads `0 errors, 1 advisory` — a pass, not an alarm.
function doctorFooter(errors: number, advisories: number): string {
	const e = `${errors} error${errors === 1 ? '' : 's'}`;
	const a = `${advisories} advisor${advisories === 1 ? 'y' : 'ies'}`;
	return `${e}, ${a}`;
}

// ── `--json` read contract (§6) ──────────────────────────────────────────────
// The per-issue shape every read emits: the stored fields plus the derived
// `blocked`/`takeable` an agent would otherwise re-compute. Ids are normalized.
function issueJson(doc: Doc, issue: Issue, section: SectionName) {
	return {
		id: issue.id,
		title: issue.title,
		section,
		status: issue.status ?? null,
		assignee: issue.assignee ?? null,
		labels: issue.labels,
		blockedBy: issue.blockedBy.map((b) => normalizeId(b, doc.pattern)),
		partOf: issue.partOf ? normalizeId(issue.partOf, doc.pattern) : null,
		blocked: isBlocked(doc, issue),
		takeable: isTakeable(doc, issue, section)
	};
}

export function cmdListJson(doc: Doc, opts: ListOptions = {}, filters: FrontierFilters = {}) {
	const items: ReturnType<typeof issueJson>[] = [];
	for (const name of listSections(opts))
		for (const it of doc.sections.get(name) ?? [])
			if (listFilter(doc, it, filters)) items.push(issueJson(doc, it, name));
	return items;
}

// `ready --json` — the frontier list plus the §4.5 reason when it is empty (null otherwise).
export function cmdReadyJson(doc: Doc, filters: FrontierFilters = {}) {
	const items = frontier(doc, filters);
	return {
		issues: items.map((it) => issueJson(doc, it, OPEN_SECTION)),
		reason: items.length ? null : diagnoseEmpty(doc, filters)
	};
}

// `next --json` — the topmost takeable issue (or null) plus the same empty-reason.
export function cmdNextJson(doc: Doc, filters: FrontierFilters = {}) {
	const top = frontier(doc, { ...filters, limit: undefined })[0];
	return {
		issue: top ? issueJson(doc, top, OPEN_SECTION) : null,
		reason: top ? null : diagnoseEmpty(doc, filters)
	};
}

// A relationship pointer resolved for JSON: the target's title/section/openness, or a
// `found: false` marker when it dangles.
function refJson(doc: Doc, rawId: string) {
	const id = normalizeId(rawId, doc.pattern);
	const found = findIssue(doc, id);
	return {
		id,
		title: found ? found.issue.title : null,
		section: found ? found.section : null,
		open: found ? found.section === OPEN_SECTION : false,
		found: !!found
	};
}

// The forest as JSON nodes — each issue's `--json` shape plus its nested children.
function treeJson(doc: Doc, issues: Issue[], seen = new Set<string>()): unknown[] {
	const out: unknown[] = [];
	for (const it of issues) {
		if (seen.has(it.id)) continue;
		seen.add(it.id);
		const found = findIssue(doc, it.id);
		out.push({
			...issueJson(doc, it, found ? found.section : OPEN_SECTION),
			children: treeJson(doc, childrenOf(doc, it.id), seen)
		});
	}
	return out;
}

export function cmdTreeJson(doc: Doc) {
	return treeJson(doc, rootsOf(doc));
}

export function cmdShowJson(doc: Doc, idInput: string, opts: ShowOptions = {}) {
	const { section, issue } = requireIssue(doc, idInput);
	const base = issueJson(doc, issue, section);
	const result: Record<string, unknown> = {
		...base,
		parent: issue.partOf ? refJson(doc, issue.partOf) : null,
		blockers: issue.blockedBy.map((b) => refJson(doc, b)),
		detail: issue.detail,
		warnings: opts.quiet ? [] : warningsFor(doc, issue.id)
	};
	if (opts.children) result.children = treeJson(doc, childrenOf(doc, issue.id));
	return result;
}

// `doctor --json` — `{ findings: Finding[] }`, `ok` dropped (findings.md §5.2): once
// the exit code is the gate, `ok` is a second encoding where drift lives. Every
// finding carries the full field set (`value`/`line` as null when absent) so the
// machine shape is stable regardless of code.
export function cmdDoctorJson(doc: Doc, text: string) {
	return {
		findings: findings(doc, text).map((f) => ({
			severity: f.severity,
			code: f.code,
			subjects: f.subjects,
			mentions: f.mentions,
			value: f.value ?? null,
			line: f.line ?? null
		}))
	};
}

// ── CLI dispatch ───────────────────────────────────────────────────────────
// Flags that consume the next token as their value. The frontier filters and
// `--limit` (§4.4) plus the mutation-verb value flags `--by`/`--part-of`/
// `--blocked-by` join `--note` (§5.3 arg-parser extension).
const VALUE_FLAGS = new Set([
	'note',
	'status',
	'label',
	'parent',
	'assignee',
	'limit',
	'by',
	'part-of',
	'blocked-by'
]);
// Value flags that may repeat — each occurrence accumulates into an array so a
// dimension can OR within itself (`--label a --label b`; §4.4). The comma-list
// `add` flags accumulate the same way and are flattened at read time.
const REPEATABLE_FLAGS = new Set(['status', 'label', 'parent', 'assignee', 'blocked-by']);

export type FlagValue = string | boolean | string[];

/**
 * The CLI's argument grammar. Exported so the shell resolves the presentation flags
 * (§6.1) through the *same* parser `run` dispatches on — scanning raw argv instead
 * would diverge the moment a value flag swallowed the next token (`--status --plain`
 * means `status:--plain`, not plain rendering) or a flag arrived as `--json=1`.
 */
export function parseArgs(argv: string[]): {
	positionals: string[];
	flags: Record<string, FlagValue>;
} {
	const positionals: string[] = [];
	const flags: Record<string, FlagValue> = {};
	const setValue = (key: string, value: string) => {
		if (REPEATABLE_FLAGS.has(key)) {
			const cur = flags[key];
			if (Array.isArray(cur)) cur.push(value);
			else flags[key] = [value];
		} else {
			flags[key] = value;
		}
	};
	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i] ?? '';
		// `-q` is the sole short flag — the quiet toggle (§5 decision 8), aliasing
		// `--quiet`. Every other single-dash token falls through to a positional.
		if (tok === '-q') {
			flags.quiet = true;
		} else if (tok.startsWith('--')) {
			const body = tok.slice(2);
			const eq = body.indexOf('=');
			if (eq !== -1) setValue(body.slice(0, eq), body.slice(eq + 1));
			else if (VALUE_FLAGS.has(body)) setValue(body, argv[++i] ?? '');
			else flags[body] = true;
		} else {
			positionals.push(tok);
		}
	}
	return { positionals, flags };
}

// Normalize a flag value to a flat string list, splitting comma-lists so
// `--label a,b` ORs the same as `--label a --label b` (§4.4). Blank fragments drop.
function commaList(v: FlagValue | undefined): string[] {
	if (v === undefined) return [];
	const arr = Array.isArray(v) ? v : [String(v)];
	return arr
		.flatMap((s) => String(s).split(','))
		.map((s) => s.trim())
		.filter(Boolean);
}

// The first scalar value of a (possibly repeated) flag — for the single-valued
// `add` field flags (`--part-of`, `--status`, `--assignee`).
function firstStr(v: FlagValue | undefined): string | undefined {
	const list = commaList(v);
	return list.length ? list[0] : undefined;
}

// The section flags (§4.4 / §3.1), read once and shared by `list` and `tree` so the
// two cannot drift into separate vocabularies.
function readSections(flags: Record<string, FlagValue>): ListOptions {
	return {
		all: !!flags.all,
		closed: !!flags.closed,
		deferred: !!flags.deferred,
		wontfix: !!flags.wontfix
	};
}

// Read the §4.4 filter set off the parsed flags. Repeatable/comma dimensions arrive
// as arrays; a lone occurrence is normalized up to a one-element array.
function readFilters(flags: Record<string, FlagValue>): FrontierFilters {
	const arr = (v: FlagValue | undefined): string[] | undefined =>
		v === undefined ? undefined : commaList(v);
	const limit = typeof flags.limit === 'string' ? Number(flags.limit) : undefined;
	return {
		status: arr(flags.status),
		label: arr(flags.label),
		parent: arr(flags.parent),
		assignee: arr(flags.assignee),
		limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined
	};
}

const HELP = `Usage: issues <command> [args]

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

--json is the only stable read surface; human-readable output may change in any release.`;

export interface RunResult {
	text: string; // resulting file contents (unchanged unless `mutated`)
	output: string; // text to print to stdout
	mutated: boolean; // whether the file should be written back
	warnings: string[]; // advisory §3 messages — bin.ts prints to stderr, never mixed into `output`
	exitCode?: number; // defaults to 0; `doctor` sets 1 on any error finding (the sole exception)
}

// Fill the advisory defaults so each dispatch arm names only what it produces —
// most commands emit no warnings. Later stages pass `warnings`/`exitCode` explicitly.
function result(fields: Omit<RunResult, 'warnings'> & { warnings?: string[] }): RunResult {
	return { warnings: [], ...fields };
}

/**
 * Pure command runner — no filesystem access, for testing and reuse.
 *
 * `render` is the already-resolved `{color, plain}` pair (§6.1); the shell resolves
 * the tri-state flags, `NO_COLOR` and TTY-ness before calling. A library consumer
 * that omits it gets uncoloured, non-plain output.
 */
export function run(text: string, argv: string[], render: RenderOptions = DEFAULT_RENDER): RunResult {
	const { positionals, flags } = parseArgs(argv);
	const cmd = positionals[0] ?? 'help';
	if (cmd === 'help' || cmd === '--help' || flags.help) {
		return result({ text, output: HELP, mutated: false });
	}

	const doc = parse(text);
	const arg = (n: number) => positionals[n];
	const need = (n: number, label: string) => {
		const v = arg(n);
		if (v === undefined) throw new Error(`${cmd}: missing <${label}>`);
		return v;
	};

	// Global read modifiers (§5 decision 8/9): `-q`/`--quiet` silences the advisory
	// channel; `--json` swaps the human render for the §6 machine contract.
	const quiet = !!flags.quiet;
	const wantJson = !!flags.json;
	const jsonOut = (d: unknown): string => JSON.stringify(d, null, 2);
	// The §3 advisories a graph-reading command surfaces to stderr, gated by `-q`.
	// The ADR 0007 schema-compat advisory rides the same channel and leads, since a
	// too-new file colours everything read below it.
	const advisories = (): string[] => (quiet ? [] : [...compatWarnings(doc), ...graphWarnings(doc)]);
	// Write-time advisories for an edge-touching mutation (§5 decision 8): only the
	// warnings that name the issue whose edge just changed — plus the schema-compat
	// advisory, so an older build writing a newer file always says so first.
	const edgeAdvisories = (id: string): string[] =>
		quiet ? [] : [...compatWarnings(doc), ...warningsFor(doc, id)];

	switch (cmd) {
		// ── Reads ────────────────────────────────────────────────────────────────
		case 'list': {
			const opts = readSections(flags);
			const filters = readFilters(flags);
			const output = wantJson
				? jsonOut(cmdListJson(doc, opts, filters))
				: cmdList(doc, opts, filters, render);
			return result({ text, mutated: false, output, warnings: advisories() });
		}
		case 'next': {
			const filters = readFilters(flags);
			const output = wantJson ? jsonOut(cmdNextJson(doc, filters)) : cmdNext(doc, filters, render);
			return result({ text, mutated: false, output, warnings: advisories() });
		}
		case 'ready': {
			const filters = readFilters(flags);
			const output = wantJson ? jsonOut(cmdReadyJson(doc, filters)) : cmdReady(doc, filters, render);
			return result({ text, mutated: false, output, warnings: advisories() });
		}
		case 'show': {
			const id = need(1, 'id');
			const opts: ShowOptions = { children: !!flags.children, quiet };
			// `show` folds its issue's warnings into the dossier/JSON itself (§5 decision
			// 17), so it does not also duplicate them on the stderr channel.
			const output = wantJson ? jsonOut(cmdShowJson(doc, id, opts)) : cmdShow(doc, id, opts, render);
			return result({ text, mutated: false, output });
		}
		case 'tree': {
			// `tree --json` is deliberately unfiltered — the machine forest is the whole
			// forest, and §6's contract does not change here (§8).
			const output = wantJson
				? jsonOut(cmdTreeJson(doc))
				: cmdTree(doc, readSections(flags), readFilters(flags), render);
			return result({ text, mutated: false, output, warnings: advisories() });
		}
		case 'doctor': {
			// The exit code is a threshold-shaped contract (findings.md §5.3): 1 iff any
			// finding is `error`-or-above, else 0 — so an advisories-only file exits 0.
			// Findings ride stdout, not the stderr advisory channel; they colour there.
			const found = findings(doc, text);
			const output = wantJson ? jsonOut(cmdDoctorJson(doc, text)) : cmdDoctor(doc, text, render.color);
			const exitCode = found.some((f) => f.severity === 'error') ? 1 : 0;
			return result({ text, mutated: false, output, exitCode });
		}

		// ── Mutations ──────────────────────────────────────────────────────────────
		case 'add': {
			const note = typeof flags.note === 'string' ? flags.note : undefined;
			const newId = formatId(doc.nextId, doc.pattern);
			const msg = cmdAdd(doc, need(1, 'title'), note, {
				partOf: firstStr(flags['part-of']),
				blockedBy: commaList(flags['blocked-by']),
				status: firstStr(flags.status),
				assignee: firstStr(flags.assignee),
				labels: commaList(flags.label)
			});
			return result({ text: serialize(doc), output: msg, mutated: true, warnings: edgeAdvisories(newId) });
		}
		case 'block': {
			const id = need(1, 'id');
			const by = firstStr(flags.by);
			if (!by) throw new Error('block: missing --by <blocker>');
			const msg = cmdBlock(doc, id, by);
			return result({ text: serialize(doc), output: msg, mutated: true, warnings: edgeAdvisories(id) });
		}
		case 'unblock': {
			const msg = cmdUnblock(doc, need(1, 'id'), firstStr(flags.by));
			return result({ text: serialize(doc), output: msg, mutated: true });
		}
		case 'assign': {
			const msg = cmdAssign(doc, need(1, 'id'), need(2, 'who'));
			return result({ text: serialize(doc), output: msg, mutated: true });
		}
		case 'unassign': {
			const msg = cmdUnassign(doc, need(1, 'id'));
			return result({ text: serialize(doc), output: msg, mutated: true });
		}
		case 'label': {
			const msg = cmdLabel(doc, need(1, 'id'), commaList(need(2, 'name')));
			return result({ text: serialize(doc), output: msg, mutated: true });
		}
		case 'unlabel': {
			const msg = cmdUnlabel(doc, need(1, 'id'), commaList(need(2, 'name')));
			return result({ text: serialize(doc), output: msg, mutated: true });
		}
		case 'set': {
			const id = need(1, 'id');
			const kv = need(2, 'key:value');
			const m = kv.match(/^([^:]+):([\s\S]*)$/);
			if (!m) throw new Error(`set: expected <key>:<value>, got "${kv}"`);
			const { message, warnings } = cmdSet(doc, id, m[1]!, m[2]!);
			return result({
				text: serialize(doc),
				output: message,
				mutated: true,
				warnings: quiet ? [] : warnings
			});
		}
		case 'unset': {
			const msg = cmdUnset(doc, need(1, 'id'), need(2, 'key'));
			return result({ text: serialize(doc), output: msg, mutated: true });
		}
		case 'done': {
			const target = flags.defer ? DEFER_SECTION : flags.wontfix ? WONTFIX_SECTION : DONE_SECTION;
			const msg = cmdDone(doc, need(1, 'id'), target);
			return result({ text: serialize(doc), output: msg, mutated: true });
		}
		case 'reopen': {
			const msg = cmdReopen(doc, need(1, 'id'));
			return result({ text: serialize(doc), output: msg, mutated: true });
		}
		case 'edit': {
			const msg = cmdEdit(doc, need(1, 'id'), need(2, 'title'));
			return result({ text: serialize(doc), output: msg, mutated: true });
		}
		case 'note': {
			const msg = cmdNote(doc, need(1, 'id'), need(2, 'text'));
			return result({ text: serialize(doc), output: msg, mutated: true });
		}
		default:
			throw new Error(`Unknown command: ${cmd}\n\n${HELP}`);
	}
}
