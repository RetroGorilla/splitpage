import assert from "node:assert/strict";
import { bootApp, closeApp } from "../../src/test/_app-boot.mjs";
import { stopApp } from "../../src/bootstrap/app.ts";
import { documentTransitions } from "../../src/bootstrap/wiring/transition-owners.ts";
import { currentCapabilities, currentDocument, sharedSession } from "../../src/bootstrap/wiring/session-owner.ts";
import { enterSharedSession, forceLeaveSharedSession, leaveRunningSharedSession } from "../../src/bootstrap/wiring/shared-session.ts";
import type { SharedSwitchPorts } from "../../src/bootstrap/wiring/shared-session.ts";
import { openNativeEditor } from "../../src/bootstrap/wiring/native-shared-session.ts";
import { openingStatus } from "../../src/bootstrap/wiring/ports/transitions.ts";
import { localFilesOwner } from "../../src/bootstrap/wiring/local-files.ts";
import { stopRowsRenderFeature } from "../../src/bootstrap/wiring/render.ts";
import { setHome } from "../../src/bootstrap/wiring/location-owner.ts";
import { migrateRows } from "../../src/bootstrap/document-ports.ts";
import { fakeClock } from "../application/session-fakes.ts";

const SOURCE = { title: "Captured script", rows: [{ id: "R1", audioText: "Captured words" }] };

export async function bootNativeEntrySwitchFixture() {
  await bootApp(JSON.stringify(SOURCE));
  await localFilesOwner().tryResumeLastProject();
  stopRowsRenderFeature();
}

export function stopNativeEntrySwitchFixture() {
  try {
    if (sharedSession()) {
      const left = leaveRunningSharedSession();
      if (!left.ok) forceLeaveSharedSession();
    }
  } finally {
    stopApp();
    closeApp();
  }
}

export function nativeEntrySwitchFixture() {
  assert.equal(sharedSession(), false);
  documentTransitions().open({ from: { raw: structuredClone(SOURCE) }, reason: "switch entry fixture" });
  setHome("none");
  let serial = 0;
  const standalone = currentCapabilities(), errors: unknown[] = [];
  const ports: SharedSwitchPorts = {
    opening: openingStatus, commandRefused: undefined, refusal: () => null, settle: () => {}, detach: () => {},
    common: standalone, standalone,
    migrate: migrateRows, docId: () => "d" + String(++serial).padStart(32, "0"), editor: () => "Editor",
    timers: fakeClock(), now: () => 0, report: error => { errors.push(error); }
  };
  return {
    ports,
    errors,
    enterNative: (customPorts: SharedSwitchPorts = ports) => {
      const opened: { value?: ReturnType<typeof openNativeEditor> } = {};
      return enterSharedSession(customPorts, (doc, failed) => {
        opened.value = openNativeEditor(customPorts, doc, failed);
        return opened.value.backend;
      }).then(outcome => ({ outcome, opened: opened.value }));
    },
    close: () => {
      if (sharedSession()) {
        const left = leaveRunningSharedSession();
        if (!left.ok) forceLeaveSharedSession();
      }
    }
  };
}

export function attemptNativeSwitchEntry(kind: "open" | "startNew") {
  try {
    documentTransitions()[kind]({ from: { raw: { title: "Replacement script", rows: [{ id: "R2", audioText: "Replacement words" }] } }, reason: "reentrant entry" });
    return { accepted: currentDocument()?.title };
  } catch (error) { return { refused: error instanceof Error ? error.message : String(error) }; }
}
