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
var FIELD_RE = /^([A-Za-z][A-Za-z0-9_-]*):(\S+)$/;
var ASSIGNEE_RE = /^@(\S+)$/;
var LABEL_RE = /^#(\S+)$/;
function isTailToken(tok) {
  return FIELD_RE.test(tok) || ASSIGNEE_RE.test(tok) || LABEL_RE.test(tok);
}
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
  const { title: bareTitle, tokens } = peelTail(title);
  title = bareTitle;
  let partOf;
  let blockedBy = [];
  let status;
  let assignee;
  const labels = [];
  const uda = [];
  for (const tok of tokens) {
    const am = tok.match(ASSIGNEE_RE);
    if (am) {
      assignee = am[1];
      continue;
    }
    const lm = tok.match(LABEL_RE);
    if (lm) {
      labels.push(lm[1]);
      continue;
    }
    const fm = tok.match(FIELD_RE);
    const key = fm[1];
    const value = fm[2];
    if (key === "part-of")
      partOf = value;
    else if (key === "blocked-by")
      blockedBy = value.split(",");
    else if (key === "status")
      status = value;
    else
      uda.push({ key, value });
  }
  return {
    id: normalizeId(id, pattern),
    num: idNum(id),
    checked,
    title,
    date,
    partOf,
    blockedBy,
    status,
    assignee,
    labels,
    uda,
    detail: []
  };
}
function peelTail(rest) {
  let s = rest;
  const tokens = [];
  while (true) {
    const m = s.match(/^(.*\S)\s+(\S+)$/);
    if (!m || !isTailToken(m[2]))
      break;
    tokens.unshift(m[2]);
    s = m[1];
  }
  return { title: s, tokens };
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
  if (issue.partOf)
    line += ` part-of:${issue.partOf}`;
  if (issue.blockedBy.length)
    line += ` blocked-by:${issue.blockedBy.join(",")}`;
  for (const u of issue.uda)
    line += ` ${u.key}:${u.value}`;
  if (issue.status)
    line += ` status:${issue.status}`;
  if (issue.assignee)
    line += ` @${issue.assignee}`;
  for (const l of issue.labels)
    line += ` #${l}`;
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
  doc.sections.get(OPEN_SECTION).push({ id, num: doc.nextId, checked: false, title, blockedBy: [], labels: [], uda: [], detail });
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
  return idSet(doc, OPEN_SECTION);
}
function idSet(doc, section) {
  const ids = new Set;
  for (const it of doc.sections.get(section) ?? [])
    ids.add(it.id);
  return ids;
}
function allIdSet(doc) {
  const ids = new Set;
  for (const name of SECTION_ORDER)
    for (const it of doc.sections.get(name) ?? [])
      ids.add(it.id);
  return ids;
}
function blockerIds(doc, issue) {
  return issue.blockedBy.map((b) => normalizeId(b, doc.pattern)).filter((b) => b !== issue.id);
}
function isBlocked(doc, issue) {
  if (!issue.blockedBy.length)
    return false;
  const open = openIdSet(doc);
  return blockerIds(doc, issue).some((b) => open.has(b));
}
function graphWarnings(doc) {
  const warnings = [];
  const all = allIdSet(doc);
  const wontfix = idSet(doc, WONTFIX_SECTION);
  for (const it of doc.sections.get(OPEN_SECTION) ?? []) {
    for (const raw of it.blockedBy) {
      const b = normalizeId(raw, doc.pattern);
      if (b === it.id) {
        warnings.push(`${it.id}: blocked-by ${b} is a self-reference — edge ignored`);
      } else if (!all.has(b)) {
        warnings.push(`${it.id}: blocked-by ${b} not found — fails open (does not block)`);
      } else if (wontfix.has(b)) {
        warnings.push(`${it.id}: blocker ${b} is won't-fix — gate satisfied by a rejected issue`);
      }
    }
    if (it.partOf) {
      const p = normalizeId(it.partOf, doc.pattern);
      if (!all.has(p)) {
        warnings.push(`${it.id}: part-of ${p} not found — rendered top-level`);
      }
    }
  }
  for (const cycle of detectCycles(doc)) {
    warnings.push(`blocked-by cycle: ${cycle.join(" → ")} → ${cycle[0]} — members stay blocked`);
  }
  return warnings;
}
function detectCycles(doc) {
  const openIds = openIdSet(doc);
  const adj = new Map;
  for (const it of doc.sections.get(OPEN_SECTION) ?? []) {
    adj.set(it.id, blockerIds(doc, it).filter((b) => openIds.has(b)));
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map;
  for (const id of adj.keys())
    color.set(id, WHITE);
  const stack = [];
  const cycles = [];
  const seen = new Set;
  const visit = (u) => {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      if (color.get(v) === GRAY) {
        const cycle = rotateToMin(stack.slice(stack.indexOf(v)));
        const key = cycle.join(",");
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (color.get(v) === WHITE) {
        visit(v);
      }
    }
    stack.pop();
    color.set(u, BLACK);
  };
  for (const id of adj.keys())
    if (color.get(id) === WHITE)
      visit(id);
  return cycles;
}
function rotateToMin(cycle) {
  let min = 0;
  for (let i = 1;i < cycle.length; i++)
    if ((cycle[i] ?? "") < (cycle[min] ?? ""))
      min = i;
  return [...cycle.slice(min), ...cycle.slice(0, min)];
}
function frontier(doc, filters = {}) {
  const wantAssignee = filters.assignee && filters.assignee.length ? filters.assignee : undefined;
  const wantStatus = filters.status && filters.status.length ? filters.status : undefined;
  const wantLabel = filters.label && filters.label.length ? filters.label : undefined;
  const wantParent = filters.parent && filters.parent.length ? filters.parent.map((p) => normalizeId(p, doc.pattern)) : undefined;
  let items = (doc.sections.get(OPEN_SECTION) ?? []).filter((it) => {
    if (isBlocked(doc, it))
      return false;
    if (wantAssignee) {
      if (!it.assignee || !wantAssignee.includes(it.assignee))
        return false;
    } else if (it.assignee)
      return false;
    if (wantStatus && (!it.status || !wantStatus.includes(it.status)))
      return false;
    if (wantLabel && !it.labels.some((l) => wantLabel.includes(l)))
      return false;
    if (wantParent) {
      const p = it.partOf ? normalizeId(it.partOf, doc.pattern) : undefined;
      if (!p || !wantParent.includes(p))
        return false;
    }
    return true;
  });
  if (filters.limit !== undefined && filters.limit >= 0)
    items = items.slice(0, filters.limit);
  return items;
}
function frontierRow(it) {
  const more = it.detail.length ? " …" : "";
  return `  ${it.id}  ${it.title}${more}`;
}
function cmdReady(doc, filters = {}) {
  const items = frontier(doc, filters);
  if (!items.length)
    return diagnoseEmpty(doc, filters);
  return items.map(frontierRow).join(`
`);
}
function cmdNext(doc, filters = {}) {
  const top = frontier(doc, { ...filters, limit: undefined })[0];
  return top ? frontierRow(top) : diagnoseEmpty(doc, filters);
}
function diagnoseEmpty(doc, filters) {
  const open = doc.sections.get(OPEN_SECTION) ?? [];
  if (!open.length)
    return "No open issues.";
  const filtered = (filters.status?.length ?? 0) + (filters.label?.length ?? 0) + (filters.parent?.length ?? 0) + (filters.assignee?.length ?? 0);
  if (filtered)
    return "No takeable issues match the filter.";
  const blocked = open.filter((it) => isBlocked(doc, it));
  const claimed = open.filter((it) => !isBlocked(doc, it) && it.assignee);
  if (blocked.length === open.length) {
    const waiting = openBlockersOf(doc, blocked);
    return `${open.length} open, all blocked — waiting on ${waiting.join(", ")}.`;
  }
  if (claimed.length === open.length) {
    const who = [...new Set(claimed.map((it) => `@${it.assignee}`))];
    return `${open.length} open, all in progress — ${who.join(", ")}.`;
  }
  return `${open.length} open — ${blocked.length} blocked, ${claimed.length} in progress.`;
}
function openBlockersOf(doc, blocked) {
  const open = openIdSet(doc);
  const waiting = [];
  const seen = new Set;
  for (const it of blocked) {
    for (const b of blockerIds(doc, it)) {
      if (open.has(b) && !seen.has(b)) {
        seen.add(b);
        waiting.push(b);
      }
    }
  }
  return waiting;
}
var VALUE_FLAGS = new Set(["note", "status", "label", "parent", "assignee", "limit"]);
var REPEATABLE_FLAGS = new Set(["status", "label", "parent", "assignee"]);
function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  const setValue = (key, value) => {
    if (REPEATABLE_FLAGS.has(key)) {
      const cur = flags[key];
      if (Array.isArray(cur))
        cur.push(value);
      else
        flags[key] = [value];
    } else {
      flags[key] = value;
    }
  };
  for (let i = 0;i < argv.length; i++) {
    const tok = argv[i] ?? "";
    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1)
        setValue(body.slice(0, eq), body.slice(eq + 1));
      else if (VALUE_FLAGS.has(body))
        setValue(body, argv[++i] ?? "");
      else
        flags[body] = true;
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, flags };
}
function readFilters(flags) {
  const arr = (v) => v === undefined ? undefined : Array.isArray(v) ? v : [String(v)];
  const limit = typeof flags.limit === "string" ? Number(flags.limit) : undefined;
  return {
    status: arr(flags.status),
    label: arr(flags.label),
    parent: arr(flags.parent),
    assignee: arr(flags.assignee),
    limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined
  };
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
      return result({
        text,
        mutated: false,
        output: cmdNext(doc, readFilters(flags)),
        warnings: graphWarnings(doc)
      });
    case "ready":
      return result({
        text,
        mutated: false,
        output: cmdReady(doc, readFilters(flags)),
        warnings: graphWarnings(doc)
      });
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
  graphWarnings,
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
