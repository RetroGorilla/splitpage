import "../../../src/test/_dom.mjs";
import "../../../src/test/_copy-paste-mounted.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { beatPaste, beatsOnClipboard, isMove } from "../../../src/features/clipboard/beat-clip.ts";
import { copyFlowClipboard, pasteFlowClipboard } from "../../../src/features/clipboard/flow-clip.ts";
import { migrateRows } from "../../../src/bootstrap/document-ports.ts";
import { cellOf, fromHtml, inertBody } from "../../../src/bootstrap/richtext.ts";
import { intern } from "../../../src/adapters/storage/02c-blobs.ts";
import { mountProductionTagsFeature } from "../../../src/bootstrap/wiring/production-tags.ts";
import { beatPos, caretAt } from "../../../src/core/flow/flow.ts";
import type { FlowPorts } from "../../../src/core/flow/flow.ts";
import { deepLock } from "../../../src/core/document/freeze.ts";

let next = 0;
mountProductionTagsFeature();
const ports: FlowPorts = { cells: cellOf, newId: () => "new" + ++next, hasVisual: row => !!row.visualText };
function clipboard() {
  const values = new Map<string, string>();
  return { values, getData: (type: string) => values.get(type) ?? "", setData: (type: string, value: string) => { values.set(type, value); } };
}

test("Writer copies whole beats without writing into the source document", () => {
  const source = deepLock(migrateRows({ rows: [{ id: "a", audioText: "A" }, { id: "b", audioText: "Bravo", visualText: "Visual", status: "shot" }, { id: "c", audioText: "C" }],
    comments: [{ id: "comment", rowId: "b", field: "visualText", body: "Note", author: "Ann" }] }));
  const before = JSON.stringify(source);
  const data = clipboard();
  copyFlowClipboard(source, { anchor: beatPos("a", 1), head: beatPos("c", 0) }, data, ports, null, migrateRows);
  const clip = beatsOnClipboard(type => data.getData(type));
  assert.ok(clip);
  assert.equal(clip.rows[0]?.visualText, "Visual");
  assert.equal(clip.comments[0]?.body, "Note");
  assert.equal(JSON.stringify(source), before);
});

for (const backward of [false, true]) {
  test(`flow clipboard carries picture bytes and preserves source metadata (${backward})`, () => {
    const imageRef = intern(new Uint8Array([255,216,255,192,0,17,8,0,2,0,3,3,1,34,0,2,17,1,3,17,1,255,217]));
    assert.ok(imageRef);
    const source = migrateRows({ rows: [{ id: "a", audioText: "Alpha" }, { id: "b", audioText: "Bravo", visualText: "Keep", imageRef, imageName: "wide.jpg", status: "shot" }, { id: "c", audioText: "Charlie" }] });
    const before = JSON.stringify(source);
    const a = beatPos("a", 2), b = beatPos("c", 3);
    const data = clipboard();
    assert.equal(copyFlowClipboard(source, backward ? { anchor: b, head: a } : { anchor: a, head: b }, data, ports, null, migrateRows), false);
    const wire = JSON.parse(data.getData("application/x-splitpage-flow")) as { beats: { blobs: Record<string, string> } };
    assert.ok(wire.beats.blobs[imageRef.sha256]?.startsWith("data:image/jpeg;base64,"));
    assert.ok(!data.getData("text/html").includes("data:image/jpeg;base64,"));
    const destination = migrateRows({ rows: [{ id: "dest", audioText: "Target", visualText: "Original" }] });
    const result = pasteFlowClipboard(destination, caretAt(beatPos("dest", 3)), data, ports, inertBody, migrateRows);
    assert.ok(result && "rows" in result);
    assert.deepEqual(result.rows.map(row => row.audioText), ["Tar", "pha", "Bravo", "Cha", "get"]);
    assert.deepEqual(result.rows[2]?.imageRef, imageRef);
    assert.equal(result.rows[2]?.imageName, "wide.jpg");
    assert.equal(result.rows[2]?.status, "shot");
    assert.equal(JSON.stringify(source), before);
  });
}

test("seeded untrusted clipboard payloads never escape canonical cells or mutate the destination", () => {
  const doc = migrateRows({ rows: [{ id: "dest", audioText: "Target", visualText: "Keep" }] });
  const before = JSON.stringify(doc);
  let seed = 354;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const fragments = ["<script>bad()</script>", '<img src=x onerror="bad()">', '<a href="javascript:bad()">link</a>', "<b>Words</b>", "<span>Plain</span>", "&lt;tag&gt;"];
  for (let i = 0; i < 150; i++) {
    const data = clipboard();
    const html = fragments[random() % fragments.length] as string;
    const index = random() % 4 - 1;
    data.setData("application/x-splitpage-flow", JSON.stringify({ format: "splitpage-flow", version: 1, text: html,
      wholeIds: ["copied"], headers: i % 3 ? [] : [{ index, scene: { name: html } }],
      beats: { format: "splitpage-scenes", version: 1, rows: [{ id: "copied", audioText: html, visualText: html }] } }));
    const result = pasteFlowClipboard(doc, caretAt(beatPos("dest", 3)), data, ports, inertBody, migrateRows);
    if (result && "rows" in result) {
      assert.equal(new Set(result.rows.map(row => row.id)).size, result.rows.length);
      for (const row of result.rows) {
        for (const value of [row.audioText, row.visualText]) {
          assert.ok(!/<script|onerror=|javascript:/i.test(value ?? ""));
          assert.deepEqual(fromHtml(value ?? ""), cellOf(value));
        }
      }
      assert.ok(result.sections?.every(scene => result.rows.some(row => row.id === scene.firstSceneId)) ?? true);
    }
    assert.equal(JSON.stringify(doc), before);
  }
});

test("a whole beat keeps inline picture atoms in both fields", () => {
  const imageRef = intern(new Uint8Array([255,216,255,192,0,17,8,0,2,0,3,3,1,34,0,2,17,1,3,17,2,255,217]));
  assert.ok(imageRef);
  const image = `<img class="comment-img" data-blob="${imageRef.sha256}" data-w="3" data-h="2" data-mime="image/jpeg">`;
  const source = migrateRows({ rows: [{ id: "a", audioText: "A" }, { id: "b", audioText: "B" + image, visualText: "V" + image }, { id: "c", audioText: "C" }] });
  assert.ok(source.rows[1]?.audioText?.includes("data-blob"));
  assert.ok(source.rows[1]?.visualText?.includes("data-blob"));
  const data = clipboard();
  const mediaPorts: FlowPorts = { ...ports, cells: html => fromHtml(html ?? "", { media: true }) };
  copyFlowClipboard(source, { anchor: beatPos("a", 1), head: beatPos("c", 0) }, data, mediaPorts, null, migrateRows);
  const dest = migrateRows({ rows: [{ id: "dest", audioText: "Target" }] });
  const result = pasteFlowClipboard(dest, caretAt(beatPos("dest", 3)), data, mediaPorts, inertBody, migrateRows);
  assert.ok(result && "rows" in result);
  assert.equal(result.rows[1]?.audioText, source.rows[1]?.audioText);
  assert.equal(result.rows[1]?.visualText, source.rows[1]?.visualText);
});

test("Split reads whole beats copied from Writer", () => {
  const source = migrateRows({ rows: [{ id: "a", audioText: "Alpha" }, { id: "b", audioText: "Bravo", visualText: "Picture", status: "shot" }, { id: "c", audioText: "Charlie" }] });
  const data = clipboard();
  copyFlowClipboard(source, { anchor: beatPos("a", 2), head: beatPos("c", 3) }, data, ports, null, migrateRows);
  const clip = beatsOnClipboard(type => data.getData(type));
  assert.ok(clip);
  assert.deepEqual(clip.rows.map(row => row.audioText), ["pha", "Bravo", "Cha"]);
  assert.equal(clip.rows[1]?.visualText, "Picture");
  assert.equal(clip.rows[1]?.status, "shot");
});

test("Split reads HTML-only flow beats with picture references but no carried bytes", () => {
  const imageRef = intern(new Uint8Array([255,216,255,192,0,17,8,0,2,0,3,3,1,34,0,2,17,1,3,17,3,255,217]));
  assert.ok(imageRef);
  const source = migrateRows({ rows: [{ id: "a", audioText: "A" }, { id: "b", audioText: "B", imageRef }, { id: "c", audioText: "C" }] });
  const data = clipboard();
  copyFlowClipboard(source, { anchor: beatPos("a", 1), head: beatPos("c", 0) }, data, ports, null, migrateRows);
  const clip = beatsOnClipboard(type => type === "text/html" ? data.getData(type) : "");
  assert.ok(clip);
  assert.deepEqual(clip.rows[0]?.imageRef, imageRef);
  assert.deepEqual(clip.carried, []);
  assert.ok(clip.refs.includes(imageRef.sha256));
});

test("a partial-only Writer selection remains text and selected headers survive", () => {
  const source = migrateRows({ rows: [{ id: "a", audioText: "Alpha" }, { id: "b", audioText: "Bravo" }], sections: [{ id: "s", name: "Scene", firstSceneId: "b" }] });
  const partial = clipboard();
  copyFlowClipboard(source, { anchor: beatPos("a", 1), head: beatPos("a", 3) }, partial, ports, null, migrateRows);
  assert.equal(beatsOnClipboard(type => partial.getData(type)), null);
  assert.equal(partial.getData("text/plain"), "lp");
  const withHeader = clipboard();
  copyFlowClipboard(source, { anchor: beatPos("a", 1), head: beatPos("b", 5) }, withHeader, ports, null, migrateRows);
  const clip = beatsOnClipboard(type => withHeader.getData(type));
  assert.ok(clip);
  assert.deepEqual(clip.headers?.map(header => [header.index, header.scene.name]), [[1, "Scene"]]);
  assert.match(withHeader.getData("text/plain"), /Scene/);
});

test("Writer copies get fresh row and comment identities on repeated Split paste", () => {
  const source = migrateRows({ schema: 2, docId: "source", rows: [{ id: "a", audioText: "A" }, { id: "b", audioText: '<span class="cmt-anchor" data-cmt="c1">Bravo</span>', visualText: "Visual", status: "shot" }, { id: "c", audioText: "C" }],
    comments: [{ id: "c1", anchorId: "c1", rowId: "b", field: "audioText", body: "Note", author: "Ann" }] });
  const data = clipboard();
  copyFlowClipboard(source, { anchor: beatPos("a", 1), head: beatPos("c", 0) }, data, ports, null, migrateRows);
  const clip = beatsOnClipboard(type => data.getData(type));
  assert.ok(clip);
  const dest = migrateRows({ rows: [{ id: "dest", audioText: "Existing" }] });
  for (let i = 0; i < 2; i++) {
    const paste = beatPaste(clip, { afterRowId: "dest" });
    assert.ok(paste.plan(dest));
    paste.apply(dest);
  }
  const inserted = dest.rows.filter(row => row.visualText === "Visual");
  assert.equal(inserted.length, 2);
  assert.notEqual(inserted[0]?.id, inserted[1]?.id);
  assert.ok(inserted.every(row => row.id !== "b" && row.status === "shot"));
  assert.equal(dest.comments.length, 2);
  assert.notEqual(dest.comments[0]?.id, dest.comments[1]?.id);
  assert.deepEqual(new Set(dest.comments.map(comment => comment.rowId)), new Set(inserted.map(row => row.id)));
  assert.ok(dest.comments.every(comment => inserted.some(row => row.id === comment.rowId && row.audioText?.includes(`data-cmt="${comment.anchorId}"`))));
});

test("a Writer cut moves only while its source beats are absent from the same document", () => {
  const source = migrateRows({ docId: "same", rows: [{ id: "a", audioText: "A" }, { id: "b", audioText: "B" }, { id: "c", audioText: "C" }] });
  const data = clipboard();
  copyFlowClipboard(source, { anchor: beatPos("a", 1), head: beatPos("c", 0) }, data, ports, "nonce1", migrateRows);
  const clip = beatsOnClipboard(type => data.getData(type));
  assert.ok(clip);
  assert.equal(isMove(clip, source), false);
  const afterCut = migrateRows({ ...source, rows: source.rows.filter(row => row.id !== "b") });
  assert.equal(isMove(clip, afterCut), true);
  const paste = beatPaste(clip, { afterRowId: "a" });
  assert.ok(paste.plan(afterCut));
  paste.apply(afterCut);
  assert.equal(afterCut.rows[1]?.id, "b");
  assert.equal(isMove(clip, afterCut), false);
  assert.equal(isMove(clip, migrateRows({ ...afterCut, docId: "other", rows: [{ id: "other" }] })), false);
});

test("Writer paste preserves copied shot details and related registries", () => {
  const source = migrateRows({ schema: 2, rows: [{ id: "a", audioText: "A" }, { id: "b", audioText: "B", visualText: '<span class="tag-anchor" data-tag-cat="location" data-tag-name="Harbour" contenteditable="false">Harbour</span><br><span class="broll-key" data-broll-id="bs1" contenteditable="false">B-roll:</span> gulls' }, { id: "c", audioText: "C" }],
    people: [{ id: "p1", name: "Camera" }], productionTags: [{ cat: "location", name: "Harbour", owner: "p1", notes: "Permit", status: "sourcing" }],
    brollShots: [{ id: "bs1", name: "gulls", owner: "p1", notes: "Dawn", status: "shot" }], sections: [{ id: "shotScene", name: "Shot", firstSceneId: "b" }] });
  const data = clipboard();
  copyFlowClipboard(source, { anchor: headingPos("shotScene", 0), head: beatPos("c", 0) }, data, ports, null, migrateRows);
  const clip = beatsOnClipboard(type => data.getData(type));
  assert.ok(clip);
  const paste = beatPaste(clip, { afterRowId: "c" });
  assert.ok(paste.plan(source));
  paste.apply(source);
  const row = source.rows.at(-1);
  assert.ok(row);
  const shotId = /data-broll-id="([^"]+)"/.exec(row.visualText ?? "")?.[1];
  assert.ok(shotId && shotId !== "bs1", row.visualText ?? "");
  assert.equal(source.brollShots.find(shot => shot.id === shotId)?.notes, "Dawn");
  assert.equal(source.brollShots.find(shot => shot.id === shotId)?.owner, "p1");
  assert.equal(source.productionTags.find(tag => tag?.name === "Harbour")?.notes, "Permit");
});

import { pasteBeatsCommand } from "../../../src/application/commands/beats.ts";
import { harness, runConfined } from "../../application/session-fakes.ts";
import { headingPos } from "../../../src/core/flow/flow.ts";

test("header slices paste as ordered sections and declare blank replacement", () => {
  const source = migrateRows({ rows: [{ id: "a", audioText: "Alpha" }, { id: "b", audioText: "Bravo", visualText: "Picture" }, { id: "c", audioText: "Charlie" }],
    sections: [{ id: "s1", name: "One", firstSceneId: "b" }, { id: "s2", name: "Two", firstSceneId: "c" }] });
  const data = clipboard();
  copyFlowClipboard(source, { anchor: beatPos("a", 2), head: headingPos("s2", 3) }, data, ports, null, migrateRows);
  for (const htmlOnly of [false, true]) {
    const clip = beatsOnClipboard(type => htmlOnly && type !== "text/html" ? "" : data.getData(type));
    assert.ok(clip);
    const h = harness(undefined, { entry: migrateRows });
    h.session.adopt({ rows: [{ id: "before", audioText: "Before" }, { id: "blank" }, { id: "after", audioText: "After" }],
      sections: [{ id: "dest", name: "Destination", firstSceneId: "blank" }, { id: "next", name: "Next", firstSceneId: "after" }] });
    const result = runConfined(h.session, pasteBeatsCommand(beatPaste(clip, { afterRowId: "blank" })));
    assert.equal(result.kind, "applied");
    if (result.kind !== "applied") continue;
    assert.ok(result.changes.docFields.includes("sections"));
    assert.deepEqual(result.changes.rowsRemoved, ["blank"]);
    h.session.read(doc => {
      assert.ok(doc);
      assert.deepEqual(doc.rows.map(row => row.audioText), ["Before", "pha", "Bravo", "", "After"]);
      const sections = doc.sections as { name: string; firstSceneId: string }[];
      assert.deepEqual(sections.map(scene => scene.name), ["Destination", "One", "Two", "Next"]);
      assert.deepEqual(sections.map(scene => doc.rows.findIndex(row => row.id === scene.firstSceneId)), [1, 2, 3, 4]);
      assert.equal(doc.rows[2]?.visualText, "Picture");
    });
  }
});

test("header-only selection creates a blank anchored beat", () => {
  const source = migrateRows({ rows: [{ id: "a", audioText: "A" }], sections: [{ id: "s", name: "Heading", firstSceneId: "a" }] });
  const data = clipboard();
  copyFlowClipboard(source, { anchor: headingPos("s", 0), head: headingPos("s", 7) }, data, ports, null, migrateRows);
  const clip = beatsOnClipboard(type => data.getData(type));
  assert.ok(clip);
  const h = harness(undefined, { entry: migrateRows });
  h.session.adopt({ rows: [{ id: "d", audioText: "Destination" }] });
  assert.equal(runConfined(h.session, pasteBeatsCommand(beatPaste(clip, { afterRowId: "d" }))).kind, "applied");
  h.session.read(doc => {
    assert.ok(doc);
    assert.equal(doc.rows.length, 2);
    assert.equal(doc.rows[1]?.audioText, "");
    assert.deepEqual((doc.sections as { name: string; firstSceneId: string }[]).map(s => [s.name, s.firstSceneId]), [["Heading", doc.rows[1]?.id]]);
  });
});

test("malformed flow headers are rejected safely", () => {
  const valid = { format: "splitpage-flow", version: 1, text: "x", wholeIds: ["a"], beats: { format: "splitpage-scenes", version: 1, rows: [{ id: "a", audioText: "x" }] } };
  for (const headers of [[null], [{ index: -1, scene: { name: "X" } }], [{ index: 2, scene: { name: "X" } }],
    [{ index: 0, scene: { name: " " } }], [{ index: 0, scene: { name: "X" } }, { index: 0, scene: { name: "Y" } }]]) {
    assert.equal(beatsOnClipboard(type => type === "application/x-splitpage-flow" ? JSON.stringify({ ...valid, headers }) : ""), null);
  }
});

test("a leading copied header preserves the replaced destination scene boundary", () => {
  const source = migrateRows({ rows: [{ id: "a", audioText: "First", visualText: "Visual" }, { id: "b", audioText: "Last" }],
    sections: [{ id: "source", name: "Copied", firstSceneId: "a" }] });
  const data = clipboard();
  copyFlowClipboard(source, { anchor: headingPos("source", 0), head: beatPos("b", 0) }, data, ports, null, migrateRows);
  const clip = beatsOnClipboard(type => data.getData(type));
  assert.ok(clip);
  const h = harness(undefined, { entry: migrateRows });
  h.session.adopt({ rows: [{ id: "blank" }, { id: "next", audioText: "Next" }],
    sections: [{ id: "dest", name: "Destination", firstSceneId: "blank" }, { id: "nextScene", name: "Next", firstSceneId: "next" }] });
  assert.equal(runConfined(h.session, pasteBeatsCommand(beatPaste(clip, { afterRowId: "blank" }))).kind, "applied");
  h.session.read(doc => {
    assert.ok(doc);
    assert.deepEqual(doc.rows.map(row => row.audioText), ["", "First", "Next"]);
    const sections = doc.sections as { name: string; firstSceneId: string }[];
    assert.deepEqual(sections.map(scene => scene.name), ["Destination", "Copied", "Next"]);
    assert.deepEqual(sections.map(scene => doc.rows.findIndex(row => row.id === scene.firstSceneId)), [0, 1, 2]);
  });
});

test("a cut with a header retains a whole beat identity only for a same-document move", () => {
  const source = migrateRows({ docId: "same", rows: [{ id: "a", audioText: "A" }, { id: "b", audioText: "B", visualText: "Visual" }, { id: "c", audioText: "C" }],
    sections: [{ id: "s", name: "Scene", firstSceneId: "b" }] });
  const data = clipboard();
  copyFlowClipboard(source, { anchor: headingPos("s", 0), head: beatPos("c", 0) }, data, ports, "headercut", migrateRows);
  const clip = beatsOnClipboard(type => data.getData(type));
  assert.ok(clip);
  const h = harness(undefined, { entry: migrateRows });
  h.session.adopt({ ...source, rows: source.rows.filter(row => row.id !== "b"), sections: [] });
  assert.equal(runConfined(h.session, pasteBeatsCommand(beatPaste(clip, { afterRowId: "a" }))).kind, "applied");
  h.session.read(doc => {
    assert.ok(doc);
    assert.equal(doc.rows[1]?.id, "b");
    assert.equal((doc.sections as { firstSceneId: string }[])[0]?.firstSceneId, "b");
    assert.equal(isMove(clip, doc), false);
  });
});
