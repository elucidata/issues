// src/index.ts
var SECTION_ORDER = ["Issues", "Completed", "Deferred", "Won't Fix"];
var OPEN_SECTION = "Issues";
var DONE_SECTION = "Completed";
var DEFER_SECTION = "Deferred";
var WONTFIX_SECTION = "Won't Fix";
var CHECKED_SECTIONS = new Set([DONE_SECTION]);
var DETAIL_INDENT = "      ";
var DEFAULT_PATTERN = "###";
var SUPPORTED_SCHEMA = 1;
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
function cmdAdd(doc, title, note, fields = {}) {
  const id = formatId(doc.nextId, doc.pattern);
  const detail = note ? note.split(`
`).map((l) => l.trimStart()) : [];
  doc.sections.get(OPEN_SECTION).push({
    id,
    num: doc.nextId,
    checked: false,
    title,
    partOf: fields.partOf ? normalizeId(fields.partOf, doc.pattern) : undefined,
    blockedBy: (fields.blockedBy ?? []).map((b) => normalizeId(b, doc.pattern)).filter((b) => b !== id),
    status: fields.status,
    assignee: fields.assignee,
    labels: fields.labels ?? [],
    uda: [],
    detail
  });
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
  issue.status = undefined;
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
function cmdBlock(doc, idInput, byInput) {
  const { issue } = requireIssue(doc, idInput);
  const by = normalizeId(byInput, doc.pattern);
  if (by === issue.id)
    throw new Error(`${issue.id}: cannot block on itself.`);
  const cur = issue.blockedBy.map((b) => normalizeId(b, doc.pattern));
  if (cur.includes(by))
    return `${issue.id} already blocked-by ${by}`;
  issue.blockedBy = [...cur, by];
  return `${issue.id} blocked-by ${by}`;
}
function cmdUnblock(doc, idInput, byInput) {
  const { issue } = requireIssue(doc, idInput);
  if (byInput === undefined) {
    if (!issue.blockedBy.length)
      return `${issue.id} has no blockers`;
    issue.blockedBy = [];
    return `${issue.id} unblocked (all)`;
  }
  const by = normalizeId(byInput, doc.pattern);
  const cur = issue.blockedBy.map((b) => normalizeId(b, doc.pattern));
  if (!cur.includes(by))
    return `${issue.id} was not blocked-by ${by}`;
  issue.blockedBy = cur.filter((b) => b !== by);
  return `${issue.id} no longer blocked-by ${by}`;
}
function cmdAssign(doc, idInput, who) {
  const { issue } = requireIssue(doc, idInput);
  issue.assignee = who;
  return `${issue.id} assigned to @${who}`;
}
function cmdUnassign(doc, idInput) {
  const { issue } = requireIssue(doc, idInput);
  if (!issue.assignee)
    return `${issue.id} was not assigned`;
  const who = issue.assignee;
  issue.assignee = undefined;
  return `${issue.id} unassigned (@${who})`;
}
function cmdLabel(doc, idInput, names) {
  const { issue } = requireIssue(doc, idInput);
  const added = [];
  for (const n of names)
    if (n && !issue.labels.includes(n))
      added.push(n);
  issue.labels.push(...added);
  if (!added.length)
    return `${issue.id}: no new labels`;
  return `${issue.id} labelled ${added.map((l) => "#" + l).join(" ")}`;
}
function cmdUnlabel(doc, idInput, names) {
  const { issue } = requireIssue(doc, idInput);
  const removed = [];
  for (const n of names) {
    const i = issue.labels.indexOf(n);
    if (i !== -1) {
      issue.labels.splice(i, 1);
      removed.push(n);
    }
  }
  if (!removed.length)
    return `${issue.id}: no matching labels`;
  return `${issue.id} unlabelled ${removed.map((l) => "#" + l).join(" ")}`;
}
function cmdSet(doc, idInput, key, value) {
  const { section, issue } = requireIssue(doc, idInput);
  const warnings = [];
  switch (key) {
    case "status": {
      issue.status = value;
      if (section !== OPEN_SECTION)
        warnings.push(`${issue.id}: status set on a closed issue — open-only per §2.2`);
      const declared = declaredStatuses(doc);
      if (declared && !declared.has(value))
        warnings.push(`${issue.id}: status:${value} is not in the declared statuses`);
      break;
    }
    case "part-of":
      issue.partOf = normalizeId(value, doc.pattern);
      break;
    case "assignee":
      issue.assignee = value;
      break;
    case "blocked-by":
      issue.blockedBy = value.split(",").map((v) => normalizeId(v.trim(), doc.pattern)).filter((b) => b && b !== issue.id);
      break;
    case "label":
      issue.labels = value.split(",").map((s) => s.trim()).filter(Boolean);
      break;
    default: {
      const existing = issue.uda.find((u) => u.key === key);
      if (existing)
        existing.value = value;
      else
        issue.uda.push({ key, value });
    }
  }
  return { message: `${issue.id} set ${key}:${value}`, warnings };
}
function cmdUnset(doc, idInput, key) {
  const { issue } = requireIssue(doc, idInput);
  const noop = `${issue.id}: ${key} was not set`;
  switch (key) {
    case "status":
      if (!issue.status)
        return noop;
      issue.status = undefined;
      break;
    case "part-of":
      if (!issue.partOf)
        return noop;
      issue.partOf = undefined;
      break;
    case "assignee":
      if (!issue.assignee)
        return noop;
      issue.assignee = undefined;
      break;
    case "blocked-by":
      if (!issue.blockedBy.length)
        return noop;
      issue.blockedBy = [];
      break;
    case "label":
      if (!issue.labels.length)
        return noop;
      issue.labels = [];
      break;
    default: {
      const i = issue.uda.findIndex((u) => u.key === key);
      if (i === -1)
        return noop;
      issue.uda.splice(i, 1);
    }
  }
  return `${issue.id} unset ${key}`;
}
function declaredStatuses(doc) {
  const entry = doc.frontmatter.find((e) => e.key === "statuses");
  if (!entry)
    return null;
  const raw = entry.raw.replace(/^["']|["']$/g, "");
  const vals = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  return vals.length ? new Set(vals) : null;
}
var DEFAULT_RENDER = { color: false, plain: false };
var CLOSED_STATES = {
  [DONE_SECTION]: "completed",
  [DEFER_SECTION]: "deferred",
  [WONTFIX_SECTION]: "wontfix"
};
function issueState(doc, issue, section) {
  const closed = CLOSED_STATES[sectionOf(doc, issue, section)];
  if (closed)
    return closed;
  if (isBlocked(doc, issue))
    return "blocked";
  if (issue.assignee)
    return "claimed";
  return "open";
}
function sectionOf(doc, issue, known) {
  return known ?? findIssue(doc, issue.id)?.section ?? OPEN_SECTION;
}
var STATE_GLYPHS = {
  open: { glyph: "-", color: null },
  claimed: { glyph: "~", color: "yellow" },
  blocked: { glyph: "⊘", color: "red" },
  completed: { glyph: "✓", color: "green" },
  deferred: { glyph: "»", color: "dim" },
  wontfix: { glyph: "×", color: "dim" }
};
var SGR = {
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36
};
var RESET = "\x1B[0m";
function paint(text, style, color) {
  if (!color || style === null)
    return text;
  const codes = (Array.isArray(style) ? style : [style]).map((s) => SGR[s]);
  return `\x1B[${codes.join(";")}m${text}${RESET}`;
}
function warningsFor(doc, idInput) {
  const id = normalizeId(idInput, doc.pattern);
  return graphWarnings(doc).filter((w) => w.includes(id));
}
function cmdShow(doc, idInput, opts = {}, render = DEFAULT_RENDER) {
  const { section, issue } = requireIssue(doc, idInput);
  const color = render.color && !render.plain;
  const date = issue.date ? ` (${issue.date})` : "";
  const title = section === OPEN_SECTION ? issue.title : paint(issue.title, "dim", color);
  const lines = [`${paint(issue.id, "cyan", color)}  ${title}${date}`];
  lines.push(`  state: ${stateField(doc, issue, section, color)}`);
  if (issue.status)
    lines.push(`  status: ${paint(issue.status, "yellow", color)}`);
  if (issue.assignee)
    lines.push(`  assignee: ${paint("@" + issue.assignee, "magenta", color)}`);
  if (issue.labels.length)
    lines.push(`  labels: ${issue.labels.map((l) => paint("#" + l, "blue", color)).join(" ")}`);
  if (issue.partOf)
    lines.push(`  part-of: ${resolveRef(doc, issue.partOf, undefined, color)}`);
  for (const b of issue.blockedBy)
    lines.push(`  blocked-by: ${resolveRef(doc, b, issue.id, color)}`);
  for (const u of issue.uda)
    lines.push(`  ${u.key}: ${u.value}`);
  for (const d of issue.detail)
    lines.push(`    ${d}`);
  if (opts.children) {
    const kids = childrenOf(doc, issue.id);
    if (kids.length) {
      lines.push("  children:");
      for (const k of kids)
        lines.push(...treeLines(doc, k, 1, render, undefined));
    }
  }
  if (!opts.quiet)
    for (const w of warningsFor(doc, issue.id))
      lines.push(`  ! ${w}`);
  return lines.join(`
`);
}
function sectionLabel(section) {
  return section === OPEN_SECTION ? "Open" : section;
}
function stateField(doc, issue, section, color) {
  const token = (label, state) => paint(label, STATE_GLYPHS[state].color, color);
  if (section !== OPEN_SECTION)
    return token(sectionLabel(section), issueState(doc, issue, section));
  const tokens = [token(sectionLabel(section), "open")];
  if (isBlocked(doc, issue))
    tokens.push(token("blocked", "blocked"));
  if (issue.assignee)
    tokens.push(token("claimed", "claimed"));
  return tokens.join(", ");
}
function resolveRef(doc, rawId, selfId, color) {
  const id = normalizeId(rawId, doc.pattern);
  const shown = paint(id, "cyan", color);
  if (selfId && id === selfId)
    return `${shown} (self-reference — ignored)`;
  const found = findIssue(doc, id);
  if (!found)
    return `${shown} (not found)`;
  return `${shown} (${found.issue.title}) — ${sectionLabel(found.section)}`;
}
function markers(issue, color) {
  let s = "";
  if (issue.status)
    s += ` status:${paint(issue.status, "yellow", color)}`;
  if (issue.assignee)
    s += ` ${paint("@" + issue.assignee, "magenta", color)}`;
  for (const l of issue.labels)
    s += ` ${paint("#" + l, "blue", color)}`;
  return s;
}
function compactRow(doc, issue, fields, render) {
  const ansi = render.color && !render.plain;
  const elementColor = ansi && !fields.scaffold;
  const section = sectionOf(doc, issue, fields.section);
  const tail = (fields.markers ? markers(issue, elementColor) : "") + (fields.date && issue.date ? ` (${issue.date})` : "") + (fields.note && issue.detail.length ? " …" : "");
  const scaffoldMark = fields.scaffold && !ansi ? " /" : "";
  if (render.plain) {
    const tags = plainTags(doc, issue, section);
    return `${fields.indent}${issue.id}  ${issue.title}${tail}${tags}${scaffoldMark}`;
  }
  const { glyph, color: gutter } = STATE_GLYPHS[issueState(doc, issue, section)];
  if (fields.scaffold) {
    const row = `${glyph} ${issue.id}  ${issue.title}${tail}${scaffoldMark}`;
    return fields.indent + paint(row, "dim", ansi);
  }
  const title = section === OPEN_SECTION ? issue.title : paint(issue.title, "dim", elementColor);
  const id = paint(issue.id, "cyan", elementColor);
  return `${fields.indent}${paint(glyph, gutter, elementColor)} ${id}  ${title}${tail}`;
}
function plainTags(doc, issue, section) {
  let s = "";
  if (section !== OPEN_SECTION)
    s += ` [${section}]`;
  if (isBlocked(doc, issue))
    s += " [blocked]";
  return s;
}
function passesFilters(doc, it, filters) {
  if (filters.status?.length && (!it.status || !filters.status.includes(it.status)))
    return false;
  if (filters.label?.length && !it.labels.some((l) => filters.label.includes(l)))
    return false;
  if (filters.parent?.length) {
    const p = it.partOf ? normalizeId(it.partOf, doc.pattern) : undefined;
    const want = filters.parent.map((x) => normalizeId(x, doc.pattern));
    if (!p || !want.includes(p))
      return false;
  }
  return true;
}
function listFilter(doc, it, filters) {
  if (!passesFilters(doc, it, filters))
    return false;
  if (filters.assignee?.length && (!it.assignee || !filters.assignee.includes(it.assignee)))
    return false;
  return true;
}
function listSections(opts) {
  if (opts.all)
    return [...SECTION_ORDER];
  const set = new Set;
  if (opts.closed)
    [DONE_SECTION, DEFER_SECTION, WONTFIX_SECTION].forEach((s) => set.add(s));
  if (opts.deferred)
    set.add(DEFER_SECTION);
  if (opts.wontfix)
    set.add(WONTFIX_SECTION);
  return set.size ? SECTION_ORDER.filter((n) => set.has(n)) : [OPEN_SECTION];
}
function cmdList(doc, opts = {}, filters = {}, render = DEFAULT_RENDER) {
  const names = listSections(opts);
  const blocks = [];
  for (const name of names) {
    const issues = (doc.sections.get(name) ?? []).filter((it) => listFilter(doc, it, filters));
    if (!issues.length)
      continue;
    const header = names.length > 1 ? `${name}:` : "";
    const rows = issues.map((it) => compactRow(doc, it, { indent: "  ", section: name, markers: true, date: true, note: true }, render));
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
function compatWarnings(doc) {
  const entry = doc.frontmatter.find((e) => e.key === "schema");
  if (!entry)
    return [];
  const raw = entry.raw.trim().replace(/^["']|["']$/g, "");
  const n = Number(raw);
  if (raw === "" || !Number.isFinite(n)) {
    return [`schema:${raw} is not a recognized format version — proceeding, the file may not round-trip cleanly`];
  }
  if (n > SUPPORTED_SCHEMA) {
    return [
      `file declares schema ${n}; this build understands schema ${SUPPORTED_SCHEMA} — proceeding, it may not round-trip cleanly (upgrade \`issues\`)`
    ];
  }
  return [];
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
  let items = (doc.sections.get(OPEN_SECTION) ?? []).filter((it) => {
    if (isBlocked(doc, it))
      return false;
    if (wantAssignee) {
      if (!it.assignee || !wantAssignee.includes(it.assignee))
        return false;
    } else if (it.assignee)
      return false;
    return passesFilters(doc, it, filters);
  });
  if (filters.limit !== undefined && filters.limit >= 0)
    items = items.slice(0, filters.limit);
  return items;
}
function isTakeable(doc, issue, section) {
  return section === OPEN_SECTION && !issue.assignee && !isBlocked(doc, issue);
}
function frontierRow(doc, it, render) {
  return compactRow(doc, it, { indent: "  ", note: true }, render);
}
function cmdReady(doc, filters = {}, render = DEFAULT_RENDER) {
  const items = frontier(doc, filters);
  if (!items.length)
    return diagnoseEmpty(doc, filters);
  return items.map((it) => frontierRow(doc, it, render)).join(`
`);
}
function cmdNext(doc, filters = {}, render = DEFAULT_RENDER) {
  const top = frontier(doc, { ...filters, limit: undefined })[0];
  return top ? frontierRow(doc, top, render) : diagnoseEmpty(doc, filters);
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
function allEntries(doc) {
  const out = [];
  for (const name of SECTION_ORDER)
    for (const it of doc.sections.get(name) ?? [])
      out.push({ section: name, issue: it });
  return out;
}
function validParentId(doc, issue) {
  if (!issue.partOf)
    return;
  const p = normalizeId(issue.partOf, doc.pattern);
  return findIssue(doc, p) ? p : undefined;
}
function childrenOf(doc, parentId) {
  const pid = normalizeId(parentId, doc.pattern);
  return allEntries(doc).filter((e) => validParentId(doc, e.issue) === pid).map((e) => e.issue);
}
function rootsOf(doc) {
  return allEntries(doc).filter((e) => !validParentId(doc, e.issue)).map((e) => e.issue);
}
function treeView(doc, opts, filters) {
  const sections = new Set(listSections(opts));
  const matched = new Set;
  const hits = [];
  for (const { section, issue } of allEntries(doc))
    if (sections.has(section) && listFilter(doc, issue, filters)) {
      matched.add(issue.id);
      hits.push(issue);
    }
  const visible = new Set(matched);
  for (const hit of hits) {
    let cur = hit;
    const guard = new Set([hit.id]);
    for (;; ) {
      const parent = cur ? validParentId(doc, cur) : undefined;
      if (!parent || guard.has(parent))
        break;
      guard.add(parent);
      visible.add(parent);
      cur = findIssue(doc, parent)?.issue;
    }
  }
  const scaffold = new Set([...visible].filter((id) => !matched.has(id)));
  return { visible, scaffold };
}
function treeLines(doc, issue, depth, render, view, seen = new Set) {
  if (view && !view.visible.has(issue.id))
    return [];
  const indent = "  ".repeat(depth + 1);
  if (seen.has(issue.id))
    return [`${indent}${issue.id} (part-of cycle)`];
  seen.add(issue.id);
  const scaffold = view?.scaffold.has(issue.id);
  const out = [compactRow(doc, issue, { indent, markers: true, scaffold }, render)];
  for (const k of childrenOf(doc, issue.id))
    out.push(...treeLines(doc, k, depth + 1, render, view, seen));
  return out;
}
function cmdTree(doc, opts = {}, filters = {}, render = DEFAULT_RENDER) {
  const view = treeView(doc, opts, filters);
  const seen = new Set;
  const lines = [];
  for (const r of rootsOf(doc))
    lines.push(...treeLines(doc, r, 0, render, view, seen));
  if (!lines.length)
    return "No issues.";
  return lines.join(`
`);
}
function doctorFindings(doc, text) {
  const out = [...graphWarnings(doc)];
  const declared = declaredStatuses(doc);
  if (declared) {
    for (const { issue } of allEntries(doc))
      if (issue.status && !declared.has(issue.status))
        out.push(`${issue.id}: status:${issue.status} is not in the declared statuses`);
  }
  out.push(...malformedLines(text));
  return out;
}
function malformedLines(text) {
  const out = [];
  let inSection = false;
  for (const line of text.split(`
`)) {
    if (/^## /.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection || line.trim() === "")
      continue;
    if (ISSUE_RE.test(line) || /^\s+/.test(line))
      continue;
    out.push(`malformed line (not an issue or note): ${line.trim()}`);
  }
  return out;
}
function cmdDoctor(doc, text) {
  const findings = doctorFindings(doc, text);
  if (!findings.length)
    return "No issues found — clean.";
  const lines = [`${findings.length} finding${findings.length === 1 ? "" : "s"}:`];
  for (const f of findings)
    lines.push(`  · ${f}`);
  return lines.join(`
`);
}
function issueJson(doc, issue, section) {
  return {
    id: issue.id,
    title: issue.title,
    section,
    status: issue.status ?? null,
    assignee: issue.assignee ?? null,
    labels: issue.labels,
    blockedBy: issue.blockedBy.map((b) => normalizeId(b, doc.pattern)),
    partOf: issue.partOf ? normalizeId(issue.partOf, doc.pattern) : null,
    blocked: isBlocked(doc, issue),
    takeable: isTakeable(doc, issue, section)
  };
}
function cmdListJson(doc, opts = {}, filters = {}) {
  const items = [];
  for (const name of listSections(opts))
    for (const it of doc.sections.get(name) ?? [])
      if (listFilter(doc, it, filters))
        items.push(issueJson(doc, it, name));
  return items;
}
function cmdReadyJson(doc, filters = {}) {
  const items = frontier(doc, filters);
  return {
    issues: items.map((it) => issueJson(doc, it, OPEN_SECTION)),
    reason: items.length ? null : diagnoseEmpty(doc, filters)
  };
}
function cmdNextJson(doc, filters = {}) {
  const top = frontier(doc, { ...filters, limit: undefined })[0];
  return {
    issue: top ? issueJson(doc, top, OPEN_SECTION) : null,
    reason: top ? null : diagnoseEmpty(doc, filters)
  };
}
function refJson(doc, rawId) {
  const id = normalizeId(rawId, doc.pattern);
  const found = findIssue(doc, id);
  return {
    id,
    title: found ? found.issue.title : null,
    section: found ? found.section : null,
    open: found ? found.section === OPEN_SECTION : false,
    found: !!found
  };
}
function treeJson(doc, issues, seen = new Set) {
  const out = [];
  for (const it of issues) {
    if (seen.has(it.id))
      continue;
    seen.add(it.id);
    const found = findIssue(doc, it.id);
    out.push({
      ...issueJson(doc, it, found ? found.section : OPEN_SECTION),
      children: treeJson(doc, childrenOf(doc, it.id), seen)
    });
  }
  return out;
}
function cmdTreeJson(doc) {
  return treeJson(doc, rootsOf(doc));
}
function cmdShowJson(doc, idInput, opts = {}) {
  const { section, issue } = requireIssue(doc, idInput);
  const base = issueJson(doc, issue, section);
  const result = {
    ...base,
    parent: issue.partOf ? refJson(doc, issue.partOf) : null,
    blockers: issue.blockedBy.map((b) => refJson(doc, b)),
    detail: issue.detail,
    warnings: opts.quiet ? [] : warningsFor(doc, issue.id)
  };
  if (opts.children)
    result.children = treeJson(doc, childrenOf(doc, issue.id));
  return result;
}
function cmdDoctorJson(doc, text) {
  const findings = doctorFindings(doc, text);
  return { ok: findings.length === 0, findings };
}
var VALUE_FLAGS = new Set([
  "note",
  "status",
  "label",
  "parent",
  "assignee",
  "limit",
  "by",
  "part-of",
  "blocked-by"
]);
var REPEATABLE_FLAGS = new Set(["status", "label", "parent", "assignee", "blocked-by"]);
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
    if (tok === "-q") {
      flags.quiet = true;
    } else if (tok.startsWith("--")) {
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
function commaList(v) {
  if (v === undefined)
    return [];
  const arr = Array.isArray(v) ? v : [String(v)];
  return arr.flatMap((s) => String(s).split(",")).map((s) => s.trim()).filter(Boolean);
}
function firstStr(v) {
  const list = commaList(v);
  return list.length ? list[0] : undefined;
}
function readSections(flags) {
  return {
    all: !!flags.all,
    closed: !!flags.closed,
    deferred: !!flags.deferred,
    wontfix: !!flags.wontfix
  };
}
function readFilters(flags) {
  const arr = (v) => v === undefined ? undefined : commaList(v);
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

Reads (add --json for the machine contract; -q silences advisories):
  list [--all|--closed|--deferred|--wontfix] [filters]   list issues (default: open)
  next   [filters]                                       the topmost takeable issue
  ready  [filters] [--limit N]                           the whole takeable frontier
  show <id> [--children]                                 full resolved dossier
  tree [--all|--closed|--deferred|--wontfix] [filters]   containment forest (default: open)
  doctor                                                 lint the file (exit nonzero on findings)

Mutations:
  add "<title>" [--note <t>] [--part-of <id>] [--blocked-by <id[,id]>]
                [--status <s>] [--assignee <who>] [--label <name[,name]>]
  block <id> --by <blocker>        unblock <id> [--by <blocker>]   (no --by clears all)
  assign <id> <who>                unassign <id>
  label <id> <name[,name]>         unlabel <id> <name[,name]>
  set <id> <key>:<value>           unset <id> <key>
  done <id> [--defer|--wontfix]    reopen <id>
  edit <id> "<title>"              note <id> "<text>"
  help                                                   show this message
  version, --version                                     print the installed version

filters (list/next/ready/tree): --status <s> | --label <n> | --parent <id> | --assignee <who>
         (AND across dimensions, OR within a repeated/comma-listed dimension)

presentation (human-readable reads only; --json is never colourized):
  --plain      no colour, no state gutter — state as postfix [tags] at the row's end
               strongest of the three: --plain --color renders plain, silently
  --color      force colour on;  --no-color  force it off but keep the gutter/glyphs
               colour otherwise follows NO_COLOR and whether stdout is a terminal

state gutter:  - open   ~ claimed   ⊘ blocked   ✓ completed   » deferred   × won't fix

--json is the only stable read surface; human-readable output may change in any release.`;
function result(fields) {
  return { warnings: [], ...fields };
}
function run(text, argv, render = DEFAULT_RENDER) {
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
  const quiet = !!flags.quiet;
  const wantJson = !!flags.json;
  const jsonOut = (d) => JSON.stringify(d, null, 2);
  const advisories = () => quiet ? [] : [...compatWarnings(doc), ...graphWarnings(doc)];
  const edgeAdvisories = (id) => quiet ? [] : [...compatWarnings(doc), ...warningsFor(doc, id)];
  switch (cmd) {
    case "list": {
      const opts = readSections(flags);
      const filters = readFilters(flags);
      const output = wantJson ? jsonOut(cmdListJson(doc, opts, filters)) : cmdList(doc, opts, filters, render);
      return result({ text, mutated: false, output, warnings: advisories() });
    }
    case "next": {
      const filters = readFilters(flags);
      const output = wantJson ? jsonOut(cmdNextJson(doc, filters)) : cmdNext(doc, filters, render);
      return result({ text, mutated: false, output, warnings: advisories() });
    }
    case "ready": {
      const filters = readFilters(flags);
      const output = wantJson ? jsonOut(cmdReadyJson(doc, filters)) : cmdReady(doc, filters, render);
      return result({ text, mutated: false, output, warnings: advisories() });
    }
    case "show": {
      const id = need(1, "id");
      const opts = { children: !!flags.children, quiet };
      const output = wantJson ? jsonOut(cmdShowJson(doc, id, opts)) : cmdShow(doc, id, opts, render);
      return result({ text, mutated: false, output });
    }
    case "tree": {
      const output = wantJson ? jsonOut(cmdTreeJson(doc)) : cmdTree(doc, readSections(flags), readFilters(flags), render);
      return result({ text, mutated: false, output, warnings: advisories() });
    }
    case "doctor": {
      const findings = doctorFindings(doc, text);
      const output = wantJson ? jsonOut(cmdDoctorJson(doc, text)) : cmdDoctor(doc, text);
      return result({ text, mutated: false, output, exitCode: findings.length ? 1 : 0 });
    }
    case "add": {
      const note = typeof flags.note === "string" ? flags.note : undefined;
      const newId = formatId(doc.nextId, doc.pattern);
      const msg = cmdAdd(doc, need(1, "title"), note, {
        partOf: firstStr(flags["part-of"]),
        blockedBy: commaList(flags["blocked-by"]),
        status: firstStr(flags.status),
        assignee: firstStr(flags.assignee),
        labels: commaList(flags.label)
      });
      return result({ text: serialize(doc), output: msg, mutated: true, warnings: edgeAdvisories(newId) });
    }
    case "block": {
      const id = need(1, "id");
      const by = firstStr(flags.by);
      if (!by)
        throw new Error("block: missing --by <blocker>");
      const msg = cmdBlock(doc, id, by);
      return result({ text: serialize(doc), output: msg, mutated: true, warnings: edgeAdvisories(id) });
    }
    case "unblock": {
      const msg = cmdUnblock(doc, need(1, "id"), firstStr(flags.by));
      return result({ text: serialize(doc), output: msg, mutated: true });
    }
    case "assign": {
      const msg = cmdAssign(doc, need(1, "id"), need(2, "who"));
      return result({ text: serialize(doc), output: msg, mutated: true });
    }
    case "unassign": {
      const msg = cmdUnassign(doc, need(1, "id"));
      return result({ text: serialize(doc), output: msg, mutated: true });
    }
    case "label": {
      const msg = cmdLabel(doc, need(1, "id"), commaList(need(2, "name")));
      return result({ text: serialize(doc), output: msg, mutated: true });
    }
    case "unlabel": {
      const msg = cmdUnlabel(doc, need(1, "id"), commaList(need(2, "name")));
      return result({ text: serialize(doc), output: msg, mutated: true });
    }
    case "set": {
      const id = need(1, "id");
      const kv = need(2, "key:value");
      const m = kv.match(/^([^:]+):([\s\S]*)$/);
      if (!m)
        throw new Error(`set: expected <key>:<value>, got "${kv}"`);
      const { message, warnings } = cmdSet(doc, id, m[1], m[2]);
      return result({
        text: serialize(doc),
        output: message,
        mutated: true,
        warnings: quiet ? [] : warnings
      });
    }
    case "unset": {
      const msg = cmdUnset(doc, need(1, "id"), need(2, "key"));
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
  parseArgs,
  parse,
  paint,
  normalizeId,
  issueState,
  isTakeable,
  isBlocked,
  graphWarnings,
  frontier,
  formatId,
  findIssue,
  doctorFindings,
  compatWarnings,
  cmdUnset,
  cmdUnlabel,
  cmdUnblock,
  cmdUnassign,
  cmdTreeJson,
  cmdTree,
  cmdShowJson,
  cmdShow,
  cmdSet,
  cmdReopen,
  cmdReadyJson,
  cmdReady,
  cmdNote,
  cmdNextJson,
  cmdNext,
  cmdListJson,
  cmdList,
  cmdLabel,
  cmdEdit,
  cmdDone,
  cmdDoctorJson,
  cmdDoctor,
  cmdBlock,
  cmdAssign,
  cmdAdd,
  STATE_GLYPHS,
  DEFAULT_RENDER
};
