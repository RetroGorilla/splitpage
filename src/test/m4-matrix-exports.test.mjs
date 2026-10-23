import { bootApp, closeApp } from "./_app-boot.mjs";
import { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { createGates, createHeldFetch, mockClock, rightToday } from "./_m4-matrix.mjs";

await bootApp();
after(closeApp);

const { LONG_DEMO } = await import("../js/_starters.js");
const { migrateRows } = await import("../js/02-state.js");
const { blobStore, createMemoryBackend, intern, setBackend } = await import("../adapters/storage/02c-blobs.js");
const { brollShotListForPrint } = await import("../js/08d-broll-panel.js");
const { confirmSavedNow } = await import("../legacy/save-bridge.ts");
const { flushEdits } = await import("../js/12a-undo.js");
const { captureExportDocument } = await import("../js/14b-export-kit.js");
const { exportAssetsNow } = await import("../adapters/formats/export-assets.ts");
const { buildDocx, buildNarrationDocx, buildNarrationText } = await import("../adapters/formats/docx.ts");
const { narrationIncludesDirections, setNarrationIncludesDirections } = await import("../bootstrap/wiring/exporters.ts");
const { buildBreakdownCsv, buildBrollCsv, buildCsv } = await import("../adapters/formats/csv.ts");
const { buildBreakdownXlsx, buildBrollXlsx, buildScriptXlsx } = await import("../adapters/formats/xlsx.ts");
const { buildPackingListPdf, buildPdf, buildShotListPdf } = await import("../adapters/formats/pdf.ts");
const { buildFileData } = await import("../js/18-local-files.js");
const homeModule = await import("../legacy/location-bridge.ts");
const hosted = await import("../js/13-hosted.js");
const { loadTestDocument } = await import("./_document.mjs");

const KINDS = [
  "docx", "csv", "breakdown", "b-roll csv", "xlsx", "breakdown xlsx", "b-roll xlsx", "b-roll pdf", "pdf", "txt",
  "narration-docx", "narration-txt", "packing-gear", "packing-prop", "md-table", "html", "md"
];

const DATED = ["docx", "xlsx", "breakdown xlsx", "b-roll xlsx", "b-roll pdf", "pdf", "narration-docx", "packing-gear", "packing-prop"];

function demo() {
  return migrateRows(JSON.parse(JSON.stringify(LONG_DEMO.state)));
}

function useDocument(doc) {
  loadTestDocument(doc);
  flushEdits();
  confirmSavedNow();
  return doc;
}

function mutateLive() {
  const s = S.state;
  s.title = "A different title";
  s.wordsPerMinute = 90;
  s.targetSeconds = 61;
  s.rows.forEach((row, i) => {
    row.audioText = "Changed audio " + i + ". " + row.audioText;
    row.visualText = "Changed visual " + i + ". " + row.visualText;
    row.status = i % 2 ? "todo" : "shot";
  });
  s.rows.pop();
  s.comments.forEach((c) => { c.author = "Someone Else"; c.resolved = !c.resolved; });
  s.productionTags.forEach((tag) => { if (tag) tag.status = tag.status === "have" ? "needed" : "have"; });
  s.brollShots.forEach((shot) => { shot.note = "changed after capture"; shot.name = shot.name + " (edited)"; });
  s.people.forEach((p) => { p.name = p.name + " Jr"; });
  setNarrationIncludesDirections(!narrationIncludesDirections());
}

function bytesOf(data) {
  return typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function sameBytes(a, b, message) {
  assert.ok(bytesOf(a).equals(bytesOf(b)), message);
}

function liveJson() {
  return JSON.stringify(S.state);
}

const BROLL_VIEW = { filter: "all", group: "scene" };

const WRITERS = [
  ["X6", "buildDocx", (doc) => buildDocx(doc, exportAssetsNow(doc))],
  ["X7", "buildNarrationDocx", (doc) => buildNarrationDocx(doc, { directions: true })],
  ["X8", "buildNarrationText", (doc) => buildNarrationText(doc, { directions: false })],
  ["X9", "buildCsv", (doc) => buildCsv(doc)],
  ["X10", "buildScriptXlsx", (doc) => buildScriptXlsx(doc)],
  ["X11", "buildBreakdownXlsx", (doc) => buildBreakdownXlsx(doc)],
  ["X12", "buildBrollXlsx", (doc) => buildBrollXlsx(doc)],
  ["X13", "buildPdf", (doc) => buildPdf(doc, null, null)],
  ["X14", "buildBreakdownCsv", (doc) => buildBreakdownCsv(doc)],
  ["X15", "buildBrollCsv", (doc) => buildBrollCsv(doc)],
  ["X16", "buildShotListPdf", (doc) => buildShotListPdf(doc, brollShotListForPrint(doc, BROLL_VIEW))],
  ["X17", "buildPackingListPdf", (doc) => buildPackingListPdf(doc, "prop")]
];

WRITERS.forEach(([id, name, serialize]) => {
  rightToday(id, name + " gives the captured bytes after the live document changed", async (t) => {
    mockClock(t);
    useDocument(demo());
    const before = serialize(captureExportDocument());
    const captured = captureExportDocument();
    mutateLive();
    const mutated = liveJson();
    assert.ok(!bytesOf(serialize(captureExportDocument())).equals(bytesOf(before)), "the mutation shows in the live bytes, so the case can tell");
    sameBytes(serialize(captured), before, "the captured document gives the captured bytes");
    assert.equal(liveJson(), mutated, "serializing the capture left the live document as it was");
  });
});

rightToday("X18", "every export route builds from the one capture taken before its first await, and leaves the live document as it was", async (t) => {
  mockClock(t);
  const changed = [];
  for (const kind of KINDS) {
    const opts = { allowImageBundle: true };
    const directions = narrationIncludesDirections();
    useDocument(demo());
    const reference = await buildFileData(kind, "export", opts);
    setNarrationIncludesDirections(directions);
    useDocument(demo());
    const building = buildFileData(kind, "export", opts);
    mutateLive();
    const mutated = liveJson();
    const built = await building;
    assert.equal(liveJson(), mutated, kind + ": the export left the live document as it was");
    sameBytes(built.data, reference.data, kind + ": the export gives the bytes of the document as it was when asked");
    assert.equal(built.filename, reference.filename, kind + ": the file name is the requested one");
    const live = await buildFileData(kind, "export", opts);
    if (!bytesOf(live.data).equals(bytesOf(reference.data))) changed.push(kind);
    setNarrationIncludesDirections(directions);
  }
  assert.deepEqual(changed, KINDS, "the mutation shows in a fresh export of every kind, so the case can tell");
});

const jpegBytes = (w, h, salt) => new Uint8Array([0xFF, 0xD8, 0xFF, 0xC0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, salt || 0, 0xFF, 0xD9]);

function pngBytes(width, height, salt) {
  const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52,
    ...be32(width), ...be32(height), 8, 6, 0, 0, 0, ...be32(salt || 0), ...be32(0), 0x49, 0x45, 0x4e, 0x44
  ]);
}

function picturedScript(refs) {
  return migrateRows({
    schema: 5, title: "Pictures", docId: "d" + "7".repeat(32),
    rows: [
      { id: "r1", visualText: "Wide", audioText: "One.", status: "todo", imageRef: refs.row, moreImages: [{ imageRef: refs.more }] },
      { id: "r2", visualText: "Close", audioText: "Two.", status: "todo" }
    ],
    comments: [{
      id: "c1", rowId: "r1", field: "audioText", author: "Ann", createdAt: "2026-10-01T10:00:00.000Z", replies: [],
      body: 'See <img class="comment-img" data-blob="' + refs.comment.sha256 + '" data-w="40" data-h="30" data-mime="' + refs.comment.mime + '">'
    }]
  });
}

function heldBackend(gates, kept) {
  const inner = createMemoryBackend();
  const reads = [];
  return {
    reads: reads,
    fill: async function (pictures) {
      for (const p of pictures) await inner.put(p.ref.sha256, p.bytes, p.ref.mime);
    },
    backend: {
      name: "held",
      persistent: false,
      get: async function (sha) {
        reads.push(sha);
        await gates.pass("blob.get", sha);
        return kept() ? inner.get(sha) : null;
      },
      put: function (sha, bytes, mime) { return inner.put(sha, bytes, mime); },
      missing: function (shas) { return inner.missing(shas); }
    }
  };
}

function freshPicture(make, w, h, salt) {
  const bytes = make(w, h, salt);
  return { bytes: bytes, ref: intern(bytes) };
}

async function withHeldStore(run) {
  const gates = createGates();
  const held = heldBackend(gates, () => true);
  try {
    await run({ gates: gates, held: held });
  } finally {
    gates.releaseAll("blob.get");
    setBackend(createMemoryBackend());
  }
}

function swapPictures(replacement) {
  S.state.rows[0].imageRef = replacement.ref;
  S.state.rows[0].moreImages = [];
  S.state.comments[0].body = "No picture now";
}

rightToday("X19", "an export whose local picture reads are held keeps the captured pictures and their places when the document, connection and pictures change", async (t) => {
  mockClock(t);
  for (const kind of ["docx", "md", "md-table", "html"]) {
    await withHeldStore(async ({ gates, held }) => {
      const row = freshPicture(jpegBytes, 300, 200, 31);
      const more = freshPicture(jpegBytes, 200, 300, 32);
      const comment = freshPicture(jpegBytes, 40, 30, 33);
      const replacement = freshPicture(jpegBytes, 120, 90, 34);
      const doc = picturedScript({ row: row.ref, more: more.ref, comment: comment.ref });
      useDocument(doc);
      const reference = await buildFileData(kind, "pictures", { allowImageBundle: true });
      await held.fill([row, more, comment]);
      setBackend(held.backend);
      blobStore.forgetMemory();
      intern(replacement.bytes);
      useDocument(picturedScript({ row: row.ref, more: more.ref, comment: comment.ref }));
      gates.hold("blob.get", { times: 99 });
      const building = buildFileData(kind, "pictures", { allowImageBundle: true });
      await gates.arrived("blob.get");
      mutateLive();
      swapPictures(replacement);
      homeModule.documentLocation().setConnection({ serverUrl: "http://elsewhere.test/", token: "t-other", role: "edit" });
      const replaced = liveJson();
      gates.releaseAll("blob.get");
      const built = await building;
      homeModule.documentLocation().setConnection({});
      assert.deepEqual(held.reads.slice().sort(), [row.ref.sha256, more.ref.sha256, comment.ref.sha256].sort(), kind + ": the held reads were for the captured pictures");
      sameBytes(built.data, reference.data, kind + ": the export holds the captured pictures where they were");
      assert.equal(liveJson(), replaced, kind + ": the replacement document is as it was left");
      assert.equal(S.state.rows[0].imageRef.sha256, replacement.ref.sha256, kind + ": the live row keeps its new picture");
    });
  }
});

function fakeDecoder(gates, out) {
  const RealImage = globalThis.Image;
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  const proto = window.HTMLCanvasElement.prototype;
  const realContext = proto.getContext;
  const realToBlob = proto.toBlob;
  const blobs = new Map();
  const decoded = [];
  let n = 0;
  URL.createObjectURL = (blob) => { const url = "blob:decode/" + (++n); blobs.set(url, blob); return url; };
  URL.revokeObjectURL = () => {};
  class FakeImage {
    set src(url) {
      const blob = blobs.get(url);
      blob.arrayBuffer().then(async (ab) => {
        decoded.push(new Uint8Array(ab));
        await gates.pass("decode", url);
        this.naturalWidth = 40;
        this.naturalHeight = 30;
        this.onload();
      });
    }
  }
  globalThis.Image = FakeImage;
  window.Image = FakeImage;
  proto.getContext = function () { return { fillRect() {}, drawImage() {}, fillStyle: "" }; };
  proto.toBlob = function (cb) { cb(new Blob([out])); };
  return {
    decoded: decoded,
    restore: function () {
      globalThis.Image = RealImage;
      window.Image = RealImage;
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
      proto.getContext = realContext;
      proto.toBlob = realToBlob;
    }
  };
}

rightToday("X20", "a PDF whose picture decoding is held prints the captured pictures in their captured places when the document and pictures change", async (t) => {
  mockClock(t);
  const gates = createGates();
  const decoder = fakeDecoder(gates, jpegBytes(40, 30, 77));
  try {
    const row = freshPicture(pngBytes, 40, 30, 41);
    const more = freshPicture(pngBytes, 40, 30, 42);
    const comment = freshPicture(pngBytes, 40, 30, 43);
    const replacement = freshPicture(pngBytes, 40, 30, 44);
    useDocument(picturedScript({ row: row.ref, more: more.ref, comment: comment.ref }));
    const reference = await buildFileData("pdf", "pictures");
    const asked = decoder.decoded.length;
    useDocument(picturedScript({ row: row.ref, more: more.ref, comment: comment.ref }));
    gates.hold("decode", { times: 99 });
    const building = buildFileData("pdf", "pictures");
    await gates.arrived("decode");
    mutateLive();
    swapPictures(replacement);
    const replaced = liveJson();
    gates.releaseAll("decode");
    const built = await building;
    const late = decoder.decoded.slice(asked).map((b) => Buffer.from(b).toString("hex")).sort();
    assert.deepEqual(late, [row.bytes, more.bytes, comment.bytes].map((b) => Buffer.from(b).toString("hex")).sort(), "the held decodes were of the captured pictures");
    sameBytes(built.data, reference.data, "the PDF holds the captured pictures where they were");
    assert.ok(Buffer.from(built.data).toString("latin1").includes("/Im3 Do"), "setup: the decoded pictures are drawn");
    assert.equal(liveJson(), replaced, "the replacement document is as it was left");
  } finally {
    gates.releaseAll("decode");
    decoder.restore();
  }
});

function blobServer(pictures) {
  const byHex = new Map(pictures.map((p) => [p.ref.sha256, p.bytes]));
  return function (r) {
    const m = /api\/blobs\/([0-9a-f]{64})$/.exec(r.url);
    if (m && r.method === "GET") return byHex.has(m[1]) ? { status: 200, bytes: byHex.get(m[1]), headers: { "content-type": "image/jpeg" } } : { status: 404, body: { error: "not-found" } };
    return { status: 404, body: { error: "no-such-route" } };
  };
}

rightToday("X21", "an export of a server document fetches its missing pictures from the server it was asked on, even when the tab moves to another server's document meanwhile", async (t) => {
  mockClock(t);
  const row = freshPicture(jpegBytes, 300, 200, 51);
  const more = freshPicture(jpegBytes, 200, 300, 52);
  const comment = freshPicture(jpegBytes, 40, 30, 53);
  const gates = createGates();
  const local = heldBackend(gates, () => false);
  const held = createHeldFetch({ connection: () => homeModule.currentConn(), answer: blobServer([row, more, comment]) });
  const uninstall = held.install();
  try {
    useDocument(picturedScript({ row: row.ref, more: more.ref, comment: comment.ref }));
    const reference = await buildFileData("docx", "pictures");
    hosted.pointTabAt("http://origin.test/");
    useDocument(picturedScript({ row: row.ref, more: more.ref, comment: comment.ref }));
    window.__hostedTest.setSession({ docId: "srv-pictures", rev: 1, blobs: true });
    await new Promise((resolve) => setImmediate(resolve));
    setBackend(local.backend);
    blobStore.forgetMemory();
    gates.hold("blob.get", { times: 99 });
    const building = buildFileData("docx", "pictures");
    await gates.arrived("blob.get");
    window.__hostedTest.pointTabAt("http://other.test/");
    useDocument(script("Elsewhere"));
    window.__hostedTest.setSession({ docId: "srv-elsewhere", rev: 1, blobs: true });
    const before = held.requests.length;
    gates.releaseAll("blob.get");
    const built = await building;
    const blobGets = held.requests.slice(before).filter((r) => r.url.includes("api/blobs/"));
    const asked = new Set(blobGets.map((r) => r.url.replace(/^.*api\/blobs\//, "")));
    assert.deepEqual([...asked].sort(), [row.ref.sha256, more.ref.sha256, comment.ref.sha256].sort(), "setup: the three pictures were fetched after the move");
    assert.deepEqual(blobGets.filter((r) => !r.url.startsWith("http://origin.test/")).map((r) => r.url), [], "every picture request went to the server the export was asked on");
    sameBytes(built.data, reference.data, "the export holds the pictures the original server sent, where they were");
  } finally {
    gates.releaseAll("blob.get");
    held.gates.releaseAll("fetch");
    uninstall();
    if (homeModule.currentHome().kind === "server") homeModule.setHome("none");
    hosted.pointTabAt("");
    homeModule.documentLocation().updateConnection({ token: "", role: "", scope: "" });
    setBackend(createMemoryBackend());
    confirmSavedNow();
  }
});

function script(title) {
  return migrateRows({
    schema: 5, title: title, docId: "d" + "8".repeat(32),
    rows: [{ id: "r1", visualText: "Wide", audioText: "One.", status: "todo" }]
  });
}

function localTime(y, m, d, h, min, s) {
  return new Date(y, m, d, h, min, s || 0).getTime();
}

rightToday("X22", "INV-60: every export captured at two times on one day is the same bytes, and one serialized after midnight keeps its captured day", async (t) => {
  const clock = mockClock(t, localTime(2026, 9, 14, 8, 5, 1));
  const undated = [];
  for (const kind of KINDS) {
    const opts = { allowImageBundle: true };
    useDocument(demo());
    const morning = await buildFileData(kind, "export", opts);
    t.mock.timers.setTime(localTime(2026, 9, 14, 23, 59, 59));
    const evening = await buildFileData(kind, "export", opts);
    sameBytes(evening.data, morning.data, kind + ": two captures on one day give the same bytes");
    const lateBuild = buildFileData(kind, "export", opts);
    clock.tick(2000);
    const late = await lateBuild;
    sameBytes(late.data, morning.data, kind + ": a capture serialized after midnight keeps its captured day");
    const nextDay = await buildFileData(kind, "export", opts);
    if (bytesOf(nextDay.data).equals(bytesOf(morning.data))) undated.push(kind);
    t.mock.timers.setTime(localTime(2026, 9, 14, 8, 5, 1));
  }
  assert.deepEqual(KINDS.filter((k) => !undated.includes(k)).filter((k) => DATED.includes(k)), DATED, "every dated format shows the next day's date, so the case can tell");
});
