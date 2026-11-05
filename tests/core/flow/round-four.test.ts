import { test } from "node:test";
import assert from "node:assert/strict";
import { flowCommand } from "../../../src/application/commands/flow.ts";
import { beatPos, caretAt, headingPos, insertBeats, joinWithPrevious, renameHeading, replaceRange } from "../../../src/core/flow/flow.ts";
import type { FlowEdit, FlowOutcome, FlowRow } from "../../../src/core/flow/flow.ts";
import { rowSlots } from "../../../src/core/document/gallery.ts";
import { slotPoster } from "../../../src/features/common/gallery.ts";
import { harness, runConfined } from "../../application/session-fakes.ts";
import { createFlowLoadRuntime } from "./load.ts";

const stamps = { clock: { nowIso: () => "2026-11-04T12:00:00Z" }, editor: { name: () => "Editor" } };
const image = { sha256: "a".repeat(64), width: 1, height: 1, mime: "image/png" };
const href = "https://example.com/video";
function edited(out: FlowOutcome): FlowEdit {
  assert.ok(out && "rows" in out, JSON.stringify(out));
  return out;
}

test("R4-1: a whitespace-only heading rename is a no-op before further input", () => {
  const rt = createFlowLoadRuntime();
  const h = harness(undefined, { entry: rt.load });
  h.session.adopt({ rows: [{ id: "p", audioText: "Previous" }, { id: "a", audioText: "Body" }], sections: [{ id: "s", name: "Title", firstSceneId: "a" }] });
  const before = JSON.stringify(h.session.held());
  for (const name of ["", "   ", "\t\n", "\u00a0", " ".repeat(201), "<b></b>"]) {
    assert.equal(renameHeading(h.session.held() as NonNullable<ReturnType<typeof h.session.held>>, "s", name, name.length), null);
    assert.equal(runConfined(h.session, flowCommand("blank-heading", doc => renameHeading(doc, "s", name, name.length), stamps)).kind, "noop");
    assert.equal(JSON.stringify(h.session.held()), before);
  }
  assert.equal(h.session.generation(), 0);
  const result = runConfined(h.session, flowCommand("type-after-refused-rename", doc => replaceRange(doc, caretAt(headingPos("s", 5)), [{ text: "X", marks: {} }], rt.ports), stamps));
  assert.equal(result.kind, "applied");
  assert.equal((h.session.held()?.["sections"] as { name: string }[])[0]?.name, "TitleX");
  assert.equal(h.session.held()?.rows[1]?.paragraphStart, undefined);
  h.session.dispose();
});

test("R4-2: a duplicate link carries the later poster marker without claiming a poster was dropped", () => {
  const rt = createFlowLoadRuntime();
  const doc = rt.load({ rows: [{ id: "a", imageRef: image, imageLinks: [{ href }] }, { id: "b", imageRef: image, imageLinks: [{ href, poster: true }] }] });
  const out = edited(joinWithPrevious(doc, "b", rt.ports));
  const slot = rowSlots(out.rows[0])[0];
  assert.ok(slot);
  assert.equal(slot.links.length, 1);
  assert.equal(slot.links.filter(link => link.poster).length, 1);
  assert.equal(slotPoster(slot)?.href, href);
  assert.equal(slotPoster(slot)?.poster, true);
  assert.doesNotMatch(out.notice ?? "", /Kept one poster|Left out.*link/);
  assert.match(out.notice ?? "", /Combined duplicate pictures/);
});

test("R4-2: losing an over-limit sole poster link never claims one was kept", () => {
  const rt = createFlowLoadRuntime();
  const doc = rt.load({ rows: [{ id: "a", imageRef: image, imageLinks: Array.from({ length: 20 }, (_, i) => ({ href: "https://example.com/" + i })) },
    { id: "b", imageRef: image, imageLinks: [{ href, poster: true }] }] });
  const out = edited(joinWithPrevious(doc, "b", rt.ports));
  const slot = rowSlots(out.rows[0])[0];
  assert.ok(slot);
  assert.equal(slot.links.filter(link => link.poster).length, 0);
  assert.equal(slotPoster(slot), null);
  assert.match(out.notice ?? "", /Left out 1 picture link/);
  assert.doesNotMatch(out.notice ?? "", /Kept one poster/);
});

test("R4-3: every supplied inserted flag is absent unless it is literal true", () => {
  const rt = createFlowLoadRuntime();
  for (const value of [false, "false", 0, 1, "true", null, {}, [], true]) {
    const h = harness(undefined, { entry: rt.load });
    h.session.adopt({ rows: [{ id: "a", audioText: "Body" }] });
    const supplied = [{ id: "x", audioText: "New" }, { id: "y", audioText: "Tail", paragraphStart: value }] as unknown as FlowRow[];
    assert.equal(runConfined(h.session, flowCommand("insert-flags", doc => insertBeats(doc, beatPos("a", 2), supplied, rt.ports), stamps)).kind, "applied");
    const row = h.session.held()?.rows.find(item => item.id === "y");
    assert.ok(row);
    assert.equal(row.paragraphStart, value === true ? true : undefined);
    assert.deepEqual(h.session.held(), rt.load(h.session.held()));
    h.session.dispose();
  }
});

test("R4 audit: supplied statuses and beat lengths use their stored policies before reload", () => {
  const rt = createFlowLoadRuntime();
  const cases = [{ status: "invalid", lengthSeconds: -1, expectedStatus: "todo", expectedLength: undefined },
    { status: "ready", lengthSeconds: 1.4, expectedStatus: "ready", expectedLength: 1 },
    { status: 0, lengthSeconds: "3", expectedStatus: "todo", expectedLength: undefined }];
  for (const item of cases) {
    const h = harness(undefined, { entry: rt.load });
    h.session.adopt({ rows: [{ id: "a", audioText: "Body" }] });
    try {
      const supplied = [{ id: "x", audioText: "New", status: item.status, lengthSeconds: item.lengthSeconds }];
      assert.equal(runConfined(h.session, flowCommand("row-policy-audit", doc => insertBeats(doc, beatPos("a", 2), supplied, rt.ports), stamps)).kind, "applied");
      const row = h.session.held()?.rows.find(value => value.id === "x");
      assert.equal(row?.status, item.expectedStatus);
      assert.equal(row?.lengthSeconds, item.expectedLength);
      assert.deepEqual(rt.load(h.session.held()), h.session.held());
    } finally { h.session.dispose(); }
  }
});
