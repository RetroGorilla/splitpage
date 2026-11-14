import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { bootApp, closeApp } from "../../src/test/_app-boot.mjs";
import { stopApp } from "../../src/bootstrap/app.ts";
import { enterSharedSession, leaveSharedSession } from "../../src/bootstrap/wiring/shared-session.ts";
import type { SharedSwitchPorts } from "../../src/bootstrap/wiring/shared-session.ts";
import { currentCapabilities } from "../../src/bootstrap/wiring/session-owner.ts";
import { openingStatus } from "../../src/bootstrap/wiring/ports/transitions.ts";
import { localFilesOwner } from "../../src/bootstrap/wiring/local-files.ts";
import { appActions } from "../../src/bootstrap/wiring/ports/actions.ts";
import { recoveryPanelBinding } from "../../src/bootstrap/wiring/recovery-panel.ts";
import { stopRowsRenderFeature, mountRowsRenderFeature } from "../../src/bootstrap/wiring/render.ts";
import { migrateRows } from "../../src/bootstrap/document-ports.ts";
import { fromHtml } from "../../src/bootstrap/richtext.ts";
import { fakeClock } from "../application/session-fakes.ts";

before(async () => {
  await bootApp(JSON.stringify({ title: "Recovery lifecycle", rows: [{ id: "R1", audioText: "Words" }] }));
  await localFilesOwner().tryResumeLastProject();
});
after(() => { stopApp(); closeApp(); });

test("C9 the real switch binding registers and releases recovery on normal leave and rolled-back enter", async () => {
  let serial = 0;
  const standalone = currentCapabilities(), reported: unknown[] = [];
  const ports: SharedSwitchPorts = { opening: openingStatus, refusal: () => null, settle: () => {}, detach: () => {},
    bindings: { ...recoveryPanelBinding, settle: () => null, leave: () => {
      recoveryPanelBinding.leave();
      assert.equal(appActions.has("recovery"), false);
      assert.equal(document.getElementById("shared-recovery-panel"), null);
    } }, common: standalone, standalone,
    migrate: migrateRows, docId: () => "d" + String(++serial).padStart(32, "0"), editor: () => "Alice",
    structure: { cells: fromHtml }, report: error => { reported.push(error); }, timers: fakeClock(), now: () => 0 };
  stopRowsRenderFeature();
  try {
    assert.equal(appActions.has("recovery"), false);
    assert.deepEqual(await enterSharedSession(ports), { ok: true });
    assert.equal(appActions.has("recovery"), true);
    assert.equal(appActions.invoke("recovery", "command-menu").kind, "ran");
    assert.ok(document.getElementById("shared-recovery-panel"));
    assert.deepEqual(leaveSharedSession(ports), { ok: true });
    assert.equal(appActions.has("recovery"), false);
    assert.equal(document.getElementById("shared-recovery-panel"), null);
    const broken: SharedSwitchPorts = { ...ports, detach: () => { throw new Error("rollback"); } };
    assert.deepEqual(await enterSharedSession(broken), { ok: false, reason: "enter-failed" });
    assert.equal(appActions.has("recovery"), false);
    assert.equal(document.getElementById("shared-recovery-panel"), null);
    assert.equal(reported.length, 1);
  } finally { mountRowsRenderFeature(); }
});
