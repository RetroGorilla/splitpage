import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { createPdfPrinter, PDF_OPTIONS, PRINT_CSP, PRINT_ORIGIN, PRINT_PARTITION } = require(path.join(here, "..", "print-pdf.js"));

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const PAGE = "<!doctype html><title>Script</title><h1>Script</h1>";
const PDF = Buffer.from("%PDF-1.7 printed");

function world(behave = {}) {
  const app = new EventEmitter();
  const views = [];
  const partitions = [];
  let handler = null;
  let filter = null;
  let permissionRequest = null;
  let permissionCheck = null;
  const ses = {
    protocol: { handle: (scheme, fn) => { assert.equal(scheme, "splitpage"); handler = fn; } },
    webRequest: { onBeforeRequest: (fn) => { filter = fn; } },
    setPermissionRequestHandler: (fn) => { permissionRequest = fn; },
    setPermissionCheckHandler: (fn) => { permissionCheck = fn; }
  };
  const session = { fromPartition: (name, options) => { partitions.push({ name, options }); return ses; } };
  function WebContentsView(options) {
    const contents = new EventEmitter();
    let destroyed = false;
    const view = { options, webContents: contents, loaded: null, printed: null, served: null, opened: null };
    contents.isDestroyed = () => destroyed;
    contents.close = () => { destroyed = true; contents.emit("destroyed"); };
    contents.setWindowOpenHandler = (fn) => { view.opened = fn; };
    contents.loadURL = async (url) => {
      view.loaded = url;
      const response = await handler({ url });
      view.served = { status: response.status, csp: response.headers.get("content-security-policy"), text: await response.text() };
      if (behave.load) return behave.load(view);
    };
    contents.executeJavaScript = async () => (behave.ready ? behave.ready(view) : true);
    contents.printToPDF = async (opts) => {
      view.printed = opts;
      if (behave.print) return behave.print(view);
      return PDF;
    };
    views.push(view);
    return view;
  }
  const printer = createPdfPrinter({ app, session, WebContentsView, timeoutMs: behave.timeoutMs || 1000, maxChars: 1000 });
  const owner = new EventEmitter();
  return {
    app, printer, owner, views, partitions,
    serve: (url) => handler({ url }),
    allowed: (url) => new Promise((resolve) => filter({ url }, (answer) => resolve(!answer.cancel))),
    permissions: () => [new Promise((resolve) => permissionRequest({}, "media", resolve)), permissionCheck({}, "media")]
  };
}

test("a print page becomes the PDF Electron prints, from a sandboxed view in its own in-memory partition", async () => {
  const w = world();
  const pdf = await w.printer.print(w.owner, PAGE);
  assert.equal(pdf, PDF);
  assert.deepEqual(w.partitions, [{ name: PRINT_PARTITION, options: { cache: false } }]);
  assert.equal(PRINT_PARTITION.startsWith("persist:"), false);
  const view = w.views[0];
  assert.match(view.loaded, new RegExp("^" + PRINT_ORIGIN + "/[0-9a-f]{32}\\.html$"));
  assert.deepEqual(view.served, { status: 200, csp: PRINT_CSP, text: PAGE });
  const prefs = view.options.webPreferences;
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.webSecurity, true);
  assert.equal("preload" in prefs, false);
  assert.deepEqual({ ...view.printed }, { preferCSSPageSize: true, printBackground: true, generateDocumentOutline: true, generateTaggedPDF: true });
  assert.equal(Object.isFrozen(PDF_OPTIONS), true);
});

test("after printing, the view is closed and the page is no longer served", async () => {
  const w = world();
  await w.printer.print(w.owner, PAGE);
  const view = w.views[0];
  assert.equal(view.webContents.isDestroyed(), true);
  assert.equal((await w.serve(view.loaded)).status, 404);
  assert.equal(await w.allowed(view.loaded), false);
  assert.equal(w.printer.openJobs(), 0);
  assert.equal(w.owner.listenerCount("destroyed"), 0);
});

test("the print partition serves only the page being printed and data: pictures, and grants no permission", async () => {
  let seen = null;
  const w = world({ load: async (view) => { seen = { page: await w.allowed(view.loaded), picture: await w.allowed("data:image/png;base64,AA==") }; } });
  await w.printer.print(w.owner, PAGE);
  assert.deepEqual(seen, { page: true, picture: true });
  for (const url of ["https://example.com/a.png", "file:///C:/Windows/win.ini", "splitpage://app/index.html", PRINT_ORIGIN + "/other.html"]) {
    assert.equal(await w.allowed(url), false, url);
    assert.equal((await w.serve(url)).status, 404, url);
  }
  const [asked, checked] = w.permissions();
  assert.equal(await asked, false);
  assert.equal(checked, false);
  assert.deepEqual(w.views[0].opened({ url: "https://example.com/" }), { action: "deny" });
  const navigation = { prevented: false, preventDefault() { this.prevented = true; } };
  w.views[0].webContents.emit("will-navigate", navigation, "https://example.com/");
  assert.equal(navigation.prevented, true);
});

test("a request that is not a nonempty string within the size limit is refused before any view exists", async () => {
  const w = world();
  for (const bad of [undefined, null, "", 42, { html: PAGE }, new Uint8Array(4), "x".repeat(1001)]) {
    await assert.rejects(w.printer.print(w.owner, bad), /empty or too large/);
  }
  assert.equal(w.views.length, 0);
  assert.equal(w.partitions.length, 0);
  assert.ok(await w.printer.print(w.owner, "x".repeat(1000)));
});

test("a picture that did not load fails the print and cleans up", async () => {
  const w = world({ ready: () => false });
  await assert.rejects(w.printer.print(w.owner, PAGE), /picture could not be prepared/);
  assert.equal(w.views[0].printed, null);
  assert.equal(w.views[0].webContents.isDestroyed(), true);
  assert.equal(w.printer.openJobs(), 0);
});

test("Electron failing to load or print rejects and cleans up", async () => {
  for (const behave of [{ load: () => { throw new Error("ERR_ABORTED"); } }, { print: () => { throw new Error("print failed"); } }]) {
    const w = world(behave);
    await assert.rejects(w.printer.print(w.owner, PAGE), /ERR_ABORTED|print failed/);
    assert.equal(w.views[0].webContents.isDestroyed(), true);
    assert.equal((await w.serve(w.views[0].loaded)).status, 404);
    assert.equal(w.printer.openJobs(), 0);
  }
});

test("the asking tab closing mid-print cancels it and cleans up", async () => {
  let release;
  const w = world({ print: () => new Promise((resolve) => { release = resolve; }) });
  const pending = w.printer.print(w.owner, PAGE);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(w.printer.openJobs(), 1);
  w.owner.emit("destroyed");
  await assert.rejects(pending, /has closed/);
  assert.equal(w.views[0].webContents.isDestroyed(), true);
  assert.equal(w.printer.openJobs(), 0);
  release(PDF);
});

test("a page that never finishes preparing times out and cleans up", async () => {
  const w = world({ timeoutMs: 20, ready: () => new Promise(() => {}) });
  await assert.rejects(w.printer.print(w.owner, PAGE), /took too long/);
  assert.equal(w.views[0].webContents.isDestroyed(), true);
  assert.equal(w.printer.openJobs(), 0);
});

test("a crashed print renderer fails the print and cleans up", async () => {
  const w = world({ ready: (view) => { view.webContents.emit("render-process-gone", {}, { reason: "crashed" }); return new Promise(() => {}); } });
  await assert.rejects(w.printer.print(w.owner, PAGE), /stopped/);
  assert.equal(w.views[0].webContents.isDestroyed(), true);
});

test("quitting cancels every open print and refuses new ones", async () => {
  const w = world({ print: () => new Promise(() => {}) });
  const first = w.printer.print(w.owner, PAGE);
  const second = w.printer.print(new EventEmitter(), PAGE);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(w.printer.openJobs(), 2);
  w.app.emit("will-quit");
  await assert.rejects(first, /cancelled/);
  await assert.rejects(second, /cancelled/);
  assert.ok(w.views.every((view) => view.webContents.isDestroyed()));
  assert.equal(w.printer.openJobs(), 0);
  await assert.rejects(w.printer.print(w.owner, PAGE), /quitting/);
  assert.equal(w.views.length, 2);
});

test("an open print holds its view, so collecting garbage cannot stop the page mid-load", async () => {
  v8.setFlagsFromString("--expose-gc");
  const collect = vm.runInNewContext("gc");
  const app = new EventEmitter();
  const refs = [];
  const ses = { protocol: { handle() {} }, webRequest: { onBeforeRequest() {} }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} };
  function WebContentsView() {
    const contents = new EventEmitter();
    contents.isDestroyed = () => false;
    contents.close = () => {};
    contents.setWindowOpenHandler = () => {};
    contents.loadURL = () => new Promise(() => {});
    const view = { webContents: contents };
    refs.push(new WeakRef(view));
    return view;
  }
  const printer = createPdfPrinter({ app, session: { fromPartition: () => ses }, WebContentsView, timeoutMs: 60000 });
  const pending = printer.print(new EventEmitter(), PAGE);
  for (let i = 0; i < 3; i++) { await new Promise((resolve) => setImmediate(resolve)); collect(); }
  assert.ok(refs[0].deref(), "the view is still alive while its print is open");
  app.emit("will-quit");
  await assert.rejects(pending, /cancelled/);
});

test("two prints at once each get their own view and page address", async () => {
  const w = world();
  const [a, b] = await Promise.all([w.printer.print(w.owner, PAGE), w.printer.print(w.owner, PAGE + "<p>2</p>")]);
  assert.equal(a, PDF);
  assert.equal(b, PDF);
  assert.notEqual(w.views[0].loaded, w.views[1].loaded);
  assert.equal(w.views[1].served.text, PAGE + "<p>2</p>");
  assert.equal(w.partitions.length, 1);
});

let failed = 0;
for (const c of cases) {
  try { await c.fn(); console.log("ok   " + c.name); } catch (e) { failed++; console.log("FAIL " + c.name + "\n     " + (e && e.stack || e)); }
}
if (failed) { console.log(failed + " FAILED"); process.exit(1); }
console.log("ALL PASS (" + cases.length + ")");
