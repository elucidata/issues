/**
 * PROTOTYPE runner — wayfinder ticket #3 (keystone representation).
 *
 * QUESTION: How should relationships + metadata (blocked-by, part-of, assignee,
 * labels, type, status) be physically represented inside a single hand-editable
 * `ISSUES.md`, such that (a) a human still reads it at a glance and (b) a
 * metadata-free file round-trips byte-for-byte?
 *
 * This driver renders three concrete encodings side by side, proves round-trip
 * for each, shows the derived relationship graph, and demonstrates why the
 * nested-list encoding is hostile to the current line grammar. Then it drops
 * into an interactive loop so you can close/reopen issues and watch the derived
 * "blocked" / frontier state recompute from the inline encoding.
 *
 *   Run:  node prototypes/keystone-representation/run.ts
 *         (or: bun prototypes/keystone-representation/run.ts)
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseDoc, serializeDoc, derive } from './meta.ts';

const B = '\x1b[1m';
const D = '\x1b[2m';
const G = '\x1b[32m';
const R = '\x1b[31m';
const Y = '\x1b[33m';
const X = '\x1b[0m';

const here = dirname(fileURLToPath(import.meta.url));
const sample = (name: string) => readFileSync(join(here, 'samples', name), 'utf8');

function roundTrip(name: string, conv: 'inline' | 'field-lines' | 'nested', text: string) {
	const out = serializeDoc(parseDoc(text, conv), conv);
	const ok = out === text;
	const verdict = ok ? `${G}✓ byte-identical${X}` : `${R}✗ DRIFT${X}`;
	console.log(`  ${B}${name}${X}  round-trip: ${verdict}`);
	if (!ok) {
		const a = text.split('\n');
		const b = out.split('\n');
		for (let i = 0; i < Math.max(a.length, b.length); i++) {
			if (a[i] !== b[i]) console.log(`    ${D}L${i + 1}${X} ${R}- ${a[i]}${X}\n         ${G}+ ${b[i]}${X}`);
		}
	}
	return ok;
}

function showGraph(conv: 'inline' | 'field-lines' | 'nested', text: string) {
	const d = derive(parseDoc(text, conv));
	for (const n of d) {
		const bits: string[] = [];
		if (n.parent) bits.push(`${D}part-of ${n.parent}${X}`);
		if (n.blockedByOpen.length) bits.push(`${Y}blocked-by ${n.blockedByOpen.join(',')}${X}`);
		if (n.claimed) bits.push(`${D}claimed${X}`);
		const tag = !n.open
			? `${D}closed${X}`
			: n.blocked
				? `${Y}BLOCKED${X}`
				: n.frontier
					? `${G}FRONTIER${X}`
					: `${D}open${X}`;
		console.log(`    ${B}${n.id}${X} ${tag}  ${bits.join('  ')}`);
	}
}

// The CURRENT real grammar: any indented line under an issue is a detail note.
// This is what makes the nested-list encoding lossy without a grammar rewrite.
function realGrammarSwallow(text: string) {
	const lines = text.split('\n');
	let inIssues = false;
	let last: { id: string; detail: string[] } | null = null;
	const parsed: { id: string; detail: string[] }[] = [];
	for (const line of lines) {
		if (/^## /.test(line)) {
			inIssues = /^## Issues/.test(line);
			continue;
		}
		if (!inIssues || line.trim() === '') continue;
		const m = line.match(/^- \[[ xX]\] ([A-Za-z]*[0-9]+): (.*)$/); // flush-left only
		if (m) {
			last = { id: m[1] as string, detail: [] };
			parsed.push(last);
		} else if (/^\s+/.test(line) && last) {
			last.detail.push(line.trimStart());
		}
	}
	return parsed;
}

function report() {
	console.log(`\n${B}═══ Keystone representation — three encodings ═══${X}\n`);

	console.log(`${B}① INLINE trailing fields${X} ${D}(todo.txt style — research's pick)${X}`);
	console.log(indent(sample('inline.md').split('\n').slice(10, 14).join('\n')));
	roundTrip('inline.md   ', 'inline', sample('inline.md'));
	roundTrip('plain.md    ', 'inline', sample('plain.md'));
	console.log(`  ${D}derived graph:${X}`);
	showGraph('inline', sample('inline.md'));

	console.log(`\n${B}② FIELD detail-lines${X} ${D}(labeled Key: value note lines — most English-readable)${X}`);
	console.log(indent(sample('field-lines.md').split('\n').slice(10, 18).join('\n')));
	roundTrip('field-lines.md', 'field-lines', sample('field-lines.md'));
	roundTrip('plain.md      ', 'field-lines', sample('plain.md'));
	console.log(`  ${D}derived graph:${X}`);
	showGraph('field-lines', sample('field-lines.md'));

	console.log(`\n${B}③ NESTED list${X} ${D}(parent/child via indentation)${X}`);
	console.log(indent(sample('nested.md').split('\n').slice(10, 16).join('\n')));
	roundTrip('nested.md   ', 'nested', sample('nested.md'));
	console.log(`  ${R}⚠ but under the CURRENT real grammar, indented issue lines are swallowed as notes:${X}`);
	for (const p of realGrammarSwallow(sample('nested.md'))) {
		console.log(`    ${B}${p.id}${X} detail: ${JSON.stringify(p.detail)}`);
	}
	console.log(
		`  ${R}→ 007 and 008 vanish into 002's detail. Nesting needs a line-grammar rewrite;${X}\n` +
			`  ${R}  a metadata-free file with real indented notes becomes ambiguous. Round-trip hazard.${X}`
	);

	console.log(`\n${B}RECOMMENDATION${X} ${D}(react to this)${X}`);
	console.log(
		`  Hybrid = encoding ① as source of truth (inline pointers, read but never\n` +
			`  restructured), with list-indentation allowed ONLY as a display hint the\n` +
			`  parser ignores. ② is a fine alternative when English labels matter more\n` +
			`  than density. ③ alone is rejected: indentation as load-bearing structure\n` +
			`  breaks the byte-for-byte round-trip.\n`
	);
}

function indent(s: string) {
	return D + s.split('\n').map((l) => '    │ ' + l).join('\n') + X;
}

// ── Interactive: close/reopen and watch the frontier recompute (encoding ①) ─
function interactive() {
	const doc = parseDoc(sample('inline.md'), 'inline');
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const render = () => {
		console.clear();
		console.log(`${B}Interactive frontier — encoding ① (inline)${X}  ${D}state lives in memory${X}\n`);
		showGraph2(doc);
		console.log(
			`\n${D}[close <id>] [open <id>] [claim <id>] [unclaim <id>] [q]uit${X}\n` +
				`${D}Watch: close 004 → 007 leaves BLOCKED. claim 007 → drops off FRONTIER.${X}`
		);
		rl.question('> ', handle);
	};
	const move = (id: string, to: string) => {
		for (const [name, arr] of doc.sections) {
			const i = arr.findIndex((x) => x.id === pad(id));
			if (i >= 0) {
				const [it] = arr.splice(i, 1);
				it!.checked = to === 'Completed';
				doc.sections.get(to)!.push(it!);
				return;
			}
		}
	};
	const setClaim = (id: string, who: string | undefined) => {
		for (const [, arr] of doc.sections)
			for (const it of arr) if (it.id === pad(id)) it.meta.assignee = who;
	};
	const handle = (input: string) => {
		const [cmd, arg] = input.trim().split(/\s+/);
		if (cmd === 'q') return rl.close();
		if (cmd === 'close' && arg) move(arg, 'Completed');
		if (cmd === 'open' && arg) move(arg, 'Issues');
		if (cmd === 'claim' && arg) setClaim(arg, 'matt');
		if (cmd === 'unclaim' && arg) setClaim(arg, undefined);
		render();
	};
	render();
}

function showGraph2(doc: ReturnType<typeof parseDoc>) {
	const d = derive(doc);
	for (const n of d) {
		const bits: string[] = [];
		if (n.parent) bits.push(`${D}part-of ${n.parent}${X}`);
		if (n.blockedByOpen.length) bits.push(`${Y}blocked-by ${n.blockedByOpen.join(',')}${X}`);
		if (n.claimed) bits.push(`${D}claimed${X}`);
		const tag = !n.open
			? `${D}closed${X}`
			: n.blocked
				? `${Y}BLOCKED ${X}`
				: n.frontier
					? `${G}FRONTIER${X}`
					: `${D}open    ${X}`;
		console.log(`  ${B}${n.id}${X} ${tag}  ${bits.join('  ')}`);
	}
}

function pad(id: string) {
	const m = id.match(/^([A-Za-z]*)([0-9]+)$/);
	return m ? (m[1] ?? '') + (m[2] ?? '').padStart(3, '0') : id;
}

report();
if (process.argv.includes('--interactive') || process.argv.includes('-i')) interactive();
else console.log(`${D}Re-run with --interactive to drive the frontier by hand.${X}`);
