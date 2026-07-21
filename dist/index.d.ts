/**
 * Issue tracker for the project's `ISSUES.md` log — pure library core.
 *
 * This module is filesystem-free: it parses, serializes, and runs commands over
 * the ISSUES.md text. The thin CLI shell that reads and writes the file lives in
 * `./bin.ts`.
 *
 * Commands (dispatched by `run`) — reads take `--json` (§6) and `-q`:
 *   list [section flags] [filters]   list issues (default: open), with ⊘/@/# markers
 *   next / ready [filters]           the takeable frontier (topmost / whole list)
 *   show <id> [--children]           full resolved dossier
 *   tree                             containment-only forest (blocking as a ⊘ annotation)
 *   doctor                           read-only linter (exits nonzero on findings)
 *   add "<title>" [--note] [--part-of] [--blocked-by] [--status] [--assignee] [--label]
 *   block/unblock · assign/unassign · label/unlabel · set/unset   field mutations
 *   done <id> [--defer|--wontfix] · reopen · edit · note · help
 *
 * The file stays human-editable Markdown. Frontmatter and preamble prose are
 * preserved verbatim; section bodies are regenerated deterministically so an
 * untouched file round-trips byte-for-byte.
 */
declare const SECTION_ORDER: readonly ['Issues', 'Completed', 'Deferred', "Won't Fix"];
type SectionName = (typeof SECTION_ORDER)[number];
export interface Uda {
    key: string;
    value: string;
}
export interface Issue {
    id: string;
    num: number;
    checked: boolean;
    title: string;
    date?: string;
    partOf?: string;
    blockedBy: string[];
    status?: string;
    assignee?: string;
    labels: string[];
    uda: Uda[];
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
export interface AddFields {
    partOf?: string;
    blockedBy?: string[];
    status?: string;
    assignee?: string;
    labels?: string[];
}
export declare function cmdAdd(doc: Doc, title: string, note?: string, fields?: AddFields): string;
export declare function cmdDone(doc: Doc, idInput: string, target?: SectionName): string;
export declare function cmdReopen(doc: Doc, idInput: string): string;
export declare function cmdEdit(doc: Doc, idInput: string, title: string): string;
export declare function cmdNote(doc: Doc, idInput: string, text: string): string;
/**
 * `block <id> --by <blocker>` — add one blocker (§5 decision 3). Self-reference is
 * the one hard **reject**; unknown-blocker / cycle are warn-but-write (surfaced by
 * the caller via `graphWarnings`). Re-blocking an existing edge is an idempotent no-op.
 */
export declare function cmdBlock(doc: Doc, idInput: string, byInput: string): string;
/**
 * `unblock <id> [--by <blocker>]` — remove one blocker, or (no `--by`) clear all
 * (§5 decision 3). Removing an absent edge is an idempotent no-op + message (§5.3).
 */
export declare function cmdUnblock(doc: Doc, idInput: string, byInput?: string): string;
/** `assign <id> <who>` — the claim is an explicit string; no identity magic (§5 decision 4). */
export declare function cmdAssign(doc: Doc, idInput: string, who: string): string;
/** `unassign <id>` — clear the claim; absent is an idempotent no-op (§5.3). */
export declare function cmdUnassign(doc: Doc, idInput: string): string;
/** `label <id> <name[,name]>` — additive, deduped (§5 decision 5). */
export declare function cmdLabel(doc: Doc, idInput: string, names: string[]): string;
/** `unlabel <id> <name[,name]>` — targeted removal; absent names no-op (§5.3). */
export declare function cmdUnlabel(doc: Doc, idInput: string, names: string[]): string;
/**
 * `set <id> <key>:<value>` — replace a flat scalar (`status`) or any UDA (§5 decision
 * 6). Recognized relational keys route to their fields (a generic escape hatch); an
 * unknown key upserts a verbatim UDA. Returns any write-time advisories: `set status:`
 * on a closed issue, or a value outside a declared `statuses:` set — both warn-but-write
 * (§5 decisions 7, 15 / §5.3).
 */
export declare function cmdSet(doc: Doc, idInput: string, key: string, value: string): {
    message: string;
    warnings: string[];
};
/** `unset <id> <key>` — remove a scalar/UDA; absent is an idempotent no-op (§5.3). */
export declare function cmdUnset(doc: Doc, idInput: string, key: string): string;
export interface RenderOptions {
    color: boolean;
    plain: boolean;
}
export declare const DEFAULT_RENDER: RenderOptions;
/**
 * The six-state vocabulary (§1). Precedence is **closed > blocked > claimed > open**:
 * the gutter has one slot, and the highest applicable state takes it.
 */
export type IssueState = 'open' | 'claimed' | 'blocked' | 'completed' | 'deferred' | 'wontfix';
/**
 * Collapse an issue to the one state its gutter shows (§1). Pass `section` when the
 * caller already knows it; otherwise it is looked up.
 *
 * The precedence is **semantic, not merely compression** — closed *subsumes* the
 * derived axis. `isBlocked` does not consult the issue's own section, so a Completed
 * issue with a reopened blocker still has `blocked === true`; but a finished issue is
 * not *blocked*, and its assignee is provenance, not a claim. Do not "fix" that by
 * surfacing the derived axis on closed issues — `show`'s `state:` field suppression
 * (§4.2) depends on it reading exactly this way.
 */
export declare function issueState(doc: Doc, issue: Issue, section?: SectionName): IssueState;
/** The gutter glyph and its colour, per state (§1). `null` = uncoloured. */
export declare const STATE_GLYPHS: Record<IssueState, {
    glyph: string;
    color: AnsiStyle | null;
}>;
export type AnsiStyle = 'dim' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan';
/**
 * Wrap `text` in an SGR pair — or return it untouched when `color` is false, so the
 * colour gate is one boolean at every call site rather than a branch per line. A
 * `null` style is also a no-op (open's gutter has no colour), so a table entry can
 * be passed straight through.
 *
 * The terminator is a full reset, so styles do not nest: paint the innermost span,
 * not an outer one that a nested reset would cut short.
 */
export declare function paint(text: string, style: AnsiStyle | AnsiStyle[] | null, color: boolean): string;
export interface ShowOptions {
    children?: boolean;
    quiet?: boolean;
}
/**
 * `show <id>` — the full resolved dossier (§5 decision 17): status/assignee/labels,
 * relationships expanded with their target's title + open/closed state, derived
 * `⊘ blocked`, the note body, this issue's §3 warnings, and (with `--children`) its
 * containment subtree. Its own render path — terminal output is never double-spaced.
 */
export declare function cmdShow(doc: Doc, idInput: string, opts?: ShowOptions, render?: RenderOptions): string;
export interface ListOptions {
    all?: boolean;
    closed?: boolean;
    deferred?: boolean;
    wontfix?: boolean;
}
export declare function cmdList(doc: Doc, opts?: ListOptions, filters?: FrontierFilters, render?: RenderOptions): string;
/**
 * Is `issue` blocked? True iff any of its `blocked-by:` ids still sits in the
 * open `Issues` section — direct-only, non-transitive (§3.1). A dangling id
 * (found nowhere) is not open, so it fails open and does not block. Purely
 * derived; nothing is written back.
 */
export declare function isBlocked(doc: Doc, issue: Issue): boolean;
/**
 * The §3 advisory warnings, derived read-time as the graph is walked over the open
 * `Issues` section. Every anomaly fails open (§3.4 / §4.6) — these change nothing
 * about frontier membership, they only inform. Five kinds:
 *   · self-reference     — `A blocked-by A`: edge ignored (§3.1)
 *   · dangling blocker   — id found nowhere: fails open (§3.1)
 *   · won't-fix blocker  — gate satisfied by a rejected issue (§3.1, advisory)
 *   · dangling part-of   — parent found nowhere: child renders top-level (§3.2)
 *   · cycle              — mutual deadlock: members stay blocked, never broken (§3.1)
 * Exported for focused unit tests and reused by the read commands.
 */
export declare function graphWarnings(doc: Doc): string[];
/**
 * The ADR 0007 file-format compat advisory. A file may carry an optional `schema:`
 * frontmatter key naming its format version. This build understands
 * `SUPPORTED_SCHEMA`; anything newer (or non-numeric) is surfaced as an advisory
 * and **never blocks** the read or write — the file is always yours to hand-edit.
 * An absent key is the original/legacy format: silent, never rejected. Dormant
 * until a breaking format change first writes the key.
 */
export declare function compatWarnings(doc: Doc): string[];
export interface FrontierFilters {
    status?: string[];
    label?: string[];
    parent?: string[];
    assignee?: string[];
    limit?: number;
}
/**
 * The takeable frontier (§4.1): open issues whose every blocker is closed and which
 * are **unclaimed**, in document order — then narrowed by the §4.4 filters. The
 * block gate is always on (§4.4); `status:` never gates (§4.3), it is only a filter.
 * `--assignee <who>` relaxes the unclaimed gate and instead requires `assignee == who`.
 * Pure; nothing stored.
 */
export declare function frontier(doc: Doc, filters?: FrontierFilters): Issue[];
/**
 * Is `issue` (living in `section`) takeable — the base frontier predicate as a
 * per-issue boolean for the `--json` contract (§6): open, unblocked, and unclaimed.
 * Closed issues are never takeable.
 */
export declare function isTakeable(doc: Doc, issue: Issue, section: SectionName): boolean;
/** `ready` — the whole ordered takeable frontier (§4.2); empty is diagnosed (§4.5). */
export declare function cmdReady(doc: Doc, filters?: FrontierFilters, render?: RenderOptions): string;
/** `next` — the topmost takeable issue (`ready[0]`), or the same empty-diagnosis. */
export declare function cmdNext(doc: Doc, filters?: FrontierFilters, render?: RenderOptions): string;
/**
 * `tree` — the containment-only forest (§5 decision 13), state-annotated. Roots are
 * issues with no valid parent (top-level or dangling `part-of:`); children nest by
 * `part-of:`. Blocking is carried by the row's state gutter (or a `[blocked]` tag under
 * `--plain`), never by tree structure.
 */
export declare function cmdTree(doc: Doc, render?: RenderOptions): string;
export declare function doctorFindings(doc: Doc, text: string): string[];
/** `doctor` — human-readable grouped findings; exit code is the caller's job (§5 decision 19). */
export declare function cmdDoctor(doc: Doc, text: string): string;
export declare function cmdListJson(doc: Doc, opts?: ListOptions, filters?: FrontierFilters): {
    id: string;
    title: string;
    section: "Completed" | "Deferred" | "Issues" | "Won't Fix";
    status: string | null;
    assignee: string | null;
    labels: string[];
    blockedBy: string[];
    partOf: string | null;
    blocked: boolean;
    takeable: boolean;
}[];
export declare function cmdReadyJson(doc: Doc, filters?: FrontierFilters): {
    issues: {
        id: string;
        title: string;
        section: "Completed" | "Deferred" | "Issues" | "Won't Fix";
        status: string | null;
        assignee: string | null;
        labels: string[];
        blockedBy: string[];
        partOf: string | null;
        blocked: boolean;
        takeable: boolean;
    }[];
    reason: string | null;
};
export declare function cmdNextJson(doc: Doc, filters?: FrontierFilters): {
    issue: {
        id: string;
        title: string;
        section: "Completed" | "Deferred" | "Issues" | "Won't Fix";
        status: string | null;
        assignee: string | null;
        labels: string[];
        blockedBy: string[];
        partOf: string | null;
        blocked: boolean;
        takeable: boolean;
    } | null;
    reason: string | null;
};
export declare function cmdTreeJson(doc: Doc): unknown[];
export declare function cmdShowJson(doc: Doc, idInput: string, opts?: ShowOptions): Record<string, unknown>;
export declare function cmdDoctorJson(doc: Doc, text: string): {
    ok: boolean;
    findings: string[];
};
export type FlagValue = string | boolean | string[];
/**
 * The CLI's argument grammar. Exported so the shell resolves the presentation flags
 * (§6.1) through the *same* parser `run` dispatches on — scanning raw argv instead
 * would diverge the moment a value flag swallowed the next token (`--status --plain`
 * means `status:--plain`, not plain rendering) or a flag arrived as `--json=1`.
 */
export declare function parseArgs(argv: string[]): {
    positionals: string[];
    flags: Record<string, FlagValue>;
};
export interface RunResult {
    text: string;
    output: string;
    mutated: boolean;
    warnings: string[];
    exitCode?: number;
}
/**
 * Pure command runner — no filesystem access, for testing and reuse.
 *
 * `render` is the already-resolved `{color, plain}` pair (§6.1); the shell resolves
 * the tri-state flags, `NO_COLOR` and TTY-ness before calling. A library consumer
 * that omits it gets uncoloured, non-plain output.
 */
export declare function run(text: string, argv: string[], render?: RenderOptions): RunResult;
export {};
