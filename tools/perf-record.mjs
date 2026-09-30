import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { cpus, totalmem, platform, release, arch, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "./source-scan.mjs";

const DRIVER = join(REPO, ".claude", "skills", "run-splitpage-app", "driver.mjs");
const TYPED = "The quick brown fox films a take by the window at dusk.";
const KEY_GAP_MS = 60;
const SPLITS = 5;
const EXPORT_RUNS = 5;

const PROBE = `(function () {
  if (window.__perf) return 'ready';
  var perf = { lat: [], long: [] };
  perf.reset = function () { perf.lat = []; perf.long = []; return true; };
  perf.take = function (label) {
    var lat = perf.lat.slice().sort(function (a, b) { return a - b; });
    var q = function (p) { return lat.length ? +lat[Math.min(lat.length - 1, Math.floor(p * lat.length))].toFixed(1) : null; };
    var out = { label: label, keys: lat.length, p50: q(0.5), p95: q(0.95), max: lat.length ? +lat[lat.length - 1].toFixed(1) : null,
      longTasks: perf.long.length, longTaskMs: +perf.long.reduce(function (a, b) { return a + b; }, 0).toFixed(1) };
    perf.reset();
    return 'PERF ' + JSON.stringify(out);
  };
  addEventListener('keydown', function (e) {
    var t0 = e.timeStamp;
    requestAnimationFrame(function () { setTimeout(function () { perf.lat.push(performance.now() - t0); }, 0); });
  }, true);
  try { new PerformanceObserver(function (list) { list.getEntries().forEach(function (en) { perf.long.push(en.duration); }); }).observe({ type: 'longtask' }); } catch (e) {}
  window.__perf = perf;
  return 'ready';
})()`;

const ENVIRONMENT = `(function () {
  var cell = document.querySelector('#rows .cell-editable');
  var family = cell ? getComputedStyle(cell).fontFamily : '';
  var first = family.split(',')[0].trim().replace(/^["']|["']$/g, '');
  var ctx = document.createElement('canvas').getContext('2d');
  var width = function (font) { ctx.font = font; return ctx.measureText('The quick brown fox 0123456789').width; };
  var rendered = first ? ['monospace', 'serif'].some(function (f) { return width('16px "' + first + '", ' + f) !== width('16px ' + f); }) : false;
  return 'PERF ' + JSON.stringify({ label: 'environment', userAgent: navigator.userAgent, viewport: innerWidth + 'x' + innerHeight,
    devicePixelRatio: devicePixelRatio, cellFont: family, firstFont: first, firstFontRendered: rendered,
    scenes: document.querySelectorAll('#rows .row').length });
})()`;

const EXPORTS = `(function () {
  var F = window.__splitpageFormats;
  var s = F.state();
  var time = function (fn) {
    var runs = [];
    for (var i = 0; i < ${EXPORT_RUNS}; i++) { var t = performance.now(); fn(); runs.push(performance.now() - t); }
    runs.sort(function (a, b) { return a - b; });
    return +runs[Math.floor(runs.length / 2)].toFixed(1);
  };
  return 'PERF ' + JSON.stringify({ label: 'export', splitpage: time(function () { F.buildSplitpage(s); }),
    markdown: time(function () { F.buildMarkdown(s); }), standaloneHtml: time(function () { F.buildStandaloneHtml(); }) });
})()`;

const oneLine = (code) => code.replace(/\n\s*/g, " ");

function typing(fixture) {
  const lines = ["eval window.__perf.reset()", "caret #rows .row:nth-child(2) .audio-cell .cell-editable", "key end"];
  for (const token of TYPED.match(/ ?[^ ]/g)) lines.push(`press ${token}`, `sleep ${KEY_GAP_MS}`);
  lines.push("sleep 1200", `eval window.__perf.take('${fixture} typing')`);
  return lines;
}

function rowEdits(fixture) {
  const lines = ["eval window.__perf.reset()"];
  for (let i = 0; i < SPLITS; i++) lines.push("caret #rows .row:nth-child(2) .audio-cell .cell-editable", "key ctrl Enter", "sleep 400");
  lines.push("sleep 800", `eval window.__perf.take('${fixture} new scene')`);
  return lines;
}

function bulk(fixture) {
  return [
    "eval document.activeElement && document.activeElement.blur()",
    "eval (function(){ var r = document.querySelectorAll('#rows .row'); window.__sceneSelectTest.select(r[0].dataset.id, r[r.length - 1].dataset.id); return window.__sceneSelectTest.ids().length; })()",
    "sleep 300",
    "eval window.__perf.reset()",
    "key delete",
    "sleep 1500",
    `eval window.__perf.take('${fixture} delete every scene')`,
    "key ctrl keyz",
    "sleep 1500",
    `eval window.__perf.take('${fixture} undo the delete')`,
    "expect document.querySelectorAll('#rows .row').length > 1"
  ];
}

export function suiteText(fixture) {
  const lines = fixture === "long"
    ? [
      "open /index.html?newtab=1",
      "viewport 1400 900",
      "wait document.getElementById('newtab-page').hidden == false",
      "click [data-newtab-action=\"long-demo\"]",
      "wait document.querySelectorAll('#rows .row').length == 30"
    ]
    : ["open", "viewport 1400 900"];
  lines.push(`eval ${oneLine(PROBE)}`, "sleep 2000", `eval ${oneLine(ENVIRONMENT)}`);
  lines.push(...typing(fixture), ...rowEdits(fixture), ...bulk(fixture), `eval ${oneLine(EXPORTS).replace("'export'", `'${fixture} export'`)}`);
  return lines.join("\n") + "\n";
}

export function parsePerf(stdout) {
  return stdout.split("\n").filter((l) => l.startsWith("PERF ")).map((l) => JSON.parse(l.slice(5)));
}

function machine() {
  const c = cpus();
  return { platform: `${platform()} ${release()} ${arch()}`, cpu: `${c[0]?.model ?? "unknown"} x${c.length}`, memoryGb: +(totalmem() / 2 ** 30).toFixed(1), node: process.version };
}

export function report(results, env, when) {
  const rows = results.filter((r) => r.keys !== undefined);
  const exports = results.filter((r) => r.label.endsWith("export"));
  const browsers = results.filter((r) => r.label === "environment");
  const lines = [
    "# Performance record",
    "",
    `Recorded ${when} by \`node tools/perf-record.mjs\`, once. The numbers describe this machine and browser; compare a later run only under the same conditions.`,
    "",
    "## Conditions",
    "",
    `- Machine: ${env.platform}, ${env.cpu}, ${env.memoryGb} GB, Node ${env.node}`,
    `- Browser: ${browsers[0]?.userAgent ?? "unknown"}, headless, viewport ${browsers[0]?.viewport ?? "?"} at ${browsers[0]?.devicePixelRatio ?? "?"}x`,
    `- Script font: \`${browsers[0]?.cellFont ?? "?"}\`; ${browsers[0]?.firstFont} ${browsers[0]?.firstFontRendered ? "is installed and used" : "is not installed, so a fallback family drew the text"}`,
    `- Fixtures: short is the seed script (${browsers[0]?.scenes ?? "?"} scenes); long is the long demo (${browsers[1]?.scenes ?? "?"} scenes)`,
    `- Typing: ${TYPED.length} characters, one real key event every ${KEY_GAP_MS} ms, into scene 2's audio cell; latency is key-down to the frame after it`,
    "",
    "## Input latency (ms)",
    "",
    "| Case | Keys | p50 | p95 | Max | Long tasks | Long-task ms |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r.label} | ${r.keys} | ${r.p50 ?? "—"} | ${r.p95 ?? "—"} | ${r.max ?? "—"} | ${r.longTasks} | ${r.longTaskMs} |`),
    "",
    `## Export (median of ${EXPORT_RUNS} runs, ms)`,
    "",
    "| Fixture | .splitpage | .md project | Standalone HTML |",
    "| --- | --- | --- | --- |",
    ...exports.map((r) => `| ${r.label.replace(" export", "")} | ${r.splitpage} | ${r.markdown} | ${r.standaloneHtml} |`),
    "",
    ".docx, PDF, CSV and .xlsx have no page hook to time them by and are not measured.",
    ""
  ];
  return lines.join("\n");
}

export function main(argv) {
  const out = argv[0] ? resolve(argv[0]) : null;
  if (!existsSync(join(REPO, "index.html"))) {
    console.error("perf-record: index.html is not built; run `node build.mjs` first");
    return 2;
  }
  const work = mkdtempSync(join(tmpdir(), "splitpage-perf-"));
  const results = [];
  for (const fixture of ["short", "long"]) {
    const suite = join(work, `${fixture}.txt`);
    writeFileSync(suite, suiteText(fixture));
    const r = spawnSync(process.execPath, [DRIVER, "--script", suite, "--port", "18990", "--cdp-port", "19990", "--shot-dir", work], {
      cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60 * 1000
    });
    const found = parsePerf(r.stdout ?? "");
    if (r.status !== 0 || found.length !== 6) {
      console.error((r.stdout ?? "").split("\n").filter((l) => !l.startsWith("pressed")).slice(-30).join("\n"));
      console.error((r.stderr ?? "").split("\n").slice(-20).join("\n"));
      console.error(`perf-record: the ${fixture} run failed (exit ${r.status ?? r.signal}, ${found.length} of 6 measurements)`);
      rmSync(work, { recursive: true, force: true });
      return 1;
    }
    results.push(...found);
  }
  const text = report(results, machine(), new Date().toISOString().slice(0, 10));
  if (out) writeFileSync(out, text);
  console.log(text);
  rmSync(work, { recursive: true, force: true });
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}

