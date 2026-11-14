import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Stage1ExecutorHarness } from "../../adapters/collab/stage1-executor-support.ts";
import { adapterReplica, sharedHarness } from "../../application/session/shared-session-support.ts";
import { createMonitoredSharedDocument } from "../../adapters/collab/helpers.ts";
import { applySharedUpdate, encodeSharedState, destroySharedDocument } from "../../../src/adapters/collab/document.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";
import { sharedBufferedTarget } from "../../../src/adapters/collab/buffer.ts";
import { sharedBufferPorts } from "../../../src/bootstrap/wiring/ports/shared-buffer.ts";
import { createBufferedField } from "../../../src/application/editing/buffered-field.ts";
import { createPaintedBeats } from "../../../src/application/editing/painted-beats.ts";
import { bindBufferedInput } from "../../../src/features/common/buffered-input.ts";
import { TITLE_FIELD_KEY } from "../../../src/application/editing/buffered-field-key.ts";
import { beatPos, headingPos } from "../../../src/core/flow/flow.ts";
import { bufferReaders, bufferStamps } from "../../collab/buffer-readers.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import { edgeInput } from "../edge-input.ts";

function peer(handle: SharedDocumentHandle, key: string, by: string) {
  const session = sharedHarness(adapterReplica(handle)), reports: unknown[] = [];
  let serial = 0;
  const shared = sharedBufferPorts(handle, session.session, { readers: bufferReaders, stamps: bufferStamps(by),
    author: () => ({ id: by + ":" + ++serial, by }), report: outcome => reports.push(outcome),
    recovered: value => reports.push(value), missingBase: value => reports.push(value) });
  const input = document.body.appendChild(document.createElement("input"));
  const target = sharedBufferedTarget(handle, key), stored = () => readSharedPaintedText(handle, target)?.text ?? null;
  let painted = () => {}, check = () => {};
  const bound = bindBufferedInput({ inputs: [input], key, stored, pasteLimit: key === TITLE_FIELD_KEY ? 300 : 200,
    position: offset => key === TITLE_FIELD_KEY ? beatPos(key, offset) : headingPos("H1", offset),
    owns: pos => key === TITLE_FIELD_KEY ? pos.kind === "beat" && pos.rowId === key : pos.kind === "heading" && pos.sceneId === "H1"
  }, { field: surface => createBufferedField(shared.bufferedText, surface), painted: createPaintedBeats(shared.paintedText),
    report: outcome => reports.push(outcome), shown: edit => edit(), repaint: () => {},
    onPainted: listener => { painted = listener; return () => {}; }, beforePaint: listener => { check = listener; return () => {}; } });
  return { input, edge: edgeInput(() => input), reports, session, stored,
    paint: () => { check(); painted(); }, close: () => { bound.dispose(); session.session.dispose(); } };
}

for (const key of [TITLE_FIELD_KEY, "heading:H1"]) {
  test(`rule 84 seeded three-writer name-box histories: ${key}, replacement, cut, insertion, reordered and duplicated delivery and a late joiner`, () => {
    let seed = 0x84c017;
    const limits: readonly string[] = [];
    const violations: string[] = [];
    for (let round = 0; round < 24; round++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const h = new Stage1ExecutorHarness([{ id: "R1", text: "beat" }], { title: "abcdef", sections: [{ id: "H1", name: "abcdef", firstSceneId: "R1" }] });
      h.join();
      const late = createMonitoredSharedDocument();
      const peers = [h.a, h.b, h.c].map((handle, index) => peer(handle, key, "writer" + index));
      const rotation = seed % 3, roles = [peers[rotation], peers[(rotation + 1) % 3], peers[(rotation + 2) % 3]];
      try {
        const replacement = roles[0], cut = roles[1], insertion = roles[2]; assert.ok(replacement && cut && insertion);
        replacement.input.focus(); replacement.edge.select(1, 3); replacement.edge.paste("X");
        cut.input.focus(); cut.edge.select(3, 5); cut.edge.cut();
        insertion.input.focus(); insertion.edge.select(6); insertion.edge.paste("Y");
        assert.deepEqual(roles.map(item => [item?.stored(), item?.input.value, item?.input.selectionStart, item?.reports]),
          [["aXdef", "aXdef", 2, []], ["abcf", "abcf", 3, []], ["abcdefY", "abcdefY", 7, []]]);
        assert.equal(cut.edge.copied(), "de");
        assert.deepEqual(roles.map(item => item?.session.executed.flatMap(command => command.operations.map(operation => operation.kind))),
          [["text-insert", "text-delete"], ["text-delete"], ["text-insert"]]);
        const order = ["D1", "rev", "dup"][round % 3] as "D1" | "rev" | "dup";
        h.queue.flush(order);
        assert.equal(applySharedUpdate(late, encodeSharedState(h.a)).ok, true);
        const outputs = [h.a, h.b, h.c, late].map(handle => readSharedPaintedText(handle, sharedBufferedTarget(handle, key))?.text);
        if (outputs.some(value => value !== "aXfY")) violations.push("text");
        assertReplicasAgree("seeded name-box clipboard", outputs.map((output, index) => ({ order: index === 3 ? "late-C" : order,
          replica: index === 0 ? "A" : index === 1 ? "B" : "C", output: [output] })));
        for (const item of peers) item.paint();
        assert.deepEqual(roles.map(item => [item?.input.value, item?.reports]), [["aXfY", []], ["aXfY", []], ["aXfY", []]]);
        assert.equal(insertion.input.selectionStart, 4);
      } finally { for (const item of peers) item.close(); destroySharedDocument(late); h.destroy(); document.body.innerHTML = ""; }
    }
    assert.deepEqual(violations, limits);
  });
}
