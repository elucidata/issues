import { describe, it, expect, beforeAll } from 'vitest';
import {
	parse,
	serialize,
	formatId,
	normalizeId,
	findIssue,
	cmdAdd,
	cmdDone,
	cmdReopen,
	cmdEdit,
	cmdNote,
	cmdShow,
	cmdList,
	isBlocked,
	isTakeable,
	frontier,
	graphWarnings,
	cmdNext,
	cmdReady,
	cmdBlock,
	cmdUnblock,
	cmdAssign,
	cmdUnassign,
	cmdLabel,
	cmdUnlabel,
	cmdSet,
	cmdUnset,
	cmdTree,
	cmdDoctor,
	doctorFindings,
	compatWarnings,
	issueState,
	STATE_GLYPHS,
	paint,
	run
} from './index';
import type { AnsiStyle } from './index';
import { readFileSync } from 'node:fs';

// Deterministic datestamps for any code path that calls today().
beforeAll(() => {
	process.env.ISSUES_DATE = '2026-06-07';
});

// A self-contained, package-local fixture. It uses the generic numeric `###`
// pattern (no host-project prefix) so the suite is independent of any real
// ISSUES.md.
const SAMPLE = `---
next_id: 7
pattern: "###"
---
# Issue Tracker

The following issues were discovered while manually testing the app.

## Issues

- [ ] 001: Styles aren't matching the mockups.

- [ ] 005: (Embed) Mask the scrim so the captured element isn't obscured.
      When capturing a particular element, I'd like the scrim masked or cut out
      so the element that will be selected is unobscured.

## Completed

- [x] 006: Create example ISSUES.md. (2026-06-07)

## Deferred

## Won't Fix
`;

describe('parse', () => {
	it('reads frontmatter, preamble, sections, and inline notes', () => {
		const doc = parse(SAMPLE);
		expect(doc.nextId).toBe(7);
		expect(doc.pattern).toBe('###');
		expect(doc.preamble).toContain('# Issue Tracker');
		expect(doc.sections.get('Issues')!.map((i) => i.id)).toEqual(['001', '005']);
		const issue5 = doc.sections.get('Issues')![1]!;
		expect(issue5.detail).toHaveLength(2);
		expect(issue5.detail[0]).toBe(
			"When capturing a particular element, I'd like the scrim masked or cut out"
		);
	});

	it('separates the trailing datestamp from the title', () => {
		const issue6 = parse(SAMPLE).sections.get('Completed')![0]!;
		expect(issue6.title).toBe('Create example ISSUES.md.');
		expect(issue6.date).toBe('2026-06-07');
		expect(issue6.checked).toBe(true);
	});

	it('always provides all four sections', () => {
		const doc = parse('---\nnext_id: 1\npattern: "###"\n---\n# T\n\n## Issues\n');
		expect([...doc.sections.keys()]).toEqual(
			expect.arrayContaining(['Issues', 'Completed', 'Deferred', "Won't Fix"])
		);
	});
});

// The round-trip guard, restated to the §7.2 invariant: a file in canonical
// (blank-separated) form is a fixed point; single-`\n` input is accepted on read
// and normalized to blank-separated on write. SAMPLE above is in canonical form.
describe('serialize', () => {
	it('round-trips a canonical file byte-for-byte', () => {
		expect(serialize(parse(SAMPLE))).toBe(SAMPLE);
	});

	it('is idempotent', () => {
		const once = serialize(parse(SAMPLE));
		expect(serialize(parse(once))).toBe(once);
	});

	// The canonical boundary between entries 001 and 005 (blank-separated).
	const CANONICAL_BOUNDARY = '- [ ] 001: Styles aren\'t matching the mockups.\n\n- [ ] 005:';

	it('separates top-level entries with a blank line, keeping detail tight', () => {
		const out = serialize(parse(SAMPLE));
		// Blank line falls between top-level entries…
		expect(out).toContain(CANONICAL_BOUNDARY);
		// …but never before an indented detail line (that would detach the note).
		expect(out).toContain(
			'- [ ] 005: (Embed) Mask the scrim so the captured element isn\'t obscured.\n' +
				'      When capturing a particular element'
		);
	});

	it('normalizes tight single-`\\n` input to blank-separated on write (defined reflow)', () => {
		const tight = SAMPLE.replace(CANONICAL_BOUNDARY, CANONICAL_BOUNDARY.replace('\n\n', '\n'));
		expect(tight).not.toBe(SAMPLE); // the tight form really is different input
		// Read accepts it; write reflows it to the canonical (blank-separated) form.
		expect(serialize(parse(tight))).toBe(SAMPLE);
	});

	it('round-trips a metadata-free canonical file byte-for-byte', () => {
		const plain = `---
next_id: 3
pattern: "###"
---
# Tracker

## Issues

- [ ] 001: First task.

- [ ] 002: Second task.
      A note under the second task.

## Completed

## Deferred

## Won't Fix
`;
		expect(serialize(parse(plain))).toBe(plain);
	});
});

describe('id helpers', () => {
	it('zero-pads per the pattern', () => {
		expect(formatId(7)).toBe('007');
		expect(formatId(123)).toBe('123');
		expect(formatId(1000)).toBe('1000');
	});

	it('normalizes many input shapes to canonical ids', () => {
		for (const input of ['1', '001', 'M1', 'M001', 'x1']) {
			expect(normalizeId(input)).toBe('001');
		}
	});

	it('finds an issue across sections, unknown ids return null', () => {
		const doc = parse(SAMPLE);
		expect(findIssue(doc, '1')!.section).toBe('Issues');
		expect(findIssue(doc, '006')!.section).toBe('Completed');
		expect(findIssue(doc, '999')).toBeNull();
	});
});

describe('cmdAdd', () => {
	it('appends with the padded next id and increments next_id', () => {
		const doc = parse(SAMPLE);
		const msg = cmdAdd(doc, 'A brand new bug');
		expect(msg).toBe('Added 007: A brand new bug');
		expect(doc.nextId).toBe(8);
		const issues = doc.sections.get('Issues')!;
		expect(issues[issues.length - 1]).toMatchObject({ id: '007', title: 'A brand new bug' });
	});

	it('attaches an inline note when --note is given', () => {
		const doc = parse(SAMPLE);
		cmdAdd(doc, 'With a note', 'extra context here');
		const added = doc.sections.get('Issues')!.at(-1)!;
		expect(added.detail).toEqual(['extra context here']);
	});
});

describe('cmdDone / cmdReopen', () => {
	it('moves to Completed with a checkbox and ISO datestamp', () => {
		const doc = parse(SAMPLE);
		const msg = cmdDone(doc, '1');
		expect(msg).toBe('001 → Completed (2026-06-07)');
		expect(findIssue(doc, '1')!.section).toBe('Completed');
		const issue = findIssue(doc, '1')!.issue;
		expect(issue.checked).toBe(true);
		expect(issue.date).toBe('2026-06-07');
	});

	it('defers without a checkbox', () => {
		const doc = parse(SAMPLE);
		cmdDone(doc, '1', 'Deferred');
		const issue = findIssue(doc, '1')!.issue;
		expect(findIssue(doc, '1')!.section).toBe('Deferred');
		expect(issue.checked).toBe(false);
		expect(issue.date).toBe('2026-06-07');
	});

	it('wontfixes without a checkbox', () => {
		const doc = parse(SAMPLE);
		cmdDone(doc, '1', "Won't Fix");
		expect(findIssue(doc, '1')!.section).toBe("Won't Fix");
		expect(findIssue(doc, '1')!.issue.checked).toBe(false);
	});

	it('errors when closing into the section it already lives in', () => {
		const doc = parse(SAMPLE);
		expect(() => cmdDone(doc, '006')).toThrow(/already in Completed/);
	});

	it('reopens back to Issues and strips the date', () => {
		const doc = parse(SAMPLE);
		const msg = cmdReopen(doc, '006');
		expect(msg).toBe('006 reopened');
		const found = findIssue(doc, '006')!;
		expect(found.section).toBe('Issues');
		expect(found.issue.checked).toBe(false);
		expect(found.issue.date).toBeUndefined();
	});

	it('errors when reopening an already-open issue', () => {
		const doc = parse(SAMPLE);
		expect(() => cmdReopen(doc, '1')).toThrow(/already open/);
	});

	it('errors on an unknown id', () => {
		const doc = parse(SAMPLE);
		expect(() => cmdDone(doc, '999')).toThrow(/not found/);
	});
});

describe('cmdEdit / cmdNote / cmdShow', () => {
	it('replaces the title', () => {
		const doc = parse(SAMPLE);
		cmdEdit(doc, '1', 'Styles now match the mockups precisely.');
		expect(findIssue(doc, '1')!.issue.title).toBe('Styles now match the mockups precisely.');
	});

	it('appends a note line', () => {
		const doc = parse(SAMPLE);
		cmdNote(doc, '1', 'Check the button radius tokens.');
		expect(findIssue(doc, '1')!.issue.detail).toEqual(['Check the button radius tokens.']);
	});

	it('renders an issue with its note', () => {
		const out = cmdShow(parse(SAMPLE), '005');
		expect(out.split('\n')[0]).toContain('005  (Embed) Mask the scrim');
		expect(out).toContain('  state: Open');
		expect(out).toContain('When capturing a particular element');
	});
});

describe('cmdList', () => {
	it('shows only open issues by default, one line each, no detail body', () => {
		const out = cmdList(parse(SAMPLE));
		expect(out).toContain('001');
		expect(out).toContain('005');
		expect(out).not.toContain('006');
		expect(out).not.toContain('When capturing');
		expect(out).toContain('…'); // 005 has a note marker
	});

	it('--closed shows closed buckets and hides open ones', () => {
		const out = cmdList(parse(SAMPLE), { closed: true });
		expect(out).toContain('006');
		expect(out).not.toContain('001');
	});

	it('--all shows everything with section headers', () => {
		const out = cmdList(parse(SAMPLE), { all: true });
		expect(out).toContain('Issues:');
		expect(out).toContain('Completed:');
		expect(out).toContain('001');
		expect(out).toContain('006');
	});
});

describe('run (pure CLI dispatch)', () => {
	it('list is read-only', () => {
		const r = run(SAMPLE, ['list']);
		expect(r.mutated).toBe(false);
		expect(r.text).toBe(SAMPLE);
	});

	it('add serializes a mutated document', () => {
		const r = run(SAMPLE, ['add', 'From the CLI']);
		expect(r.mutated).toBe(true);
		expect(r.text).toContain('- [ ] 007: From the CLI');
		expect(r.text).toContain('next_id: 8');
	});

	it('add --note attaches detail', () => {
		const r = run(SAMPLE, ['add', 'With note', '--note', 'the note body']);
		expect(r.text).toContain('- [ ] 007: With note');
		expect(r.text).toContain('      the note body');
	});

	it('done --defer routes to the Deferred section', () => {
		const r = run(SAMPLE, ['done', '001', '--defer']);
		expect(r.text).toMatch(/## Deferred\n\n- \[ \] 001: .* \(2026-06-07\)/);
	});

	it('help is read-only and prints usage', () => {
		const r = run(SAMPLE, ['help']);
		expect(r.mutated).toBe(false);
		expect(r.output).toContain('Usage: issues');
	});

	it('unknown command throws', () => {
		expect(() => run(SAMPLE, ['frobnicate'])).toThrow(/Unknown command/);
	});

	it('missing required argument throws', () => {
		expect(() => run(SAMPLE, ['done'])).toThrow(/missing <id>/);
	});

	it('every result carries a warnings array (seam extension)', () => {
		expect(run(SAMPLE, ['list']).warnings).toEqual([]);
		expect(run(SAMPLE, ['add', 'x']).warnings).toEqual([]);
	});
});

// ── T1 — Tracer: blocked-by: one field, end-to-end (spec #11 Stage 1) ────────
// A self-contained fixture in canonical (blank-separated) form carrying the one
// field this tracer drives the whole way through the pipeline.
const BLOCKED = `---
next_id: 10
pattern: "###"
---
# Tracker

## Issues

- [ ] 001: Root task.

- [ ] 002: Blocked by an open one. blocked-by:001

- [ ] 003: Blocked by a closed one. blocked-by:006

- [ ] 004: Blocked by two, one open. blocked-by:001,006

## Completed

- [x] 006: Done already. (2026-06-07)

## Deferred

## Won't Fix
`;

describe('blocked-by: parse & serialize (tail field)', () => {
	it('peels a trailing blocked-by: field off the issue line into the model', () => {
		const issues = parse(BLOCKED).sections.get('Issues')!;
		expect(issues.map((i) => i.title)).toEqual([
			'Root task.',
			'Blocked by an open one.',
			'Blocked by a closed one.',
			'Blocked by two, one open.'
		]);
		expect(issues[0]!.blockedBy).toEqual([]);
		expect(issues[1]!.blockedBy).toEqual(['001']);
		expect(issues[3]!.blockedBy).toEqual(['001', '006']);
	});

	it('leaves a metadata-free line untouched (SAMPLE still round-trips)', () => {
		expect(serialize(parse(SAMPLE))).toBe(SAMPLE);
	});

	it('round-trips a blocked-by:-bearing tail verbatim (fixed point)', () => {
		expect(serialize(parse(BLOCKED))).toBe(BLOCKED);
	});
});

describe('blocked derivation (read-time, nothing stored)', () => {
	it('is blocked only when a listed blocker still sits in the open Issues section', () => {
		const doc = parse(BLOCKED);
		const by = (id: string) => findIssue(doc, id)!.issue;
		expect(isBlocked(doc, by('001'))).toBe(false); // no blockers
		expect(isBlocked(doc, by('002'))).toBe(true); // 001 open
		expect(isBlocked(doc, by('003'))).toBe(false); // 006 closed satisfies the gate
		expect(isBlocked(doc, by('004'))).toBe(true); // 001 open → still blocked (direct-only)
	});

	it('a dangling blocker fails open (does not block)', () => {
		const doc = parse(BLOCKED);
		const dangler = { ...findIssue(doc, '001')!.issue, blockedBy: ['999'] };
		expect(isBlocked(doc, dangler)).toBe(false);
	});

	it('reopening a blocker re-derives the block for free', () => {
		const doc = parse(BLOCKED);
		expect(isBlocked(doc, findIssue(doc, '003')!.issue)).toBe(false);
		cmdReopen(doc, '006'); // 006 → Issues (open)
		expect(isBlocked(doc, findIssue(doc, '003')!.issue)).toBe(true);
	});

	it('frontier is open ∩ every blocker closed, in document order', () => {
		expect(frontier(parse(BLOCKED)).map((i) => i.id)).toEqual(['001', '003']);
	});
});

// ── T2 — Widen the grammar: part-of, status, @assignee, #label, UDAs (#14) ───
// The full metadata primitive on the tail (§1, design example), in canonical
// field order so the fully-annotated line is a fixed point.
const ANNOTATED = `---
next_id: 8
pattern: "###"
---
# Tracker

## Issues

- [ ] 002: Parent map.

- [ ] 004: A blocker.

- [ ] 007: Wire up the parser. part-of:002 blocked-by:004 type:bug status:in-progress @matt #parser #round-trip

## Completed

## Deferred

## Won't Fix
`;

describe('T2 tail grammar — parse & serialize', () => {
	const issue = () => parse(ANNOTATED).sections.get('Issues')!.find((i) => i.id === '007')!;

	it('peels every field kind off the tail into the model, leaving a clean title', () => {
		const it7 = issue();
		expect(it7.title).toBe('Wire up the parser.');
		expect(it7.partOf).toBe('002');
		expect(it7.blockedBy).toEqual(['004']);
		expect(it7.status).toBe('in-progress');
		expect(it7.assignee).toBe('matt');
		expect(it7.labels).toEqual(['parser', 'round-trip']);
	});

	it('keeps an unrecognized key:value token as a verbatim UDA (§1.3)', () => {
		expect(issue().uda).toEqual([{ key: 'type', value: 'bug' }]);
	});

	it('round-trips a fully-annotated line verbatim (fixed point)', () => {
		expect(serialize(parse(ANNOTATED))).toBe(ANNOTATED);
	});

	it('leaves a metadata-free line byte-identical (SAMPLE still round-trips)', () => {
		expect(serialize(parse(SAMPLE))).toBe(SAMPLE);
	});

	it('does not mistake a title colon/sigil in the middle of the line for a field', () => {
		const doc = parse(
			'---\nnext_id: 2\npattern: "###"\n---\n# T\n\n## Issues\n\n- [ ] 001: Fix the see:here bug for @nobody now\n\n## Completed\n\n## Deferred\n\n## Won\'t Fix\n'
		);
		const it1 = doc.sections.get('Issues')![0]!;
		expect(it1.title).toBe('Fix the see:here bug for @nobody now');
		expect(it1.uda).toEqual([]);
		expect(it1.assignee).toBeUndefined();
	});

	it('parses part-of/status/label singly and multiply per their arity', () => {
		const doc = parse(
			'---\nnext_id: 2\npattern: "###"\n---\n# T\n\n## Issues\n\n- [ ] 001: Multi. blocked-by:003,004 #a #b\n\n## Completed\n\n## Deferred\n\n## Won\'t Fix\n'
		);
		const it1 = doc.sections.get('Issues')![0]!;
		expect(it1.blockedBy).toEqual(['003', '004']);
		expect(it1.labels).toEqual(['a', 'b']);
	});
});

describe('T2 tail grammar through the run seam', () => {
	it('add writes no status: — metadata-free output stays byte-identical', () => {
		const r = run(SAMPLE, ['add', 'Plain new one']);
		expect(r.text).toContain('- [ ] 007: Plain new one\n');
		expect(r.text).not.toContain('status:');
	});

	it('edit preserves all trailing fields when replacing the title (§5.3)', () => {
		const r = run(ANNOTATED, ['edit', '007', 'Retitled the parser work.']);
		expect(r.text).toContain(
			'- [ ] 007: Retitled the parser work. part-of:002 blocked-by:004 type:bug status:in-progress @matt #parser #round-trip'
		);
	});
});

describe('next / ready through the run seam', () => {
	it('ready lists the whole unblocked frontier in document order', () => {
		const out = cmdReady(parse(BLOCKED));
		expect(out).toContain('001');
		expect(out).toContain('003');
		expect(out).not.toContain('002');
		expect(out).not.toContain('004');
	});

	it('next is ready[0] — the topmost takeable issue', () => {
		expect(cmdNext(parse(BLOCKED))).toContain('001');
	});

	it('neither next nor ready mutates', () => {
		expect(run(BLOCKED, ['next']).mutated).toBe(false);
		expect(run(BLOCKED, ['ready']).mutated).toBe(false);
		expect(run(BLOCKED, ['ready']).text).toBe(BLOCKED);
	});

	it('reports a normal empty frontier when nothing is takeable', () => {
		// A mutual 001↔002 cycle: both open, both blocked → §4.5 all-blocked diagnosis.
		const doc = `---\nnext_id: 3\npattern: "###"\n---\n# T\n\n## Issues\n\n- [ ] 001: A. blocked-by:002\n\n- [ ] 002: B. blocked-by:001\n\n## Completed\n\n## Deferred\n\n## Won't Fix\n`;
		const r = run(doc, ['next']);
		expect(r.mutated).toBe(false);
		expect(r.exitCode ?? 0).toBe(0);
		expect(r.output).toMatch(/all blocked/i);
		expect(r.output).toContain('001');
		expect(r.output).toContain('002');
	});
});

// ── T3 — Complete derivation + full frontier (spec #11 Stage 3, §§3–4) ────────
// A graph exercising every §3 anomaly at once: self-ref, dangling blocker,
// dangling part-of, a won't-fix blocker (gate satisfied), and a mutual cycle.
const GRAPH = `---
next_id: 20
pattern: "###"
---
# Tracker

## Issues

- [ ] 001: Selfie. blocked-by:001

- [ ] 002: Dangling blocker. blocked-by:999

- [ ] 003: Orphan child. part-of:998

- [ ] 004: Unblocked by a won't-fix. blocked-by:010

- [ ] 005: Cycle A. blocked-by:006

- [ ] 006: Cycle B. blocked-by:005

## Completed

## Deferred

## Won't Fix

- [ ] 010: Rejected outright. (2026-06-07)
`;

describe('T3 graph derivation — self-reference (§3.1)', () => {
	it('ignores a self-reference edge: A blocked-by A does not block', () => {
		const doc = parse(GRAPH);
		expect(isBlocked(doc, findIssue(doc, '001')!.issue)).toBe(false);
	});
});

describe('T3 graph derivation — fail-open blocking (§3.1)', () => {
	const doc = () => parse(GRAPH);

	it('a dangling blocker fails open — 002 is takeable', () => {
		expect(isBlocked(doc(), findIssue(doc(), '002')!.issue)).toBe(false);
	});

	it('a won\'t-fix blocker satisfies the gate — 004 is takeable', () => {
		expect(isBlocked(doc(), findIssue(doc(), '004')!.issue)).toBe(false);
	});

	it('a dangling part-of carries no lifecycle effect — 003 stays takeable', () => {
		expect(isBlocked(doc(), findIssue(doc(), '003')!.issue)).toBe(false);
	});

	it('mutual-cycle members stay blocked, never auto-broken', () => {
		expect(isBlocked(doc(), findIssue(doc(), '005')!.issue)).toBe(true);
		expect(isBlocked(doc(), findIssue(doc(), '006')!.issue)).toBe(true);
	});
});

describe('T3 graph derivation — warnings (§3, fail-open advisories)', () => {
	const warns = graphWarnings(parse(GRAPH));
	const has = (re: RegExp) => warns.some((w) => re.test(w));

	it('warns on a self-reference and reports the edge ignored', () => {
		expect(has(/001.*self-ref/i)).toBe(true);
	});

	it('warns on a dangling blocker (id 999 found nowhere)', () => {
		expect(has(/002.*999/)).toBe(true);
	});

	it('warns on a dangling part-of (parent 998 found nowhere)', () => {
		expect(has(/003.*part-of.*998/i)).toBe(true);
	});

	it('emits the won\'t-fix-blocker advisory (gate satisfied by a rejected blocker)', () => {
		expect(has(/004.*(won.?t.?fix|010)/i)).toBe(true);
	});

	it('detects the 005↔006 cycle and reports both members', () => {
		const cycleWarn = warns.find((w) => /cycle/i.test(w));
		expect(cycleWarn).toBeDefined();
		expect(cycleWarn).toContain('005');
		expect(cycleWarn).toContain('006');
	});

	it('a clean graph produces no warnings', () => {
		expect(graphWarnings(parse(SAMPLE))).toEqual([]);
	});
});

// A frontier exercising the claim gate and every filter dimension. 004 is claimed;
// the rest are open, unblocked, and variously statused/labelled/contained.
const FRONTIER = `---
next_id: 20
pattern: "###"
---
# Tracker

## Issues

- [ ] 001: Map parent.

- [ ] 002: Child A. part-of:001 status:ready-for-agent #frontend

- [ ] 003: Child B. part-of:001 status:ready-for-human #backend

- [ ] 004: Claimed work. @matt #frontend

- [ ] 005: Other-map child. part-of:009 status:ready-for-agent #backend

## Completed

## Deferred

## Won't Fix
`;

describe('T3 frontier — claim gate & document order (§4.1)', () => {
	const ids = (f = {}) => frontier(parse(FRONTIER), f).map((i) => i.id);

	it('base frontier is open ∩ unblocked ∩ unclaimed, in document order', () => {
		expect(ids()).toEqual(['001', '002', '003', '005']); // 004 is claimed → excluded
	});
});

describe('T3 frontier — filters (§4.4)', () => {
	const ids = (f: object) => frontier(parse(FRONTIER), f).map((i) => i.id);

	it('--status narrows to a matching workflow value', () => {
		expect(ids({ status: ['ready-for-agent'] })).toEqual(['002', '005']);
	});

	it('a repeated dimension ORs within it (label a OR b)', () => {
		expect(ids({ label: ['frontend', 'backend'] })).toEqual(['002', '003', '005']);
	});

	it('--parent keeps only the direct children of one map', () => {
		expect(ids({ parent: ['001'] })).toEqual(['002', '003']);
	});

	it('different dimensions AND together', () => {
		expect(ids({ status: ['ready-for-agent'], label: ['backend'] })).toEqual(['005']);
	});

	it('--assignee drops the unclaimed gate and requires assignee == who', () => {
		expect(ids({ assignee: ['matt'] })).toEqual(['004']);
		expect(ids({ assignee: ['nobody'] })).toEqual([]);
	});

	it('--limit truncates the ordered frontier', () => {
		expect(ids({ limit: 2 })).toEqual(['001', '002']);
	});
});

describe('T3 empty frontier — diagnosed, exit 0 (§4.5)', () => {
	const head = '---\nnext_id: 9\npattern: "###"\n---\n# T\n\n## Issues\n\n';
	const tail = '\n\n## Completed\n\n## Deferred\n\n## Won\'t Fix\n';
	const doc = (body: string) => head + body + tail;

	it('no open issues → drained', () => {
		expect(cmdReady(parse(doc('')))).toMatch(/no open issues/i);
	});

	it('all blocked → names the open ids being waited on', () => {
		const out = cmdReady(parse(doc('- [ ] 001: A. blocked-by:002\n\n- [ ] 002: B. blocked-by:001')));
		expect(out).toMatch(/all blocked/i);
		expect(out).toContain('001');
		expect(out).toContain('002');
	});

	it('all claimed → names the assignees in progress', () => {
		const out = cmdReady(parse(doc('- [ ] 001: A. @matt\n\n- [ ] 002: B. @jane')));
		expect(out).toMatch(/in progress/i);
		expect(out).toContain('@matt');
		expect(out).toContain('@jane');
	});

	it('a mix → summarizes the counts', () => {
		const out = cmdReady(parse(doc('- [ ] 001: A. blocked-by:002\n\n- [ ] 002: B. @jane')));
		expect(out).toMatch(/blocked/i);
		expect(out).toMatch(/in progress|claimed/i);
	});

	it('next reports the same diagnosis as ready when empty', () => {
		const d = parse(doc('- [ ] 001: A. @matt'));
		expect(cmdNext(d)).toMatch(/in progress/i);
	});

	it('a filtered miss is distinguished from a drained frontier', () => {
		const out = cmdReady(parse(FRONTIER), { status: ['does-not-exist'] });
		expect(out).toMatch(/no takeable issues match/i);
	});
});

describe('T3 frontier through the run seam (filters, warnings, exit code)', () => {
	it('ready honors filters passed as flags, ANDing across dimensions', () => {
		const r = run(FRONTIER, ['ready', '--status', 'ready-for-agent', '--label', 'backend']);
		expect(r.output).toContain('005');
		expect(r.output).not.toContain('002');
		expect(r.mutated).toBe(false);
	});

	it('a repeated flag ORs within its dimension', () => {
		const r = run(FRONTIER, ['ready', '--label', 'frontend', '--label', 'backend']);
		expect(r.output).toContain('002');
		expect(r.output).toContain('003');
		expect(r.output).toContain('005');
	});

	it('--assignee relaxes the unclaimed gate', () => {
		const r = run(FRONTIER, ['ready', '--assignee', 'matt']);
		expect(r.output).toContain('004');
		expect(r.output).not.toContain('001');
	});

	it('--limit caps ready', () => {
		const r = run(FRONTIER, ['ready', '--limit', '2']);
		const lines = r.output.trim().split('\n');
		expect(lines).toHaveLength(2);
	});

	it('surfaces §3 advisories through RunResult.warnings, exit 0', () => {
		const r = run(GRAPH, ['ready']);
		expect(r.exitCode ?? 0).toBe(0);
		expect(r.warnings.length).toBeGreaterThan(0);
		expect(r.warnings.some((w) => /self-ref/i.test(w))).toBe(true);
		expect(r.warnings.some((w) => /cycle/i.test(w))).toBe(true);
		// Warnings never leak into stdout output.
		expect(r.output).not.toMatch(/self-ref|cycle/i);
	});

	it('next carries the same warnings', () => {
		expect(run(GRAPH, ['next']).warnings.length).toBeGreaterThan(0);
	});

	it('a clean read emits no warnings', () => {
		expect(run(SAMPLE, ['ready']).warnings).toEqual([]);
	});
});

// ── T4 — CLI verbs, reads & --json (spec #11 Stage 4, §§5–6, ADR 0005) ────────
// A clean, fully-annotated fixture the T4 surface drives end-to-end: a parent map
// (001) with two children (002, 003), a claimed issue (004), a blocked one (005).
const T4 = `---
next_id: 10
pattern: "###"
---
# Tracker

## Issues

- [ ] 001: Parent map.

- [ ] 002: Child A. part-of:001 status:ready-for-agent #frontend

- [ ] 003: Child B. part-of:001 @jane #backend

- [ ] 004: Claimed. @matt #frontend

- [ ] 005: Blocked one. blocked-by:001

## Completed

- [x] 007: Done work. (2026-06-07)

## Deferred

## Won't Fix
`;

describe('T4 verbs — block / unblock (§5 decision 3)', () => {
	it('block adds one blocker, canonicalizing the id', () => {
		const doc = parse(T4);
		expect(cmdBlock(doc, '002', '4')).toMatch(/blocked-by 004/);
		expect(findIssue(doc, '002')!.issue.blockedBy).toEqual(['004']);
	});

	it('rejects a self-reference (the one hard reject)', () => {
		expect(() => cmdBlock(parse(T4), '002', '002')).toThrow(/itself/i);
		expect(() => run(T4, ['block', '002', '--by', '002'])).toThrow(/itself/i);
	});

	it('re-blocking an existing edge is an idempotent no-op', () => {
		const doc = parse(T4);
		cmdBlock(doc, '005', '001'); // 005 already blocked-by:001
		expect(findIssue(doc, '005')!.issue.blockedBy).toEqual(['001']);
	});

	it('unblock --by removes one edge; no --by clears all', () => {
		const doc = parse(T4);
		cmdBlock(doc, '005', '002'); // now blocked-by 001,002
		expect(cmdUnblock(doc, '005', '002')).toMatch(/no longer blocked-by 002/);
		expect(findIssue(doc, '005')!.issue.blockedBy).toEqual(['001']);
		cmdUnblock(doc, '005'); // clear all
		expect(findIssue(doc, '005')!.issue.blockedBy).toEqual([]);
	});

	it('removing an absent edge is an idempotent no-op + message (§5.3)', () => {
		const doc = parse(T4);
		expect(cmdUnblock(doc, '001')).toMatch(/no blockers/);
		expect(cmdUnblock(doc, '005', '999')).toMatch(/was not blocked-by 999/);
	});

	it('warn-but-write on an unknown blocker through the run seam', () => {
		const r = run(T4, ['block', '002', '--by', '999']);
		expect(r.mutated).toBe(true);
		expect(r.text).toContain('blocked-by:999');
		expect(r.warnings.some((w) => /999.*not found/.test(w))).toBe(true);
	});

	it('missing --by is a usage error', () => {
		expect(() => run(T4, ['block', '002'])).toThrow(/missing --by/i);
	});
});

describe('T4 verbs — assign / unassign (§5 decision 4)', () => {
	it('assign sets an explicit claim string', () => {
		const doc = parse(T4);
		expect(cmdAssign(doc, '001', 'matt')).toMatch(/@matt/);
		expect(findIssue(doc, '001')!.issue.assignee).toBe('matt');
	});

	it('unassign clears; absent is an idempotent no-op (§5.3)', () => {
		const doc = parse(T4);
		expect(cmdUnassign(doc, '004')).toMatch(/unassigned/);
		expect(findIssue(doc, '004')!.issue.assignee).toBeUndefined();
		expect(cmdUnassign(doc, '001')).toMatch(/was not assigned/);
	});
});

describe('T4 verbs — label / unlabel (§5 decision 5)', () => {
	it('label is additive and deduped', () => {
		const doc = parse(T4);
		cmdLabel(doc, '004', ['frontend', 'urgent']); // frontend already present
		expect(findIssue(doc, '004')!.issue.labels).toEqual(['frontend', 'urgent']);
	});

	it('unlabel removes targeted names; absent names no-op (§5.3)', () => {
		const doc = parse(T4);
		expect(cmdUnlabel(doc, '002', ['frontend'])).toMatch(/unlabelled/);
		expect(findIssue(doc, '002')!.issue.labels).toEqual([]);
		expect(cmdUnlabel(doc, '002', ['nope'])).toMatch(/no matching labels/);
	});

	it('comma-lists through the run seam', () => {
		const r = run(T4, ['label', '001', 'a,b']);
		expect(r.text).toContain('#a #b');
	});
});

describe('T4 verbs — set / unset (§5 decision 6)', () => {
	it('set writes a scalar status', () => {
		const { message } = cmdSet(parse(T4), '001', 'status', 'wip');
		expect(message).toMatch(/status:wip/);
	});

	it('set on a closed issue warns but writes (§5.3, decision 15)', () => {
		const doc = parse(T4);
		const { warnings } = cmdSet(doc, '007', 'status', 'wip'); // 007 is Completed
		expect(findIssue(doc, '007')!.issue.status).toBe('wip');
		expect(warnings.some((w) => /closed/.test(w))).toBe(true);
	});

	it('an unknown key upserts a verbatim UDA', () => {
		const doc = parse(T4);
		cmdSet(doc, '001', 'type', 'bug');
		expect(findIssue(doc, '001')!.issue.uda).toEqual([{ key: 'type', value: 'bug' }]);
	});

	it('unset removes a scalar/UDA; absent is an idempotent no-op (§5.3)', () => {
		const doc = parse(T4);
		expect(cmdUnset(doc, '002', 'status')).toMatch(/unset status/);
		expect(findIssue(doc, '002')!.issue.status).toBeUndefined();
		expect(cmdUnset(doc, '002', 'status')).toMatch(/was not set/);
	});

	it('warns when a status is outside a declared statuses: set (decision 7)', () => {
		const declared = `---\nnext_id: 2\npattern: "###"\nstatuses: ready, wip, review\n---\n# T\n\n## Issues\n\n- [ ] 001: A.\n\n## Completed\n\n## Deferred\n\n## Won't Fix\n`;
		const r = run(declared, ['set', '001', 'status:banana']);
		expect(r.text).toContain('status:banana');
		expect(r.warnings.some((w) => /declared/.test(w))).toBe(true);
	});
});

describe('T4 add field flags — byte-identical to the verb sequence (§5 decision 2)', () => {
	it('produces the same file as add + set + block + assign + label', () => {
		const viaFlags = run(SAMPLE, [
			'add',
			'Task',
			'--part-of',
			'002',
			'--blocked-by',
			'004,006',
			'--status',
			'wip',
			'--assignee',
			'matt',
			'--label',
			'a,b'
		]).text;
		let t = run(SAMPLE, ['add', 'Task']).text;
		t = run(t, ['set', '007', 'part-of:002']).text;
		t = run(t, ['block', '007', '--by', '004']).text;
		t = run(t, ['block', '007', '--by', '006']).text;
		t = run(t, ['set', '007', 'status:wip']).text;
		t = run(t, ['assign', '007', 'matt']).text;
		t = run(t, ['label', '007', 'a,b']).text;
		expect(viaFlags).toBe(t);
		expect(viaFlags).toContain(
			'- [ ] 007: Task part-of:002 blocked-by:004,006 status:wip @matt #a #b'
		);
	});

	it('a bare add still writes no tail fields (§8 back-compat)', () => {
		expect(run(SAMPLE, ['add', 'Plain']).text).toContain('- [ ] 007: Plain\n');
	});
});

describe('T4 close voids status: only (§5 decision 15)', () => {
	it('done clears status but keeps assignee / relationships / labels', () => {
		const r = run(ANNOTATED, ['done', '007']); // 007: part-of blocked-by type status @matt #labels
		expect(r.text).not.toContain('status:in-progress');
		expect(r.text).toContain('part-of:002');
		expect(r.text).toContain('blocked-by:004');
		expect(r.text).toContain('@matt');
		expect(r.text).toContain('#parser #round-trip');
	});
});

describe('T4 reads — list compact markers (§5 decision 17)', () => {
	it('marks a blocked issue with ⊘', () => {
		expect(run(BLOCKED, ['list']).output).toContain('⊘ 002');
	});

	it('shows status:/@assignee/#labels inline', () => {
		const out = run(ANNOTATED, ['list']).output;
		expect(out).toContain('status:in-progress');
		expect(out).toContain('@matt');
		expect(out).toContain('#parser');
	});

	it('shares the frontier filter vocabulary (§5 decision 18)', () => {
		const out = run(T4, ['list', '--label', 'frontend']).output;
		expect(out).toContain('002');
		expect(out).toContain('004');
		expect(out).not.toContain('003');
	});
});

describe('T4 reads — show full dossier (§5 decision 17)', () => {
	it('expands relationships with titles + state and names blocked in state:', () => {
		const out = run(ANNOTATED, ['show', '007']).output;
		// §4.2 moved `⊘ blocked` out of the header and into the unified field.
		expect(out).toContain('state: Open, blocked'); // blocked-by:004, 004 open
		expect(out).toContain('status: in-progress');
		expect(out).toContain('assignee: @matt');
		expect(out).toContain('labels: #parser #round-trip');
		expect(out).toMatch(/part-of: 002/);
		expect(out).toMatch(/blocked-by: 004 \(A blocker\.\) — Open/); // §4.4 capitalizes
	});

	it('--children renders the containment subtree', () => {
		const out = run(T4, ['show', '001', '--children']).output;
		expect(out).toContain('children:');
		expect(out).toContain('002');
		expect(out).toContain('003');
	});

	it('resolves a dangling pointer as (not found)', () => {
		const out = run(GRAPH, ['show', '003']).output; // 003 part-of:998 (dangling)
		expect(out).toMatch(/part-of: 998 \(not found\)/);
	});
});

describe('T4 reads — tree containment-only forest (§5 decision 13)', () => {
	it('nests children under their parent by part-of', () => {
		const out = cmdTree(parse(T4));
		const lines = out.split('\n');
		const p = lines.findIndex((l) => /\b001\b/.test(l));
		const c = lines.findIndex((l) => /\b002\b/.test(l));
		expect(p).toBeGreaterThanOrEqual(0);
		expect(c).toBeGreaterThan(p);
		// child is indented deeper than its parent
		const indent = (l: string) => l.length - l.trimStart().length;
		expect(indent(lines[c]!)).toBeGreaterThan(indent(lines[p]!));
	});

	it('draws blocking as a ⊘ annotation, never as tree structure', () => {
		const out = cmdTree(parse(BLOCKED));
		const lines = out.split('\n');
		const indent = (l: string) => l.length - l.trimStart().length;
		const a = lines.find((l) => /\b001\b/.test(l))!;
		const b = lines.find((l) => /\b002\b/.test(l))!; // 002 blocked-by:001
		expect(b).toContain('⊘');
		// 002 is NOT a child of 001 (no part-of) — same depth, both roots
		expect(indent(a)).toBe(indent(b));
	});
});

describe('T4 doctor — read-only linter (§5 decision 19)', () => {
	it('reports every §3 anomaly and exits nonzero on findings', () => {
		const r = run(GRAPH, ['doctor']);
		expect(r.exitCode).toBe(1);
		expect(r.output).toMatch(/self-ref/i);
		expect(r.output).toMatch(/cycle/i);
		expect(r.mutated).toBe(false);
	});

	it('exits 0 on a clean file', () => {
		const r = run(SAMPLE, ['doctor']);
		expect(r.exitCode).toBe(0);
		expect(r.output).toMatch(/clean/i);
	});

	it('flags a status outside a declared statuses: set', () => {
		const declared = `---\nnext_id: 2\npattern: "###"\nstatuses: ready, wip\n---\n# T\n\n## Issues\n\n- [ ] 001: A. status:banana\n\n## Completed\n\n## Deferred\n\n## Won't Fix\n`;
		expect(doctorFindings(parse(declared), declared).some((f) => /banana/.test(f))).toBe(true);
	});

	it('flags a structurally malformed line', () => {
		const bad = `---\nnext_id: 2\npattern: "###"\n---\n# T\n\n## Issues\n\n- [ ] 001: A.\nthis is not an issue line\n\n## Completed\n\n## Deferred\n\n## Won't Fix\n`;
		expect(doctorFindings(parse(bad), bad).some((f) => /malformed/.test(f))).toBe(true);
	});
});

describe('T4 --json read contract (§6)', () => {
	it('ready --json carries derived blocked/takeable and a null reason when non-empty', () => {
		const data = JSON.parse(run(T4, ['ready', '--json']).output);
		expect(Array.isArray(data.issues)).toBe(true);
		expect(data.reason).toBeNull();
		const first = data.issues[0];
		expect(first).toMatchObject({ id: '001', blocked: false, takeable: true });
	});

	it('ready --json reports the frontier reason when empty', () => {
		const claimed = `---\nnext_id: 3\npattern: "###"\n---\n# T\n\n## Issues\n\n- [ ] 001: A. @matt\n\n## Completed\n\n## Deferred\n\n## Won't Fix\n`;
		const data = JSON.parse(run(claimed, ['ready', '--json']).output);
		expect(data.issues).toEqual([]);
		expect(data.reason).toMatch(/in progress/i);
	});

	it('next --json leads with the issue object (or null + reason)', () => {
		const data = JSON.parse(run(BLOCKED, ['next', '--json']).output);
		expect(data.issue.id).toBe('001');
		expect(data.reason).toBeNull();
	});

	it('show --json expands relationships and derived state', () => {
		const data = JSON.parse(run(ANNOTATED, ['show', '007', '--json']).output);
		expect(data).toMatchObject({ id: '007', blocked: true, takeable: false });
		expect(data.parent.id).toBe('002');
		expect(data.blockers[0]).toMatchObject({ id: '004', open: true });
	});

	it('tree --json is a nested forest', () => {
		const data = JSON.parse(run(T4, ['tree', '--json']).output);
		const root = data.find((n: { id: string }) => n.id === '001');
		expect(root.children.map((c: { id: string }) => c.id)).toEqual(['002', '003']);
	});

	it('list --json is a flat array of issue objects with derived fields', () => {
		const data = JSON.parse(run(SAMPLE, ['list', '--json']).output);
		expect(data.every((i: { id: string; takeable: boolean }) => 'takeable' in i)).toBe(true);
	});

	it('doctor --json emits ok + findings', () => {
		const data = JSON.parse(run(GRAPH, ['doctor', '--json']).output);
		expect(data.ok).toBe(false);
		expect(data.findings.length).toBeGreaterThan(0);
	});
});

describe('T4 advisories, quiet, and exit codes (§5 decisions 8, 10)', () => {
	it('graph-reading commands surface §3 advisories to the warnings channel', () => {
		expect(run(GRAPH, ['list']).warnings.length).toBeGreaterThan(0);
		expect(run(GRAPH, ['tree']).warnings.length).toBeGreaterThan(0);
	});

	it('-q / --quiet silences the advisory channel', () => {
		expect(run(GRAPH, ['ready', '-q']).warnings).toEqual([]);
		expect(run(GRAPH, ['ready', '--quiet']).warnings).toEqual([]);
	});

	it('-q drops the folded-in advisories from a show dossier too (decision 8)', () => {
		// The `! …edge ignored` advisory line is silenced; the resolved blocked-by line
		// (structural dossier content) is not — only the §3 warning channel is quieted.
		expect(run(GRAPH, ['show', '001']).output).toMatch(/edge ignored/i); // 001 blocked-by:001
		expect(run(GRAPH, ['show', '001', '-q']).output).not.toMatch(/edge ignored/i);
		expect(JSON.parse(run(GRAPH, ['show', '001', '-q', '--json']).output).warnings).toEqual([]);
	});

	it('an empty frontier is exit 0 (never an error, §4.5)', () => {
		const claimed = `---\nnext_id: 3\npattern: "###"\n---\n# T\n\n## Issues\n\n- [ ] 001: A. @matt\n\n## Completed\n\n## Deferred\n\n## Won't Fix\n`;
		expect(run(claimed, ['next']).exitCode ?? 0).toBe(0);
	});

	it('help documents the full T4 surface', () => {
		const out = run(SAMPLE, ['help']).output;
		for (const verb of ['block', 'assign', 'label', 'set', 'tree', 'doctor']) {
			expect(out).toContain(verb);
		}
	});
});

describe('T4 isTakeable — the per-issue frontier predicate (§6)', () => {
	it('is true only for an open, unblocked, unclaimed issue', () => {
		const doc = parse(T4);
		expect(isTakeable(doc, findIssue(doc, '001')!.issue, 'Issues')).toBe(true);
		expect(isTakeable(doc, findIssue(doc, '004')!.issue, 'Issues')).toBe(false); // claimed
		expect(isTakeable(doc, findIssue(doc, '005')!.issue, 'Issues')).toBe(false); // blocked
		expect(isTakeable(doc, findIssue(doc, '007')!.issue, 'Completed')).toBe(false); // closed
	});
});

describe('ADR 0007 — file-format schema compat contract', () => {
	// A file carrying a `schema:` newer than this build understands.
	const NEWER = `---
next_id: 2
pattern: "###"
schema: 99
---
# T

## Issues

- [ ] 001: A.

## Completed

## Deferred

## Won't Fix
`;

	it('an unversioned file (no schema key) is silent — absent ⇒ legacy, never rejected', () => {
		expect(compatWarnings(parse(SAMPLE))).toEqual([]);
	});

	it('a recognized schema (≤ supported) is silent', () => {
		const v1 = SAMPLE.replace('pattern: "###"', 'pattern: "###"\nschema: 1');
		expect(compatWarnings(parse(v1))).toEqual([]);
	});

	it('a newer schema warns but never rejects — advisory only', () => {
		const warns = compatWarnings(parse(NEWER));
		expect(warns).toHaveLength(1);
		expect(warns[0]).toMatch(/schema 99/);
	});

	it('a non-numeric schema warns rather than throwing', () => {
		const bad = SAMPLE.replace('pattern: "###"', 'pattern: "###"\nschema: draft');
		expect(compatWarnings(parse(bad))).toHaveLength(1);
	});

	it('the schema key round-trips verbatim — reserved, preserved, never rewritten', () => {
		expect(serialize(parse(NEWER))).toBe(NEWER);
	});

	it('reads surface the compat advisory through RunResult.warnings, exit 0 (never rejects)', () => {
		const r = run(NEWER, ['list']);
		expect(r.exitCode ?? 0).toBe(0);
		expect(r.warnings.some((w) => /schema 99/.test(w))).toBe(true);
		expect(r.output).toContain('001'); // the file still reads normally
	});

	it('a mutation of a newer file still writes, leading with the compat advisory', () => {
		const r = run(NEWER, ['add', 'B']);
		expect(r.mutated).toBe(true);
		expect(r.warnings.some((w) => /schema 99/.test(w))).toBe(true);
	});

	it('-q silences the compat advisory', () => {
		expect(run(NEWER, ['list', '-q']).warnings).toEqual([]);
	});
});

// ── T5 — terminal-output rendering primitives (design §1, §2, §6) ────────────
// The expand half of an expand–contract: the plumbing lands beside today's
// rendering and changes no output. Tickets 2–4 migrate the renderers onto it.

// Every row of the §1 precedence table, plus the two cases precedence exists for:
// blocked+claimed (005) and closed-with-a-still-open-blocker (006, 008).
const T5 = `---
next_id: 9
pattern: "###"
---
# Tracker

## Issues

- [ ] 001: Open blocker.

- [ ] 002: Plain open.

- [ ] 003: Claimed. @matt

- [ ] 004: Blocked. blocked-by:001

- [ ] 005: Blocked and claimed. blocked-by:001 @matt

## Completed

- [x] 006: Completed with a still-open blocker. blocked-by:001 @matt (2026-06-07)

## Deferred

- [ ] 007: Deferred. (2026-06-07)

## Won't Fix

- [ ] 008: Won't fix. blocked-by:001 (2026-06-07)
`;

describe('T5 state resolver — precedence closed > blocked > claimed > open (§1)', () => {
	const doc = parse(T5);
	const state = (id: string) => issueState(doc, findIssue(doc, id)!.issue);

	it('resolves every row of the precedence table', () => {
		expect(state('002')).toBe('open');
		expect(state('003')).toBe('claimed');
		expect(state('004')).toBe('blocked');
		expect(state('006')).toBe('completed');
		expect(state('007')).toBe('deferred');
		expect(state('008')).toBe('wontfix');
	});

	it('blocked + claimed resolves to blocked — one slot, highest wins', () => {
		expect(state('005')).toBe('blocked');
	});

	it('closed subsumes the derived axis — closed + blocked resolves to the section', () => {
		expect(state('006')).toBe('completed');
		expect(state('008')).toBe('wontfix');
	});

	it('the derived axis is still true underneath — precedence is semantic, not a fix', () => {
		// isBlocked does not consult the issue's own section (§1); ticket 4's `state:`
		// suppression depends on this staying true.
		expect(isBlocked(doc, findIssue(doc, '006')!.issue)).toBe(true);
		expect(findIssue(doc, '006')!.issue.assignee).toBe('matt');
	});

	it('accepts an explicit section, skipping the lookup', () => {
		expect(issueState(doc, findIssue(doc, '002')!.issue, 'Issues')).toBe('open');
		expect(issueState(doc, findIssue(doc, '006')!.issue, 'Completed')).toBe('completed');
	});
});

describe('T5 glyph table (§1)', () => {
	it('carries the six glyphs and their gutter colours', () => {
		expect(STATE_GLYPHS.open).toEqual({ glyph: '-', color: null });
		expect(STATE_GLYPHS.claimed).toEqual({ glyph: '~', color: 'yellow' });
		expect(STATE_GLYPHS.blocked).toEqual({ glyph: '⊘', color: 'red' });
		expect(STATE_GLYPHS.completed).toEqual({ glyph: '✓', color: 'green' });
		expect(STATE_GLYPHS.deferred).toEqual({ glyph: '»', color: 'dim' });
		expect(STATE_GLYPHS.wontfix).toEqual({ glyph: '×', color: 'dim' });
	});
});

describe('T5 ANSI helper — gated on the colour boolean, 8/16-colour only (§2, §6.2)', () => {
	it('emits nothing at all when colour is false', () => {
		expect(paint('ISS-001', 'cyan', false)).toBe('ISS-001');
		for (const { glyph, color } of Object.values(STATE_GLYPHS)) {
			expect(paint(glyph, color, false)).toBe(glyph);
		}
	});

	it('wraps in an SGR pair when colour is true', () => {
		expect(paint('ISS-001', 'cyan', true)).toBe('\x1b[36mISS-001\x1b[0m');
		expect(paint('x', ['dim', 'cyan'], true)).toBe('\x1b[2;36mx\x1b[0m');
	});

	it('a null style is a no-op even when colour is true — open has no gutter colour', () => {
		expect(paint('-', null, true)).toBe('-');
	});

	it('only ever emits 8/16-colour codes — no 256-colour, no truecolor, no bright', () => {
		const codes = Object.values(STATE_GLYPHS)
			.map((s) => paint('x', s.color, true))
			.concat(['cyan', 'magenta', 'blue', 'yellow', 'dim'].map((c) => paint('x', c as AnsiStyle, true)))
			.join('');
		expect(codes).not.toMatch(/\x1b\[[0-9;]*(38|48);/); // 256-colour / truecolor
		expect(codes).not.toMatch(/\x1b\[(9[0-7]|10[0-7])/); // bright / bright-background
		for (const m of codes.matchAll(/\x1b\[([0-9;]*)m/g)) {
			for (const n of (m[1] ?? '').split(';')) {
				expect([0, 2, 31, 32, 33, 34, 35, 36]).toContain(Number(n));
			}
		}
	});
});

describe('T5 render options thread through the read path, changing nothing (§6)', () => {
	const READS = [['list'], ['next'], ['ready'], ['tree'], ['show', '005'], ['show', '005', '--children']];
	const COMBOS = [
		{ color: false, plain: false },
		{ color: true, plain: false },
		{ color: false, plain: true },
		{ color: true, plain: true }
	];

	// The byte-identical-in-all-four-combinations guard that lived here was the
	// expand half's whole point; T6 migrates the renderers onto the options, so the
	// combinations now differ on purpose. T6 covers each of them explicitly.

	it('the flags parse on every read command without error', () => {
		for (const argv of READS) {
			for (const flag of ['--plain', '--color', '--no-color']) {
				expect(() => run(T5, [...argv, flag])).not.toThrow();
			}
		}
	});

	it('--json output is untouched by the render options', () => {
		for (const argv of [['list'], ['next'], ['ready'], ['tree'], ['show', '005']]) {
			const baseline = run(T5, [...argv, '--json']).output;
			for (const render of COMBOS) {
				expect(run(T5, [...argv, '--json'], render).output).toBe(baseline);
			}
		}
	});

	it('the core still reads no process.env and probes no TTY', () => {
		// Comments name both (they explain the boundary); only real code counts.
		const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/\/\/.*$/gm, '')
			// The help text documents `NO_COLOR` and the flags as prose; exempt it so the
			// token check below stays a real guard rather than a false positive.
			.replace(/const HELP = `[\s\S]*?`;/, '');
		// `today()` is the one sanctioned env read (the ISSUES_DATE test hook).
		expect([...src.matchAll(/process\.env\.(\w+)/g)].map((m) => m[1])).toEqual(['ISSUES_DATE']);
		expect(src).not.toMatch(/\bisTTY\b|\bNO_COLOR\b|process\.stdout/);
	});
});

// ── T6 — compact rows: gutter, element colour, --plain postfix tags (§1, §2, §5) ──
// The contract half of the expand–contract: the renderers move onto T5's plumbing,
// and the four `{color, plain}` combinations now differ on purpose.

const T6 = `---
next_id: 5
pattern: "###"
---
# T

## Issues

- [ ] 001: Blocker.

- [ ] 002: Rich row. status:doing @matt #bug #parser
      A note line.

- [ ] 003: Blocked. blocked-by:001

## Completed

- [x] 004: Closed and blocked. blocked-by:001 @jo (2026-06-07)

## Deferred

## Won't Fix
`;

const ESC = '\x1b';
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const rowFor = (out: string, id: string) => out.split('\n').find((l) => stripAnsi(l).includes(id))!;

describe('T6 gutter — the state channel, glyph and colour (§1, §2)', () => {
	it('every row leads with its state glyph, in every section', () => {
		const out = run(T6, ['list', '--all']).output;
		expect(rowFor(out, '001')).toBe('  - 001  Blocker.');
		expect(rowFor(out, '003')).toBe('  ⊘ 003  Blocked.');
		expect(rowFor(out, '004')).toContain('✓ 004');
	});

	it('claimed and the three closed sections each get their glyph', () => {
		const out = run(T5, ['list', '--all']).output;
		expect(rowFor(out, '003')).toContain('~ 003'); // claimed
		expect(rowFor(out, '005')).toContain('⊘ 005'); // blocked + claimed → blocked
		expect(rowFor(out, '006')).toContain('✓ 006'); // completed
		expect(rowFor(out, '007')).toContain('» 007'); // deferred
		expect(rowFor(out, '008')).toContain('× 008'); // won't fix
	});

	it('the gutter aligns — a blocked row no longer shifts the id right', () => {
		const rows = run(T6, ['list']).output.split('\n');
		const cols = rows.map((r) => r.indexOf(stripAnsi(r).match(/00\d/)![0]));
		expect(new Set(cols).size).toBe(1);
	});

	it('the section tags are gone in glyph mode — the gutter carries the section', () => {
		const out = run(T6, ['list', '--all']).output;
		expect(out).not.toContain('[Completed]');
		expect(out).not.toContain('[blocked]');
	});

	it('the gutter takes its state colour; open is uncoloured', () => {
		const out = run(T6, ['list', '--all'], { color: true, plain: false }).output;
		expect(rowFor(out, '003')).toContain(`${ESC}[31m⊘${ESC}[0m`); // blocked → red
		expect(rowFor(out, '004')).toContain(`${ESC}[32m✓${ESC}[0m`); // completed → green
		expect(rowFor(out, '001')).toContain('  - '); // open → no colour at all
	});
});

describe('T6 element colours — same field, same colour, every row (§2)', () => {
	const out = run(T6, ['list', '--all'], { color: true, plain: false }).output;

	it('ids are cyan', () => {
		expect(rowFor(out, '002')).toContain(`${ESC}[36m002${ESC}[0m`);
	});

	it('the status value is yellow and its key stays default', () => {
		expect(rowFor(out, '002')).toContain(`status:${ESC}[33mdoing${ESC}[0m`);
	});

	it('assignees are magenta and labels blue', () => {
		expect(rowFor(out, '002')).toContain(`${ESC}[35m@matt${ESC}[0m`);
		expect(rowFor(out, '002')).toContain(`${ESC}[34m#bug${ESC}[0m`);
		expect(rowFor(out, '002')).toContain(`${ESC}[34m#parser${ESC}[0m`);
	});

	it('the title dims when the issue is closed, and only then', () => {
		expect(rowFor(out, '004')).toContain(`${ESC}[2mClosed and blocked.${ESC}[0m`);
		expect(rowFor(out, '002')).toContain(' Rich row.');
		expect(rowFor(out, '002')).not.toContain(`${ESC}[2m`);
	});

	it('--no-color keeps the gutter and glyphs, dropping only the colour (§5.4.2)', () => {
		const plainish = run(T6, ['list', '--all'], { color: false, plain: false }).output;
		expect(plainish).not.toContain(ESC);
		expect(plainish).toContain('⊘ 003');
		expect(stripAnsi(out)).toBe(plainish); // colour is the only difference
	});
});

describe('T6 --plain — the colour-free rendering of the new design (§5)', () => {
	const plain = run(T6, ['list', '--all'], { color: false, plain: true }).output;

	it('emits no escape codes anywhere', () => {
		expect(plain).not.toContain(ESC);
	});

	it('drops the gutter — indent + id + title + markers + [tags]', () => {
		expect(rowFor(plain, '001')).toBe('  001  Blocker.');
		expect(rowFor(plain, '002')).toBe('  002  Rich row. status:doing @matt #bug #parser …');
	});

	it('restores the postfix tags, tags last — after markers, date and note', () => {
		expect(rowFor(plain, '003')).toBe('  003  Blocked. [blocked]');
		expect(rowFor(plain, '004')).toBe('  004  Closed and blocked. @jo (2026-06-07) [Completed] [blocked]');
	});

	it('a closed-and-blocked row shows both tags — --plain has room the gutter does not', () => {
		expect(rowFor(plain, '004')).toContain('[Completed] [blocked]');
	});

	it('casing is load-bearing: capitalized = stored, lowercase = derived (ADR 0003)', () => {
		const all = run(T5, ['list', '--all'], { color: false, plain: true }).output;
		expect(rowFor(all, '006')).toContain('[Completed]');
		expect(rowFor(all, '007')).toContain('[Deferred]');
		expect(rowFor(all, '008')).toContain("[Won't Fix]");
		expect(rowFor(all, '004')).toContain('[blocked]');
	});

	it('claimed needs no tag — @who already carries the claim', () => {
		const all = run(T5, ['list', '--all'], { color: false, plain: true }).output;
		expect(rowFor(all, '003')).toBe('  003  Claimed. @matt');
	});

	it('--plain is the strongest flag — it wins over colour, silently (§5.4.1)', () => {
		expect(run(T6, ['list', '--all'], { color: true, plain: true }).output).toBe(plain);
	});
});

describe('T6 the same row renderer everywhere — list, next, ready, tree, children', () => {
	const COMBOS = [
		{ color: false, plain: false },
		{ color: true, plain: false },
		{ color: false, plain: true },
		{ color: true, plain: true }
	];

	it('next and ready render the gutter in all four combinations', () => {
		for (const render of COMBOS) {
			for (const cmd of ['next', 'ready']) {
				const out = run(T6, [cmd], render).output;
				// The gutter is present in glyph mode and gone under --plain. Strip the
				// colour first — in colour mode an SGR pair sits between glyph and id.
				expect(stripAnsi(out).includes('- 001')).toBe(!render.plain);
				expect(stripAnsi(out)).toContain('001  Blocker.');
				if (!render.color || render.plain) expect(out).not.toContain(ESC);
			}
		}
	});

	it('ready colours ids and gutters like list does', () => {
		const out = run(T6, ['ready'], { color: true, plain: false }).output;
		expect(out).toContain(`${ESC}[36m001${ESC}[0m`);
	});

	it('tree inherits the gutter without waiting on its own ticket', () => {
		const out = run(T6, ['tree', '--all']).output; // --all: #29 flipped tree to open-only
		expect(rowFor(out, '003')).toContain('⊘ 003');
		expect(rowFor(out, '004')).toContain('✓ 004');
		expect(out).not.toContain('[Completed]'); // tag gone in glyph mode
		expect(rowFor(run(T6, ['tree'], { color: true, plain: false }).output, '001')).toContain(
			`${ESC}[36m001${ESC}[0m`
		);
	});

	it('tree under --plain drops the gutter and restores the tags', () => {
		const out = run(T6, ['tree', '--all'], { color: false, plain: true }).output;
		expect(out).not.toContain(ESC);
		expect(rowFor(out, '003')).toBe('  003  Blocked. [blocked]');
		expect(rowFor(out, '004')).toContain('[Completed] [blocked]');
	});

	it('show --children renders its child rows through the same renderer', () => {
		const kids = `---\nnext_id: 4\npattern: "###"\n---\n# T\n\n## Issues\n\n- [ ] 001: Parent.\n\n- [ ] 002: Kid. part-of:001 @jo\n\n## Completed\n\n## Deferred\n\n## Won't Fix\n`;
		expect(run(kids, ['show', '001', '--children']).output).toContain('~ 002');
		expect(run(kids, ['show', '001', '--children'], { color: false, plain: true }).output).toContain(
			'  002  Kid. @jo'
		);
	});
});

describe('T6 --json is untouched by any of it (§7, §8)', () => {
	it('carries no escape codes, no glyphs, and still no state field', () => {
		for (const argv of [['list', '--all'], ['next'], ['ready'], ['tree'], ['show', '004']]) {
			const baseline = run(T6, [...argv, '--json']).output;
			for (const render of [{ color: true, plain: false }, { color: false, plain: true }]) {
				expect(run(T6, [...argv, '--json'], render).output).toBe(baseline);
			}
			expect(baseline).not.toContain(ESC);
			expect(baseline).not.toContain('⊘');
			// Reach the issue objects themselves — `list`/`ready`/`tree` emit arrays and
			// `next` a `{issue, reason}` wrapper, so asserting on the root would name a
			// guard it does not apply.
			const parsed = JSON.parse(baseline);
			const issues = Array.isArray(parsed) ? parsed : [parsed.issue ?? parsed];
			expect(issues.length).toBeGreaterThan(0);
			for (const it of issues) expect(it).not.toHaveProperty('state');
		}
	});
});

// ── T7 — tree: list's filters, open-by-default, ancestor scaffolding (§3, §7) ──

const T7 = `---
next_id: 11
pattern: "###"
---
# T

## Issues

- [ ] 001: Root.

- [ ] 002: Match me. part-of:001 status:doing #api

- [ ] 003: Middle. part-of:001 #ui

- [ ] 004: Deep match. part-of:003 status:doing #api

- [ ] 005: Unrelated open.

- [ ] 009: Open under closed. part-of:006

## Completed

- [x] 006: Closed root. (2026-06-07)

- [x] 007: Closed child. part-of:006 (2026-06-07)

## Deferred

- [ ] 008: Deferred one. (2026-06-07)

## Won't Fix
`;

// The ids a rendered forest actually shows, in render order.
const idsIn = (out: string) =>
	out
		.split('\n')
		.map((l) => stripAnsi(l).match(/\b(\d{3})\b/)?.[1])
		.filter(Boolean) as string[];

describe('T7 tree — the same flag set as list (§3.1)', () => {
	it('defaults to open — the breaking flip', () => {
		const ids = idsIn(run(T7, ['tree']).output);
		expect(ids).toContain('001');
		expect(ids).toContain('009');
		expect(ids).not.toContain('007'); // closed, and no open descendant
		expect(ids).not.toContain('008'); // deferred
	});

	it('--all restores the every-section behaviour tree had before the flip', () => {
		const ids = idsIn(run(T7, ['tree', '--all']).output);
		for (const id of ['001', '002', '003', '004', '005', '006', '007', '008', '009']) {
			expect(ids).toContain(id);
		}
	});

	it('the section flags select the same issues list does', () => {
		for (const flag of ['--all', '--closed', '--deferred', '--wontfix']) {
			const treeIds = new Set(idsIn(run(T7, ['tree', flag]).output));
			const listIds = new Set(idsIn(run(T7, ['list', flag]).output));
			// tree may add ancestors as scaffolding, so list ⊆ tree, never the reverse.
			for (const id of listIds) expect(treeIds).toContain(id);
		}
	});

	it('the filters AND across dimensions and OR within one, exactly as list does', () => {
		const matched = (argv: string[]) =>
			new Set(idsIn(run(T7, ['list', ...argv]).output));
		// #api OR #ui, AND status:doing → 002 and 004 both qualify.
		expect(matched(['--label', 'api,ui', '--status', 'doing'])).toEqual(new Set(['002', '004']));
		// A tree over the same filter matches the same issues (plus scaffolding).
		const treeIds = new Set(idsIn(run(T7, ['tree', '--label', 'api,ui', '--status', 'doing']).output));
		for (const id of ['002', '004']) expect(treeIds).toContain(id);
	});

	it('--parent and --assignee are accepted and narrow the forest', () => {
		expect(idsIn(run(T7, ['tree', '--parent', '001']).output)).toContain('002');
		expect(run(T7, ['tree', '--assignee', 'nobody']).output).toBe('No issues.');
	});
});

describe('T7 tree — ancestor scaffolding (§3.2)', () => {
	it('renders a non-matching ancestor in place, nothing stripped, nothing moved', () => {
		const out = run(T7, ['tree', '--status', 'doing']).output;
		expect(idsIn(out)).toEqual(['001', '002', '003', '004']);
		// 003 is scaffolding but keeps its glyph, id, title and markers.
		expect(stripAnsi(out)).toContain('- 003  Middle. #ui');
	});

	it('drops non-matching branches that contain no match', () => {
		const ids = idsIn(run(T7, ['tree', '--status', 'doing']).output);
		expect(ids).not.toContain('005'); // no match anywhere in it
		expect(ids).not.toContain('009');
	});

	it('a closed ancestor of an open match is scaffolding under the default sections', () => {
		const ids = idsIn(run(T7, ['tree']).output);
		expect(ids).toContain('006'); // closed, kept as the path to open 009
		expect(ids).toContain('009');
		expect(ids).not.toContain('007'); // closed with no open descendant
	});

	it('containment reads identically to an unfiltered tree — depth is preserved', () => {
		const filtered = run(T7, ['tree', '--status', 'doing']).output.split('\n');
		const all = run(T7, ['tree', '--all']).output.split('\n');
		const indentOf = (lines: string[], id: string) =>
			stripAnsi(lines.find((l) => stripAnsi(l).includes(id))!).match(/^\s*/)![0].length;
		for (const id of ['001', '002', '003', '004']) {
			expect(indentOf(filtered, id)).toBe(indentOf(all, id));
		}
	});

	it('in colour mode the whole scaffolding row dims — and carries no element colour', () => {
		const out = run(T7, ['tree', '--status', 'doing'], { color: true, plain: false }).output;
		const scaffold = out.split('\n').find((l) => l.includes('003'))!;
		expect(scaffold).toBe(`    ${ESC}[2m- 003  Middle. #ui${ESC}[0m`);
		expect(scaffold).not.toContain(`${ESC}[36m`); // no cyan id inside the dim span
		expect(scaffold).not.toContain(`${ESC}[34m`); // no blue label either
	});

	it('a matching row keeps its element colours and does not dim', () => {
		const out = run(T7, ['tree', '--status', 'doing'], { color: true, plain: false }).output;
		const match = out.split('\n').find((l) => l.includes('004'))!;
		expect(match).toContain(`${ESC}[36m004${ESC}[0m`);
		expect(match).not.toContain(`${ESC}[2m`);
	});

	it('the marker follows the colour channel, not the flag — --no-color still marks it', () => {
		// A dimmed row is byte-identical to a matching one when nothing can be dimmed,
		// so the structural marker has to appear in every mode without colour: --plain,
		// --no-color, and a piped (non-TTY) stdout. Otherwise the filter goes invisible,
		// which is the one outcome §3.2 rules out.
		const out = run(T7, ['tree', '--status', 'doing'], { color: false, plain: false }).output;
		expect(out).not.toContain(ESC);
		const row = (id: string) => out.split('\n').find((l) => l.includes(id))!;
		expect(row('003')).toBe('    - 003  Middle. #ui /'); // scaffolding, gutter intact
		expect(row('004')).toBe('      - 004  Deep match. status:doing #api'); // a match
	});

	it('under --plain scaffolding carries a trailing / and matches do not', () => {
		const out = run(T7, ['tree', '--status', 'doing'], { color: false, plain: true }).output;
		expect(out).not.toContain(ESC);
		const row = (id: string) => out.split('\n').find((l) => l.includes(id))!;
		expect(row('001')).toBe('  001  Root. /');
		expect(row('003')).toBe('    003  Middle. #ui /');
		expect(row('002')).toBe('    002  Match me. status:doing #api');
		expect(row('004')).toBe('      004  Deep match. status:doing #api');
	});

	it('the trailing / sits last, after the postfix state tags', () => {
		const out = run(T7, ['tree'], { color: false, plain: true }).output;
		expect(out.split('\n').find((l) => l.includes('006'))).toBe('  006  Closed root. [Completed] /');
	});
});

describe('T7 tree — what scaffolding does not touch (§3.2, §4.4)', () => {
	it('scaffolding never reaches show — children render unfiltered', () => {
		const out = run(T7, ['show', '001', '--children']).output;
		expect(out).not.toContain(' /');
		expect(idsIn(out)).toContain('003'); // rendered as an ordinary row
	});

	it('tree --json is unchanged — the machine forest stays unfiltered', () => {
		const baseline = run(T7, ['tree', '--json']).output;
		for (const argv of [['--status', 'doing'], ['--all'], ['--label', 'api']]) {
			expect(run(T7, ['tree', '--json', ...argv]).output).toBe(baseline);
		}
		expect(JSON.parse(baseline)).toHaveLength(4); // 001, 005, 006 and 008 are the roots
	});
});

// ── T8 — show: one-line header, unified state:, capitalized sections (§4) ────

// The spec's own §4.5 example, rebuilt as a fixture so the dossier can be asserted
// byte-for-byte against the document that specified it.
const T8 = `---
next_id: 46
pattern: "ISS###"
---
# T

## Issues

- [ ] ISS030: Round-trip fidelity

- [ ] ISS041: Land the tokenizer rewrite

- [ ] ISS042: Parser drops trailing detail lines on reserialize part-of:ISS030 blocked-by:ISS041,ISS039 spike:2d status:doing @matt #bug #parser (2026-01-14)
      Reproduces only when the note body ends without a blank line.

- [ ] ISS044: Add regression fixture part-of:ISS042 @jo #parser

- [ ] ISS045: Backfill the round-trip corpus part-of:ISS042 blocked-by:ISS041 #parser

## Completed

- [x] ISS039: Pin the detail-line grammar (2026-01-10)

## Deferred

## Won't Fix
`;

// §4.5 verbatim, down to the child rows — with two documented departures from the
// printed example (see the spec's §9.0):
//   · the ids are `ISS042`, not `ISS-042`: `ISSUE_RE` is `[A-Za-z]*[0-9]+`, so a
//     hyphenated id cannot exist in an ISSUES.md at all.
//   · the example's closing `! … is blocked by …, which is closed` line has no
//     counterpart in `graphWarnings` — it is the cascade advisory design §10 defers
//     to #26, on a *write* command. Nothing here should emit it.
const DOSSIER = [
	'ISS042  Parser drops trailing detail lines on reserialize (2026-01-14)',
	'  state: Open, blocked, claimed',
	'  status: doing',
	'  assignee: @matt',
	'  labels: #bug #parser',
	'  part-of: ISS030 (Round-trip fidelity) — Open',
	'  blocked-by: ISS041 (Land the tokenizer rewrite) — Open',
	'  blocked-by: ISS039 (Pin the detail-line grammar) — Completed',
	'  spike: 2d',
	'    Reproduces only when the note body ends without a blank line.',
	'  children:'
].join('\n');

describe('T8 show — the §4.5 dossier, byte-for-byte through the child rows', () => {
	it('emits no advisory for a closed blocker — §4.5s last line is #26s, not ours', () => {
		expect(run(T8, ['show', 'ISS042']).output).not.toContain('!');
		expect(graphWarnings(parse(T8))).toEqual([]);
	});

	it('renders the spec example exactly, in glyph mode', () => {
		const out = run(T8, ['show', 'ISS042', '--children']).output;
		expect(out).toBe(
			DOSSIER +
				'\n    ~ ISS044  Add regression fixture @jo #parser' +
				'\n    ⊘ ISS045  Backfill the round-trip corpus #parser'
		);
	});

	it('renders the --plain example exactly — only the child rows differ', () => {
		const out = run(T8, ['show', 'ISS042', '--children'], { color: false, plain: true }).output;
		expect(out).toBe(
			DOSSIER +
				'\n    ISS044  Add regression fixture @jo #parser' +
				'\n    ISS045  Backfill the round-trip corpus #parser [blocked]'
		);
	});

	it('the two are byte-identical down to children: — the dossier is plain-native', () => {
		const glyph = run(T8, ['show', 'ISS042', '--children']).output;
		const plain = run(T8, ['show', 'ISS042', '--children'], { color: false, plain: true }).output;
		const upTo = (s: string) => s.slice(0, s.indexOf('children:') + 'children:'.length);
		expect(upTo(plain)).toBe(upTo(glyph));
	});
});

describe('T8 show — the header collapses to one line (§4.1)', () => {
	const out = run(T8, ['show', 'ISS042']).output;

	it('is id  title (date), with the date inline', () => {
		expect(out.split('\n')[0]).toBe(
			'ISS042  Parser drops trailing detail lines on reserialize (2026-01-14)'
		);
	});

	it('sheds the section suffix, the [x] mark and ⊘ blocked', () => {
		expect(out.split('\n')[0]).not.toContain('—');
		expect(out).not.toContain('[x]');
		expect(out).not.toContain('⊘ blocked');
	});
});

describe('T8 show — the unified state: field (§4.2)', () => {
	const stateOf = (text: string, id: string) =>
		run(text, ['show', id]).output.split('\n').find((l) => l.startsWith('  state:'))!;

	it('names every applicable state, derived terms in blocked-then-claimed order', () => {
		expect(stateOf(T8, 'ISS042')).toBe('  state: Open, blocked, claimed');
		expect(stateOf(T8, 'ISS041')).toBe('  state: Open');
		expect(stateOf(T8, 'ISS044')).toBe('  state: Open, claimed');
		expect(stateOf(T8, 'ISS045')).toBe('  state: Open, blocked');
	});

	it('the three closed sections speak their own name', () => {
		expect(stateOf(T5, '006')).toBe('  state: Completed');
		expect(stateOf(T5, '007')).toBe('  state: Deferred');
		expect(stateOf(T5, '008')).toBe("  state: Won't Fix");
	});

	it('suppresses the derived axis once closed — but keeps the evidence', () => {
		// 006 is Completed, blocked-by an open 001, and assigned to @matt.
		const out = run(T5, ['show', '006']).output;
		expect(out).toContain('  state: Completed');
		expect(out).not.toContain('blocked,');
		expect(out).not.toContain('claimed');
		// Nothing is lost: the stale blocker is still fully visible with its — Open
		// suffix, and the assignee is still rendered — just not relabelled a claim.
		expect(out).toContain('blocked-by: 001 (Open blocker.) — Open');
		expect(out).toContain('assignee: @matt');
	});
});

describe('T8 show — one capitalized vocabulary for the section axis (§4.4)', () => {
	it('resolveRef suffixes capitalize, matching the token in state:', () => {
		const out = run(T8, ['show', 'ISS042']).output;
		expect(out).toContain('— Completed');
		expect(out).not.toContain('— completed');
	});

	it('the Issues section is spoken as Open, in both places', () => {
		const out = run(T8, ['show', 'ISS042']).output;
		expect(out).toContain('blocked-by: ISS041 (Land the tokenizer rewrite) — Open');
		expect(out).toContain('  state: Open');
		expect(out).not.toContain('Issues');
	});

	it('a dangling and a self-referencing pointer are unchanged', () => {
		expect(run(GRAPH, ['show', '003']).output).toMatch(/part-of: 998 \(not found\)/);
		expect(run(GRAPH, ['show', '001']).output).toMatch(/self-reference — ignored/);
	});
});

describe('T8 show — colour is confined to the state: field (§4.3)', () => {
	const out = run(T8, ['show', 'ISS042', '--children'], { color: true, plain: false }).output;
	const line = (prefix: string) => out.split('\n').find((l) => stripAnsi(l).startsWith(prefix))!;

	it('each state token takes its own colour', () => {
		expect(line('  state:')).toBe(
			`  state: Open, ${ESC}[31mblocked${ESC}[0m, ${ESC}[33mclaimed${ESC}[0m`
		);
	});

	it('the title is never state-coloured', () => {
		const header = out.split('\n')[0]!;
		expect(header).toContain('  Parser drops trailing detail lines on reserialize (2026-01-14)');
		expect(header).not.toContain(`${ESC}[31m`);
		expect(header).not.toContain(`${ESC}[33m`);
		expect(header).not.toContain(`${ESC}[2m`);
	});

	it('the title dims when the issue is closed — de-emphasis, not a state claim', () => {
		const closed = run(T8, ['show', 'ISS039'], { color: true, plain: false }).output;
		expect(closed.split('\n')[0]).toContain(`${ESC}[2mPin the detail-line grammar${ESC}[0m`);
	});

	it('everything else is element-typed, ids inside relationships included', () => {
		expect(out.split('\n')[0]).toContain(`${ESC}[36mISS042${ESC}[0m`);
		expect(line('  part-of:')).toContain(`${ESC}[36mISS030${ESC}[0m`);
		expect(line('  blocked-by:')).toContain(`${ESC}[36mISS041${ESC}[0m`);
		expect(line('  status:')).toBe(`  status: ${ESC}[33mdoing${ESC}[0m`);
		expect(line('  assignee:')).toBe(`  assignee: ${ESC}[35m@matt${ESC}[0m`);
		expect(line('  labels:')).toBe(`  labels: ${ESC}[34m#bug${ESC}[0m ${ESC}[34m#parser${ESC}[0m`);
	});

	it('the relationship suffix is default-coloured — state colour lives in one place', () => {
		expect(line('  part-of:')).toBe(
			`  part-of: ${ESC}[36mISS030${ESC}[0m (Round-trip fidelity) — Open`
		);
	});

	it('--plain keeps state: bare while child rows bracket their derived tags (§5.3)', () => {
		const plain = run(T8, ['show', 'ISS042', '--children'], { color: false, plain: true }).output;
		expect(plain).not.toContain(ESC);
		expect(plain).toContain('  state: Open, blocked, claimed'); // bare — key: delimits
		expect(plain).toContain('[blocked]'); // bracketed on a row — no key: to delimit
	});
});

describe('T8 show --json is unchanged (§4, §8)', () => {
	it('carries no state field, no colour, and the same shape as before', () => {
		const baseline = run(T8, ['show', 'ISS042', '--children', '--json']).output;
		for (const render of [{ color: true, plain: false }, { color: false, plain: true }]) {
			expect(run(T8, ['show', 'ISS042', '--children', '--json'], render).output).toBe(baseline);
		}
		const parsed = JSON.parse(baseline);
		expect(parsed).not.toHaveProperty('state');
		expect(parsed.section).toBe('Issues'); // the raw section, not the spoken label
		expect(parsed.blocked).toBe(true);
	});
});

// ── T9 — the docs cannot drift from the CLI surface ─────────────────────────
// `ReadMe.md` and `skills/issues/SKILL.md` both embed a copy of `--help`. CLAUDE.md
// requires the skill to track the CLI surface, and it went stale once already, so the
// copies are pinned rather than trusted.
//
// Scope of the guard: the fenced help block only, and by line-membership rather than
// order — the surrounding prose and the README's example rows are still trust-based.

describe('T9 embedded --help copies stay in step with the real one', () => {
	const help = run('', ['help']).output;
	const embedded = (file: string) => {
		const src = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
		const block = src.match(/```\nissues <command> \[args\]\n([\s\S]*?)\n```/);
		expect(block, `${file} has no embedded help block`).toBeTruthy();
		return block![1]!;
	};

	for (const file of ['ReadMe.md', 'skills/issues/SKILL.md']) {
		it(`${file} quotes every line of --help verbatim`, () => {
			const lines = help.split('\n');
			for (const line of embedded(file).split('\n')) {
				if (!line.trim()) continue;
				expect(lines, `${file}: "${line}" is not in --help`).toContain(line);
			}
		});

		it(`${file} documents every command and flag --help names`, () => {
			const doc = embedded(file);
			for (const line of help.split('\n')) {
				if (!line.trim() || line.startsWith('Usage:')) continue;
				expect(doc, `--help line missing from ${file}: "${line}"`).toContain(line);
			}
		});
	}
});

// ── T10 — the parser must read every id the writer can produce ──────────────
// `formatId` builds an id as `pattern` minus its trailing `#`s, plus zero-padded
// digits — so `pattern: "ISS-###"` writes `ISS-042`. `ISSUE_RE` did not admit the
// hyphen, so the tool wrote lines it could not read back, and the next mutation
// serialized the file without them. Silent data loss, not a cosmetic gap.

const HYPHENATED = `---
next_id: 44
pattern: "ISS-###"
---
# T

## Issues

- [ ] ISS-042: Parser drops trailing detail lines. blocked-by:ISS-041 @matt #bug
      A note line.

- [ ] ISS-041: Land the tokenizer rewrite.

## Completed

- [x] ISS-039: Pin the detail-line grammar. (2026-01-10)

## Deferred

## Won't Fix
`;

describe('T10 prefixed id patterns round-trip, hyphens included', () => {
	it('parses every id its own formatId can write', () => {
		for (const pattern of ['###', 'M##', 'BZ###', 'ISS-###', 'proj_##']) {
			const id = formatId(7, pattern);
			const text = `---\nnext_id: 8\npattern: "${pattern}"\n---\n# T\n\n## Issues\n\n- [ ] ${id}: A title.\n\n## Completed\n\n## Deferred\n\n## Won't Fix\n`;
			const doc = parse(text);
			expect(findIssue(doc, id), `${pattern} → ${id} did not parse`).toBeTruthy();
			expect(serialize(doc)).toBe(text); // and round-trips byte-for-byte
		}
	});

	it('round-trips a hyphenated file byte-for-byte', () => {
		expect(serialize(parse(HYPHENATED))).toBe(HYPHENATED);
	});

	it('add → read → add no longer destroys the first issue', () => {
		const empty = `---\nnext_id: 42\npattern: "ISS-###"\n---\n# T\n\n## Issues\n\n## Completed\n\n## Deferred\n\n## Won't Fix\n`;
		const afterFirst = run(empty, ['add', 'First issue']).text;
		expect(run(afterFirst, ['list']).output).toContain('ISS-042');
		const afterSecond = run(afterFirst, ['add', 'Second issue']).text;
		expect(afterSecond).toContain('ISS-042: First issue'); // survived the rewrite
		expect(afterSecond).toContain('ISS-043: Second issue');
	});

	it('resolves relationships and ids through the hyphen', () => {
		const doc = parse(HYPHENATED);
		expect(normalizeId('ISS-42', doc.pattern)).toBe('ISS-042');
		expect(normalizeId('42', doc.pattern)).toBe('ISS-042'); // still forgiving on input
		expect(isBlocked(doc, findIssue(doc, 'ISS-042')!.issue)).toBe(true);
		expect(run(HYPHENATED, ['show', 'ISS-042']).output).toContain(
			'blocked-by: ISS-041 (Land the tokenizer rewrite.) — Open'
		);
	});

	it('an id still needs a letter before the hyphen — `-42` is not an id', () => {
		const odd = `---\nnext_id: 2\npattern: "###"\n---\n# T\n\n## Issues\n\n- [ ] -42: Not an id.\n\n## Completed\n\n## Deferred\n\n## Won't Fix\n`;
		expect(parse(odd).sections.get('Issues')).toHaveLength(0);
		// and `doctor` says so rather than dropping it silently
		expect(doctorFindings(parse(odd), odd).some((f) => /malformed line/.test(f))).toBe(true);
	});

	it('does not absorb a hand-written checklist item as an issue', () => {
		// The dangerous direction: `parse` normalizes every id it reads to the document's
		// pattern, so absorbing `TODO-1` under `###` would rewrite it to `001`, collide
		// with the real 001, break the round-trip on write, and aim `done 001` at the
		// wrong issue — while `doctor` reported the file clean.
		const prose = `---\nnext_id: 2\npattern: "###"\n---\n# T\n\n## Issues\n\n- [ ] 001: Real issue.\n\n- [ ] TODO-1: buy milk\n\n## Completed\n\n## Deferred\n\n## Won't Fix\n`;
		const doc = parse(prose);
		expect(doc.sections.get('Issues')!.map((i) => i.id)).toEqual(['001']);
		expect(doctorFindings(doc, prose).some((f) => /malformed line/.test(f))).toBe(true);
	});

	it('a foreign prefix stays malformed even when it looks like an id', () => {
		for (const line of ['- [ ] TODO-1: x', '- [ ] Fix-123: x', '- [ ] ABC_9: x']) {
			const text = `---\nnext_id: 2\npattern: "ISS-###"\n---\n# T\n\n## Issues\n\n${line}\n\n## Completed\n\n## Deferred\n\n## Won't Fix\n`;
			expect(parse(text).sections.get('Issues'), line).toHaveLength(0);
		}
	});

	it('bare ids still migrate into a newly-adopted prefix', () => {
		// A `###` file that switches to `ISS-###` keeps reading its existing ids and
		// renumbers them on the next write — the one lenient case worth keeping.
		const migrating = `---\nnext_id: 3\npattern: "ISS-###"\n---\n# T\n\n## Issues\n\n- [ ] 001: Written before the prefix.\n\n## Completed\n\n## Deferred\n\n## Won't Fix\n`;
		const doc = parse(migrating);
		expect(findIssue(doc, '001')!.issue.id).toBe('ISS-001');
		expect(serialize(doc)).toContain('- [ ] ISS-001: Written before the prefix.');
	});

	it('the prefix match is case-insensitive, as id input has always been', () => {
		const lower = `---\nnext_id: 2\npattern: "ISS-###"\n---\n# T\n\n## Issues\n\n- [ ] iss-001: Hand-typed.\n\n## Completed\n\n## Deferred\n\n## Won't Fix\n`;
		expect(findIssue(parse(lower), 'ISS-001')).toBeTruthy();
	});

	it('doctor flags an unparseable id line — the damage is at least detectable', () => {
		const broken = `---\nnext_id: 2\npattern: "###"\n---\n# T\n\n## Issues\n\n- [ ] no-digits: Bad.\n\n## Completed\n\n## Deferred\n\n## Won't Fix\n`;
		expect(doctorFindings(parse(broken), broken).some((f) => /malformed line/.test(f))).toBe(true);
	});
});
