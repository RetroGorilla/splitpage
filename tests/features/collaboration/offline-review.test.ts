import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { jsdomWindow } from "../editing/jsdom.mjs";
import { createCollaborationState } from "../../../src/application/collaboration/state.ts";
import type { OfflineSavedBeat } from "../../../src/application/collaboration/offline-clashes.ts";
import { deriveDocumentNumbering } from "../../../src/core/document/numbering.ts";
import { createOfflineReview } from "../../../src/features/collaboration/offline-review.ts";

test("a refused put-back can be retried and restoring cannot be repeated by a stale button", () => {
  const page = readFileSync(new URL("../../../src/page.html", import.meta.url), "utf8");
  usingWindow(page, (window, document) => {
    const owner = createCollaborationState();
    const saved: OfflineSavedBeat = {
      id: "beat", row: "beat", narration: [{ text: "Saved", marks: {} }], visual: [],
      fields: {}, joined: null, placement: { scene: null, left: null, right: null, sceneOrder: ["beat"] }
    };
    const dialog = document.getElementById("offline-review");
    assert.ok(dialog);
    let attempts = 0;
    const view = createOfflineReview(window, {
      collaboration: owner,
      document: { onChange: () => () => {}, numbering: () => deriveDocumentNumbering({ rows: [] }) },
      readBeat: () => null,
      revealBeat: () => assert.fail("The beat was removed"),
      putBack: entry => owner.restoreOfflineClash(entry, () => {
        attempts++;
        assert.equal(owner.restoreOfflineClash(entry, () => assert.fail("Already restoring")), false);
        return attempts === 2;
      })
    });
    try {
      owner.enter();
      owner.setOfflineClashes([{ id: saved.id, mine: saved }]);
      document.getElementById("collab-offline-review")?.click();
      const restore = dialog.querySelector<HTMLButtonElement>(".offline-review-restore");
      assert.ok(restore);
      const trigger = document.getElementById("collab-offline-review");
      const close = document.getElementById("offline-review-close");
      assert.equal(document.activeElement, close);
      assert.equal(trigger?.getAttribute("aria-expanded"), "true");
      const view = document.defaultView;
      assert.ok(view);
      const key = (key: string, shiftKey = false) => document.activeElement?.dispatchEvent(
        new view.KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
      key("Tab", true);
      assert.equal(document.activeElement, restore);
      key("Tab");
      assert.equal(document.activeElement, close);
      let escaped = false;
      const otherEscape = () => { escaped = true; };
      window.addEventListener("keydown", otherEscape, { capture: true, once: true });
      key("Escape");
      window.removeEventListener("keydown", otherEscape, true);
      assert.equal(escaped, false);
      assert.equal(dialog.hidden, true);
      assert.equal(document.activeElement, trigger);
      assert.equal(trigger?.getAttribute("aria-expanded"), "false");
      trigger?.click();
      const newRestore = dialog.querySelector<HTMLButtonElement>(".offline-review-restore");
      assert.ok(newRestore);
      newRestore.click();
      assert.equal(newRestore.disabled, false);
      assert.match(document.getElementById("offline-review-feedback")?.textContent ?? "", /Could not put the beat back/);
      newRestore.click();
      assert.equal(dialog.querySelector<HTMLButtonElement>(".offline-review-restore")?.disabled, true);
      newRestore.click();
      assert.equal(attempts, 2);
      assert.equal(owner.snapshot().offlineClashes[0]?.restored, true);
      const summary = document.getElementById("collab-offline-summary");
      assert.equal(summary?.textContent, "All changes reviewed");
      owner.setOfflineClashes([{ id: saved.id, mine: structuredClone(saved) }]);
      assert.equal(owner.snapshot().offlineClashes[0]?.restored, true);
      assert.equal(dialog.querySelector<HTMLButtonElement>(".offline-review-restore")?.disabled, true);
      assert.equal(summary?.textContent, "All changes reviewed");
      owner.setOfflineClashes([{ id: saved.id, mine: { ...saved, narration: [{ text: "Later edit", marks: {} }] } }]);
      assert.equal(owner.snapshot().offlineClashes[0]?.restored, false);
      assert.equal(dialog.querySelector<HTMLButtonElement>(".offline-review-restore")?.disabled, false);
      assert.equal(summary?.textContent, "1 beat to review");
      owner.dismissOfflineClashes();
      assert.equal(dialog.hidden, true);
      assert.equal(document.getElementById("collab-offline-banner")?.hidden, true);
    } finally { view.dispose(); }
  });
});

function usingWindow(page: string, run: (window: Window, document: Document) => void): void {
  const window = jsdomWindow() as unknown as Window;
  window.document.documentElement.innerHTML = page;
  try { run(window, window.document); }
  finally { window.close(); }
}
