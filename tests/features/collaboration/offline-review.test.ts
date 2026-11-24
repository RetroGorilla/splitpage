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
    const dialog = document.querySelector<HTMLDialogElement>("#offline-review");
    assert.ok(dialog);
    Object.assign(dialog, { showModal() { dialog.open = true; }, close() { dialog.open = false; } });
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
      restore.click();
      assert.equal(restore.disabled, false);
      assert.match(document.getElementById("offline-review-feedback")?.textContent ?? "", /Could not put the beat back/);
      restore.click();
      assert.equal(dialog.querySelector<HTMLButtonElement>(".offline-review-restore")?.disabled, true);
      restore.click();
      assert.equal(attempts, 2);
      assert.equal(owner.snapshot().offlineClashes[0]?.restored, true);
      owner.dismissOfflineClashes();
      assert.equal(dialog.open, false);
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
