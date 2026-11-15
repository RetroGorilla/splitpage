import assert from "node:assert/strict";
import { bootApp, closeApp } from "../../src/test/_app-boot.mjs";
import { stopApp } from "../../src/bootstrap/app.ts";
import { documentTransitions } from "../../src/bootstrap/wiring/transition-owners.ts";
import { currentCapabilities, currentDocument } from "../../src/bootstrap/wiring/session-owner.ts";
import { enterSharedSession, leaveRunningSharedSession, sharedSessionParts } from "../../src/bootstrap/wiring/shared-session.ts";
import type { SharedSwitchPorts } from "../../src/bootstrap/wiring/shared-session.ts";
import { openingStatus } from "../../src/bootstrap/wiring/ports/transitions.ts";
import { localFilesOwner } from "../../src/bootstrap/wiring/local-files.ts";
import { stopRowsRenderFeature } from "../../src/bootstrap/wiring/render.ts";
import { setHome } from "../../src/bootstrap/wiring/location-owner.ts";
import { migrateRows } from "../../src/bootstrap/document-ports.ts";
import { fromHtml } from "../../src/bootstrap/richtext.ts";
import { collabState } from "../../src/adapters/collab/state.ts";
import { destroySharedDocument } from "../../src/adapters/collab/document.ts";
import { fakeClock } from "../application/session-fakes.ts";

const SOURCE = { title: "Captured script", rows: [{ id: "R1", audioText: "Captured words" }] };

export async function bootEntrySwitchFixture() {
  await bootApp(JSON.stringify(SOURCE));
  await localFilesOwner().tryResumeLastProject();
  stopRowsRenderFeature();
}

export function stopEntrySwitchFixture() {
  const parts = sharedSessionParts();
  try { if (parts) leaveRunningSharedSession(); }
  finally {
    if (parts && !collabState(parts.handle).destroyed) destroySharedDocument(parts.handle);
    stopApp(); closeApp();
  }
}

export function entrySwitchFixture() {
  assert.equal(sharedSessionParts() === null, true);
  documentTransitions().open({ from: { raw: structuredClone(SOURCE) }, reason: "switch entry fixture" });
  setHome("none");
  let serial = 0;
  const standalone = currentCapabilities(), errors: unknown[] = [];
  const ports: SharedSwitchPorts = { opening: openingStatus, commandRefused: undefined, refusal: () => null, settle: () => {}, detach: () => {},
    bindings: { enter: () => {}, settle: () => null, leave: () => {} }, common: standalone, standalone,
    migrate: migrateRows, docId: () => "d" + String(++serial).padStart(32, "0"), editor: () => "Editor",
    structure: { cells: fromHtml }, timers: fakeClock(), now: () => 0, report: error => { errors.push(error); } };
  return { ports, errors, enter: () => enterSharedSession(ports), close: () => {
    if (sharedSessionParts()) leaveRunningSharedSession();
  } };
}

export function attemptSwitchEntry(kind: "open" | "startNew") {
  try {
    documentTransitions()[kind]({ from: { raw: { title: "Replacement script", rows: [{ id: "R2", audioText: "Replacement words" }] } }, reason: "reentrant entry" });
    return { accepted: currentDocument()?.title };
  } catch (error) { return { refused: error instanceof Error ? error.message : String(error) }; }
}
