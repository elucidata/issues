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
import { pathToFileURL } from 'node:url';
import { run } from './index';

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
	const filePath = resolveIssuesFile();
	let text: string;
	try {
		text = readFileSync(filePath, 'utf8');
	} catch {
		// Missing file is only fatal once we know the command needs it.
		text = '';
	}
	try {
		const result = run(text, argv);
		if (result.mutated) writeFileSync(filePath, result.text);
		if (result.output) process.stdout.write(result.output + '\n');
	} catch (err) {
		process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n');
		process.exit(1);
	}
}

// Entry guard that works under both Bun and Node.
const invokedAs = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedAs) main(process.argv.slice(2));
