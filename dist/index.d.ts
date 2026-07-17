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
declare const SECTION_ORDER: readonly ['Issues', 'Completed', 'Deferred', "Won't Fix"];
type SectionName = (typeof SECTION_ORDER)[number];
export interface Issue {
    id: string;
    num: number;
    checked: boolean;
    title: string;
    date?: string;
    blockedBy: string[];
    detail: string[];
}
interface FrontmatterEntry {
    key: string;
    raw: string;
}
export interface Doc {
    frontmatter: FrontmatterEntry[];
    nextId: number;
    pattern: string;
    preamble: string;
    sections: Map<SectionName, Issue[]>;
}
export declare function parse(text: string): Doc;
export declare function serialize(doc: Doc): string;
export declare function formatId(num: number, pattern?: string): string;
export declare function normalizeId(input: string, pattern?: string): string;
export declare function findIssue(doc: Doc, idInput: string): {
    section: SectionName;
    index: number;
    issue: Issue;
} | null;
export declare function today(): string;
export declare function cmdAdd(doc: Doc, title: string, note?: string): string;
export declare function cmdDone(doc: Doc, idInput: string, target?: SectionName): string;
export declare function cmdReopen(doc: Doc, idInput: string): string;
export declare function cmdEdit(doc: Doc, idInput: string, title: string): string;
export declare function cmdNote(doc: Doc, idInput: string, text: string): string;
export declare function cmdShow(doc: Doc, idInput: string): string;
export interface ListOptions {
    all?: boolean;
    closed?: boolean;
    deferred?: boolean;
    wontfix?: boolean;
}
export declare function cmdList(doc: Doc, opts?: ListOptions): string;
/**
 * Is `issue` blocked? True iff any of its `blocked-by:` ids still sits in the
 * open `Issues` section — direct-only, non-transitive (§3.1). A dangling id
 * (found nowhere) is not open, so it fails open and does not block. Purely
 * derived; nothing is written back.
 */
export declare function isBlocked(doc: Doc, issue: Issue): boolean;
/**
 * The takeable frontier: open issues whose every blocker is closed, in document
 * order (§4.1). The claim gate and filters arrive in a later stage (T3); this
 * first cut is open ∩ unblocked.
 */
export declare function frontier(doc: Doc): Issue[];
/** `ready` — the whole ordered takeable frontier (§4.2). Read-only. */
export declare function cmdReady(doc: Doc): string;
/** `next` — the topmost takeable issue (`ready[0]`), or a normal empty state. */
export declare function cmdNext(doc: Doc): string;
export interface RunResult {
    text: string;
    output: string;
    mutated: boolean;
    warnings: string[];
    exitCode?: number;
}
/** Pure command runner — no filesystem access, for testing and reuse. */
export declare function run(text: string, argv: string[]): RunResult;
export {};
