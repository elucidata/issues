#!/usr/bin/env node
/**
 * Issue tracker CLI — the thin filesystem shell around `./index`.
 *
 * Runs under both Node (22+ strips TS types) and Bun:
 *   node src/bin.ts <command> [args]
 *   bun src/bin.ts <command> [args]
 *
 * The published/built entry is `dist/cli.js` (Node-targeted), exposed as the
 * `issues` bin — so consumers run it with `npx`, a global install, or straight
 * from GitHub (`npx github:elucidata/issues …`) without any Bun dependency.
 *
 * The target file is `ISSUES.md`, found by walking up from the current working
 * directory to the nearest directory that contains it. Set the `ISSUES_FILE`
 * env var to point at a specific file instead.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run } from './index';
import { resolveRenderOptions } from './options';
// The package manifest is the single source of truth for the tool's version. The
// bundler **inlines** this JSON at build time, so `dist/cli.js` carries the literal
// and prints it with zero runtime file I/O — the pure core (`./index`) stays
// import-free, and only this shell knows the version.
import pkg from '../package.json' with { type: 'json' };

// Resolve `ISSUES.md` by walking up from the working directory; the package
// hardcodes no depth in the tree, so it stays extraction-ready. An explicit
// `ISSUES_FILE` override short-circuits the search.
function resolveIssuesFile(): string {
	const override = process.env.ISSUES_FILE;
	if (override) return override;
	let dir = process.cwd();
	for (;;) {
		const candidate = join(dir, 'ISSUES.md');
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break; // reached the filesystem root
		dir = parent;
	}
	// Nothing found: fall back to the working-directory path so a `mutated`
	// command can create it (and a read returns empty).
	return join(process.cwd(), 'ISSUES.md');
}

function main(argv: string[]): void {
	// `version` / `--version` is a shell concern — it reports *this tool's* version,
	// not anything about `ISSUES.md`, so it answers before the file is even resolved.
	if (argv[0] === 'version' || argv.includes('--version')) {
		process.stdout.write(pkg.version + '\n');
		return;
	}

	const filePath = resolveIssuesFile();
	let text: string;
	try {
		text = readFileSync(filePath, 'utf8');
	} catch {
		// Missing file is only fatal once we know the command needs it.
		text = '';
	}
	// Terminal detection is exclusively a shell concern (design §6.1): the tri-state
	// presentation flags, `NO_COLOR` and TTY-ness resolve here, and the pure core is
	// handed the two booleans it renders from.
	const render = resolveRenderOptions(argv, process.env, !!process.stdout.isTTY);
	try {
		const result = run(text, argv, render);
		if (result.mutated) writeFileSync(filePath, result.text);
		if (result.output) process.stdout.write(result.output + '\n');
		// Advisory §3 warnings ride their own channel — stderr, never mixed into
		// stdout/JSON — and never block a write. `-q`/`--quiet` gating arrives later.
		for (const w of result.warnings) process.stderr.write(w + '\n');
		if (result.exitCode) process.exit(result.exitCode);
	} catch (err) {
		process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n');
		process.exit(1);
	}
}

// `bin.ts` is exclusively the CLI entry point — it is never imported (tests and
// library consumers import `./index`). Run unconditionally: an entry guard that
// compares `import.meta.url` to `process.argv[1]` breaks when the built bin is
// invoked through a symlink (as npm/bun bin shims and `npx`/`bunx` do), leaving
// `main()` silently un-run.
main(process.argv.slice(2));
