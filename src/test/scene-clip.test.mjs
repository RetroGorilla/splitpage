import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { __init as initStatus } from "../js/01-scene-status.js";
import { migrateRows } from "../js/02-state.js";
import { dataUrlForSync, intern } from "../adapters/storage/02c-blobs.js";
import { __init as initTags } from "../js/07-production-tags.js";
import { commentIds, fromHtml } from "../js/04c-doc-model.js";
import { createUndoHistory, diffStates } from "../js/12a-undo.js";
import { detectTwoColumnFormat, parseImportRows } from "../js/11-import.js";
import {
  SCENES_ATTR, SCENES_MIME, buildScenePayload, insertScenes, isBlankScene, isMove, parseScenePayload,
  scenesOnClipboard, setLiveCut
} from "../js/05g-scene-clip.js";
import { loadTestDocument } from "./_document.mjs";
import { removeScenesCommand } from "../application/commands/scenes.ts";
import { currentDocument, runCommand } from "../legacy/session-bridge.ts";

initTags();
initStatus();

function removeScenes(rowIds) {
  const outcome = runCommand(removeScenesCommand(rowIds));
  assert.notEqual(outcome.kind, "failed", outcome.error && outcome.error.stack);
  assert.notEqual(outcome.kind, "rejected", outcome.reason);
  return outcome.kind === "noop" ? 0 : outcome.changes.rowsRemoved.length;
}

const jpegBytes = (w, h, salt) => new Uint8Array([0xFF, 0xD8, 0xFF, 0xC0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, salt || 0, 0xFF, 0xD9]);
const P1 = intern(jpegBytes(300, 200, 41));
const P2 = intern(jpegBytes(200, 300, 42));
const P3 = intern(jpegBytes(120, 90, 43));

const cmt = (id, inner) => `<span class="cmt-anchor" data-cmt="${id}">${inner}</span>`;
const tag = (cat, name) => `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${name}</span>`;
const key = (id) => `<span class="broll-key" data-broll-id="${id}" contenteditable="false">B-roll:</span>`;
const img = (ref) => `<img class="comment-img" data-blob="${ref.sha256}" data-w="${ref.width}" data-h="${ref.height}" data-mime="${ref.mime}">`;

function source() {
  return migrateRows({
    schema: 2, title: "Harbour film",
    rows: [
      { id: "r1", visualText: "Opening", audioText: "Hello.", status: "todo" },
      { id: "r2", visualText: "Wide of the " + tag("location", "Harbour") + "<br>" + key("bs1") + " gulls at dawn",
        audioText: "Every " + cmt("c1", "morning") + " the town wakes.", status: "shot", lengthSeconds: 42,
        imageRef: P1, imageName: "wide.jpg", imageLinks: [{ href: "https://www.youtube.com/watch?v=abcdefghijk" }],
        moreImages: [{ imageRef: P2, name: "close.jpg", links: [] }] },
      { id: "r3", visualText: "Mara with the " + tag("prop", "Kettle"), audioText: "She has " + cmt("c2", "mended") + " nets.", status: "ready" },
      { id: "r4", visualText: "End", audioText: "Bye.", status: "todo" }
    ],
    comments: [
      { id: "c1", rowId: "r2", field: "audioText", anchorId: "c1", quotedText: "morning", author: "Ann", body: "Warmer?" + img(P3),
        assignee: "Ben", createdAt: "2026-09-01T10:00:00Z",
        replies: [{ id: "rp1", author: "Ben", body: "Yes", createdAt: "2026-09-01T11:00:00Z" }] },
      { id: "c2", rowId: "r3", field: "audioText", anchorId: "c2", quotedText: "mended", author: "Ann", body: "Check", resolved: true, resolvedBy: "Ann", resolvedAt: "2026-09-02T09:00:00Z" },
      { id: "c9", rowId: "r3", field: "visualImage", anchorId: "c9", quotedText: "", author: "Cy", body: "Picture note" },
      { id: "c4", rowId: "r4", field: "audioText", anchorId: "c4", quotedText: "", author: "Ann", body: "not copied" }
    ],
    people: [{ id: "p1", name: "Jordan" }, { id: "p2", name: "Ada" }, { id: "p3", name: "Nobody" }],
    productionTags: [
      { cat: "location", name: "Harbour", status: "sourcing", owner: "p1", notes: "Ask the harbour master." },
      { cat: "prop", name: "Kettle", status: "have", owner: "", notes: "" },
      { cat: "prop", name: "Drone", status: "needed", owner: "p2", notes: "" },
      { cat: "prop", name: "Unrelated", status: "needed", owner: "p3", notes: "" }
    ],
    brollShots: [
      { id: "bs1", name: "gulls at dawn", status: "shot", notes: "Got it on day 2", owner: "p2", props: [{ id: "", name: "Drone" }] },
      { id: "bs9", name: "elsewhere", status: "unshot" }
    ]
  });
}

function target(extra) {
  return migrateRows(Object.assign({
    schema: 2, title: "New film",
    rows: [{ id: "t1", visualText: "Mine", audioText: "My words", status: "todo" }, { id: "t2", visualText: "", audioText: "", status: "todo" }],
    comments: [], people: [{ id: "q1", name: "jordan" }],
    productionTags: [{ cat: "prop", name: "kettle", status: "needed", owner: "", notes: "theirs, not ours" }],
    brollShots: []
  }, extra || {}));
}

let n = 0;
const mint = (prefix) => (prefix || "r") + "new" + (++n);
const clip = (built) => parseScenePayload(built.json);

test("a copy carries the scenes in document order and everything that belongs to them", () => {
  const src = source();
  const out = buildScenePayload(src, ["r3", "r2"]);
  const p = out.payload;
  assert.equal(p.format, "splitpage-scenes");
  assert.equal(p.version, 1);
  assert.deepEqual(p.rows.map((r) => r.id), ["r2", "r3"], "the document's order, not the order asked");
  assert.equal(p.rows[0].status, "shot");
  assert.equal(p.rows[0].lengthSeconds, 42);
  assert.equal(p.rows[0].imageRef.sha256, P1.sha256);
  assert.equal(p.rows[0].moreImages[0].imageRef.sha256, P2.sha256);
  assert.equal(p.rows[0].imageLinks[0].href, "https://www.youtube.com/watch?v=abcdefghijk");
  assert.deepEqual(p.comments.map((c) => c.id).sort(), ["c1", "c2", "c9"], "by mark and by row, never another scene's");
  assert.equal(p.comments.find((c) => c.id === "c1").replies[0].body, "Yes");
  assert.deepEqual(p.brollShots.map((b) => b.id), ["bs1"]);
  assert.deepEqual(p.productionTags.map((t) => t.name).sort(), ["Drone", "Harbour", "Kettle"], "its tags, and its shot's props");
  assert.deepEqual(p.people.map((x) => x.name).sort(), ["Ada", "Jordan"]);
  assert.deepEqual(Object.keys(p.blobs).sort(), [P1.sha256, P2.sha256, P3.sha256].sort(), "a comment's picture too");
  assert.equal(p.blobs[P1.sha256], dataUrlForSync(P1.sha256));
  assert.deepEqual(p.blobsLeftOut, []);
  assert.equal(p.cut, undefined);
  assert.equal(p.source.docId, src.docId);
  assert.equal(out.rows, 2);
});

test("pictures past the cap, or not held, travel by reference", () => {
  const src = source();
  const oneSize = Math.floor((dataUrlForSync(P1.sha256).split(",")[1].length) * 3 / 4);
  const capped = buildScenePayload(src, ["r2"], { cap: oneSize });
  assert.deepEqual(Object.keys(capped.payload.blobs), [P1.sha256]);
  assert.deepEqual(capped.leftOut.sort(), [P2.sha256, P3.sha256].sort());
  const none = buildScenePayload(src, ["r2"], { dataUrl: () => null });
  assert.deepEqual(none.payload.blobs, {});
  assert.equal(none.leftOut.length, 3);
});

test("the plain text is labelled two-column text File > Paste a script reads back", () => {
  const out = buildScenePayload(source(), ["r2", "r3"]);
  assert.equal(out.text, "Visual: Wide of the Harbour\nB-roll: gulls at dawn\nAudio: Every morning the town wakes.\n\n" +
    "Visual: Mara with the Kettle\nAudio: She has mended nets.");
  assert.equal(detectTwoColumnFormat(out.text), "labels");
  const plain = buildScenePayload(source(), ["r1", "r3"]).text;
  const back = parseImportRows(plain, "twocolumn");
  assert.equal(back.length, 2);
  assert.equal(back[1].visualText, "Mara with the Kettle");
  assert.equal(back[1].audioText, "She has mended nets.");
});

test("the HTML is a two-column table without comment marks, carrying the payload without its bytes", () => {
  const out = buildScenePayload(source(), ["r2", "r3"]);
  assert.match(out.html, /^<table [^>]*data-splitpage-scenes="/);
  assert.match(out.html, /<th>Visual<\/th><th>Audio<\/th>/);
  assert.equal((out.html.match(/<tr>/g) || []).length, 3);
  const body = new DOMParser().parseFromString(out.html, "text/html").body;
  const tbody = body.querySelector("tbody").innerHTML;
  assert.ok(tbody.indexOf("cmt-anchor") === -1, "no comment marks for another program");
  assert.ok(tbody.indexOf("Every morning the town wakes.") !== -1);
  const lean = JSON.parse(body.querySelector("[" + SCENES_ATTR + "]").getAttribute(SCENES_ATTR));
  assert.deepEqual(lean.blobs, {});
  assert.equal(lean.blobsLeftOut.length, 3);
  assert.equal(lean.rows.length, 2);
});

test("a paste reads the custom type first, and the table's marker when that is gone", () => {
  const out = buildScenePayload(source(), ["r2"]);
  const full = scenesOnClipboard((t) => ({ [SCENES_MIME]: out.json, "text/html": out.html, "text/plain": out.text })[t] || "");
  assert.equal(full.rows.length, 1);
  assert.equal(full.carried.length, 3);
  const wrapped = '<meta charset="utf-8"><html><body><!--StartFragment-->' + out.html + "<!--EndFragment--></body></html>";
  const lean = scenesOnClipboard((t) => ({ "text/html": wrapped })[t] || "");
  assert.equal(lean.rows.length, 1);
  assert.equal(lean.carried.length, 0, "no bytes in the table");
  assert.deepEqual(lean.refs.sort(), [P1.sha256, P2.sha256, P3.sha256].sort(), "but every picture by reference");
  assert.equal(scenesOnClipboard((t) => ({ "text/html": "<b>just words</b>", "text/plain": "just words" })[t] || ""), null);
  assert.equal(scenesOnClipboard(() => ""), null);
});

test("a payload is untrusted: only ours is read, every cell sanitised, every picture checked against its sha", () => {
  assert.equal(parseScenePayload("not json"), null);
  assert.equal(parseScenePayload(JSON.stringify({ format: "something-else", version: 1, rows: [{}] })), null);
  assert.equal(parseScenePayload(JSON.stringify({ format: "splitpage-scenes", version: 1, rows: [] })), null);
  const other = intern(jpegBytes(64, 64, 99));
  const evil = parseScenePayload(JSON.stringify({
    format: "splitpage-scenes", version: 1, cut: "../bad nonce",
    rows: [{ id: "x", visualText: '<img src=x onerror="alert(1)">hi<script>alert(2)</script>', audioText: '<a href="javascript:alert(3)">link</a>', status: "weird" }],
    comments: [{ id: "k", rowId: "x", body: "<iframe src=//evil></iframe>ok" }],
    blobs: { [P1.sha256]: dataUrlForSync(other.sha256), nothex: dataUrlForSync(P2.sha256) }
  }));
  assert.ok(!/<script|<img|onerror/.test(evil.rows[0].visualText), evil.rows[0].visualText);
  assert.ok(evil.rows[0].visualText.indexOf("hi") === 0);
  assert.ok(evil.rows[0].audioText.indexOf("javascript:") === -1);
  assert.equal(evil.rows[0].status, "todo");
  assert.equal(evil.comments[0].body, "ok");
  assert.deepEqual(evil.carried, [], "bytes filed under another picture's sha are not believed");
  assert.equal(evil.cut, null);
});

test("a copy pasted into another document: every id its own, the details that belong to it along", () => {
  loadTestDocument(target());
  const c = clip(buildScenePayload(source(), ["r2", "r3"]));
  n = 0;
  const res = insertScenes(c, { afterRowId: "t1", mint });
  const rows = currentDocument().rows;
  assert.deepEqual(rows.map((r) => r.id), ["t1", "rnew1", "rnew2", "t2"], "after the caret's scene");
  assert.deepEqual(res.rowIds, ["rnew1", "rnew2"]);
  const pasted = rows[1];
  assert.equal(pasted.status, "shot");
  assert.equal(pasted.lengthSeconds, 42);
  assert.equal(pasted.imageRef.sha256, P1.sha256);
  assert.equal(pasted.moreImages[0].imageRef.sha256, P2.sha256);
  assert.equal(pasted.imageLinks.length, 1);
  const cs = currentDocument().comments;
  assert.equal(cs.length, 3);
  assert.ok(cs.every((x) => /new/.test(x.id) && x.anchorId === x.id), "fresh ids, anchor = id");
  const morning = cs.find((x) => x.quotedText === "morning");
  assert.deepEqual(commentIds(fromHtml(pasted.audioText)), [morning.id]);
  assert.equal(morning.rowId, "rnew1");
  assert.equal(morning.assignee, "Ben");
  assert.ok(/new/.test(morning.replies[0].id) && morning.replies[0].body === "Yes");
  assert.ok(morning.body.indexOf(P3.sha256) !== -1, "a comment's picture comes with it");
  assert.equal(cs.find((x) => x.quotedText === "mended").resolved, true);
  assert.equal(cs.find((x) => x.field === "visualImage").rowId, "rnew2", "a picture comment follows its scene");
  assert.ok(pasted.visualText.indexOf('data-broll-id="bs1"') !== -1);
  assert.deepEqual(res.broll, { kept: ["bs1"], minted: [] });
  const shot = currentDocument().brollShots.find((b) => b.id === "bs1");
  assert.equal(shot.status, "shot");
  assert.equal(shot.notes, "Got it on day 2");
  const ada = currentDocument().people.find((p) => p.name === "Ada");
  assert.ok(ada && shot.owner === ada.id);
  const harbour = currentDocument().productionTags.find((t) => t.name === "Harbour");
  assert.equal(harbour.status, "sourcing");
  assert.equal(harbour.notes, "Ask the harbour master.");
  assert.equal(harbour.owner, "q1", "Jordan is already on this crew, as 'jordan'");
  assert.equal(currentDocument().productionTags.filter((t) => t.name.toLowerCase() === "kettle").length, 1);
  assert.equal(currentDocument().productionTags.find((t) => t.name === "kettle").notes, "theirs, not ours");
  const drone = currentDocument().productionTags.find((t) => t.name === "Drone");
  assert.deepEqual(shot.props, [{ id: drone.id, name: "Drone" }], "a prop by name, then its entry's id here");
  assert.ok(!currentDocument().people.some((p) => p.name === "Nobody"), "nobody a pasted thing names is not added");
  assert.equal(currentDocument().people.filter((p) => p.name.toLowerCase() === "jordan").length, 1);
});

test("a copy pasted into its own document: a new b-roll shot, new comments, the originals untouched", () => {
  loadTestDocument(source());
  const before = JSON.stringify(currentDocument().rows.find((r) => r.id === "r2"));
  const c = clip(buildScenePayload(currentDocument(), ["r2"]));
  n = 0;
  const res = insertScenes(c, { afterRowId: "r4", mint });
  assert.deepEqual(currentDocument().rows.map((r) => r.id), ["r1", "r2", "r3", "r4", "rnew1"]);
  assert.equal(JSON.stringify(currentDocument().rows.find((r) => r.id === "r2")), before);
  assert.equal(res.broll.kept.length, 0);
  assert.equal(res.broll.minted.length, 1);
  const copyKey = res.broll.minted[0];
  assert.ok(currentDocument().rows[4].visualText.indexOf('data-broll-id="' + copyKey + '"') !== -1);
  const fresh = currentDocument().brollShots.find((b) => b.id === copyKey);
  assert.equal(fresh.status, "unshot", "the copy has not been shot");
  assert.equal(fresh.notes, "");
  assert.equal(currentDocument().brollShots.find((b) => b.id === "bs1").status, "shot", "the original keeps its record");
  assert.equal(currentDocument().comments.filter((x) => x.quotedText === "morning").length, 2);
  const original = currentDocument().comments.find((x) => x.id === "c1");
  assert.equal(original.rowId, "r2", "the original still points at its own words");
});

test("a cut then its paste in the same document is a move: ids kept, comments not copied, records found", () => {
  loadTestDocument(source());
  const nonce = "ab12";
  const built = buildScenePayload(currentDocument(), ["r2", "r3"], { cut: nonce });
  assert.equal(built.payload.cut, nonce);
  setLiveCut(nonce, currentDocument().docId);
  assert.equal(removeScenes(["r2", "r3"]), 2);
  assert.deepEqual(currentDocument().rows.map((r) => r.id), ["r1", "r4"]);
  assert.equal(currentDocument().comments.length, 4, "a cut leaves the comments, as a delete does");
  const c = clip(built);
  assert.equal(isMove(c, currentDocument()), true);
  assert.equal(isMove(c, target()), false, "another document: a copy");
  n = 0;
  const res = insertScenes(c, { afterRowId: "r4", move: true, mint });
  assert.deepEqual(currentDocument().rows.map((r) => r.id), ["r1", "r4", "r2", "r3"]);
  assert.equal(res.comments, 0);
  assert.equal(currentDocument().comments.length, 4);
  assert.deepEqual(commentIds(fromHtml(currentDocument().rows[2].audioText)), ["c1"]);
  assert.deepEqual(res.broll, { kept: ["bs1"], minted: [] });
  assert.equal(currentDocument().brollShots.filter((b) => b.id === "bs1").length, 1);
  assert.equal(currentDocument().brollShots.find((b) => b.id === "bs1").status, "shot");
  setLiveCut(null);
  assert.equal(isMove(c, currentDocument()), false);
});

test("a move whose rows came back meanwhile (the cut undone) is a copy where it has to be", () => {
  loadTestDocument(source());
  const built = buildScenePayload(currentDocument(), ["r2"], { cut: "cd34" });
  setLiveCut("cd34", currentDocument().docId);
  n = 0;
  insertScenes(clip(built), { afterRowId: "r4", move: true, mint });
  const ids = currentDocument().rows.map((r) => r.id);
  assert.deepEqual(ids, ["r1", "r2", "r3", "r4", "rnew1"], "r2 is still here, so the paste is a new row");
  assert.equal(new Set(ids).size, ids.length);
  const keys = currentDocument().rows.map((r) => (r.visualText.match(/data-broll-id="([^"]+)"/) || [])[1]).filter(Boolean);
  assert.equal(new Set(keys).size, keys.length, "never two keys with one id");
  const copyCmts = commentIds(fromHtml(currentDocument().rows[4].audioText));
  assert.equal(copyCmts.length, 1);
  assert.notEqual(copyCmts[0], "c1");
  assert.ok(currentDocument().comments.some((x) => x.id === copyCmts[0] && x.rowId === "rnew1"));
  setLiveCut(null);
});

const markedIn = (state) => {
  const out = {};
  state.rows.forEach((r) => ["visualText", "audioText"].forEach((f) => {
    commentIds(fromHtml(r[f] || "")).forEach((id) => { (out[id] = out[id] || []).push(r.id); });
  }));
  return out;
};

test("the live cut follows undo: the move's paste undone, the next paste is the move again", () => {
  loadTestDocument(source());
  const history = createUndoHistory();
  const built = buildScenePayload(currentDocument(), ["r2", "r3"], { cut: "ef56" });
  setLiveCut("ef56", currentDocument().docId);
  let base = JSON.parse(JSON.stringify(currentDocument()));
  removeScenes(["r2", "r3"]);
  history.record(diffStates(base, currentDocument()), Date.now());
  const c = clip(built);
  assert.equal(isMove(c, currentDocument()), true);
  base = JSON.parse(JSON.stringify(currentDocument()));
  n = 0;
  insertScenes(c, { afterRowId: "r4", move: isMove(c, currentDocument()), mint });
  history.record(diffStates(base, currentDocument()), Date.now());
  assert.deepEqual(currentDocument().rows.map((r) => r.id), ["r1", "r4", "r2", "r3"]);
  assert.equal(isMove(c, currentDocument()), false, "its scenes are back: another paste is a copy");
  assert.equal(history.undo(currentDocument()).ok, true);
  assert.deepEqual(currentDocument().rows.map((r) => r.id), ["r1", "r4"]);
  assert.equal(isMove(c, currentDocument()), true, "the undo put the cut back");
  const res = insertScenes(c, { afterRowId: "r1", move: isMove(c, currentDocument()), mint });
  assert.deepEqual(currentDocument().rows.map((r) => r.id), ["r1", "r2", "r3", "r4"]);
  assert.equal(res.comments, 0);
  assert.deepEqual(currentDocument().comments.map((x) => x.id + "@" + x.rowId).sort(), ["c1@r2", "c2@r3", "c4@r4", "c9@r3"]);
  assert.deepEqual(res.broll, { kept: ["bs1"], minted: [] });
  assert.deepEqual(currentDocument().brollShots.map((b) => b.id + ":" + b.status), ["bs1:shot", "bs9:unshot"], "the shot found its record, nothing orphaned");
  setLiveCut(null);
});

test("the cut undone, its paste is a copy: comments and b-roll records of its own, never the originals' marks", () => {
  loadTestDocument(source());
  const history = createUndoHistory();
  const built = buildScenePayload(currentDocument(), ["r2", "r3"], { cut: "ab78" });
  setLiveCut("ab78", currentDocument().docId);
  const base = JSON.parse(JSON.stringify(currentDocument()));
  removeScenes(["r2", "r3"]);
  history.record(diffStates(base, currentDocument()), Date.now());
  assert.equal(history.undo(currentDocument()).ok, true);
  assert.deepEqual(currentDocument().rows.map((r) => r.id), ["r1", "r2", "r3", "r4"]);
  const c = clip(built);
  assert.equal(isMove(c, currentDocument()), false, "the scenes came back with the undo");
  n = 0;
  const res = insertScenes(c, { afterRowId: "r4", move: isMove(c, currentDocument()), mint });
  assert.deepEqual(currentDocument().rows.map((r) => r.id), ["r1", "r2", "r3", "r4", "rnew1", "rnew2"]);
  assert.equal(res.comments, 3);
  assert.equal(currentDocument().comments.length, 7);
  const marks = markedIn(currentDocument());
  assert.deepEqual(marks.c1, ["r2"], "the original is marked only in its own scene");
  assert.deepEqual(marks.c2, ["r3"]);
  assert.ok(Object.keys(marks).every((id) => marks[id].length === 1), JSON.stringify(marks));
  assert.ok(Object.keys(marks).every((id) => currentDocument().comments.some((x) => x.id === id)), "every mark has its comment");
  assert.equal(res.broll.minted.length, 1);
  assert.equal(currentDocument().brollShots.find((b) => b.id === res.broll.minted[0]).status, "unshot");
  assert.equal(currentDocument().brollShots.find((b) => b.id === "bs1").status, "shot");
  setLiveCut(null);
});

test("deleting or cutting a scene points a comment split across it at the words that stay", () => {
  loadTestDocument(migrateRows({
    schema: 2, title: "Split",
    rows: [
      { id: "r1", visualText: "", audioText: "Every " + cmt("c1", "morn"), status: "todo" },
      { id: "r2", visualText: "", audioText: cmt("c1", "ing") + " the town wakes.", status: "todo" },
      { id: "r3", visualText: "", audioText: "Bye.", status: "todo" }
    ],
    comments: [{ id: "c1", rowId: "r1", field: "audioText", anchorId: "c1", quotedText: "morning", author: "Ann", body: "Warmer?" }]
  }));
  assert.equal(removeScenes(["r1"]), 1);
  assert.equal(currentDocument().comments[0].rowId, "r2", "its surviving words");
  assert.equal(currentDocument().comments[0].field, "audioText");
  removeScenes(["r2"]);
  assert.equal(currentDocument().comments[0].rowId, "r2", "no words left anywhere: detached, as it was");
});

test("a paste onto a blank scene takes its place; comments can be held back for a second step", () => {
  const t = target();
  assert.equal(isBlankScene(t, t.rows[1]), true);
  assert.equal(isBlankScene(t, t.rows[0]), false);
  loadTestDocument(t);
  n = 0;
  const res = insertScenes(clip(buildScenePayload(source(), ["r2"])), { replaceRowId: "t2", holdComments: true, mint });
  assert.deepEqual(currentDocument().rows.map((r) => r.id), ["t1", "rnew1"]);
  assert.equal(currentDocument().comments.length, 0);
  assert.equal(res.held.length, 1);
  assert.equal(res.held[0].rowId, "rnew1");
});

test("a paste, a cut and a delete are each one undo entry that puts the document back", () => {
  loadTestDocument(target());
  const history = createUndoHistory();
  let base = JSON.parse(JSON.stringify(currentDocument()));
  const c = clip(buildScenePayload(source(), ["r2", "r3"]));
  insertScenes(c, { afterRowId: "t1" });
  history.record(diffStates(base, currentDocument()), Date.now());
  assert.equal(history.sizes().undo, 1);
  const r = history.undo(currentDocument());
  assert.equal(r.ok, true, r.reason);
  for (const k of ["rows", "comments", "people", "productionTags", "brollShots"]) {
    assert.deepEqual(currentDocument()[k], base[k], k + " put back");
  }
  assert.equal(history.redo(currentDocument()).ok, true);
  assert.equal(currentDocument().rows.length, 4);

  const h2 = createUndoHistory();
  base = JSON.parse(JSON.stringify(currentDocument()));
  removeScenes([currentDocument().rows[1].id, currentDocument().rows[2].id]);
  h2.record(diffStates(base, currentDocument()), Date.now());
  assert.equal(currentDocument().rows.length, 2);
  assert.equal(h2.undo(currentDocument()).ok, true);
  assert.deepEqual(currentDocument().rows, base.rows);
});
