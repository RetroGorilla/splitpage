import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { bootApp, closeApp } from "../../src/test/_app-boot.mjs";
import { stopApp } from "../../src/bootstrap/app.ts";
import { documentTransitions } from "../../src/bootstrap/wiring/transition-owners.ts";
import { openingStatus } from "../../src/bootstrap/wiring/ports/transitions.ts";
import { currentCapabilities, currentDocument, sharedSession } from "../../src/bootstrap/wiring/session-owner.ts";
import { openNativeEditor } from "../../src/bootstrap/wiring/native-shared-session.ts";
import { sharedUndoRoute, stepSharedUndo } from "../../src/bootstrap/wiring/undo.ts";
import { enterSharedSession, leaveRunningSharedSession } from "../../src/bootstrap/wiring/shared-session.ts";
import type { SharedSwitchPorts } from "../../src/bootstrap/wiring/shared-session.ts";
import { mountRowsRenderFeature, stopRowsRenderFeature } from "../../src/bootstrap/wiring/render.ts";
import { confirmSavedNow } from "../../src/bootstrap/wiring/save-owners.ts";
import { setHome } from "../../src/bootstrap/wiring/location-owner.ts";
import { migrateRows } from "../../src/bootstrap/document-ports.ts";
import { fakeClock } from "../application/session-fakes.ts";

const LONG = 130000;
const SOURCE = { schema: 2, docId: "d" + "1".repeat(32), title: "Entry source", rev: 1, rows: [{ id: "R1", audioText: "abc" }] };
before(async () => { await bootApp(JSON.stringify(SOURCE)); });
after(() => { stopApp(); closeApp(); });

function ports(errors: unknown[]): SharedSwitchPorts {
  const standalone = currentCapabilities();
  return { opening: openingStatus, commandRefused: undefined, refusal: () => null, settle: () => {}, detach: () => { setHome("none"); },
    common: standalone, standalone, migrate: migrateRows,
    docId: () => "d" + "2".repeat(32), editor: () => "Editor", report: error => { errors.push(error); }, timers: fakeClock(), now: () => 0 };
}

async function roundTrip(audioText: string) {
  documentTransitions().open({ from: { raw: { ...SOURCE, rows: [{ id: "R1", audioText }, { id: "R2", audioText: "after" }] } }, reason: "long row" });
  setHome("none"); confirmSavedNow(); stopRowsRenderFeature();
  const original = currentDocument()?.rows.map(row => row.audioText), errors: unknown[] = [];
  try {
    const entryPorts = ports(errors);
    const opened: { native?: ReturnType<typeof openNativeEditor>["native"] } = {};
    assert.deepEqual(await enterSharedSession(entryPorts, (doc, failed) => {
      const { backend, native } = openNativeEditor(entryPorts, doc, failed);
      opened.native = native;
      return backend;
    }), { ok: true });
    const native = opened.native;
    assert.ok(native);
    assert.deepEqual(currentDocument()?.rows.map(row => row.audioText), original);
    const at = native.commands.anchorText({ beat: "R1", cell: "narration" }, audioText.length);
    assert.ok(at.kind === "anchored");
    assert.equal(native.commands.typeText(at.range, "X", {}).kind, "written");
    await Promise.resolve();
    const typed = currentDocument()?.rows[0]?.audioText;
    const route = sharedUndoRoute();
    assert.ok(route);
    assert.deepEqual(stepSharedUndo(route, "undo", assert.fail), { ok: true, effective: true, label: "undo", selection: null });
    const undone = currentDocument()?.rows.map(row => row.audioText);
    assert.deepEqual(leaveRunningSharedSession(), { ok: true });
    assert.deepEqual(errors, []);
    return { original, typed, undone, landed: currentDocument()?.rows.map(row => row.audioText) };
  } finally {
    if (sharedSession()) leaveRunningSharedSession();
    mountRowsRenderFeature(); setHome("none");
  }
}

test("a row of 130,000 characters, past the call argument limit, enters a shared session, takes a typed character at its end, undoes it and lands as it went in, as a row of 3 does", async () => {
  const small = await roundTrip("xxx");
  assert.deepEqual(small, { original: ["xxx", "after"], typed: "xxxX", undone: ["xxx", "after"], landed: ["xxx", "after"] });
  const long = await roundTrip("x".repeat(LONG));
  const text = "x".repeat(LONG);
  assert.deepEqual(long, { original: [text, "after"], typed: text + "X", undone: [text, "after"], landed: [text, "after"] });
});
