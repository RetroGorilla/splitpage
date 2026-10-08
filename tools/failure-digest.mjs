import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "./main-module.mjs";

export const SECTION_LIMIT = 60;
export const CONTEXT_LINES = 5;
export const CONTINUATION_LINES = 5;
export const LINE_LIMIT = 300;
const OUT_TAIL = 8;
const ERR_TAIL = 3;

const RESULT_ANY = /^RESULT:/i;
const RESULT_COUNTS = /^RESULT: (\d+)\/(\d+)/i;
const FAILURE = /^(?:FAIL|ERROR|NOT STARTED)/;
const INDENTED = /^\s+\S/;
const RETRY = /^\[driver\].*(?:attempt \d+ of \d+|\bretry\b|\bretrying\b)/i;
const WARNING = /^\s*(?:\[driver\]\s*)?WARN(?:ING)?\b[:\s]/;

export const clip = (line) => (line.length > LINE_LIMIT ? line.slice(0, LINE_LIMIT) + "..." : line);
const splitLines = (text) => text.split(/\r?\n/);

export function suiteNumber(name) {
  const m = /^(\d+)/.exec(name);
  return m ? m[1] : "";
}

export function resultLine(lines) {
  return [...lines].reverse().find((l) => RESULT_ANY.test(l)) ?? null;
}

export function judge(lines) {
  const result = resultLine(lines);
  const bad = (reason) => ({ checks: 1, failedChecks: 1, suiteFailed: true, reason, result });
  if (result === null) return bad("no RESULT line (timed out, crashed or never reported)");
  const m = RESULT_COUNTS.exec(result);
  if (!m) return bad("unreadable RESULT line, counted as one failed check");
  const ok = Number(m[1]);
  const ran = Number(m[2]);
  if (ran === 0) return bad("no checks ran, counted as one failed check");
  if (ok > ran) return bad("more passed than ran, counted as one failed check");
  return { checks: ran, failedChecks: ran - ok, suiteFailed: ok < ran || /FAILED/i.test(result), reason: null, result };
}

function failureBlocks(lines) {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!FAILURE.test(lines[i])) continue;
    const main = [i];
    for (let k = i + 1; k < lines.length && INDENTED.test(lines[k]) && main.length <= CONTINUATION_LINES; k++) main.push(k);
    blocks.push({ at: i, main });
  }
  return blocks;
}

function selectLines(lines, blocks, limit) {
  const mainSet = new Set(blocks.flatMap((b) => b.main));
  const used = new Set();
  for (const b of blocks) {
    b.ctx = [];
    for (let k = Math.max(0, b.at - CONTEXT_LINES); k < b.at; k++) {
      if (mainSet.has(k) || used.has(k)) continue;
      used.add(k);
      b.ctx.push(k);
    }
  }
  const shown = new Map();
  let mainShown = 0;
  let mainTotal = 0;
  for (const b of blocks) {
    for (const i of b.main) {
      mainTotal++;
      if (mainShown < limit) { shown.set(i, "  > "); mainShown++; }
    }
  }
  let budget = limit - mainShown;
  let ctxTotal = 0;
  let ctxShown = 0;
  for (const b of blocks) {
    ctxTotal += b.ctx.length;
    const take = b.ctx.slice(Math.max(0, b.ctx.length - Math.max(0, budget)));
    budget -= take.length;
    ctxShown += take.length;
    for (const i of take) shown.set(i, "  . ");
  }
  const body = [...shown.keys()].sort((a, b) => a - b).map((i) => shown.get(i) + clip(lines[i]));
  return { body, shown: new Set(shown.keys()), cut: mainTotal - mainShown + ctxTotal - ctxShown };
}

function tailLines(lines, count, prefix, skip = new Set()) {
  return lines.flatMap((l, i) => (l.trim() === "" ? [] : [i])).slice(-count).filter((i) => !skip.has(i)).map((i) => prefix + clip(lines[i]));
}

function failureSection(suite, lines, errLines, judged, v, logPath, limit) {
  const number = suiteNumber(suite.name);
  const headline = v.timedOut ? `TIMED OUT after ${v.timeoutSec}s` : judged.result ?? "RESULT missing";
  const reason = judged.reason && !v.timedOut ?" (" + judged.reason + ")" : "";
  const out = [`== suite ${number ? number + " " : ""}${suite.name}: ${headline}${reason}`];
  const blocks = failureBlocks(lines);
  const { body, shown, cut } = selectLines(lines, blocks, limit);
  out.push(...body);
  if (cut > 0) out.push(`  ... ${cut} more line(s) cut; full log: ${logPath}`);
  const abnormal = v.timedOut || suite.out === null || judged.result === null;
  if (abnormal || blocks.length === 0) {
    out.push(...(suite.out === null ? ["  . (no log was written)"] : tailLines(lines, OUT_TAIL, "  . ", shown)));
    if (abnormal) out.push(...tailLines(errLines, ERR_TAIL, "  e "));
  }
  return out;
}

export function buildDigest({ suites, logPath = (s) => s.name, limit = SECTION_LIMIT, timeoutSec = null }) {
  let checks = 0;
  let failedChecks = 0;
  let failedSuites = 0;
  const sections = [];
  const retries = [];
  const warnings = new Map();
  for (const suite of suites) {
    const lines = splitLines(suite.out ?? "");
    const errLines = splitLines(suite.err ?? "");
    const given = suite.verdict;
    const runnerResult = given !== undefined && Object.hasOwn(given, "result");
    const judgedLines = runnerResult ? (given.result === null ? [] : [given.result]) : lines;
    const judged = suite.out === null ? { checks: 1, failedChecks: 1, suiteFailed: true, reason: "no log was written", result: null } : judge(judgedLines);
    const v = given
      ? { checks: given.checks, failedChecks: given.failedChecks, suiteFailed: given.failed, timedOut: Boolean(given.timedOut), timeoutSec }
      : { ...judged, timedOut: false, timeoutSec };
    checks += v.checks;
    failedChecks += v.failedChecks;
    if (v.suiteFailed) {
      failedSuites++;
      sections.push(failureSection(suite, lines, errLines, judged, v, logPath(suite), limit));
    }
    for (const l of [...lines, ...errLines]) {
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

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v) => Number.isInteger(v) && v >= 0;

export function validateVerdicts(verdicts, suiteNames = null) {
  if (!isObject(verdicts)) throw new Error("verdicts must be a JSON object with a suites list");
  const problems = [];
  if (typeof verdicts.timeoutSec !== "number" || !Number.isFinite(verdicts.timeoutSec) || verdicts.timeoutSec < 0) problems.push('"timeoutSec" must be a non-negative number');
  if (!Array.isArray(verdicts.suites)) problems.push('"suites" must be a list');
  else {
    verdicts.suites.forEach((s, i) => {
      const at = `suites[${i}]` + (isObject(s) && typeof s.name === "string" && s.name !== "" ? ` (${s.name})` : "");
      if (!isObject(s)) { problems.push(`${at} must be an object`); return; }
      if (typeof s.name !== "string" || s.name === "") problems.push(`${at}: "name" must be a non-empty string`);
      if (typeof s.failed !== "boolean") problems.push(`${at}: "failed" must be true or false`);
      if (typeof s.timedOut !== "boolean") problems.push(`${at}: "timedOut" must be true or false`);
      if (s.result !== undefined && s.result !== null && typeof s.result !== "string") problems.push(`${at}: "result" must be a string or null`);
      if (!isCount(s.checks)) problems.push(`${at}: "checks" must be a whole number, 0 or more`);
      if (!isCount(s.failedChecks)) problems.push(`${at}: "failedChecks" must be a whole number, 0 or more`);
      else if (isCount(s.checks) && s.failedChecks > s.checks) problems.push(`${at}: "failedChecks" is more than "checks"`);
      if (s.failed === false && isCount(s.failedChecks) && s.failedChecks > 0) problems.push(`${at}: "failed" is false but "failedChecks" is ${s.failedChecks}`);
      if (s.failed === false && s.timedOut === true) problems.push(`${at}: "timedOut" is true but "failed" is false`);
    });
    const seen = new Set();
    const repeated = new Set();
    for (const s of verdicts.suites) {
      if (!isObject(s) || typeof s.name !== "string" || s.name === "") continue;
      if (seen.has(s.name)) repeated.add(s.name);
      seen.add(s.name);
    }
    for (const name of repeated) problems.push(`"${name}" has a verdict more than once`);
    if (suiteNames !== null) {
      const wanted = new Set(suiteNames);
      for (const name of seen) if (!wanted.has(name)) problems.push(`"${name}" has a verdict but is not in the suite list`);
      for (const name of wanted) if (!seen.has(name)) problems.push(`"${name}" is in the suite list but has no verdict`);
    }
  }
  if (problems.length) throw new Error("invalid verdicts: " + problems.join("; "));
}

function readLog(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function digestFromLogDir(dir, names, { limit = SECTION_LIMIT, verdicts = null } = {}) {
  if (verdicts !== null) validateVerdicts(verdicts, names);
  const byName = new Map((verdicts?.suites ?? []).map((s) => [s.name, s]));
  const suites = names.map((name) => ({
    name,
    out: readLog(join(dir, name + ".out.txt")),
    err: readLog(join(dir, name + ".err.txt")) ?? "",
    verdict: byName.get(name)
  }));
  return buildDigest({ suites, logPath: (s) => join(dir, s.name + ".out.txt"), limit, timeoutSec: verdicts?.timeoutSec ?? null });
}

function readVerdicts(path) {
  if (!existsSync(path)) throw new Error(`verdicts file not found: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`verdicts file is not valid JSON (${path}): ${error.message}`, { cause: error });
  }
}

function parseCli(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1];
  return args;
}

if (isMain(import.meta.url)) {
  const args = parseCli(process.argv.slice(2));
  if (!args.logs || !args.out || !args.suites) {
    console.error("usage: node tools/failure-digest.mjs --logs DIR --out FILE --suites name1,name2 [--verdicts FILE]");
    process.exit(2);
  }
  try {
    const verdicts = args.verdicts ? readVerdicts(args.verdicts) : null;
    const { text } = digestFromLogDir(args.logs, args.suites.split(",").filter(Boolean), { verdicts });
    writeFileSync(args.out, text);
  } catch (error) {
    console.error("failure-digest: " + error.message);
    process.exit(1);
  }
}
