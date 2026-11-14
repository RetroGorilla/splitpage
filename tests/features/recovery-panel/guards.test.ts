import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRecoveryPanel } from "../../../src/features/recovery-panel/mount.ts";
import { recoveryPanelActions, startRecoveryPanelActions } from "../../../src/features/recovery-panel/actions.ts";
import { createActionRegistry } from "../../../src/application/actions.ts";
import { fakeRecoveryPanelPorts } from "../fakes.ts";
import { enterSharedDocument } from "../../../src/core/migrate.ts";
import type { SharedRecoveryEntry } from "../../../src/core/collab/recovery.ts";

const removed: SharedRecoveryEntry = { kind: "removed-beat", row: { id: "R1", audioText: "Kept <text>" }, members: ["R1"],
  removal: { ids: ["gone"], by: "Alice", edited: [] } };

test("C9 standalone: no DOM, no registered action, no recovery/document reads or input work", () => {
  const f = fakeRecoveryPanelPorts([removed]), panel = createRecoveryPanel(f.ports), registry = createActionRegistry();
  const off = startRecoveryPanelActions({ registry, current: () => panel, session: f.ports.session });
  try {
    panel.open(); assert.equal(f.ports.host.childElementCount, 0); assert.deepEqual(registry.list(), []);
    const reads = [f.state.currentReads, f.state.reads, f.state.docReads, f.state.subscriptions];
    for (let key = 0; key < 20; key++) {
      f.ports.host.dispatchEvent(new window.InputEvent("beforeinput", { bubbles: true, data: "x" }));
      f.ports.host.dispatchEvent(new window.InputEvent("input", { bubbles: true, data: "x" }));
    }
    assert.deepEqual([f.state.currentReads, f.state.reads, f.state.docReads, f.state.subscriptions], reads);
    assert.deepEqual(reads.slice(1), [0, 0, 0]); assert.deepEqual(f.calls, []);
    const definition = recoveryPanelActions(() => panel, f.ports)[0]; assert.ok(definition);
    assert.deepEqual(definition.availability?.("command-menu"), { enabled: false, visible: false });
    definition.run("command-menu"); assert.equal(f.ports.host.childElementCount, 0);
  } finally { off(); panel.dispose(); f.ports.host.remove(); }
});

test("C9 follows mode changes, registers once, releases a vanished session and disposes its readers", () => {
  const f = fakeRecoveryPanelPorts([removed]), panel = createRecoveryPanel(f.ports), registry = createActionRegistry();
  const off = startRecoveryPanelActions({ registry, current: () => panel, session: f.ports.session });
  try {
    f.state.shared = true; f.changed(); f.changed();
    assert.equal(registry.list().length, 1); assert.equal(f.state.subscriptions, 1);
    assert.equal(registry.invoke("recovery", "command-menu").kind, "ran");
    assert.equal(f.ports.host.querySelector("pre")?.textContent, "Kept <text>");
    const old = [...f.ports.host.querySelectorAll("button")].find(button => button.textContent === "Restore"); assert.ok(old);
    f.state.shared = false; f.changed();
    assert.equal(f.ports.host.childElementCount, 0); assert.equal(f.state.subscriptions, 0); assert.deepEqual(registry.list(), []);
    old.click(); assert.deepEqual(f.calls, []);
    f.state.shared = true; f.changed(); panel.open();
    const late = [...f.mode]; off(); panel.dispose();
    for (const callback of late) callback();
    assert.equal(f.ports.host.childElementCount, 0); assert.equal(f.state.subscriptions, 0); assert.equal(f.mode.size, 0);
    assert.deepEqual(registry.list(), []); panel.open(); assert.equal(f.ports.host.childElementCount, 0);
  } finally { off(); panel.dispose(); f.ports.host.remove(); }
});

for (const outcome of [{ kind: "rejected", reason: "recovery-no-author" }, { kind: "rejected", reason: "viewing-only", notified: true },
  { kind: "failed", error: new Error("write failed") }] as const) test("C9 refusal feedback keeps the entry and never repeats a session warning: " + outcome.kind + "/" + ("reason" in outcome ? outcome.reason : "failure"), () => {
  const f = fakeRecoveryPanelPorts([removed]); f.state.shared = true; f.state.outcome = outcome;
  const panel = createRecoveryPanel(f.ports);
  try {
    panel.open(); const restore = [...f.ports.host.querySelectorAll("button")].find(button => button.textContent === "Restore"); assert.ok(restore); restore.click();
    assert.deepEqual(f.calls, [{ action: "restore", entry: { kind: "removed-beat", key: "R1" } }]);
    assert.equal(f.ports.host.querySelector("pre")?.textContent, "Kept <text>");
    assert.deepEqual(f.notices.shown.map(notice => [notice.message, notice.kind]), outcome.kind === "failed" ? [["Could not change recovery.", "warn"]]
      : "notified" in outcome ? [] : [["This is not available in a shared session yet.", "warn"]]);
    panel.dispose(); restore.click(); assert.equal(f.calls.length, 1);
  } finally { panel.dispose(); f.ports.host.remove(); }
});

test("C9 hides unsupported actions for damaged removals, unnamed fragments and a live person namesake", () => {
  const entries: SharedRecoveryEntry[] = [
    { kind: "removed-beat", row: { id: "R1", audioText: "Kept" }, members: ["R1"] },
    { kind: "unprojectable-fragment", reason: "missing-boundary", owner: null, segment: "S", field: "audioText", from: 0, to: 0, html: "", start: null },
    { kind: "deleted-person", person: "P1", name: "Pat", by: "Alice", owners: [], mentions: ["R1"] }
  ];
  const f = fakeRecoveryPanelPorts(entries, enterSharedDocument({ schema: 2, title: "", docId: "d1", rows: [], comments: [], people: [{ id: "P2", name: "pAt" }], productionTags: [], brollShots: [], wordsPerMinute: 150, rev: 0 }));
  f.state.shared = true; const panel = createRecoveryPanel(f.ports);
  try {
    panel.open(); const rows = [...f.ports.host.querySelectorAll("article")];
    assert.deepEqual(rows.map(row => [...row.querySelectorAll("button")].map(button => button.textContent)), [["Discard"], [], ["Discard"]]);
    assert.deepEqual(rows.map(row => row.querySelector("p")?.textContent), ["No author recorded", "No author recorded", "Alice"]);
    const close = [...f.ports.host.querySelectorAll("button")].find(button => button.textContent === "Close"); assert.ok(close); close.click();
    assert.equal(f.ports.host.childElementCount, 0);
  } finally { panel.dispose(); f.ports.host.remove(); }
});

test("C9 empty recovery wording and a remote publication repaint the open list", () => {
  const entries: SharedRecoveryEntry[] = [], f = fakeRecoveryPanelPorts(entries); f.state.shared = true;
  const panel = createRecoveryPanel(f.ports);
  try {
    panel.open(); assert.equal(f.ports.host.querySelector(".history-list")?.textContent, "Nothing in recovery.");
    entries.push(removed); f.publish(); assert.equal(f.ports.host.querySelector("pre")?.textContent, "Kept <text>");
  } finally { panel.dispose(); f.ports.host.remove(); }
});

test("C9 a removed group shows narration, visual, every picture name, comment replies and recorded provenance", () => {
  const entry: SharedRecoveryEntry = { kind: "removed-beat", row: { id: "R1", audioText: "Narration", visualText: "Visual", imageName: "First picture",
    moreImages: [{ name: "Second picture" }, null, 7], updatedBy: "Bob" }, members: ["R1"], comments: ["C1"], splitBy: "Cara",
    removal: { ids: ["gone"], by: "Alice", edited: [] } };
  const f = fakeRecoveryPanelPorts([entry], enterSharedDocument({ schema: 2, title: "", docId: "d1", rows: [],
    comments: [{ id: "C1", author: "Alice", body: "Note", replies: [{ id: "r1", author: "Bob", body: "Answer" }] }],
    people: [], productionTags: [], brollShots: [], wordsPerMinute: 150, rev: 0 }));
  f.state.shared = true; const panel = createRecoveryPanel(f.ports);
  try {
    panel.open(); assert.equal(f.ports.host.querySelector("pre")?.textContent, "Narration\nVisual\nFirst picture\nSecond picture\nAlice: Note\nBob: Answer");
    assert.equal(f.ports.host.querySelector("article p")?.textContent, "Removed by Alice\nLast edited by Bob\nSplit by Cara");
  } finally { panel.dispose(); f.ports.host.remove(); }
});
