import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { CLOCK_KEY, writePref } from "../js/00p-prefs.js";
import { __init as initSceneStatus } from "../js/01-scene-status.js";
import { migrateRows } from "../js/02-state.js";
import { blobStore, intern } from "../adapters/storage/02c-blobs.js";
import { __init as initTags } from "../js/07-production-tags.js";
import { __init as initBroll } from "../js/08c-broll.js";
import { exportAssetsNow, exportDocumentOf } from "../js/14b-export-kit.js";
import { htmlToPlainScript, toMarkdownDoc, toMarkdownTableDoc } from "../js/14d-export-text.js";
import { LONG_DEMO } from "../js/_starters.js";

initSceneStatus();
initTags();
initBroll();

const jpegBytes = (w, h, salt) => new Uint8Array([0xFF, 0xD8, 0xFF, 0xC0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, salt || 0, 0xFF, 0xD9]);
const copy = (o) => JSON.parse(JSON.stringify(o));
const MARKS_PM = /\b[AP]M\b/i;

function withPicture(salt, visualText) {
  const rec = intern(jpegBytes(30, 20, salt));
  S.state = migrateRows({
    schema: 5, title: "Pictures", docId: "d" + "8".repeat(32),
    rows: [{ id: "r1", visualText: visualText || "", audioText: "", status: "todo", imageRef: rec.ref || rec }]
  });
  return S.state;
}

test("a Markdown export of a scene that holds only a picture writes the picture, or a blank scene when the bytes are missing", () => {
  withPicture(51);
  const doc = exportDocumentOf(S.state);
  const assets = exportAssetsNow(doc);
  assert.ok(assets.picture(doc.scenes[0].imageRef.sha256), "setup: the bytes are held");
  const withBytes = toMarkdownDoc(doc, { assets });
  assert.ok(withBytes.includes("![visual for scene 01](images/scene-01.jpg)"), withBytes);
  assert.ok(!withBytes.includes("_(blank scene)_"));
  blobStore.forgetMemory();
  const gone = exportAssetsNow(doc);
  const without = toMarkdownDoc(doc, { assets: gone });
  assert.ok(without.includes("_(blank scene)_"), without);
  assert.ok(!without.includes("![visual"));
});

test("plain-text and project-Markdown comment times use the clock captured with the document, not the setting at serialization", () => {
  S.state = migrateRows(copy(LONG_DEMO.state));
  writePref(CLOCK_KEY, "12");
  try {
    const doc = exportDocumentOf(S.state);
    const text = htmlToPlainScript(doc);
    const project = toMarkdownTableDoc(doc);
    assert.ok(MARKS_PM.test(text), "setup: the captured clock is 12-hour");
    assert.ok(MARKS_PM.test(project), "setup: the captured clock is 12-hour");
    writePref(CLOCK_KEY, "24");
    assert.equal(htmlToPlainScript(doc), text, "plain text keeps the captured clock");
    assert.equal(toMarkdownTableDoc(doc), project, "project Markdown keeps the captured clock");
  } finally {
    writePref(CLOCK_KEY, null);
  }
});

test("the two-column Markdown table takes its picture from the operation's asset map, not the shared cache", () => {
  withPicture(52, "Wide");
  const doc = exportDocumentOf(S.state);
  const held = exportAssetsNow(doc);
  blobStore.forgetMemory();
  const fromMap = toMarkdownTableDoc(doc, { export: true, assets: held });
  assert.ok(fromMap.includes("![visual for scene 01](data:image/jpeg;base64,"), "the held bytes still give the picture");
  const missing = exportAssetsNow(doc);
  intern(jpegBytes(30, 20, 52));
  const fromMissing = toMarkdownTableDoc(doc, { export: true, assets: missing });
  assert.ok(!fromMissing.includes("data:image"), "bytes that arrived after the operation resolved do not add a picture");
});
