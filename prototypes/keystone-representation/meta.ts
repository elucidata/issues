/**
 * PROTOTYPE — throwaway. Answers wayfinder ticket #3 (keystone representation).
 *
 * Pure, filesystem-free module. Mirrors the real `src/index.ts` grammar and
 * extends it three ways so we can compare, round-trip, and derive relationships
 * from each. Only the winning convention's parse/serialize is meant to fold back
 * into the real core; the rest is here to be reacted to and discarded.
 *
 * The load-bearing invariant under test: `serialize(parse(x)) === x` — and in
 * particular, a METADATA-FREE file must stay byte-identical.
 */

// ── Shared grammar (verbatim from src/index.ts) ────────────────────────────
const ISSUE_RE = /^- \[([ xX])\] ([A-Za-z]*[0-9]+): (.*)$/;
const DATE_SUFFIX_RE = /^(.*?) \((\d{4}-\d{2}-\d{2})\)$/;
const SECTION_ORDER = ['Issues', 'Completed', 'Deferred', "Won't Fix"];
const DETAIL_INDENT = '      '; // 6 spaces

// The metadata a ticket can carry, once derived from whichever encoding.
export interface Meta {
	partOf?: string; // parent id
	blockedBy: string[]; // direct blocker ids
	type?: string;
	status?: string;
	assignee?: string;
	labels: string[];
	unknown: string[]; // preserved-verbatim key:value tokens we don't recognize
}

export interface PIssue {
	id: string;
	checked: boolean;
	title: string; // human title only — metadata stripped out
	date?: string;
	detail: string[]; // free-text notes only — field-lines stripped out
	meta: Meta;
	nesting: number; // presentation-only indent depth (hybrid); 0 = flush left
}

export interface PDoc {
	head: string; // frontmatter + preamble, preserved verbatim
	sections: Map<string, PIssue[]>;
}

function emptyMeta(): Meta {
	return { blockedBy: [], labels: [], unknown: [] };
}

// Split the file into a verbatim head (up to first `## `) and the section body.
function splitHead(text: string): { head: string; bodyFrom: number; lines: string[] } {
	const lines = text.split('\n');
	let first = lines.length;
	for (let i = 0; i < lines.length; i++) {
		if (/^## /.test(lines[i] ?? '')) {
			first = i;
			break;
		}
	}
	return { head: lines.slice(0, first).join('\n'), bodyFrom: first, lines };
}

function baseTitle(rest: string): { title: string; date?: string } {
	const dm = rest.match(DATE_SUFFIX_RE);
	if (dm) return { title: dm[1] ?? rest, date: dm[2] };
	return { title: rest };
}

// ── Convention 1: inline trailing fields (todo.txt style) ──────────────────
// `- [ ] 007: Title. part-of:002 blocked-by:004 type:bug @matt #parser`
// Fields are a contiguous run at the END of the title. We peel tokens off the
// end while they look like a field; the first non-field token stops the peel,
// so a title containing a stray `word:word` in prose is safe.
const KV_RE = /^([a-z][a-z-]*):(.+)$/;
const AT_RE = /^@([^\s]+)$/;
const HASH_RE = /^#([^\s]+)$/;
const KNOWN_KEYS = new Set(['part-of', 'blocked-by', 'type', 'status']);

function isFieldToken(tok: string): boolean {
	return AT_RE.test(tok) || HASH_RE.test(tok) || KV_RE.test(tok);
}

function parseInlineMeta(rest: string): { title: string; date?: string; meta: Meta } {
	const meta = emptyMeta();
	const words = rest.split(' ');
	// Peel field tokens off the tail.
	let cut = words.length;
	while (cut > 0 && isFieldToken(words[cut - 1] ?? '')) cut--;
	const fieldToks = words.slice(cut);
	const titleRaw = words.slice(0, cut).join(' ');
	for (const tok of fieldToks) {
		const at = tok.match(AT_RE);
		const hash = tok.match(HASH_RE);
		const kv = tok.match(KV_RE);
		if (at) meta.assignee = at[1];
		else if (hash) meta.labels.push(hash[1] as string);
		else if (kv) {
			const k = kv[1] as string;
			const v = kv[2] as string;
			if (k === 'part-of') meta.partOf = v;
			else if (k === 'blocked-by') meta.blockedBy.push(...v.split(','));
			else if (k === 'type') meta.type = v;
			else if (k === 'status') meta.status = v;
			else meta.unknown.push(tok); // UDA: keep verbatim
		}
	}
	const { title, date } = baseTitle(titleRaw);
	return { title, date, meta };
}

function serializeInlineFields(meta: Meta): string {
	const toks: string[] = [];
	if (meta.partOf) toks.push(`part-of:${meta.partOf}`);
	if (meta.blockedBy.length) toks.push(`blocked-by:${meta.blockedBy.join(',')}`);
	if (meta.type) toks.push(`type:${meta.type}`);
	if (meta.status) toks.push(`status:${meta.status}`);
	if (meta.assignee) toks.push(`@${meta.assignee}`);
	for (const l of meta.labels) toks.push(`#${l}`);
	for (const u of meta.unknown) toks.push(u);
	return toks.join(' ');
}

// ── Convention 2: field detail-lines (closed vocabulary) ───────────────────
// Indented `Key: value` note lines under an issue are recognized as fields;
// anything else stays free-text detail.
const FIELD_LINE_RE = /^(Part of|Blocked by|Type|Status|Assignee|Labels): (.*)$/;

function applyFieldLine(meta: Meta, key: string, val: string): void {
	if (key === 'Part of') meta.partOf = val.trim();
	else if (key === 'Blocked by') meta.blockedBy.push(...val.split(',').map((s) => s.trim()));
	else if (key === 'Type') meta.type = val.trim();
	else if (key === 'Status') meta.status = val.trim();
	else if (key === 'Assignee') meta.assignee = val.trim().replace(/^@/, '');
	else if (key === 'Labels') meta.labels.push(...val.split(',').map((s) => s.trim()));
}

function serializeFieldLines(meta: Meta): string[] {
	const out: string[] = [];
	if (meta.partOf) out.push(`Part of: ${meta.partOf}`);
	if (meta.blockedBy.length) out.push(`Blocked by: ${meta.blockedBy.join(', ')}`);
	if (meta.type) out.push(`Type: ${meta.type}`);
	if (meta.status) out.push(`Status: ${meta.status}`);
	if (meta.assignee) out.push(`Assignee: @${meta.assignee}`);
	if (meta.labels.length) out.push(`Labels: ${meta.labels.join(', ')}`);
	return out;
}

// ── Parse / serialize, parameterized by convention ─────────────────────────
export type Convention = 'inline' | 'field-lines' | 'nested';

export function parseDoc(text: string, conv: Convention): PDoc {
	const { head, bodyFrom, lines } = splitHead(text);
	const sections = new Map<string, PIssue[]>();
	let current: PIssue[] | null = null;
	let last: PIssue | null = null;

	for (let j = bodyFrom; j < lines.length; j++) {
		const line = lines[j] ?? '';
		const head2 = line.match(/^## (.+?)\s*$/);
		if (head2) {
			current = [];
			sections.set(head2[1] as string, current);
			last = null;
			continue;
		}
		if (current === null || line.trim() === '') continue;

		// An issue line — possibly indented, if this convention nests.
		const indentMatch = line.match(/^(\s*)(- \[.*)$/);
		const indent = indentMatch ? (indentMatch[1] as string) : '';
		const core = indentMatch ? (indentMatch[2] as string) : line;
		const m = core.match(ISSUE_RE);

		if (m && (conv === 'nested' || indent === '')) {
			// nested: an indented issue line is a child; others: only flush-left.
			const { title, date, meta } =
				conv === 'inline'
					? parseInlineMeta(m[3] ?? '')
					: { ...baseTitle(m[3] ?? ''), meta: emptyMeta() };
			last = {
				id: normId(m[2] ?? ''),
				checked: m[1] !== ' ',
				title,
				date,
				detail: [],
				meta,
				nesting: conv === 'nested' ? indent.replace(/\t/g, '  ').length / 2 : 0
			};
			current.push(last);
			continue;
		}

		// Indented continuation → note or field-line for the preceding issue.
		if (/^\s+/.test(line) && last) {
			const body = line.trimStart();
			const fm = conv === 'field-lines' ? body.match(FIELD_LINE_RE) : null;
			if (fm) applyFieldLine(last.meta, fm[1] as string, fm[2] as string);
			else last.detail.push(body);
		}
	}
	return { head, sections };
}

export function serializeDoc(doc: PDoc, conv: Convention): string {
	// Mirror the real serialize: the head (frontmatter + preamble) has its
	// trailing blank lines trimmed, and sections are rejoined with `\n\n`.
	let out = doc.head.replace(/\n+$/, '');
	for (const name of SECTION_ORDER) {
		const issues = doc.sections.get(name) ?? [];
		out += `\n\n## ${name}`;
		if (issues.length) out += '\n\n' + issues.map((it) => renderIssue(it, conv)).join('\n');
	}
	return out + '\n';
}

function renderIssue(it: PIssue, conv: Convention): string {
	const box = it.checked ? 'x' : ' ';
	const pad = conv === 'nested' ? '\t'.repeat(it.nesting) : '';
	let line = `${pad}- [${box}] ${it.id}: ${it.title}`;
	if (conv === 'inline') {
		const fields = serializeInlineFields(it.meta);
		if (fields) line += ' ' + fields;
	}
	if (it.date) line += ` (${it.date})`;
	const detailIndent = pad + DETAIL_INDENT;
	const fieldLines = conv === 'field-lines' ? serializeFieldLines(it.meta) : [];
	const detail = [...fieldLines, ...it.detail].map((d) => detailIndent + d);
	return [line, ...detail].join('\n');
}

function normId(id: string): string {
	const m = id.match(/^([A-Za-z]*)([0-9]+)$/);
	if (!m) return id;
	return (m[1] ?? '') + (m[2] ?? '').padStart(3, '0');
}

// ── Derive the relationship graph from parsed metadata ─────────────────────
// Read-only: demonstrates the representation carries enough to compute blocking
// and the frontier. (The actual graph/frontier *semantics* are #5/#6's call.)
export interface Derived {
	id: string;
	open: boolean;
	parent?: string;
	blockedByOpen: string[]; // blockers still open
	blocked: boolean; // derived, never stored
	claimed: boolean;
	frontier: boolean; // open & !blocked & !claimed
}

export function derive(doc: PDoc): Derived[] {
	const all: PIssue[] = [];
	const openIds = new Set<string>();
	for (const [name, issues] of doc.sections) {
		for (const it of issues) {
			all.push(it);
			if (name === 'Issues') openIds.add(it.id);
		}
	}
	return all.map((it) => {
		const open = openIds.has(it.id);
		const blockedByOpen = it.meta.blockedBy.map(normId).filter((b) => openIds.has(b));
		const blocked = blockedByOpen.length > 0;
		const claimed = !!it.meta.assignee;
		return {
			id: it.id,
			open,
			parent: it.meta.partOf ? normId(it.meta.partOf) : undefined,
			blockedByOpen,
			blocked,
			claimed,
			frontier: open && !blocked && !claimed
		};
	});
}
