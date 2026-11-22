import { bootApp, closeApp } from "./_legacy-shared-app-boot.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(() => { closeApp(); });

const { adoptReplacement, sharedSession } = await import("../bootstrap/wiring/session-owner.ts");
const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { writerControls } = await import("../bootstrap/wiring/writer.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const hook = window.__legacySharedTest;

const ROWS = [{ id: "r1", audioText: "Hello", visualText: "" }, { id: "r2", audioText: "World", visualText: "" }];
const HELLO = ["h1", "h2", "h3", "h4", "h5"];

function script(given = ROWS) {
  writerControls().closeWriter();
  adoptReplacement(migrateRows({ title: "Peer", rows: given }));
  undoOwner().flush();
  writerControls().openWriter();
}

test("legacy peer identity probe enumerates both UTF-16 units of an astral character", async () => {
  script();
  assert.deepEqual(await hook.enter(), { ok: true });
  try {
    const p = hook.peer;
    p.nameIdentities("app", "r1", 0, HELLO);
    p.hold();
    assert.equal(p.type("r1", 0, "\u{1F600}").kind, "applied");
    p.nameIdentities("peer", "r1", 0, ["p1", "p2"]);
    assert.deepEqual(p.identities("peer").find(beat => beat.beat === "r1").units, ["p1", "p2", ...HELLO]);
  } finally { if (sharedSession()) hook.leave(); }
});
