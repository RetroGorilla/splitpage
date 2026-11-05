import { test } from "node:test";
import assert from "node:assert/strict";
import { beatPos, caretAt, headingPos } from "../../../src/core/flow/flow.ts";
import { copyFlowRange, pasteFlowRange } from "../../../src/core/flow/flow.ts";
import { createFlowLoadRuntime } from "./load.ts";

for (const backward of [false, true]) {
  test(`clipboard keeps whole beats and clears partial visuals (${backward})`, () => {
    const { ports } = createFlowLoadRuntime();
    const rows = ["Alpha", "Bravo", "Charlie"].map((audioText, i) => ({ id: String(i), audioText, visualText: "Visual", status: "shot" }));
    const a = beatPos("0", 2), b = beatPos("2", 3);
    const clip = copyFlowRange({ rows, comments: [] }, backward ? { anchor: b, head: a } : { anchor: a, head: b }, ports);
    assert.equal(clip.text, "pha Bravo Cha");
    assert.deepEqual(clip.wholeIds, ["1"]);
    assert.deepEqual(clip.rows.map(row => [row.audioText, row.visualText, row.status]), [["pha", "", "todo"], ["Bravo", "Visual", "shot"], ["Cha", "", "todo"]]);
  });
  test(`clipboard excludes an empty endpoint except at script end (${backward})`, () => {
    const { ports } = createFlowLoadRuntime();
    for (const last of [false, true]) {
      const rows = [{ id: "a", audioText: "Alpha" }, { id: "b", audioText: "", visualText: "Keep" }, ...last ? [] : [{ id: "c", audioText: "Tail" }]];
      const a = beatPos("a", 0), b = beatPos("b", 0);
      const clip = copyFlowRange({ rows, comments: [] }, backward ? { anchor: b, head: a } : { anchor: a, head: b }, ports);
      assert.deepEqual(clip.wholeIds, last ? ["a", "b"] : ["a"]);
    }
  });
  test(`a header without a whole beat remains structural (${backward})`, () => {
    const { ports } = createFlowLoadRuntime();
    const doc = { rows: [{ id: "a", audioText: "Alpha" }], sections: [{ id: "s", name: "Scene", firstSceneId: "a" }], comments: [] };
    const a = headingPos("s", 0), b = headingPos("s", 5);
    const clip = copyFlowRange(doc, backward ? { anchor: b, head: a } : { anchor: a, head: b }, ports);
    assert.deepEqual(clip.headers.map(h => [h.index, h.scene.name]), [[0, "Scene"]]);
    const result = pasteFlowRange({ rows: [{ id: "dest", audioText: "Target", visualText: "Keep", status: "shot" }], comments: [] }, caretAt(beatPos("dest", 6)), clip, ports);
    assert.ok(result && "rows" in result);
    assert.deepEqual(result.rows.map(r => r.audioText), ["Target", ""]);
    assert.equal(result.sections?.[0]?.firstSceneId, result.rows[1]?.id);
    assert.equal(result.sections?.[0]?.name, "Scene");
  });
}

test("a pasted header mid-beat owns the suffix without introducing a blank beat", () => {
  const { ports } = createFlowLoadRuntime();
  const clip = { text: "Scene", wholeIds: [], rows: [], headers: [{ index: 0, scene: { id: "s", name: "Scene", firstSceneId: "unused" } }] };
  const doc = { rows: [{ id: "dest", audioText: "Target", visualText: "Keep", status: "shot" }], comments: [] };
  const result = pasteFlowRange(doc, caretAt(beatPos("dest", 3)), clip, ports);
  assert.ok(result && "rows" in result);
  assert.deepEqual(result.rows.map(row => [row.audioText, row.visualText, row.status]), [["Tar", "Keep", "shot"], ["get", "", "todo"]]);
  assert.equal(result.sections?.[0]?.firstSceneId, result.rows[1]?.id);
});

test("a header-only paste at a scene start keeps the destination header nonempty", () => {
  const { ports } = createFlowLoadRuntime();
  const clip = { text: "Pasted", wholeIds: [], rows: [], headers: [{ index: 0, scene: { id: "s", name: "Pasted", firstSceneId: "unused" } }] };
  const doc = { rows: [{ id: "dest", audioText: "Target" }], sections: [{ id: "old", name: "Existing", firstSceneId: "dest" }], comments: [] };
  const result = pasteFlowRange(doc, caretAt(beatPos("dest", 0)), clip, ports);
  assert.ok(result && "rows" in result);
  assert.deepEqual(result.rows.map(row => row.audioText), ["", "Target"]);
  assert.deepEqual(result.sections?.map(scene => [scene.name, scene.firstSceneId]), [["Existing", result.rows[0]?.id], ["Pasted", "dest"]]);
});

for (const offset of [0, 3, 6]) {
  test(`structural paste preserves paragraphs at destination offset ${offset}`, () => {
    const { ports } = createFlowLoadRuntime();
    const doc = { rows: [{ id: "above", audioText: "Above" }, { id: "dest", audioText: "Target", paragraphStart: true }, { id: "below", audioText: "Below", paragraphStart: true }], comments: [] };
    const clip = { text: "One\n\nTwo", rows: [{ id: "one", audioText: "One" }, { id: "two", audioText: "Two", paragraphStart: true }], wholeIds: ["one", "two"], headers: [] };
    const result = pasteFlowRange(doc, caretAt(beatPos("dest", offset)), clip, ports);
    assert.ok(result && "rows" in result);
    const texts = result.rows.map(row => row.audioText);
    assert.deepEqual(texts, offset === 3 ? ["Above", "Tar", "One", "Two", "get", "Below"] : offset === 0 ? ["Above", "One", "Two", "Target", "Below"] : ["Above", "Target", "One", "Two", "Below"]);
    assert.equal(result.rows.find(row => row.id === "one")?.paragraphStart, offset === 3 ? undefined : true);
    assert.equal(result.rows.find(row => row.id === "two")?.paragraphStart, true);
    assert.equal(result.rows.find(row => row.audioText === "get")?.paragraphStart, undefined);
    assert.equal(result.rows.find(row => row.id === "below")?.paragraphStart, true);
  });
}

test("several pasted headers retain their own first beats at an existing scene start", () => {
  const { ports } = createFlowLoadRuntime();
  const doc = { rows: [{ id: "dest", audioText: "Target" }], sections: [{ id: "old", name: "Existing", firstSceneId: "dest" }], comments: [] };
  const clip = { text: "First\n\nOne\n\nSecond\n\nTwo", wholeIds: ["one", "two"], rows: [{ id: "one", audioText: "One" }, { id: "two", audioText: "Two" }],
    headers: [{ index: 0, scene: { id: "first", name: "First", firstSceneId: "one" } }, { index: 1, scene: { id: "second", name: "Second", firstSceneId: "two" } }] };
  const result = pasteFlowRange(doc, caretAt(beatPos("dest", 0)), clip, ports);
  assert.ok(result && "rows" in result);
  assert.deepEqual(result.rows.map(row => row.audioText), ["", "One", "Two", "Target"]);
  assert.deepEqual(result.sections?.map(scene => [scene.name, scene.firstSceneId]), [["Existing", result.rows[0]?.id], ["First", "one"], ["Second", "two"]]);
});

test("a header pasted before an existing header keeps their order and gives the pasted scene a beat", () => {
  const { ports } = createFlowLoadRuntime();
  const doc = { rows: [{ id: "dest", audioText: "Target" }], sections: [{ id: "old", name: "Existing", firstSceneId: "dest" }], comments: [] };
  const clip = { text: "Pasted", wholeIds: [], rows: [], headers: [{ index: 0, scene: { id: "newScene", name: "Pasted", firstSceneId: "unused" } }] };
  const result = pasteFlowRange(doc, caretAt(headingPos("old", 0)), clip, ports);
  assert.ok(result && "rows" in result);
  assert.deepEqual(result.rows.map(row => row.audioText), ["", "Target"]);
  assert.equal(result.sections?.find(scene => scene.name === "Existing")?.firstSceneId, "dest");
  assert.equal(result.sections?.find(scene => scene.name === "Pasted")?.firstSceneId, result.rows[0]?.id);
});

test("a trailing pasted header before another scene gets its own blank beat", () => {
  const { ports } = createFlowLoadRuntime();
  const doc = { rows: [{ id: "above", audioText: "Above" }, { id: "dest", audioText: "Target" }], sections: [{ id: "old", name: "Existing", firstSceneId: "dest" }], comments: [] };
  const clip = { text: "One\n\nPasted", wholeIds: ["one"], rows: [{ id: "one", audioText: "One" }], headers: [{ index: 1, scene: { id: "newScene", name: "Pasted", firstSceneId: "unused" } }] };
  const result = pasteFlowRange(doc, caretAt(beatPos("above", 5)), clip, ports);
  assert.ok(result && "rows" in result);
  assert.deepEqual(result.rows.map(row => row.audioText), ["Above", "One", "", "Target"]);
  assert.equal(result.sections?.find(scene => scene.name === "Existing")?.firstSceneId, "dest");
  assert.equal(result.sections?.find(scene => scene.name === "Pasted")?.firstSceneId, result.rows[2]?.id);
});
