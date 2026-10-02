import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "./main-module.mjs";

export const SECTION_LIMIT = 60;
export const CONTEXT_LINES = 5;
const TAIL_LINES = 8;
const LINE_LIMIT = 300;

const RESULT = /^RESULT: (\d+)\/(\d+)/;
const FAILURE = /^(?:FAIL|ERROR|NOT STARTED)/;
const DETAIL = /^ +(?:expected|actual):/;
const RETRY = /^\[driver\].*(?:attempt \d+ of \d+|\bretry\b|\bretrying\b)/i;
const WARNING = /^\s*(?:\[driver\]\s*)?WARN(?:ING)?\b[:\s]/;

const clip = (line) => (line.length > LINE_LIMIT ? line.slice(0, LINE_LIMIT) + "..." : line);
const splitLines = (text) => text.split(/\r?\n/).map((l) => l.replace(/\r$/, ""));

export function suiteNumber(name) {
  const m = /^(\d+)/.exec(name);
  return m ? m[1] : "";
}

export function judge(lines) {
  const result = [...lines].reverse().find((l) => RESULT.test(l));
  if (!result) return { ran: 1, failed: 1, reason: "no RESULT line (timed out, crashed or never reported)", result: null };
  const m = RESULT.exec(result);
  const ok = Number(m[1]);
  const ran = Number(m[2]);
  if (ran === 0) return { ran: 1, failed: 1, reason: "no checks ran, counted as one failed check", result };
  if (ok > ran) return { ran: 1, failed: 1, reason: "more passed than ran, counted as one failed check", result };
  return { ran, failed: ran - ok, reason: null, result };
}

function failureSection(name, lines, verdict, logPath, limit) {
  const number = suiteNumber(name);
  const head = `== suite ${number ? number + " " : ""}${name}: ${verdict.result ?? "RESULT missing"}${verdict.reason ? " (" + verdict.reason + ")" : ""}`;
  const body = [];
  const emitted = new Set();
  const emit = (i, prefix) => {
    if (emitted.has(i)) return;
    emitted.add(i);
    body.push(prefix + clip(lines[i]));
  };
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (!FAILURE.test(lines[i])) continue;
    found = true;
    for (let k = Math.max(0, i - CONTEXT_LINES); k < i; k++) emit(k, "  . ");
    emit(i, "  > ");
    for (let k = i + 1; k < lines.length && DETAIL.test(lines[k]); k++) emit(k, "  > ");
  }
  if (!found) {
    const tail = lines.flatMap((l, i) => (l.trim() === "" ? [] : [i])).slice(-TAIL_LINES);
    for (const i of tail) emit(i, "  . ");
  }
  if (body.length > limit) {
    const cut = body.length - limit;
    body.length = limit;
    body.push(`  ... ${cut} more line(s) cut; full log: ${logPath}`);
  }
  return [head, ...body];
}

export function buildDigest({ suites, logPath = (s) => s.name, limit = SECTION_LIMIT }) {
  let checks = 0;
  let failedChecks = 0;
  let failedSuites = 0;
  const sections = [];
  const retries = [];
  const warnings = new Map();
  for (const suite of suites) {
    const lines = splitLines(suite.out ?? "");
    const all = [...lines, ...splitLines(suite.err ?? "")];
    const verdict = suite.out === null ? { ran: 1, failed: 1, reason: "no log was written", result: null } : judge(lines);
    checks += verdict.ran;
    failedChecks += verdict.failed;
    if (verdict.failed > 0) {
      failedSuites++;
      sections.push(failureSection(suite.name, lines, verdict, logPath(suite), limit));
    }
    for (const l of all) {
      if (RETRY.test(l)) retries.push(`${suite.name}: ${clip(l.trim())}`);
      else if (WARNING.test(l)) {
        const key = l.trim().replace(/^\[driver\]\s*/, "");
        const entry = warnings.get(key) ?? { count: 0, suites: new Set() };
        entry.count++;
        entry.suites.add(suite.name);
        warnings.set(key, entry);
      }
    }
  }
  const passed = checks - failedChecks;
  const out = [
    failedSuites > 0
      ? `FAILED - ${passed}/${checks} checks passed across ${suites.length} suite(s), ${failedSuites} suite(s) failed`
      : `ALL PASS - ${passed}/${checks} checks across ${suites.length} suite(s)`
  ];
  for (const s of sections) out.push("", ...s);
  if (retries.length) out.push("", `retries (${retries.length}):`, ...retries.map((r) => "  " + r));
  if (warnings.size) {
    out.push("", "warnings:");
    for (const [text, e] of warnings) out.push(`  x${e.count} in ${e.suites.size} suite(s): ${clip(text)}`);
  }
  return { text: out.join("\n") + "\n", checks, failedChecks, failedSuites };
}

function readLog(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function digestFromLogDir(dir, names, limit = SECTION_LIMIT) {
  const suites = names.map((name) => ({
    name,
    out: readLog(join(dir, name + ".out.txt")),
    err: readLog(join(dir, name + ".err.txt")) ?? ""
  }));
  return buildDigest({ suites, logPath: (s) => join(dir, s.name + ".out.txt"), limit });
}

function parseCli(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1];
  return args;
}

if (isMain(import.meta.url)) {
  const args = parseCli(process.argv.slice(2));
  if (!args.logs || !args.out || !args.suites) {
    console.error("usage: node tools/failure-digest.mjs --logs DIR --out FILE --suites name1,name2");
    process.exit(2);
  }
  const { text } = digestFromLogDir(args.logs, args.suites.split(",").filter(Boolean));
  writeFileSync(args.out, text);
}
