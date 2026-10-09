import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { cpus, totalmem, platform, release, arch, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { REPO } from "./source-scan.mjs";
import { isMain } from "./main-module.mjs";

const DRIVER = join(REPO, ".claude", "skills", "run-splitpage-app", "driver.mjs");
const TYPED = "The quick brown fox films a take by the window at dusk.";
const KEY_GAP_MS = 60;
const SPLITS = 5;
const EXPORT_RUNS = 5;
const PICTURES = 10;
const PICTURE_BYTES = 1024 * 1024;
const IMAGE_TRIALS = 3;
const FIXTURES = ["short", "long", "images"];
const EXPECTED_PERF = { short: 6, long: 6, images: 1 };
const PORT_BASE = Number(process.env.PERF_PORT_BASE) || 18990;

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

export const IMAGES = `(function () {
  if (window.__perfImg) return 'ready';
  var F = window.__splitpageFormats, B = window.__blobsTest, H = window.__hostedTest;
  var SIZE = ${PICTURE_BYTES}, COUNT = ${PICTURES};
  var table = [];
  for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); table.push(c >>> 0); }
  var crc = function (b, from, to) { var c = 0xffffffff; for (var i = from; i < to; i++) c = table[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  var put32 = function (b, at, v) { b[at] = (v >>> 24) & 255; b[at + 1] = (v >>> 16) & 255; b[at + 2] = (v >>> 8) & 255; b[at + 3] = v & 255; };
  var chunk = function (b, at, type, length, fill) {
    put32(b, at, length);
    for (var i = 0; i < 4; i++) b[at + 4 + i] = type.charCodeAt(i);
    fill(at + 8);
    put32(b, at + 8 + length, crc(b, at + 4, at + 8 + length));
    return at + 12 + length;
  };
  var picture = function (seed) {
    var b = new Uint8Array(SIZE), pad = SIZE - 84, px = [0, seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255];
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    var at = chunk(b, 8, 'IHDR', 13, function (d) { put32(b, d, 1); put32(b, d + 4, 1); b.set([8, 2, 0, 0, 0], d + 8); });
    at = chunk(b, at, 'prVt', pad, function (d) {
      var x = seed || 1;
      for (var i = 0; i < pad; i += 4) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0; put32(b, d + i, x); }
    });
    at = chunk(b, at, 'IDAT', 15, function (d) {
      var a = 1, s = 0;
      px.forEach(function (v) { a = (a + v) % 65521; s = (s + a) % 65521; });
      b.set([0x78, 0x01, 0x01, 0x04, 0x00, 0xfb, 0xff], d);
      b.set(px, d + 7);
      put32(b, d + 11, ((s << 16) | a) >>> 0);
    });
    chunk(b, at, 'IEND', 0, function () {});
    return b;
  };
  var b64 = function (b) {
    var out = [];
    for (var i = 0; i < b.length; i += 24576) out.push(btoa(String.fromCharCode.apply(null, b.subarray(i, i + 24576))));
    return out.join('');
  };
  var next = 1;
  var urls = function () {
    var out = [];
    for (var i = 0; i < COUNT; i++) out.push('data:image/png;base64,' + b64(picture(Math.imul(next++, 0x9e3779b1) >>> 0)));
    return out;
  };
  var seed = F.clone(F.state());
  var rowId = seed.rows[0].id;
  var comments = function (tag, list) {
    return list.map(function (url, i) {
      return { id: 'c-perf-' + tag + '-' + i, rowId: rowId, field: 'audioText', anchorId: null, quotedText: '', author: 'Perf',
        body: 'Reference frame ' + (i + 1) + '<br><img src="' + url + '">', resolved: false, resolvedBy: null, resolvedAt: null,
        assignee: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', kind: 'anchor', replies: [] };
    });
  };
  var withComments = function (list) { var s = F.clone(seed); s.comments = s.comments.concat(list); return s; };
  var fileOf = function (s) { return new File([F.buildSplitpage(s)], 'perf-images.splitpage', { type: 'application/json' }); };
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var frame = function () { return new Promise(function (r) { requestAnimationFrame(function () { setTimeout(r, 0); }); }); };
  var shasOf = function (s) {
    var seen = {};
    (JSON.stringify(s.comments).match(/[0-9a-f]{64}/g) || []).forEach(function (x) { seen[x] = true; });
    return Object.keys(seen);
  };
  var durable = async function (shas) {
    var until = performance.now() + 20000;
    while (!shas.every(function (sha) { return B.isDurableSync(sha); })) {
      if (performance.now() > until) return false;
      await wait(50);
    }
    return true;
  };
  var trial = function (o) { return 'TRIAL ' + JSON.stringify(o); };
  var api = {
    open: async function () {
      var file = fileOf(withComments(comments('o' + next, urls())));
      await frame();
      var t = performance.now();
      var ok = await F.openFile(file);
      await frame();
      var ms = performance.now() - t;
      var st = F.state(), shas = shasOf(st);
      var sets = JSON.parse(sessionStorage.getItem('perfShas') || '[]');
      sets.push(shas);
      sessionStorage.setItem('perfShas', JSON.stringify(sets));
      return trial({ label: 'images open', ms: +ms.toFixed(1), opened: ok === true, comments: st.comments.length - seed.comments.length, pictures: shas.length,
        held: shas.filter(function (sha) { return B.has(sha); }).length, durable: await durable(shas),
        inline: JSON.stringify(st.comments).indexOf('data:image') !== -1 });
    },
    load: async function (index) {
      var shas = JSON.parse(sessionStorage.getItem('perfShas'))[index];
      await B.backendInfo();
      var before = shas.filter(function (sha) { return B.has(sha); }).length;
      var t = performance.now();
      var missing = await B.ensureBytes(shas);
      var ms = performance.now() - t;
      return trial({ label: 'images load from IndexedDB', ms: +ms.toFixed(1), pictures: shas.length, before: before, missing: missing.length,
        held: shas.filter(function (sha) { return B.has(sha); }).length });
    },
    merge: async function () {
      await F.openFile(fileOf(seed));
      H.setSession({ docId: 'perf-doc', rev: 1 });
      var st = F.state();
      F.migrate(withComments(comments('m' + next, urls()))).comments.forEach(function (c) { if (c.id.indexOf('c-perf-') === 0) st.comments.push(c); });
      var theirs = withComments(comments('t' + next, urls()));
      var wanted = st.comments.length + COUNT;
      var shas = shasOf(st);
      var answer = { state: theirs, rev: 2, updatedBy: 'Perf' };
      window.fetch = function (url) {
        var body = String(url).indexOf('api/docs/perf-doc') !== -1 ? answer : {};
        return Promise.resolve({ status: 200, ok: true, redirected: false, headers: { get: function () { return 'application/json'; } },
          json: function () { return Promise.resolve(body); } });
      };
      var settled = await durable(shas);
      await frame();
      var t = performance.now();
      H.noteRev({ docId: 'perf-doc', rev: 2 });
      while (F.state().comments.length < wanted && performance.now() - t < 25000) await wait(0);
      await frame();
      var ms = performance.now() - t;
      var after = F.state(), merged = shasOf(after);
      return trial({ label: 'images merge', ms: +ms.toFixed(1), comments: after.comments.length - seed.comments.length, pictures: merged.length,
        held: merged.filter(function (sha) { return B.has(sha); }).length, durable: settled,
        inline: JSON.stringify(after.comments).indexOf('data:image') !== -1 });
    },
    pictures: urls,
    quiet: function () { if (F.autosave.enabled()) F.autosave.toggle(); return 'autosave ' + F.autosave.enabled(); }
  };
  window.__perfImg = api;
  return 'ready';
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

function imageSuite() {
  const inject = ["goto /index.html", "sleep 2500", `eval ${oneLine(IMAGES)}`];
  const lines = ["open", "viewport 1400 900", "sleep 2000", `eval ${oneLine(IMAGES)}`, "eval window.__perfImg.quiet()", `eval ${oneLine(ENVIRONMENT)}`];
  for (let i = 0; i < IMAGE_TRIALS; i++) lines.push("eval window.__perfImg.open()", "sleep 500");
  for (let i = 0; i < IMAGE_TRIALS; i++) lines.push(...inject, `eval window.__perfImg.load(${i})`);
  lines.push(...inject);
  for (let i = 0; i < IMAGE_TRIALS; i++) lines.push("eval window.__perfImg.merge()", "sleep 2000");
  lines.push("expect document.querySelectorAll('#rows .row').length > 0");
  return lines.join("\n") + "\n";
}

export function suiteText(fixture) {
  if (fixture === "images") return imageSuite();
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

export function parseTrials(stdout) {
  return stdout.split("\n").filter((l) => l.startsWith("TRIAL ")).map((l) => JSON.parse(l.slice(6)));
}

const IMAGE_CASES = [
  { label: "images open", pictures: PICTURES, comments: PICTURES },
  { label: "images load from IndexedDB", pictures: PICTURES, comments: undefined },
  { label: "images merge", pictures: 2 * PICTURES, comments: 2 * PICTURES }
];

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function imageProblems(trials) {
  const problems = [];
  for (const spec of IMAGE_CASES) {
    const mine = trials.filter((t) => t.label === spec.label);
    if (mine.length !== IMAGE_TRIALS) problems.push(`${spec.label}: ${mine.length} of ${IMAGE_TRIALS} trials`);
    for (const t of mine) {
      const bad = [];
      if (!(t.ms > 0)) bad.push("no time");
      if (t.pictures !== spec.pictures) bad.push(`${t.pictures} pictures, expected ${spec.pictures}`);
      if (spec.comments !== undefined && t.comments !== spec.comments) bad.push(`${t.comments} comments, expected ${spec.comments}`);
      if (t.label === "images load from IndexedDB") {
        if (t.before !== 0) bad.push(`${t.before} pictures were in memory before the load`);
        if (t.missing !== 0 || t.held !== t.pictures) bad.push(`${t.missing} pictures did not load`);
      } else {
        if (t.held !== t.pictures) bad.push(`${t.held} of ${t.pictures} pictures in the registry`);
        if (t.inline !== false) bad.push("a picture stayed inline");
        if (t.durable !== true) bad.push("the pictures were not stored in time");
      }
      if (t.label === "images open" && t.opened !== true) bad.push("the file did not open");
      if (bad.length) problems.push(`${spec.label}: ${bad.join("; ")}`);
    }
  }
  return problems;
}

export function imageRows(trials) {
  return IMAGE_CASES.map((spec) => {
    const times = trials.filter((t) => t.label === spec.label).map((t) => t.ms);
    return times.length ? { label: spec.label, pictures: spec.pictures, trials: times, first: times[0], median: median(times) } : null;
  }).filter(Boolean);
}

function cpuTimes() {
  return cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + Object.values(c.times).reduce((x, y) => x + y, 0) }), { idle: 0, total: 0 });
}

export function busyPercent(from, to) {
  const total = to.total - from.total;
  return total > 0 ? Math.round(100 * (1 - (to.idle - from.idle) / total)) : 0;
}

function sampleBusy(ms) {
  const from = cpuTimes();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  return busyPercent(from, cpuTimes());
}

function machine() {
  const c = cpus();
  return { platform: `${platform()} ${release()} ${arch()}`, cpu: `${c[0]?.model ?? "unknown"} x${c.length}`, memoryGb: +(totalmem() / 2 ** 30).toFixed(1), node: process.version };
}

export function report(results, env, when) {
  const rows = results.filter((r) => r.keys !== undefined);
  const exports = results.filter((r) => r.label.endsWith("export"));
  const browsers = results.filter((r) => r.label === "environment");
  const images = results.filter((r) => r.trials !== undefined);
  const scenes = (fixture) => browsers.find((b) => b.fixture === fixture)?.scenes;
  const fixtureLines = [
    scenes("short") !== undefined ? `short is the seed script (${scenes("short")} scenes)` : null,
    scenes("long") !== undefined ? `long is the long demo (${scenes("long")} scenes)` : null,
    images.length ? `images is the seed script with ${PICTURES} comments, each holding a fresh ${PICTURE_BYTES / 1024 / 1024} MiB PNG (a 1x1 image with a private chunk of random bytes)` : null
  ].filter(Boolean);
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
    ...(env.busy ? [`- Machine load: ${env.busy.before}% of the CPU busy in the second before the run and ${env.busy.after}% in the second after it`] : []),
    `- Fixtures: ${fixtureLines.join("; ")}`,
    ...(rows.length ? [`- Typing: ${TYPED.length} characters, one real key event every ${KEY_GAP_MS} ms, into scene 2's audio cell; latency is key-down to the frame after it`] : []),
    "",
    ...(rows.length ? [
      "## Input latency (ms)",
      "",
      "| Case | Keys | p50 | p95 | Max | Long tasks | Long-task ms |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...rows.map((r) => `| ${r.label} | ${r.keys} | ${r.p50 ?? "—"} | ${r.p95 ?? "—"} | ${r.max ?? "—"} | ${r.longTasks} | ${r.longTaskMs} |`),
      ""
    ] : []),
    ...(exports.length ? [
      `## Export (median of ${EXPORT_RUNS} runs, ms)`,
      "",
      "| Fixture | .splitpage | .md project | Standalone HTML |",
      "| --- | --- | --- | --- |",
      ...exports.map((r) => `| ${r.label.replace(" export", "")} | ${r.splitpage} | ${r.markdown} | ${r.standaloneHtml} |`),
      "",
      ".docx, PDF, CSV and .xlsx have no page hook to time them by and are not measured.",
      ""
    ] : []),
    ...(images.length ? [
      `## Image-heavy load and merge (${IMAGE_TRIALS} trials each, ms)`,
      "",
      "Each trial uses pictures no earlier trial has seen. Open is `openFile` on a .splitpage whose comment bodies hold the pictures as data URLs, until the frame after it. Load from IndexedDB is `ensureBytes` for the pictures of an earlier open, on a freshly loaded page, so the registry reads them back from the store. Merge is a hosted pull of a document that adds ten new pictures, into a document that added ten others (`noteRev`, fetch stubbed to answer from memory), until the frame after it.",
      "",
      "| Case | Pictures | Trials | First | Median |",
      "| --- | --- | --- | --- | --- |",
      ...images.map((r) => `| ${r.label} | ${r.pictures} | ${r.trials.join(", ")} | ${r.first} | ${r.median} |`),
      ""
    ] : [])
  ];
  return lines.join("\n");
}

export function parseArgs(argv) {
  const rest = [];
  let only = FIXTURES;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only") only = (argv[++i] ?? "").split(",").filter(Boolean);
    else rest.push(argv[i]);
  }
  const unknown = only.filter((f) => !FIXTURES.includes(f));
  return { out: rest[0] ? resolve(rest[0]) : null, only, error: unknown.length || !only.length ? `unknown fixture ${unknown.join(", ") || "(none given)"}; use ${FIXTURES.join(", ")}` : null };
}

export function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    console.error(`perf-record: ${args.error}`);
    return 2;
  }
  const out = args.out;
  if (!existsSync(join(REPO, "index.html"))) {
    console.error("perf-record: index.html is not built; run `node build.mjs` first");
    return 2;
  }
  const work = mkdtempSync(join(tmpdir(), "splitpage-perf-"));
  const results = [];
  const busyBefore = sampleBusy(1000);
  for (const fixture of args.only) {
    const suite = join(work, `${fixture}.txt`);
    writeFileSync(suite, suiteText(fixture));
    const r = spawnSync(process.execPath, [DRIVER, "--script", suite, "--port", String(PORT_BASE), "--cdp-port", String(PORT_BASE + 1000), "--shot-dir", work], {
      cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60 * 1000
    });
    const stdout = r.stdout ?? "";
    const found = parsePerf(stdout).map((p) => ({ ...p, fixture }));
    const trials = fixture === "images" ? parseTrials(stdout) : [];
    const problems = fixture === "images" ? imageProblems(trials) : [];
    if (r.status !== 0 || found.length !== EXPECTED_PERF[fixture] || problems.length) {
      console.error(stdout.split("\n").filter((l) => !l.startsWith("pressed") && !l.startsWith("TRIAL ")).slice(-30).join("\n"));
      console.error((r.stderr ?? "").split("\n").slice(-20).join("\n"));
      problems.forEach((p) => console.error(`perf-record: ${p}`));
      console.error(`perf-record: the ${fixture} run failed (exit ${r.status ?? r.signal}, ${found.length} of ${EXPECTED_PERF[fixture]} measurements)`);
      rmSync(work, { recursive: true, force: true });
      return 1;
    }
    results.push(...found, ...imageRows(trials));
  }
  const busyAfter = sampleBusy(1000);
  const text = report(results, { ...machine(), busy: { before: busyBefore, after: busyAfter } }, new Date().toISOString().slice(0, 10));
  if (out) writeFileSync(out, text);
  console.log(text);
  rmSync(work, { recursive: true, force: true });
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

