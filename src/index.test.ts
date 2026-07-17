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
	run
} from './index';

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
		expect(out).toContain('005 — Issues');
		expect(out).toContain('(Embed) Mask the scrim');
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
});
