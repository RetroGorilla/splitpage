import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { REPO } from "./source-scan.mjs";
import { isMain } from "./main-module.mjs";
import { KEY_GAP_MS, TYPED, parsePortBase } from "./perf-record.mjs";

const DRIVER = join(REPO, ".claude", "skills", "run-splitpage-app", "driver.mjs");
export const SHARED_FIXTURES = ["short", "long", "large", "edited"];
export const REMOTE_RATES = [0, 1, 10];
export const SEAMS = ["trial", "live-apply", "mirror-apply", "assembly", "projection-listeners", "session-receive", "document-entry", "render",
  "input-handler", "input-command", "input-write"];
const REPLAY_UPDATES = 400;
const BACKLOG_UPDATES = 200;
const BACKLOG_AT_MS = 1500;
const STRUCTURAL_CYCLES = 1;
const UNDO_PRESSES = 10;
const SETTLE_MS = 1200;
const CHUNK = 60000;
const CDP_PORT_OFFSET = 1000;
const LOCAL_ROW = 1;
export const CLIENTS = Object.freeze({ entry: 0x81234567, replay: 0x81234569 });
export const PENDING_CASES = Object.freeze([{ label: "split person structural edits", waitsFor: "#1584" }]);

export function caseList() {
  const typing = (surface) => REMOTE_RATES.map((rate) => ({ label: `${surface} typing, remote ${rate}/s`, surface, kind: "typing", rate }));
  return [
    ...typing("split"),
    { label: "split undo and redo, remote 1/s", surface: "split", kind: "undo", rate: 1 },
    { label: "split typing, peer structural edits 1/s", surface: "split", kind: "structural", rate: 1 },
    { label: `split typing, backlog of ${BACKLOG_UPDATES} released one by one`, surface: "split", kind: "backlog", order: "forward" },
    { label: `split typing, backlog of ${BACKLOG_UPDATES} released as one catch-up diff`, surface: "split", kind: "backlog", order: "catch-up" },
    ...typing("writer"),
    { label: "writer undo and redo, remote 1/s", surface: "writer", kind: "undo", rate: 1 },
    { label: "writer typing, peer structural edits 1/s", surface: "writer", kind: "structural", rate: 1 },
    { label: "writer typing, refused updates while remote 1/s", surface: "writer", kind: "refused", rate: 1 }
  ];
}

export function markTotals(entries) {
  const totals = {}, stack = [];
  let unmatched = 0;
  for (const entry of entries) {
    const found = /^measure:(.+):(start|end)$/.exec(entry.name);
    if (!found) continue;
    const seam = found[1];
    if (found[2] === "start") { stack.push({ seam, at: entry.startTime, inner: 0 }); continue; }
    let open = stack.pop();
    while (open && open.seam !== seam) { unmatched++; open = stack.pop(); }
    if (!open) { unmatched++; continue; }
    const spent = entry.startTime - open.at, row = totals[seam] || (totals[seam] = { count: 0, inclusive: 0, exclusive: 0 });
    row.count++; row.inclusive += spent; row.exclusive += spent - open.inner;
    if (stack.length) stack[stack.length - 1].inner += spent;
  }
  for (const seam of Object.keys(totals)) {
    totals[seam].inclusive = Math.round(totals[seam].inclusive * 1000) / 1000;
    totals[seam].exclusive = Math.round(totals[seam].exclusive * 1000) / 1000;
  }
  return { seams: totals, unmatched: unmatched + stack.length };
}

export function markGroups(marks) {
  const seam = (name, key) => marks.seams[name]?.[key] ?? 0;
  const round = (value) => Math.round(value * 1000) / 1000;
  return {
    validation: round(seam("trial", "inclusive")),
    apply: round(seam("live-apply", "exclusive")),
    projection: round(seam("mirror-apply", "inclusive") + seam("assembly", "inclusive") + seam("projection-listeners", "exclusive")
      + seam("session-receive", "exclusive") + seam("document-entry", "inclusive")),
    rendering: round(seam("render", "inclusive")),
    input: round(seam("input-handler", "exclusive") + seam("input-command", "exclusive") + seam("input-write", "exclusive")),
    route: round(seam("input-handler", "exclusive")),
    plan: round(seam("input-command", "exclusive")),
    write: round(seam("input-write", "exclusive"))
  };
}

export const GROUP_NAMES = ["validation", "apply", "projection", "rendering", "input", "route", "plan", "write"];

export const PAGE = `(function () {
  if (window.__perfShared) return 'ready';
  var S = window.__sharedTest;
  var totals = ${markTotals.toString()};
  var MODIFIERS = { Control: 1, Shift: 1, Alt: 1, Meta: 1 };
  var perf = { since: Infinity, lat: [], long: [], data: '', fixture: null, cursor: 0, events: [], timers: [], replaying: null, structural: [], refused: null };
  addEventListener('keydown', function (e) {
    if (MODIFIERS[e.key] || e.timeStamp < perf.since) return;
    var t0 = e.timeStamp;
    requestAnimationFrame(function () { setTimeout(function () { perf.lat.push(performance.now() - t0); }, 0); });
  }, true);
  try { new PerformanceObserver(function (list) { list.getEntries().forEach(function (en) { perf.long.push(en.duration); }); }).observe({ type: 'longtask' }); } catch (e) {}
  var need = function (ok, what) { if (!ok) throw new Error('perf shared: ' + what); };
  var clear = function () {
    var seen = {};
    performance.getEntriesByType('mark').forEach(function (m) { if (m.name.indexOf('measure:') === 0 && !seen[m.name]) { seen[m.name] = true; performance.clearMarks(m.name); } });
  };
  var quiet = function (run) { S.timing(false); try { return run(); } finally { S.timing(true); } };
  var rowId = function (index) { return S.read().app.rows[index].id; };
  var plainLength = function (html) { var d = document.createElement('div'); d.innerHTML = html || ''; return d.textContent.replace(/\\u200b/g, '').length; };
  var later = function (ms, run) { perf.timers.push(setTimeout(run, ms)); };
  var q = function (lat, p) { return lat.length ? +lat[Math.min(lat.length - 1, Math.floor(p * lat.length))].toFixed(1) : null; };
  window.__perfShared = {
    chunk: function (text) { perf.data += text; return perf.data.length; },
    enter: async function () {
      var data = JSON.parse(perf.data);
      perf.data = '';
      perf.fixture = data;
      var t0 = performance.now(), result = await S.enterFrom(data.state), ms = performance.now() - t0;
      need(result.ok, 'entry refused: ' + result.reason);
      var doc = S.read().app;
      need(doc.rows.length === data.rows, 'entered ' + doc.rows.length + ' beats, expected ' + data.rows);
      S.timing(true);
      return 'PERF ' + JSON.stringify({ kind: 'entry', label: data.name + ' entry', fixture: data.name, beats: doc.rows.length, stateBytes: data.stateBytes, ms: +ms.toFixed(1),
        browser: (navigator.userAgent.match(/(Edg|Chrome)\\/[\\d.]+/) || ['unknown'])[0], viewport: innerWidth + 'x' + innerHeight, devicePixelRatio: devicePixelRatio });
    },
    writerCaret: function () {
      var id = rowId(${LOCAL_ROW}), at = plainLength(S.read().app.rows[${LOCAL_ROW}].audioText);
      window.__writerFlowTest.place({ anchor: { kind: 'beat', rowId: id, offset: at }, head: { kind: 'beat', rowId: id, offset: at } });
      document.getElementById('writer-doc').focus();
      return at;
    },
    prepare: function (spec) {
      return quiet(function () {
        S.peer.hold();
        var remote = rowId(0), made = [];
        if (spec.kind === 'structural') {
          for (var c = 0; c < ${STRUCTURAL_CYCLES}; c++) {
            var split = S.peer.split(remote, 2); made.push(split.kind);
            made.push(S.peer.join(remote));
            var added = S.peer.add(remote); made.push(added.kind);
            made.push(added.id ? S.peer.remove(added.id) : 'no beat');
          }
          need(made.every(function (k) { return k === 'applied'; }), 'peer structural edits: ' + made.join(', '));
          perf.structural = S.peer.capture('app');
          return perf.structural.length;
        }
        if (spec.kind === 'backlog') {
          for (var i = 0; i < ${BACKLOG_UPDATES}; i++) made.push(S.peer.type(remote, 0, 'y').kind);
          need(made.every(function (k) { return k === 'applied'; }), 'the backlog was not written');
          return S.counters().queued;
        }
        if (spec.kind === 'refused') {
          perf.refused = { throws: S.peer.refusedUpdate('throws'), 'zero-length': S.peer.refusedUpdate('zero-length'), 'queue-full': S.peer.refusedUpdate('queue-full', remote) };
          return Object.keys(perf.refused).length;
        }
        return 0;
      });
    },
    begin: function (spec) {
      S.peer.hold();
      perf.since = performance.now();
      perf.lat = []; perf.long = []; perf.events = []; perf.replaying = null;
      clear();
      if (spec.kind === 'structural') { perf.replaying = 'structural'; S.peer.replay(perf.structural, 1000 / spec.rate); }
      else if (spec.rate) { perf.replaying = 'remote'; S.peer.replay(perf.fixture.replay.slice(perf.cursor), 1000 / spec.rate); }
      if (spec.kind === 'backlog') later(${BACKLOG_AT_MS}, function () {
        var t0 = performance.now(), count = S.peer.deliver(spec.order, 'app');
        perf.events.push({ release: spec.order, updates: count, ms: +(performance.now() - t0).toFixed(1) });
      });
      if (spec.kind === 'refused') ['throws', 'zero-length', 'queue-full'].forEach(function (kind, index) {
        later(1000 * (index + 1), function () {
          var result = S.peer.inject(perf.refused[kind]);
          perf.events.push({ refused: kind, ok: result.ok, reason: result.ok ? null : result.reason });
        });
      });
      return true;
    },
    end: function (label) {
      perf.since = Infinity;
      perf.timers.forEach(clearTimeout); perf.timers = [];
      var replayed = S.peer.replayed();
      S.peer.stopReplay();
      var consumed = replayed ? replayed.delivered + replayed.refused : 0;
      if (perf.replaying === 'remote') perf.cursor += consumed;
      var lat = perf.lat.slice().sort(function (a, b) { return a - b; });
      var marks = totals(performance.getEntriesByType('mark'));
      var out = { kind: 'case', label: label, keys: lat.length, p50: q(lat, 0.5), p95: q(lat, 0.95), max: lat.length ? +lat[lat.length - 1].toFixed(1) : null,
        longTasks: perf.long.length, longTaskMs: +perf.long.reduce(function (a, b) { return a + b; }, 0).toFixed(1), marks: marks,
        replayed: perf.replaying ? { source: perf.replaying, delivered: replayed ? replayed.delivered : 0, refused: replayed ? replayed.refused : 0 } : null, events: perf.events };
      clear();
      quiet(function () {
        if (perf.replaying === 'structural') perf.structural.slice(consumed).forEach(function (update) { need(S.peer.inject(update).ok, 'a late structural update was refused'); });
        S.peer.release();
      });
      return 'PERF ' + JSON.stringify(out);
    }
  };
  return 'ready';
})()`;

const oneLine = (code) => code.replace(/\n\s*/g, " ");

function typingLines() {
  const lines = [];
  for (const token of TYPED.match(/ ?[^ ]/g)) lines.push(`press ${token}`, `sleep ${KEY_GAP_MS}`);
  return lines;
}

function undoLines() {
  const lines = [];
  for (const key of ["KeyZ", "KeyY"]) for (let i = 0; i < UNDO_PRESSES; i++) lines.push(`key ctrl ${key}`, `sleep ${KEY_GAP_MS}`);
  return lines;
}

export function expectedKeys(spec) {
  return spec.kind === "undo" ? 2 * UNDO_PRESSES : TYPED.length;
}

function caret(surface) {
  return surface === "writer"
    ? ["eval window.__perfShared.writerCaret()"]
    : ["eval document.activeElement && document.activeElement.blur()", `caret #rows .row:nth-of-type(${LOCAL_ROW + 1}) .audio-cell .cell-editable`, "key end"];
}

function caseLines(spec, label = spec.label) {
  return [
    `eval window.__perfShared.prepare(${JSON.stringify(spec)})`,
    ...caret(spec.surface),
    `eval window.__perfShared.begin(${JSON.stringify(spec)})`,
    ...(spec.kind === "undo" ? undoLines() : typingLines()),
    `sleep ${SETTLE_MS}`,
    `eval window.__perfShared.end(${JSON.stringify(label)})`
  ];
}

export function sharedSuiteText(data) {
  const text = JSON.stringify(data);
  const lines = ["open", "viewport 1400 900", "wait document.querySelectorAll('#rows .row').length > 0", "sleep 1500", `eval ${oneLine(PAGE)}`];
  for (let at = 0; at < text.length; at += CHUNK) lines.push(`eval window.__perfShared.chunk(${JSON.stringify(text.slice(at, at + CHUNK))})`);
  lines.push("eval window.__perfShared.enter()", `wait document.querySelectorAll('#rows .row').length === ${data.rows}`, "sleep 1000");
  const cases = caseList();
  lines.push(...caseLines(cases[1], "warm-up (discarded)"));
  for (const spec of cases) {
    if (spec.surface === "writer" && !lines.includes("click #btn-write")) lines.push("click #btn-write", "wait window.__writerFlowTest.on()", "sleep 500");
    lines.push(...caseLines(spec));
  }
  return lines.join("\n") + "\n";
}

export function parseShared(stdout) {
  return stdout.split("\n").filter((line) => line.startsWith("PERF ")).map((line) => JSON.parse(line.slice(5)));
}

export function sharedProblems(found, fixture) {
  const problems = [];
  const entry = found.filter((r) => r.kind === "entry");
  if (entry.length !== 1) problems.push(`${fixture}: ${entry.length} entries`);
  const cases = found.filter((r) => r.kind === "case" && !r.label.startsWith("warm-up"));
  const wanted = caseList();
  if (cases.length !== wanted.length) problems.push(`${fixture}: ${cases.length} of ${wanted.length} cases`);
  for (const spec of wanted) {
    const row = cases.find((r) => r.label === spec.label);
    if (!row) continue;
    if (row.keys !== expectedKeys(spec)) problems.push(`${spec.label}: ${row.keys} key samples, expected ${expectedKeys(spec)}`);
    if (row.marks.unmatched) problems.push(`${spec.label}: ${row.marks.unmatched} unmatched timing marks`);
    if (spec.kind === "backlog" && !(row.events.length === 1 && row.events[0].updates > 0)) problems.push(`${spec.label}: the backlog was not released`);
    if (spec.kind === "refused") {
      for (const kind of ["throws", "zero-length"]) {
        const event = row.events.find((e) => e.refused === kind);
        if (!event || event.ok || event.reason !== "invalid-update") problems.push(`${spec.label}: the ${kind} update was not refused as invalid-update`);
      }
      if (!row.events.some((e) => e.refused === "queue-full")) problems.push(`${spec.label}: the queue-full update was not injected`);
    }
    if (spec.rate && !(row.replayed && row.replayed.delivered > 0)) problems.push(`${spec.label}: no remote update was delivered`);
  }
  return problems;
}

export function sharedRows(found, fixture) {
  return found.filter((r) => r.kind === "entry" || (r.kind === "case" && !r.label.startsWith("warm-up")))
    .map((r) => r.kind === "case" ? { ...r, fixture, label: `${fixture} ${r.label}`, groups: markGroups(r.marks) } : { ...r, fixture });
}

export async function prepareData(only) {
  const { fixtures, growth, updatesFor, open } = await import("../tests/collab/measure/run.mjs");
  const { hydrateSharedDocument } = await import("../src/adapters/collab/hydrate.ts");
  const { destroySharedDocument, encodeSharedState } = await import("../src/adapters/collab/document.ts");
  const { enterSharedDocument } = await import("../src/core/migrate.ts");
  const sources = fixtures();
  const base64 = (bytes) => Buffer.from(bytes).toString("base64");
  const fresh = (source) => {
    const handle = open();
    try {
      hydrateSharedDocument(handle, enterSharedDocument(structuredClone(source.document)));
      return encodeSharedState(handle);
    } finally { destroySharedDocument(handle); }
  };
  const out = {};
  for (const name of only) {
    const source = sources.find((s) => s.name === (name === "edited" ? "long" : name));
    process.stderr.write(`perf-shared: preparing ${name}\n`);
    const state = name === "edited" ? growth(source).edited : fresh(source);
    const remote = source.document.rows[0].id;
    const replay = updatesFor(state, remote).updates.slice(0, REPLAY_UPDATES);
    out[name] = { name, state: base64(state), stateBytes: state.length, rows: source.document.rows.length, remoteRow: remote,
      localRow: source.document.rows[LOCAL_ROW].id, replay: replay.map(base64) };
  }
  return { clients: CLIENTS, replayUpdates: REPLAY_UPDATES, fixtures: out };
}

export function parseSharedArgs(argv) {
  let built = false, data = null, json = null, prepare = null, only = SHARED_FIXTURES;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--built") built = true;
    else if (arg === "--data") data = argv[++i] ?? "";
    else if (arg === "--json") json = argv[++i] ?? "";
    else if (arg === "--prepare") prepare = argv[++i] ?? "";
    else if (arg === "--only") only = (argv[++i] ?? "").split(",").filter(Boolean);
    else return { error: `unknown argument: ${arg}` };
  }
  const unknown = only.filter((f) => !SHARED_FIXTURES.includes(f));
  if (unknown.length || !only.length || new Set(only).size !== only.length) return { error: `--only needs distinct fixtures from ${SHARED_FIXTURES.join(",")}` };
  if (prepare === "" || data === "" || json === "") return { error: "--prepare, --data and --json each need a file" };
  if (!prepare && !data) return { error: "usage: node tools/perf-shared.mjs --prepare <data.json> [--only ...] | --data <data.json> [--built] [--json <out.json>] [--only ...]" };
  return { built, data: data && resolve(data), json: json && resolve(json), prepare: prepare && resolve(prepare), only, error: null };
}

export function sharedReport(rows) {
  const cases = rows.filter((r) => r.kind === "case");
  const entries = rows.filter((r) => r.kind === "entry");
  const lines = [
    "# Shared composed-editor measurement",
    "",
    `- Typing: ${TYPED.length} characters, one real key event every ${KEY_GAP_MS} ms; latency is key-down to the frame after it, modifier key-downs left out`,
    `- Remote rates: ${REMOTE_RATES.join(", ")} updates a second of pre-generated single-character edits to the first beat; peer structural edits are split, join, add and remove, pre-generated and delivered one update a second`,
    `- Backlog: ${BACKLOG_UPDATES} held peer updates released ${BACKLOG_AT_MS} ms into the typing, one by one or as one catch-up diff`,
    `- Not measured yet: ${PENDING_CASES.map((c) => `${c.label} (waits for ${c.waitsFor})`).join("; ")}`,
    "",
    "| Fixture | Beats | State bytes | Entry ms | Browser |",
    "| --- | --- | --- | --- | --- |",
    ...entries.map((e) => `| ${e.fixture} | ${e.beats} | ${e.stateBytes} | ${e.ms} | ${e.browser} |`),
    "",
    `| Case | Keys | p50 | p95 | Max | Long tasks | Long-task ms | Remote delivered | ${GROUP_NAMES.map((g) => `${g} ms`).join(" | ")} |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | ${GROUP_NAMES.map(() => "---").join(" | ")} |`,
    ...cases.map((r) => `| ${r.label} | ${r.keys} | ${r.p50 ?? "—"} | ${r.p95 ?? "—"} | ${r.max ?? "—"} | ${r.longTasks} | ${r.longTaskMs} | ${r.replayed ? r.replayed.delivered : "—"} | ${GROUP_NAMES.map((g) => r.groups[g]).join(" | ")} |`)
  ];
  return lines.join("\n") + "\n";
}

export async function main(argv) {
  const args = parseSharedArgs(argv);
  if (args.error) { console.error(`perf-shared: ${args.error}`); return 2; }
  if (args.prepare) {
    writeFileSync(args.prepare, JSON.stringify(await prepareData(args.only)));
    return 0;
  }
  const ports = parsePortBase(process.env.PERF_PORT_BASE);
  if (ports.error) { console.error(`perf-shared: ${ports.error}`); return 2; }
  if (args.built && !existsSync(join(REPO, "index.html"))) { console.error("perf-shared: index.html is not built; run `node build.mjs --test` first"); return 2; }
  if (!args.built) {
    const result = spawnSync(process.execPath, ["build.mjs", "--test"], { cwd: REPO, encoding: "utf8" });
    if (result.status !== 0) { console.error(result.stdout ?? "", result.stderr ?? ""); return 1; }
  }
  const data = JSON.parse(readFileSync(args.data, "utf8"));
  const work = mkdtempSync(join(tmpdir(), "splitpage-perf-shared-"));
  const rows = [];
  try {
    for (const fixture of args.only) {
      const prepared = data.fixtures[fixture];
      if (!prepared) { console.error(`perf-shared: the data file has no ${fixture} fixture`); return 2; }
      const suite = join(work, `${fixture}.txt`);
      writeFileSync(suite, sharedSuiteText(prepared));
      const r = spawnSync(process.execPath, [DRIVER, "--script", suite, "--port", String(ports.base), "--cdp-port", String(ports.base + CDP_PORT_OFFSET), "--shot-dir", work], {
        cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000
      });
      const found = parseShared(r.stdout ?? "");
      const problems = sharedProblems(found, fixture);
      if (r.status !== 0 || problems.length) {
        console.error((r.stdout ?? "").split("\n").filter((l) => !l.startsWith("pressed") && !l.startsWith("PERF ")).slice(-30).join("\n"));
        console.error((r.stderr ?? "").split("\n").slice(-20).join("\n"));
        problems.forEach((p) => console.error(`perf-shared: ${p}`));
        console.error(`perf-shared: the ${fixture} run failed (exit ${r.status ?? r.signal})`);
        return 1;
      }
      rows.push(...sharedRows(found, fixture));
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
  if (args.json) writeFileSync(args.json, JSON.stringify({ rows, pending: PENDING_CASES }, null, 2) + "\n");
  console.log(sharedReport(rows));
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
