// PROTOTYPE — throwaway. Answers issue #20: what does a rendered row look like?
// Not wired to src/. Renders fixed sample data through several colour schemes.
// Run: bun prototype-rendered-line.ts [all|A|B|C|D] [--light]

const e = (n: number) => `\x1b[${n}m`;
const R = e(0);
// 8/16-colour floor only. No 256/truecolour, no bright-white/black (unsafe on
// one background or the other).
const C = {
	dim: e(2),
	bold: e(1),
	red: e(31),
	green: e(32),
	yellow: e(33),
	blue: e(34),
	magenta: e(35),
	cyan: e(36)
};

type State = 'open' | 'claimed' | 'blocked' | 'done' | 'defer' | 'wontfix';

const GLYPH: Record<State, string> = {
	open: '-',
	claimed: '~',
	blocked: '⊘',
	done: '✓',
	defer: '»',
	wontfix: '×'
};

type Row = {
	id: string;
	title: string;
	state: State;
	status?: string;
	assignee?: string;
	labels?: string[];
	note?: boolean;
	depth?: number;
	scaffold?: boolean; // non-matching ancestor kept as context in `tree`
};

const LIST: Row[] = [
	{ id: 'ISS-3', title: 'Parser drops trailing blank line', state: 'blocked', status: 'wip', labels: ['bug'] },
	{ id: 'ISS-7', title: 'Add --plain mode', state: 'claimed', assignee: 'matt', labels: ['cli', 'ux'] },
	{ id: 'ISS-9', title: 'Frontier query ignores deferred blockers', state: 'open', status: 'ready', labels: ['bug'], note: true },
	{ id: 'ISS-12', title: 'Document the schema compat contract', state: 'open' }
];

const CLOSED: Row[] = [
	{ id: 'ISS-1', title: 'Byte-for-byte round-trip guard', state: 'done', labels: ['core'] },
	{ id: 'ISS-4', title: 'SQLite backend', state: 'wontfix' },
	{ id: 'ISS-5', title: 'Interactive TUI', state: 'defer', labels: ['ux'] }
];

// A filtered `tree` (--label bug): ISS-2 and ISS-6 match nothing themselves but
// are kept so containment is not distorted.
const TREE: Row[] = [
	{ id: 'ISS-2', title: 'Markdown parser', state: 'open', depth: 0, scaffold: true },
	{ id: 'ISS-3', title: 'Parser drops trailing blank line', state: 'blocked', status: 'wip', labels: ['bug'], depth: 1 },
	{ id: 'ISS-6', title: 'Query engine', state: 'claimed', assignee: 'matt', depth: 0, scaffold: true },
	{ id: 'ISS-9', title: 'Frontier query ignores deferred blockers', state: 'open', status: 'ready', labels: ['bug'], depth: 1, note: true }
];

// ── Scheme A: divide labour ────────────────────────────────────────────────
// Glyph alone says state. Colour says *element type* — the same field is the
// same colour on every row, so the eye learns four fixed columns.
const A = (r: Row) => ({
	glyph: C.dim + GLYPH[r.state] + R,
	id: C.cyan + r.id + R,
	title: r.title,
	status: (s: string) => C.yellow + 'status:' + s + R,
	assignee: (a: string) => C.magenta + '@' + a + R,
	label: (l: string) => C.blue + '#' + l + R
});

// ── Scheme B: double-encode ────────────────────────────────────────────────
// State drives colour for the whole row. Redundant with the glyph on purpose:
// survives a font that eats ⊘, and blocked work is findable by colour alone.
const STATE_COLOR: Record<State, string> = {
	open: '',
	claimed: C.yellow,
	blocked: C.red,
	done: C.green,
	defer: C.dim,
	wontfix: C.dim
};
const B = (r: Row) => {
	const c = STATE_COLOR[r.state];
	const p = (s: string) => (c ? c + s + R : s);
	return {
		glyph: p(GLYPH[r.state]),
		id: p(r.id),
		title: p(r.title),
		status: (s: string) => p('status:' + s),
		assignee: (a: string) => p('@' + a),
		label: (l: string) => p('#' + l)
	};
};

// ── Scheme C: hybrid ───────────────────────────────────────────────────────
// The gutter is the state channel — glyph *and* its colour. Everything right
// of the gutter is element-typed, as in A. Two channels, one job each.
const C_ = (r: Row) => ({
	glyph: (STATE_COLOR[r.state] || C.dim) + GLYPH[r.state] + R,
	id: C.cyan + r.id + R,
	title: r.state === 'done' || r.state === 'wontfix' || r.state === 'defer' ? C.dim + r.title + R : r.title,
	status: (s: string) => C.yellow + 'status:' + s + R,
	assignee: (a: string) => C.magenta + '@' + a + R,
	label: (l: string) => C.blue + '#' + l + R
});

// ── Scheme D: minimal ──────────────────────────────────────────────────────
// Colour used only where it earns its place: blocked (red glyph) and closed
// (dim row). Everything else is uncoloured. The "does colour help at all?" null
// hypothesis — worth seeing next to the others.
const D = (r: Row) => {
	const closed = r.state === 'done' || r.state === 'defer' || r.state === 'wontfix';
	const d = (s: string) => (closed ? C.dim + s + R : s);
	return {
		glyph: r.state === 'blocked' ? C.red + GLYPH[r.state] + R : d(GLYPH[r.state]),
		id: d(r.id),
		title: d(r.title),
		status: (s: string) => d('status:' + s),
		assignee: (a: string) => d('@' + a),
		label: (l: string) => d('#' + l)
	};
};

const SCHEMES = { A, B, C: C_, D } as const;
type Scheme = keyof typeof SCHEMES;

// ── Ancestor-scaffolding treatments (tree only) ────────────────────────────
// s1 dim-everything · s2 blank gutter · s3 dim + no markers · s4 title only
type Scaffold = 's1' | 's2' | 's3' | 's4';

function row(r: Row, scheme: Scheme, scaffold: Scaffold = 's1'): string {
	const f = SCHEMES[scheme](r);
	const indent = '  '.repeat(r.depth ?? 0);
	const isScaffold = !!r.scaffold;

	let glyph = f.glyph;
	let parts: string[] = [];
	if (r.status) parts.push(f.status(r.status));
	if (r.assignee) parts.push(f.assignee(r.assignee));
	for (const l of r.labels ?? []) parts.push(f.label(l));

	let id = f.id;
	let title = f.title;

	if (isScaffold) {
		if (scaffold === 's1') {
			// dim the whole row, keep structure identical
			glyph = C.dim + GLYPH[r.state] + R;
			id = C.dim + r.id + R;
			title = C.dim + r.title + R;
			parts = parts.map((p) => C.dim + p.replace(/\x1b\[\d+m/g, '') + R);
		} else if (scaffold === 's2') {
			// gutter goes blank — the glyph column means "this is a result"
			glyph = ' ';
		} else if (scaffold === 's3') {
			glyph = ' ';
			id = C.dim + r.id + R;
			title = C.dim + r.title + R;
			parts = [];
		} else if (scaffold === 's4') {
			glyph = ' ';
			id = C.dim + r.id + R;
			title = C.dim + r.title + R;
			parts = [];
			return `${indent}${glyph} ${id}  ${title}${C.dim}/${R}`;
		}
	}

	const note = r.note ? ' …' : '';
	return `${indent}${glyph} ${id}  ${title}${parts.length ? ' ' + parts.join(' ') : ''}${note}`;
}

function header(s: string) {
	return `${C.bold}${s}${R}`;
}

function renderScheme(scheme: Scheme, scaffold: Scaffold) {
	const notes: Record<Scheme, string> = {
		A: 'divide labour — glyph = state, colour = element type',
		B: 'double-encode — state drives the whole row’s colour',
		C: 'hybrid — coloured glyph is the state channel, rest element-typed',
		D: 'minimal — colour only for blocked and closed'
	};
	console.log(`\n${C.bold}${'═'.repeat(64)}${R}`);
	console.log(`${C.bold}  SCHEME ${scheme}${R}  ${C.dim}${notes[scheme]}${R}`);
	console.log(`${C.bold}${'═'.repeat(64)}${R}`);

	console.log(`\n${C.dim}$ issues list${R}`);
	console.log(header('\n## Issues'));
	for (const r of LIST) console.log(row(r, scheme));

	console.log(`\n${C.dim}$ issues list --all${R}  ${C.dim}(closed sections)${R}`);
	console.log(header('\n## Completed / Deferred / Won’t Fix'));
	for (const r of CLOSED) console.log(row(r, scheme));

	console.log(`\n${C.dim}$ issues tree --label bug${R}  ${C.dim}(scaffold treatment ${scaffold})${R}`);
	for (const r of TREE) console.log(row(r, scheme, scaffold));

	console.log(`\n${C.dim}$ issues next${R}`);
	console.log(row(LIST[3]!, scheme));

	console.log(`\n${C.dim}$ issues list --plain${R}  ${C.dim}(no colour, no glyph, postfix tags)${R}`);
	for (const r of LIST) {
		const m = [r.status && `status:${r.status}`, r.assignee && `@${r.assignee}`, ...(r.labels ?? []).map((l) => `#${l}`)]
			.filter(Boolean)
			.join(' ');
		const tag = r.state === 'blocked' ? ' [blocked]' : r.state === 'claimed' ? '' : '';
		console.log(`  ${r.id}  ${r.title}${m ? ' ' + m : ''}${tag}${r.note ? ' …' : ''}`);
	}
}

function scaffoldGallery(scheme: Scheme) {
	console.log(`\n${C.bold}${'═'.repeat(64)}${R}`);
	console.log(`${C.bold}  ANCESTOR SCAFFOLDING${R}  ${C.dim}(scheme ${scheme}, tree --label bug)${R}`);
	console.log(`${C.bold}${'═'.repeat(64)}${R}`);
	const desc: Record<Scaffold, string> = {
		s1: 'dim the whole row — same shape, lower contrast',
		s2: 'blank gutter — the glyph column *means* “a result”',
		s3: 'blank gutter + dim + markers stripped',
		s4: 'blank gutter + dim + trailing “/” (a path, not a result)'
	};
	for (const s of ['s1', 's2', 's3', 's4'] as Scaffold[]) {
		console.log(`\n  ${C.bold}${s}${R} ${C.dim}${desc[s]}${R}`);
		for (const r of TREE) console.log('  ' + row(r, scheme, s));
	}
}

// ── Glyph-set gallery ──────────────────────────────────────────────────────
// Locked to scheme C + s1 (decided) so the only variable is the glyph set.
// Coverage per the #21 research: ASCII < Latin-1 < WGL4 < everything else.
// `⊘` U+2298 is outside all three — the one character with a measured gap.
const SETS: { name: string; note: string; risk: string; g: Record<State, string> }[] = [
	{
		name: '0 · current',
		note: 'the map’s decided set — shown as the baseline',
		risk: '⊘ missing from Cascadia Mono (Windows Terminal default), SF Mono, Fira Code',
		g: { open: '-', claimed: '~', blocked: '⊘', done: '✓', defer: '»', wontfix: '×' }
	},
	{
		name: 'A · one-char repair',
		note: 'change only the broken glyph; ! replaces ⊘',
		risk: 'only ✓ is outside WGL4 — but gh ships it ungated on Windows and CI',
		g: { open: '-', claimed: '~', blocked: '!', done: '✓', defer: '»', wontfix: '×' }
	},
	{
		name: 'B · pure ASCII',
		note: 'nothing can ever fall back; survives LANG=C and piping to column/less',
		risk: 'none — but reads plainer, and + for done is weaker than a checkmark',
		g: { open: '-', claimed: '~', blocked: '!', done: '+', defer: '>', wontfix: 'x' }
	},
	{
		name: 'C · WGL4-strict',
		note: 'non-ASCII texture with zero coverage risk; √ stands in for the checkmark',
		risk: 'none measured — √ as “done” is a convention some CLIs use, not universal',
		g: { open: '·', claimed: '~', blocked: '!', done: '√', defer: '»', wontfix: '×' }
	},
	{
		name: 'D · gate for blocked',
		note: 'as A, but # reads as a wall/gate rather than an error',
		risk: 'same as A; # may read as “comment” to some eyes',
		g: { open: '-', claimed: '~', blocked: '#', done: '✓', defer: '»', wontfix: '×' }
	}
];

function glyphGallery() {
	const rows = [...LIST, ...CLOSED];
	console.log(`\n${C.bold}${'═'.repeat(72)}${R}`);
	console.log(`${C.bold}  GLYPH SETS${R}  ${C.dim}scheme C · scaffold s1 · same data throughout${R}`);
	console.log(`${C.bold}${'═'.repeat(72)}${R}`);

	for (const s of SETS) {
		for (const k of Object.keys(GLYPH) as State[]) GLYPH[k] = s.g[k];
		console.log(`\n  ${C.bold}${s.name}${R}  ${C.dim}${s.note}${R}`);
		console.log(`  ${C.dim}risk: ${s.risk}${R}\n`);
		const legend = (['open', 'claimed', 'blocked', 'done', 'defer', 'wontfix'] as State[])
			.map((k) => `${(STATE_COLOR[k] || C.dim) + s.g[k] + R} ${C.dim}${k}${R}`)
			.join('   ');
		console.log(`    ${legend}\n`);
		for (const r of rows) console.log('  ' + row(r, 'C'));
		console.log(`  ${C.dim}── tree --label bug ──${R}`);
		for (const r of TREE) console.log('  ' + row(r, 'C', 's1'));
	}
}

const arg = (process.argv[2] ?? 'all').toUpperCase();
const scaffold = (process.argv.find((a) => /^--s[1-4]$/.test(a))?.slice(2) ?? 's1') as Scaffold;

if (arg === 'GLYPHS') {
	glyphGallery();
} else if (arg === 'ALL') {
	for (const s of ['A', 'B', 'C', 'D'] as Scheme[]) renderScheme(s, scaffold);
	scaffoldGallery('C');
} else if (arg in SCHEMES) {
	renderScheme(arg as Scheme, scaffold);
	scaffoldGallery(arg as Scheme);
} else {
	console.log('usage: bun prototype-rendered-line.ts [all|A|B|C|D] [--s1|--s2|--s3|--s4]');
}
