import { deriveDocId } from "../../src/core/document/ids.ts";
import { dom } from "../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { productionReaders, withDocumentPorts } from "../../src/legacy/document-ports.ts";
import { STATE_FIELDS, migrateRows } from "../../src/js/02-state.js";
import * as state from "../../src/js/02-state.js";
import { loadInitialState, migrateDocument } from "../../src/js/02b-doc-id.js";
import { dataUrlForSync, has, inlineStateImages, recordFor, setBackend } from "../../src/adapters/storage/02c-blobs.js";
import { createHash } from "node:crypto";
import { mergeStates } from "../../src/js/03-sync.js";
import * as tags from "../../src/js/07-production-tags.js";
import { checksumText, seedCheckPasses } from "../../src/js/20b-onboarding.js";
import { S } from "../../src/js/_state.js";
import { image } from "../../src/test/golden-helpers.mjs";

type Put = { sha: string; interned: boolean };
type Doc = Record<string, unknown>;
type Item = Record<string, unknown>;

const puts: Put[] = [];
setBackend({
  name: "recorder",
  persistent: true,
  get: () => Promise.resolve(null),
  put: (sha: string) => {
    puts.push({ sha, interned: has(sha) });
    return Promise.resolve();
  },
  missing: (shas: string[]) => Promise.resolve(shas.slice())
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function settled(): Promise<Put[]> {
  await tick();
  await tick();
  return puts.splice(0);
}

test("a pass records its pictures, and interns then persists them once it ends, in the order first met", async () => {
  const a = image("png", 91, 3), b = image("gif", 92, 3);
  let during: boolean[] = [];
  const out = withDocumentPorts(STATE_FIELDS, (ports) => {
    const html = ports.sanitize('<img src="' + b.dataUrl + '"><img src="' + a.dataUrl + '"><img src="' + b.dataUrl + '">');
    during = [has(a.sha256), has(b.sha256), !!ports.images.known(a.sha256), recordFor(a.sha256) === null];
    return html;
  });
  assert.deepEqual(during, [false, false, true, true], "inside the pass the pictures are pending, not in the registry");
  assert.match(out, new RegExp('data-blob="' + b.sha256 + '"[^>]*>.*data-blob="' + a.sha256));
  assert.equal(has(a.sha256) && has(b.sha256), true);
  assert.deepEqual(recordFor(a.sha256), a.record);
  assert.deepEqual(await settled(), [{ sha: b.sha256, interned: true }, { sha: a.sha256, interned: true }]);
});

test("a pass leaves each picture in the registry as the bytes it decoded, under those bytes' own hash", async () => {
  const a = image("png", 98, 3), b = image("jpeg", 99, 3);
  withDocumentPorts(STATE_FIELDS, (ports) => ports.sanitize('<img src="' + a.dataUrl + '"><img src="' + b.dataUrl + '">'));
  for (const pic of [a, b]) {
    const held = Buffer.from((dataUrlForSync(pic.sha256) as string).split(",")[1] as string, "base64");
    assert.deepEqual(new Uint8Array(held), pic.bytes);
    assert.equal(createHash("sha256").update(held).digest("hex"), pic.sha256);
    assert.deepEqual(recordFor(pic.sha256), pic.record);
  }
  assert.deepEqual((await settled()).map((p) => p.sha), [a.sha256, b.sha256]);
});

test("a pass that throws still keeps the pictures it decoded", async () => {
  const c = image("jpeg", 93, 3);
  assert.throws(() => withDocumentPorts(STATE_FIELDS, (ports) => {
    ports.sanitize('<img src="' + c.dataUrl + '">');
    throw new Error("stop");
  }), /stop/);
  assert.equal(has(c.sha256), true);
  assert.deepEqual(await settled(), [{ sha: c.sha256, interned: true }]);
});

test("a save straight after a load finds every picture the load decoded", async () => {
  const row = image("png", 94, 3), body = image("webp", 95, 3), card = image("gif", 96, 3);
  const doc = migrateRows({
    schema: 2,
    rows: [{ id: "r1", audioText: "x", visualImage: row.dataUrl }],
    comments: [
      { id: "c1", rowId: "r1", body: '<img src="' + body.dataUrl + '">' },
      { id: "c2", rowId: "r1", kind: "conflict", field: "visualImage", body: '<img src="' + card.dataUrl + '">' }
    ]
  });
  assert.deepEqual(((doc.comments as Item[])[1] as Item).imageValue, card.record);
  const copy = JSON.parse(JSON.stringify(doc)) as Item;
  assert.deepEqual(inlineStateImages(copy), []);
  assert.equal(((copy.rows as Item[])[0] as Item).visualImage, row.dataUrl);
  assert.deepEqual((await settled()).map((p) => p.sha), [row.sha256, body.sha256, card.sha256]);
});

test("a pass looks a picture it did not decode up in the registry: a conflict card for a held picture takes its record", async () => {
  const held = image("png", 97, 3);
  migrateRows({ rows: [{ id: "r1", visualImage: held.dataUrl }] });
  await settled();
  const doc = migrateRows({
    schema: 2,
    rows: [],
    comments: [{ id: "c1", kind: "conflict", field: "visualImage", body: '<img class="comment-img" data-blob="' + held.sha256 + '">' }]
  });
  const card = (doc.comments as Item[])[0] as Item;
  assert.deepEqual(card.imageValue, held.record);
  assert.match(card.body as string, new RegExp('data-w="97" data-h="3" data-mime="image/png"'));
  assert.deepEqual(await settled(), []);
});

test("07 uses the document ports' tagsInField without re-exporting productionReaders", () => {
  assert.equal("productionReaders" in tags, false);
  assert.equal(tags.tagsInField, productionReaders.tagsInField);
});

test("02-state, 02b and 03-sync migrate with 02-state's own table, so a field pushed onto it is filled everywhere", () => {
  STATE_FIELDS.push({ key: "probe", def: () => 7, merge: "changed-side-wins", undo: true });
  try {
    assert.equal(migrateRows({}).probe, 7);
    assert.equal(migrateDocument({ rows: [] }, { kind: "file" }).probe, 7);
    const d = migrateRows({ rows: [] });
    const mine = JSON.parse(JSON.stringify(d)) as Item;
    mine.probe = 9;
    assert.equal(mergeStates(JSON.parse(JSON.stringify(d)), mine, JSON.parse(JSON.stringify(d))).merged.probe, 9);
  } finally {
    STATE_FIELDS.pop();
  }
});

function pageWith(stateText: string | null, seedCheck: string | null): void {
  const doc = dom.window.document;
  doc.head.innerHTML = seedCheck === null ? "" : '<meta name="splitpage-seed-check" content="' + seedCheck + '">';
  doc.body.innerHTML = "";
  if (stateText !== null) {
    const el = doc.createElement("script");
    el.id = "state-data";
    el.type = "application/json";
    el.textContent = stateText;
    doc.body.appendChild(el);
  }
}

test("loadInitialState lives in 02b: a saved page opens as its file, a pristine or unsaved one as a fresh document", async () => {
  assert.equal("loadInitialState" in state, false);
  const saved = JSON.stringify({ title: "Saved", rev: 3, rows: [{ id: "r1", audioText: "x" }] });
  pageWith(saved, null);
  const opened = await loadInitialState(seedCheckPasses()) as Doc;
  assert.equal(opened.title, "Saved");
  assert.equal(opened.docId, deriveDocId("splitpage-file", saved));
  assert.equal(S.docIdWrittenOut, true);

  pageWith(saved, saved.length + "-" + checksumText(saved));
  const pristine = await loadInitialState(seedCheckPasses()) as Doc;
  assert.equal(pristine.title, "Saved");
  assert.notEqual(pristine.docId, deriveDocId("splitpage-file", saved), "a pristine copy is not the file it came from");
  assert.equal(S.docIdWrittenOut, false);

  const editedOnly = JSON.stringify({ title: "Edited", lastEditedBy: "Ann", rows: [] });
  pageWith(editedOnly, null);
  const edited = await loadInitialState(seedCheckPasses()) as Doc;
  assert.equal(edited.docId, deriveDocId("splitpage-file", editedOnly), "a page someone edited is a saved file even at rev 0");
  assert.equal(S.docIdWrittenOut, true);

  const unsaved = JSON.stringify({ title: "Seed", rows: [] });
  pageWith(unsaved, null);
  const fresh = await loadInitialState(seedCheckPasses()) as Doc;
  assert.equal(fresh.title, "Seed");
  assert.equal(S.docIdWrittenOut, false);

  pageWith("{not json", null);
  const broken = await loadInitialState(seedCheckPasses()) as Doc;
  assert.equal(broken.title, "Untitled Script");
  assert.equal(S.docIdWrittenOut, false);

  pageWith(null, null);
  assert.equal((await loadInitialState(seedCheckPasses()) as Doc).title, "Untitled Script");
});
