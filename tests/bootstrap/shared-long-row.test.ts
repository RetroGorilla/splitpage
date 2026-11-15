import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { bootApp, closeApp } from "../../src/test/_app-boot.mjs";
import { stopApp } from "../../src/bootstrap/app.ts";
import { documentTransitions } from "../../src/bootstrap/wiring/transition-owners.ts";
import { openingStatus } from "../../src/bootstrap/wiring/ports/transitions.ts";
import { currentCapabilities, currentDocument, runCommand, sharedSession } from "../../src/bootstrap/wiring/session-owner.ts";
import { enterSharedSession, leaveRunningSharedSession, sharedSessionParts } from "../../src/bootstrap/wiring/shared-session.ts";
import type { SharedSwitchPorts } from "../../src/bootstrap/wiring/shared-session.ts";
import { mountRowsRenderFeature, stopRowsRenderFeature } from "../../src/bootstrap/wiring/render.ts";
import { confirmSavedNow } from "../../src/bootstrap/wiring/save-owners.ts";
import { setHome } from "../../src/bootstrap/wiring/location-owner.ts";
import { writerFlowCommands } from "../../src/bootstrap/wiring/ports/writer-flow.ts";
import { migrateRows } from "../../src/bootstrap/document-ports.ts";
import { fromHtml } from "../../src/bootstrap/richtext.ts";
import { collabState } from "../../src/adapters/collab/state.ts";
import * as flow from "../../src/core/flow/flow.ts";
import { fakeClock } from "../application/session-fakes.ts";

const LONG = 130000;
const SOURCE = { schema: 2, docId: "d" + "1".repeat(32), title: "Entry source", rev: 1, rows: [{ id: "R1", audioText: "abc" }] };
before(async () => { await bootApp(JSON.stringify(SOURCE)); });
after(() => { stopApp(); closeApp(); });

function ports(errors: unknown[]): SharedSwitchPorts {
  const standalone = currentCapabilities();
  return { opening: openingStatus, commandRefused: undefined, refusal: () => null, settle: () => {}, detach: () => { setHome("none"); },
    bindings: { enter: () => {}, settle: () => null, leave: () => {} }, common: standalone, standalone, migrate: migrateRows,
    docId: () => "d" + "2".repeat(32), editor: () => "Editor", structure: { cells: fromHtml }, report: error => { errors.push(error); }, timers: fakeClock(), now: () => 0 };
}

async function roundTrip(audioText: string) {
  documentTransitions().open({ from: { raw: { ...SOURCE, rows: [{ id: "R1", audioText }, { id: "R2", audioText: "after" }] } }, reason: "long row" });
  setHome("none"); confirmSavedNow(); stopRowsRenderFeature();
  const original = currentDocument()?.rows.map(row => row.audioText), errors: unknown[] = [];
  try {
    assert.deepEqual(await enterSharedSession(ports(errors)), { ok: true });
    const parts = sharedSessionParts(); assert.ok(parts);
    assert.deepEqual(currentDocument()?.rows.map(row => row.audioText), original);
    const length = audioText.length;
    const commands = writerFlowCommands({ cells: fromHtml, newId: () => "new", hasVisual: () => false },
      { author: parts.author, writer: () => String(collabState(parts.handle).doc.clientID), handle: () => parts.handle });
    const at = flow.caretAt(flow.beatPos("R1", length));
    const typing = commands.commands.prepare("typing", doc => flow.replaceRange(doc, at, [{ text: "X", marks: {} }], commands.flow),
      { clock: { nowIso: () => "2026-11-14T00:00:00.000Z" }, editor: { name: () => "Editor" } }, at);
    assert.equal(runCommand(typing.command).kind, "applied");
    const typed = currentDocument()?.rows[0]?.audioText;
    assert.deepEqual([parts.undo.undo()].map(outcome => outcome.ok && outcome.effective), [true]);
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
