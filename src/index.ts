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
 *   doctor                           read-only linter (exits nonzero on findings)
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

// The id is digits with an optional letter prefix (e.g. `M01`, `BZ007`, or a
// bare `007`), so a numeric-only `pattern` round-trips alongside prefixed ones.
const ISSUE_RE = /^- \[([ xX])\] ([A-Za-z]*[0-9]+): (.*)$/;
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

	// Sections.
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
		const m = line.match(ISSUE_RE);
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
 * `show <id>` — the full resolved dossier (§5 decision 17): status/assignee/labels,
 * relationships expanded with their target's title + open/closed state, derived
 * `⊘ blocked`, the note body, this issue's §3 warnings, and (with `--children`) its
 * containment subtree. Its own render path — terminal output is never double-spaced.
 */
export function cmdShow(doc: Doc, idInput: string, opts: ShowOptions = {}): string {
	const { section, issue } = requireIssue(doc, idInput);
	const mark = issue.checked ? ' [x]' : '';
	const date = issue.date ? ` (${issue.date})` : '';
	const blk = isBlocked(doc, issue) ? ' ⊘ blocked' : '';
	const lines = [`${issue.id} — ${section}${mark}${date}${blk}`, issue.title];
	if (issue.status) lines.push(`  status: ${issue.status}`);
	if (issue.assignee) lines.push(`  assignee: @${issue.assignee}`);
	if (issue.labels.length) lines.push(`  labels: ${issue.labels.map((l) => '#' + l).join(' ')}`);
	if (issue.partOf) lines.push(`  part-of: ${resolveRef(doc, issue.partOf)}`);
	for (const b of issue.blockedBy) lines.push(`  blocked-by: ${resolveRef(doc, b, issue.id)}`);
	for (const u of issue.uda) lines.push(`  ${u.key}: ${u.value}`);
	for (const d of issue.detail) lines.push(`    ${d}`);
	if (opts.children) {
		const kids = childrenOf(doc, issue.id);
		if (kids.length) {
			lines.push('  children:');
			for (const k of kids) lines.push(...treeLines(doc, k, 2));
		}
	}
	if (!opts.quiet) for (const w of warningsFor(doc, issue.id)) lines.push(`  ! ${w}`);
	return lines.join('\n');
}

// Resolve a relationship pointer to a human-legible `id (title) — state` string, or
// `id (not found)` when it dangles (§3.1/§3.2). `selfId` flags a self-reference edge.
function resolveRef(doc: Doc, rawId: string, selfId?: string): string {
	const id = normalizeId(rawId, doc.pattern);
	if (selfId && id === selfId) return `${id} (self-reference — ignored)`;
	const found = findIssue(doc, id);
	if (!found) return `${id} (not found)`;
	const state = found.section === OPEN_SECTION ? 'open' : found.section.toLowerCase();
	return `${id} (${found.issue.title}) — ${state}`;
}

export interface ListOptions {
	all?: boolean;
	closed?: boolean;
	deferred?: boolean;
	wontfix?: boolean;
}

// The compact info-dense markers that ride an issue on the triage surface (§5
// decision 17): `status:`, `@assignee`, `#labels`. A metadata-free issue adds none.
function markers(issue: Issue): string {
	let s = '';
	if (issue.status) s += ` status:${issue.status}`;
	if (issue.assignee) s += ` @${issue.assignee}`;
	for (const l of issue.labels) s += ` #${l}`;
	return s;
}

// One compact line for `list` (§5 decision 17): `⊘` when blocked, then the id, title,
// the info-dense markers, an optional datestamp, and `…` when a note is attached.
function listRow(doc: Doc, it: Issue): string {
	const flag = isBlocked(doc, it) ? '⊘ ' : '';
	const date = it.date ? ` (${it.date})` : '';
	const more = it.detail.length ? ' …' : '';
	return `  ${flag}${it.id}  ${it.title}${markers(it)}${date}${more}`;
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

export function cmdList(doc: Doc, opts: ListOptions = {}, filters: FrontierFilters = {}): string {
	const names = listSections(opts);
	const blocks: string[] = [];
	for (const name of names) {
		const issues = (doc.sections.get(name) ?? []).filter((it) => listFilter(doc, it, filters));
		if (!issues.length) continue;
		const header = names.length > 1 ? `${name}:` : '';
		const rows = issues.map((it) => listRow(doc, it));
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

function frontierRow(it: Issue): string {
	const more = it.detail.length ? ' …' : '';
	return `  ${it.id}  ${it.title}${more}`;
}

/** `ready` — the whole ordered takeable frontier (§4.2); empty is diagnosed (§4.5). */
export function cmdReady(doc: Doc, filters: FrontierFilters = {}): string {
	const items = frontier(doc, filters);
	if (!items.length) return diagnoseEmpty(doc, filters);
	return items.map(frontierRow).join('\n');
}

/** `next` — the topmost takeable issue (`ready[0]`), or the same empty-diagnosis. */
export function cmdNext(doc: Doc, filters: FrontierFilters = {}): string {
	const top = frontier(doc, { ...filters, limit: undefined })[0];
	return top ? frontierRow(top) : diagnoseEmpty(doc, filters);
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

// One issue's forest lines: `⊘`-annotated when blocked (never drawn as structure —
// §5 decision 13), tagged with its section when closed, then its subtree indented.
// `seen` guards a pathological `part-of:` cycle from recursing forever.
function treeLines(doc: Doc, issue: Issue, depth: number, seen = new Set<string>()): string[] {
	const indent = '  '.repeat(depth + 1);
	if (seen.has(issue.id)) return [`${indent}${issue.id} (part-of cycle)`];
	seen.add(issue.id);
	const flag = isBlocked(doc, issue) ? '⊘ ' : '';
	const found = findIssue(doc, issue.id);
	const tag = found && found.section !== OPEN_SECTION ? ` [${found.section}]` : '';
	const out = [`${indent}${flag}${issue.id}  ${issue.title}${markers(issue)}${tag}`];
	for (const k of childrenOf(doc, issue.id)) out.push(...treeLines(doc, k, depth + 1, seen));
	return out;
}

/**
 * `tree` — the containment-only forest (§5 decision 13), state-annotated. Roots are
 * issues with no valid parent (top-level or dangling `part-of:`); children nest by
 * `part-of:`. Blocking is a node annotation (`⊘`), never tree structure.
 */
export function cmdTree(doc: Doc): string {
	const roots = rootsOf(doc);
	if (!roots.length) return 'No issues.';
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const r of roots) lines.push(...treeLines(doc, r, 0, seen));
	return lines.join('\n');
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
	out.push(...malformedLines(text));
	return out;
}

// Lines inside a section that are neither an issue line, an indented note, nor blank —
// content the parser would silently drop. Scanned off the raw text (the model has
// already discarded them).
function malformedLines(text: string): string[] {
	const out: string[] = [];
	let inSection = false;
	for (const line of text.split('\n')) {
		if (/^## /.test(line)) {
			inSection = true;
			continue;
		}
		if (!inSection || line.trim() === '') continue;
		if (ISSUE_RE.test(line) || /^\s+/.test(line)) continue;
		out.push(`malformed line (not an issue or note): ${line.trim()}`);
	}
	return out;
}

/** `doctor` — human-readable grouped findings; exit code is the caller's job (§5 decision 19). */
export function cmdDoctor(doc: Doc, text: string): string {
	const findings = doctorFindings(doc, text);
	if (!findings.length) return 'No issues found — clean.';
	const lines = [`${findings.length} finding${findings.length === 1 ? '' : 's'}:`];
	for (const f of findings) lines.push(`  · ${f}`);
	return lines.join('\n');
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

export function cmdDoctorJson(doc: Doc, text: string) {
	const findings = doctorFindings(doc, text);
	return { ok: findings.length === 0, findings };
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

type FlagValue = string | boolean | string[];

function parseArgs(argv: string[]): {
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
  list [--all|--closed|--deferred|--wontfix] [filters]  list issues (default: open)
  next   [filters]                                       the topmost takeable issue
  ready  [filters] [--limit N]                           the whole takeable frontier
  show <id> [--children]                                 full resolved dossier
  tree                                                   containment forest (⊘ = blocked)
  doctor                                                 lint the file (exit nonzero on findings)

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

filters (list/next/ready): --status <s> | --label <n> | --parent <id> | --assignee <who>
         (AND across dimensions, OR within a repeated/comma-listed dimension)`;

export interface RunResult {
	text: string; // resulting file contents (unchanged unless `mutated`)
	output: string; // text to print to stdout
	mutated: boolean; // whether the file should be written back
	warnings: string[]; // advisory §3 messages — bin.ts prints to stderr, never mixed into `output`
	exitCode?: number; // defaults to 0; `doctor` sets 1 on findings (the sole exception)
}

// Fill the advisory defaults so each dispatch arm names only what it produces —
// most commands emit no warnings. Later stages pass `warnings`/`exitCode` explicitly.
function result(fields: Omit<RunResult, 'warnings'> & { warnings?: string[] }): RunResult {
	return { warnings: [], ...fields };
}

/** Pure command runner — no filesystem access, for testing and reuse. */
export function run(text: string, argv: string[]): RunResult {
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
	const advisories = (): string[] => (quiet ? [] : graphWarnings(doc));
	// Write-time advisories for an edge-touching mutation (§5 decision 8): only the
	// warnings that name the issue whose edge just changed.
	const edgeAdvisories = (id: string): string[] => (quiet ? [] : warningsFor(doc, id));

	switch (cmd) {
		// ── Reads ────────────────────────────────────────────────────────────────
		case 'list': {
			const opts: ListOptions = {
				all: !!flags.all,
				closed: !!flags.closed,
				deferred: !!flags.deferred,
				wontfix: !!flags.wontfix
			};
			const filters = readFilters(flags);
			const output = wantJson ? jsonOut(cmdListJson(doc, opts, filters)) : cmdList(doc, opts, filters);
			return result({ text, mutated: false, output, warnings: advisories() });
		}
		case 'next': {
			const filters = readFilters(flags);
			const output = wantJson ? jsonOut(cmdNextJson(doc, filters)) : cmdNext(doc, filters);
			return result({ text, mutated: false, output, warnings: advisories() });
		}
		case 'ready': {
			const filters = readFilters(flags);
			const output = wantJson ? jsonOut(cmdReadyJson(doc, filters)) : cmdReady(doc, filters);
			return result({ text, mutated: false, output, warnings: advisories() });
		}
		case 'show': {
			const id = need(1, 'id');
			const opts: ShowOptions = { children: !!flags.children, quiet };
			// `show` folds its issue's warnings into the dossier/JSON itself (§5 decision
			// 17), so it does not also duplicate them on the stderr channel.
			const output = wantJson ? jsonOut(cmdShowJson(doc, id, opts)) : cmdShow(doc, id, opts);
			return result({ text, mutated: false, output });
		}
		case 'tree': {
			const output = wantJson ? jsonOut(cmdTreeJson(doc)) : cmdTree(doc);
			return result({ text, mutated: false, output, warnings: advisories() });
		}
		case 'doctor': {
			// The one exit-code exception (§5 decision 19): findings are the actionable
			// signal, so a non-empty report exits nonzero. Findings ride stdout, not stderr.
			const findings = doctorFindings(doc, text);
			const output = wantJson ? jsonOut(cmdDoctorJson(doc, text)) : cmdDoctor(doc, text);
			return result({ text, mutated: false, output, exitCode: findings.length ? 1 : 0 });
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
