/**
 * Issue tracker for the project's `ISSUES.md` log — pure library core.
 *
 * This module is filesystem-free: it parses, serializes, and runs commands over
 * the ISSUES.md text. The thin CLI shell that reads and writes the file lives in
 * `./bin.ts`.
 *
 * Commands (dispatched by `run`):
 *   list [--all] [--closed] [--deferred] [--wontfix]   list issues (default: open)
 *   add "<title>" [--note "<text>"]                     add a new open issue
 *   done <id> [--defer] [--wontfix]                     close/defer/wontfix an issue
 *   reopen <id>                                         move an issue back to open
 *   show <id>                                           print an issue with its note
 *   edit <id> "<title>"                                 replace an issue's title
 *   note <id> "<text>"                                  append a line to an issue's note
 *   help                                               show usage
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
export interface Issue {
	id: string; // canonical id, e.g. "007" (or "M007" under a prefixed pattern)
	num: number; // numeric portion, e.g. 7
	checked: boolean;
	title: string;
	date?: string; // ISO YYYY-MM-DD datestamp when closed/deferred
	blockedBy: string[]; // `blocked-by:` id pointers, verbatim (read-only; §1.2)
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
// A trailing `blocked-by:<id[,id]>` field peels off the tail of the issue line
// (§1.2). T1 recognizes this one field; the rest of the tail vocabulary arrives
// in T2. Value is comma-separated ids, stored verbatim so it round-trips.
const BLOCKED_BY_SUFFIX_RE = /^(.*?)\s+blocked-by:([A-Za-z0-9]+(?:,[A-Za-z0-9]+)*)$/;

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
	// Peel the `blocked-by:` field off the tail (before the date suffix). Ids are
	// kept verbatim — they are read-only pointers, normalized only at comparison.
	let blockedBy: string[] = [];
	const bm = title.match(BLOCKED_BY_SUFFIX_RE);
	if (bm) {
		title = bm[1] ?? title;
		blockedBy = (bm[2] ?? '').split(',');
	}
	return { id: normalizeId(id, pattern), num: idNum(id), checked, title, date, blockedBy, detail: [] };
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
	// Tail fields re-emit after the title, before the date suffix (§1.2). T1: only
	// `blocked-by:`. An empty list writes nothing, so metadata-free lines are untouched.
	if (issue.blockedBy.length) line += ` blocked-by:${issue.blockedBy.join(',')}`;
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
export function cmdAdd(doc: Doc, title: string, note?: string): string {
	const id = formatId(doc.nextId, doc.pattern);
	const detail = note ? note.split('\n').map((l) => l.trimStart()) : [];
	doc.sections
		.get(OPEN_SECTION)!
		.push({ id, num: doc.nextId, checked: false, title, blockedBy: [], detail });
	doc.nextId += 1;
	return `Added ${id}: ${title}`;
}

export function cmdDone(doc: Doc, idInput: string, target: SectionName = DONE_SECTION): string {
	const found = requireIssue(doc, idInput);
	if (found.section === target) throw new Error(`${found.issue.id} is already in ${target}.`);
	const issue = move(doc, found, target);
	issue.checked = CHECKED_SECTIONS.has(target);
	issue.date = today();
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

export function cmdShow(doc: Doc, idInput: string): string {
	const { section, issue } = requireIssue(doc, idInput);
	const mark = issue.checked ? ' [x]' : '';
	const date = issue.date ? ` (${issue.date})` : '';
	const lines = [`${issue.id} — ${section}${mark}${date}`, issue.title];
	for (const d of issue.detail) lines.push(`    ${d}`);
	return lines.join('\n');
}

export interface ListOptions {
	all?: boolean;
	closed?: boolean;
	deferred?: boolean;
	wontfix?: boolean;
}

export function cmdList(doc: Doc, opts: ListOptions = {}): string {
	let names: SectionName[];
	if (opts.all) names = [...SECTION_ORDER];
	else {
		const set = new Set<SectionName>();
		if (opts.closed) [DONE_SECTION, DEFER_SECTION, WONTFIX_SECTION].forEach((s) => set.add(s));
		if (opts.deferred) set.add(DEFER_SECTION);
		if (opts.wontfix) set.add(WONTFIX_SECTION);
		names = set.size ? SECTION_ORDER.filter((n) => set.has(n)) : [OPEN_SECTION];
	}

	const blocks: string[] = [];
	for (const name of names) {
		const issues = doc.sections.get(name) ?? [];
		if (!issues.length) continue;
		const header = names.length > 1 ? `${name}:` : '';
		const rows = issues.map((it) => {
			const date = it.date ? ` (${it.date})` : '';
			const more = it.detail.length ? ' …' : '';
			return `  ${it.id}  ${it.title}${date}${more}`;
		});
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
	const ids = new Set<string>();
	for (const it of doc.sections.get(OPEN_SECTION) ?? []) ids.add(it.id);
	return ids;
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
	return issue.blockedBy.some((b) => open.has(normalizeId(b, doc.pattern)));
}

/**
 * The takeable frontier: open issues whose every blocker is closed, in document
 * order (§4.1). The claim gate and filters arrive in a later stage (T3); this
 * first cut is open ∩ unblocked.
 */
export function frontier(doc: Doc): Issue[] {
	return (doc.sections.get(OPEN_SECTION) ?? []).filter((it) => !isBlocked(doc, it));
}

function frontierRow(it: Issue): string {
	const more = it.detail.length ? ' …' : '';
	return `  ${it.id}  ${it.title}${more}`;
}

/** `ready` — the whole ordered takeable frontier (§4.2). Read-only. */
export function cmdReady(doc: Doc): string {
	const items = frontier(doc);
	if (!items.length) return 'No takeable issues.';
	return items.map(frontierRow).join('\n');
}

/** `next` — the topmost takeable issue (`ready[0]`), or a normal empty state. */
export function cmdNext(doc: Doc): string {
	const top = frontier(doc)[0];
	return top ? frontierRow(top) : 'No takeable issues.';
}

// ── CLI dispatch ───────────────────────────────────────────────────────────
const VALUE_FLAGS = new Set(['note']);

function parseArgs(argv: string[]): {
	positionals: string[];
	flags: Record<string, string | boolean>;
} {
	const positionals: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i] ?? '';
		if (tok.startsWith('--')) {
			const body = tok.slice(2);
			const eq = body.indexOf('=');
			if (eq !== -1) flags[body.slice(0, eq)] = body.slice(eq + 1);
			else if (VALUE_FLAGS.has(body)) flags[body] = argv[++i] ?? '';
			else flags[body] = true;
		} else {
			positionals.push(tok);
		}
	}
	return { positionals, flags };
}

const HELP = `Usage: issues <command> [args]

  list [--all] [--closed] [--deferred] [--wontfix]   list issues (default: open)
  next                                                the topmost takeable issue
  ready                                               the whole takeable frontier
  add "<title>" [--note "<text>"]                     add a new open issue
  done <id> [--defer] [--wontfix]                     close / defer / wontfix an issue
  reopen <id>                                         move an issue back to open
  show <id>                                           print an issue with its note
  edit <id> "<title>"                                 replace an issue's title
  note <id> "<text>"                                  append a line to an issue's note
  help                                               show this message`;

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

	switch (cmd) {
		case 'list':
			return result({
				text,
				mutated: false,
				output: cmdList(doc, {
					all: !!flags.all,
					closed: !!flags.closed,
					deferred: !!flags.deferred,
					wontfix: !!flags.wontfix
				})
			});
		case 'next':
			return result({ text, mutated: false, output: cmdNext(doc) });
		case 'ready':
			return result({ text, mutated: false, output: cmdReady(doc) });
		case 'show':
			return result({ text, mutated: false, output: cmdShow(doc, need(1, 'id')) });
		case 'add': {
			const note = typeof flags.note === 'string' ? flags.note : undefined;
			const msg = cmdAdd(doc, need(1, 'title'), note);
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
