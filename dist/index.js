// src/index.ts
var SECTION_ORDER = ["Issues", "Completed", "Deferred", "Won't Fix"];
var OPEN_SECTION = "Issues";
var DONE_SECTION = "Completed";
var DEFER_SECTION = "Deferred";
var WONTFIX_SECTION = "Won't Fix";
var CHECKED_SECTIONS = new Set([DONE_SECTION]);
var DETAIL_INDENT = "      ";
var DEFAULT_PATTERN = "###";
var ISSUE_RE = /^- \[([ xX])\] ([A-Za-z]*[0-9]+): (.*)$/;
var DATE_SUFFIX_RE = /^(.*?) \((\d{4}-\d{2}-\d{2})\)$/;
var BLOCKED_BY_SUFFIX_RE = /^(.*?)\s+blocked-by:([A-Za-z0-9]+(?:,[A-Za-z0-9]+)*)$/;
function parse(text) {
  const lines = text.split(`
`);
  let i = 0;
  const frontmatter = [];
  let nextId = 1;
  let pattern = DEFAULT_PATTERN;
  if (lines[0] === "---") {
    i = 1;
    while (i < lines.length && lines[i] !== "---") {
      const m = (lines[i] ?? "").match(/^([^:]+):\s*(.*)$/);
      if (m) {
        const key = (m[1] ?? "").trim();
        const raw = m[2] ?? "";
        frontmatter.push({ key, raw });
        if (key === "next_id")
          nextId = Number(raw) || 1;
        if (key === "pattern")
          pattern = raw.replace(/^["']|["']$/g, "");
      }
      i++;
    }
    i++;
  }
  if (!frontmatter.length) {
    frontmatter.push({ key: "next_id", raw: String(nextId) });
    frontmatter.push({ key: "pattern", raw: `"${pattern}"` });
  }
  let firstSection = lines.length;
  for (let j = i;j < lines.length; j++) {
    if (/^## /.test(lines[j] ?? "")) {
      firstSection = j;
      break;
    }
  }
  const preamble = trimBlankEdges(lines.slice(i, firstSection)).join(`
`);
  const sections = new Map;
  for (const name of SECTION_ORDER)
    sections.set(name, []);
  let current = null;
  let lastIssue = null;
  for (let j = firstSection;j < lines.length; j++) {
    const line = lines[j] ?? "";
    const head = line.match(/^## (.+?)\s*$/);
    if (head) {
      const name = head[1];
      if (!sections.has(name))
        sections.set(name, []);
      current = sections.get(name);
      lastIssue = null;
      continue;
    }
    if (current === null || line.trim() === "")
      continue;
    const m = line.match(ISSUE_RE);
    if (m) {
      lastIssue = toIssue(m[1] !== " ", m[2] ?? "", m[3] ?? "", pattern);
      current.push(lastIssue);
      continue;
    }
    if (/^\s+/.test(line) && lastIssue)
      lastIssue.detail.push(line.trimStart());
  }
  return { frontmatter, nextId, pattern, preamble, sections };
}
function toIssue(checked, id, rest, pattern) {
  let title = rest;
  let date;
  const dm = rest.match(DATE_SUFFIX_RE);
  if (dm) {
    title = dm[1] ?? rest;
    date = dm[2];
  }
  let blockedBy = [];
  const bm = title.match(BLOCKED_BY_SUFFIX_RE);
  if (bm) {
    title = bm[1] ?? title;
    blockedBy = (bm[2] ?? "").split(",");
  }
  return { id: normalizeId(id, pattern), num: idNum(id), checked, title, date, blockedBy, detail: [] };
}
function trimBlankEdges(arr) {
  let start = 0;
  let end = arr.length;
  while (start < end && (arr[start] ?? "").trim() === "")
    start++;
  while (end > start && (arr[end - 1] ?? "").trim() === "")
    end--;
  return arr.slice(start, end);
}
function serialize(doc) {
  const fm = doc.frontmatter.map((e) => `${e.key}: ${e.key === "next_id" ? doc.nextId : e.raw}`).join(`
`);
  let out = `---
${fm}
---`;
  if (doc.preamble)
    out += `
${doc.preamble}`;
  for (const name of SECTION_ORDER) {
    out += `

${renderSection(name, doc.sections.get(name) ?? [])}`;
  }
  return out + `
`;
}
function renderSection(name, issues) {
  let s = `## ${name}`;
  if (issues.length)
    s += `

` + issues.map(renderIssue).join(`

`);
  return s;
}
function renderIssue(issue) {
  const box = issue.checked ? "x" : " ";
  let line = `- [${box}] ${issue.id}: ${issue.title}`;
  if (issue.blockedBy.length)
    line += ` blocked-by:${issue.blockedBy.join(",")}`;
  if (issue.date)
    line += ` (${issue.date})`;
  const detail = issue.detail.map((d) => DETAIL_INDENT + d);
  return [line, ...detail].join(`
`);
}
function idNum(input) {
  const m = String(input).match(/(\d+)\s*$/);
  return m ? parseInt(m[1] ?? "", 10) : NaN;
}
function formatId(num, pattern = DEFAULT_PATTERN) {
  const hashes = pattern.match(/#+$/);
  const prefix = pattern.replace(/#+$/, "");
  const width = hashes ? hashes[0].length : 0;
  return prefix + String(num).padStart(width, "0");
}
function normalizeId(input, pattern = DEFAULT_PATTERN) {
  const num = idNum(input);
  if (Number.isNaN(num))
    return String(input);
  return formatId(num, pattern);
}
function findIssue(doc, idInput) {
  const canonical = normalizeId(idInput, doc.pattern);
  for (const name of SECTION_ORDER) {
    const issues = doc.sections.get(name) ?? [];
    const index = issues.findIndex((it) => it.id === canonical);
    const issue = issues[index];
    if (issue)
      return { section: name, index, issue };
  }
  return null;
}
function requireIssue(doc, idInput) {
  const found = findIssue(doc, idInput);
  if (!found)
    throw new Error(`Issue ${normalizeId(idInput, doc.pattern)} not found.`);
  return found;
}
function move(doc, from, to) {
  const [issue] = doc.sections.get(from.section).splice(from.index, 1);
  if (!issue)
    throw new Error(`No issue at ${from.section}[${from.index}].`);
  doc.sections.get(to).push(issue);
  return issue;
}
function today() {
  const override = process.env.ISSUES_DATE;
  if (override)
    return override;
  const d = new Date;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function cmdAdd(doc, title, note) {
  const id = formatId(doc.nextId, doc.pattern);
  const detail = note ? note.split(`
`).map((l) => l.trimStart()) : [];
  doc.sections.get(OPEN_SECTION).push({ id, num: doc.nextId, checked: false, title, blockedBy: [], detail });
  doc.nextId += 1;
  return `Added ${id}: ${title}`;
}
function cmdDone(doc, idInput, target = DONE_SECTION) {
  const found = requireIssue(doc, idInput);
  if (found.section === target)
    throw new Error(`${found.issue.id} is already in ${target}.`);
  const issue = move(doc, found, target);
  issue.checked = CHECKED_SECTIONS.has(target);
  issue.date = today();
  return `${issue.id} → ${target} (${issue.date})`;
}
function cmdReopen(doc, idInput) {
  const found = requireIssue(doc, idInput);
  if (found.section === OPEN_SECTION)
    throw new Error(`${found.issue.id} is already open.`);
  const issue = move(doc, found, OPEN_SECTION);
  issue.checked = false;
  issue.date = undefined;
  return `${issue.id} reopened`;
}
function cmdEdit(doc, idInput, title) {
  const { issue } = requireIssue(doc, idInput);
  issue.title = title;
  return `${issue.id} title updated`;
}
function cmdNote(doc, idInput, text) {
  const { issue } = requireIssue(doc, idInput);
  for (const l of text.split(`
`))
    issue.detail.push(l.trimStart());
  return `${issue.id} note added`;
}
function cmdShow(doc, idInput) {
  const { section, issue } = requireIssue(doc, idInput);
  const mark = issue.checked ? " [x]" : "";
  const date = issue.date ? ` (${issue.date})` : "";
  const lines = [`${issue.id} — ${section}${mark}${date}`, issue.title];
  for (const d of issue.detail)
    lines.push(`    ${d}`);
  return lines.join(`
`);
}
function cmdList(doc, opts = {}) {
  let names;
  if (opts.all)
    names = [...SECTION_ORDER];
  else {
    const set = new Set;
    if (opts.closed)
      [DONE_SECTION, DEFER_SECTION, WONTFIX_SECTION].forEach((s) => set.add(s));
    if (opts.deferred)
      set.add(DEFER_SECTION);
    if (opts.wontfix)
      set.add(WONTFIX_SECTION);
    names = set.size ? SECTION_ORDER.filter((n) => set.has(n)) : [OPEN_SECTION];
  }
  const blocks = [];
  for (const name of names) {
    const issues = doc.sections.get(name) ?? [];
    if (!issues.length)
      continue;
    const header = names.length > 1 ? `${name}:` : "";
    const rows = issues.map((it) => {
      const date = it.date ? ` (${it.date})` : "";
      const more = it.detail.length ? " …" : "";
      return `  ${it.id}  ${it.title}${date}${more}`;
    });
    blocks.push((header ? header + `
` : "") + rows.join(`
`));
  }
  if (!blocks.length)
    return "No issues.";
  return blocks.join(`

`);
}
function openIdSet(doc) {
  const ids = new Set;
  for (const it of doc.sections.get(OPEN_SECTION) ?? [])
    ids.add(it.id);
  return ids;
}
function isBlocked(doc, issue) {
  if (!issue.blockedBy.length)
    return false;
  const open = openIdSet(doc);
  return issue.blockedBy.some((b) => open.has(normalizeId(b, doc.pattern)));
}
function frontier(doc) {
  return (doc.sections.get(OPEN_SECTION) ?? []).filter((it) => !isBlocked(doc, it));
}
function frontierRow(it) {
  const more = it.detail.length ? " …" : "";
  return `  ${it.id}  ${it.title}${more}`;
}
function cmdReady(doc) {
  const items = frontier(doc);
  if (!items.length)
    return "No takeable issues.";
  return items.map(frontierRow).join(`
`);
}
function cmdNext(doc) {
  const top = frontier(doc)[0];
  return top ? frontierRow(top) : "No takeable issues.";
}
var VALUE_FLAGS = new Set(["note"]);
function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0;i < argv.length; i++) {
    const tok = argv[i] ?? "";
    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1)
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      else if (VALUE_FLAGS.has(body))
        flags[body] = argv[++i] ?? "";
      else
        flags[body] = true;
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, flags };
}
var HELP = `Usage: issues <command> [args]

  list [--all] [--closed] [--deferred] [--wontfix]   list issues (default: open)
  next                                                the topmost takeable issue
  ready                                               the whole takeable frontier
  add "<title>" [--note "<text>"]                     add a new open issue
  done <id> [--defer] [--wontfix]                     close / defer / wontfix an issue
  reopen <id>                                         move an issue back to open
  show <id>                                           print an issue with its note
  edit <id> "<title>"                                 replace an issue's title
  note <id> "<text>"                                  append a line to an issue's note
  help                                               show this message`;
function result(fields) {
  return { warnings: [], ...fields };
}
function run(text, argv) {
  const { positionals, flags } = parseArgs(argv);
  const cmd = positionals[0] ?? "help";
  if (cmd === "help" || cmd === "--help" || flags.help) {
    return result({ text, output: HELP, mutated: false });
  }
  const doc = parse(text);
  const arg = (n) => positionals[n];
  const need = (n, label) => {
    const v = arg(n);
    if (v === undefined)
      throw new Error(`${cmd}: missing <${label}>`);
    return v;
  };
  switch (cmd) {
    case "list":
      return result({
        text,
        mutated: false,
        output: cmdList(doc, {
          all: !!flags.all,
          closed: !!flags.closed,
          deferred: !!flags.deferred,
          wontfix: !!flags.wontfix
        })
      });
    case "next":
      return result({ text, mutated: false, output: cmdNext(doc) });
    case "ready":
      return result({ text, mutated: false, output: cmdReady(doc) });
    case "show":
      return result({ text, mutated: false, output: cmdShow(doc, need(1, "id")) });
    case "add": {
      const note = typeof flags.note === "string" ? flags.note : undefined;
      const msg = cmdAdd(doc, need(1, "title"), note);
      return result({ text: serialize(doc), output: msg, mutated: true });
    }
    case "done": {
      const target = flags.defer ? DEFER_SECTION : flags.wontfix ? WONTFIX_SECTION : DONE_SECTION;
      const msg = cmdDone(doc, need(1, "id"), target);
      return result({ text: serialize(doc), output: msg, mutated: true });
    }
    case "reopen": {
      const msg = cmdReopen(doc, need(1, "id"));
      return result({ text: serialize(doc), output: msg, mutated: true });
    }
    case "edit": {
      const msg = cmdEdit(doc, need(1, "id"), need(2, "title"));
      return result({ text: serialize(doc), output: msg, mutated: true });
    }
    case "note": {
      const msg = cmdNote(doc, need(1, "id"), need(2, "text"));
      return result({ text: serialize(doc), output: msg, mutated: true });
    }
    default:
      throw new Error(`Unknown command: ${cmd}

${HELP}`);
  }
}
export {
  today,
  serialize,
  run,
  parse,
  normalizeId,
  isBlocked,
  frontier,
  formatId,
  findIssue,
  cmdShow,
  cmdReopen,
  cmdReady,
  cmdNote,
  cmdNext,
  cmdList,
  cmdEdit,
  cmdDone,
  cmdAdd
};
