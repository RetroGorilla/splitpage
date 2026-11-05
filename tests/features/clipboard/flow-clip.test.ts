import "../../../src/test/_dom.mjs";
import "../../../src/test/_copy-paste-mounted.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFlowClipboard, pasteFlowClipboard } from "../../../src/features/clipboard/flow-clip.ts";
import { migrateRows } from "../../../src/bootstrap/document-ports.ts";
import { cellOf, fromHtml, inertBody } from "../../../src/bootstrap/richtext.ts";
import { intern } from "../../../src/adapters/storage/02c-blobs.ts";
import { mountProductionTagsFeature } from "../../../src/bootstrap/wiring/production-tags.ts";
import { beatPos, caretAt } from "../../../src/core/flow/flow.ts";
import type { FlowPorts } from "../../../src/core/flow/flow.ts";

let next = 0;
mountProductionTagsFeature();
const ports: FlowPorts = { cells: cellOf, newId: () => "new" + ++next, hasVisual: row => !!row.visualText };
function clipboard() {
  const values = new Map<string, string>();
  return { values, getData: (type: string) => values.get(type) ?? "", setData: (type: string, value: string) => { values.set(type, value); } };
}

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
