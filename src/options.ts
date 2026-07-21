/**
 * Presentation-flag resolution — the shell's half of the colour/plain boundary
 * (design §6.1).
 *
 * This is `src/bin.ts` logic, split into its own module for one reason: `bin.ts`
 * runs `main()` on import (deliberately — see its footer), so nothing in it can be
 * unit-tested. Nothing here touches the filesystem or ambient state either: the
 * environment and TTY-ness arrive as arguments, so the resolver is a pure function
 * of its inputs and the four `{color, plain}` combinations are trivially covered.
 *
 * The pure core (`./index`) never sees the tri-state — it takes the two resolved
 * booleans and nothing else (§6.2).
 */
import { parseArgs } from './index';
import type { FlagValue, RenderOptions } from './index';

/**
 * Resolve `--plain` / `--color` / `--no-color` + `NO_COLOR` + TTY-ness down to the
 * two booleans the core renders from. Order (§6.1):
 *
 *   1. `--plain`      → color false (it is the strongest presentation flag, §5.4.1)
 *   2. `--no-color`   → color false — **wins over `--color`** when both are passed
 *   3. `--color`      → color true
 *   4. `NO_COLOR` set to any value → color false
 *   5. otherwise      → `isTTY`
 *   6. `--json`       → color false, regardless of everything above
 *
 * `--no-color` beating `--color` is forced, not preferred: boolean flags are stored
 * as separate keys, so argument order is unrecoverable and "last one wins" is
 * unimplementable without changing the parser. It is also the safer failure.
 *
 * `plain` is independent of all of it: `NO_COLOR` never implies `--plain` (§5.4.4),
 * `--no-color` is not an alias for it (§5.4.2), and `--json --plain` is a no-op
 * rather than an error (§5.4.3).
 *
 * The flags are read through the core's own `parseArgs`, not by scanning raw argv,
 * so the shell and `run` always agree on what was passed — `--status --plain` sets
 * `status:--plain` in both, and `--json=1` is `--json` in both.
 */
export function resolveRenderOptions(
	argv: string[],
	env: Record<string, string | undefined>,
	isTTY: boolean
): RenderOptions {
	const { flags } = parseArgs(argv);
	const plain = !!flags.plain;
	return { color: resolveColor(flags, env, isTTY, plain), plain };
}

function resolveColor(
	flags: Record<string, FlagValue>,
	env: Record<string, string | undefined>,
	isTTY: boolean,
	plain: boolean
): boolean {
	if (flags.json) return false; // 6 — `--json` is never colourized (§0)
	if (plain) return false; // 1
	if (flags['no-color']) return false; // 2
	if (flags.color) return true; // 3
	if (env.NO_COLOR !== undefined) return false; // 4 — any value, including empty
	return isTTY; // 5
}
