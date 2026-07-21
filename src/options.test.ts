import { describe, it, expect } from 'vitest';
import { resolveRenderOptions } from './options';

// Every case names its inputs explicitly — the resolver reads no ambient state, so
// a test never has to stub `process`.
const R = (argv: string[], env: Record<string, string | undefined> = {}, isTTY = false) =>
	resolveRenderOptions(argv, env, isTTY);

describe('T5 §6.1 — {color, plain} resolution in the shell', () => {
	it('1. --plain forces colour off and plain on', () => {
		expect(R(['list', '--plain'], {}, true)).toEqual({ color: false, plain: true });
	});

	it('1. --plain is the strongest flag — --plain --color renders plain, silently', () => {
		expect(R(['list', '--plain', '--color'], {}, true)).toEqual({ color: false, plain: true });
	});

	it('2. --no-color beats --color when both are passed (order is unrecoverable)', () => {
		expect(R(['list', '--color', '--no-color'], {}, true).color).toBe(false);
		expect(R(['list', '--no-color', '--color'], {}, true).color).toBe(false);
	});

	it('2. --no-color keeps plain false — it is not an alias for --plain (§5.4.2)', () => {
		expect(R(['list', '--no-color'], {}, true)).toEqual({ color: false, plain: false });
	});

	it('3. --color wins over NO_COLOR and a non-TTY stdout', () => {
		expect(R(['list', '--color'], { NO_COLOR: '1' }, false).color).toBe(true);
	});

	it('4. NO_COLOR set to any value forces colour off', () => {
		for (const value of ['1', '0', '', 'false', 'no']) {
			expect(R(['list'], { NO_COLOR: value }, true).color).toBe(false);
		}
	});

	it('4. NO_COLOR never implies --plain (§5.4.4)', () => {
		expect(R(['list'], { NO_COLOR: '1' }, true)).toEqual({ color: false, plain: false });
	});

	it('4. an absent NO_COLOR does not force colour off', () => {
		expect(R(['list'], { NO_COLOR: undefined }, true).color).toBe(true);
	});

	it('5. otherwise colour follows stdout.isTTY', () => {
		expect(R(['list'], {}, true).color).toBe(true);
		expect(R(['list'], {}, false).color).toBe(false);
	});

	it('6. --json forces colour off regardless of everything above', () => {
		expect(R(['list', '--json'], {}, true).color).toBe(false);
		expect(R(['list', '--json', '--color'], {}, true).color).toBe(false);
	});

	it('6. --json --plain is a no-op, not an error', () => {
		expect(R(['list', '--json', '--plain'], {}, true)).toEqual({ color: false, plain: true });
	});
});

// The shell and the core must agree on what was passed. Both read the same
// `parseArgs`, so a value flag that swallows the next token, or a `--flag=value`
// form, resolves identically on either side of the seam.
describe('T5 §6.1 — the resolver reads the same grammar the core dispatches on', () => {
	it('a value flag swallows the next token — `--status --plain` is not plain', () => {
		// `--status` consumes `--plain` as its value (VALUE_FLAGS), so nothing asked
		// for plain rendering; scanning raw argv would have said otherwise.
		expect(R(['list', '--status', '--plain'], {}, true).plain).toBe(false);
	});

	it('the `--flag=value` form is honoured — `--json=1` still forces colour off', () => {
		expect(R(['list', '--json=1', '--color'], {}, true).color).toBe(false);
		expect(R(['list', '--plain=yes'], {}, true).plain).toBe(true);
	});
});
