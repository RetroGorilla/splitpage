import "../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { currentMergeReview, mountMergeReviewFeature, stopMergeReviewFeature } from "../../src/bootstrap/wiring/merge-review.ts";
import { offerFileMerge, resetMergeOffer } from "../../src/legacy/merge-offer-bridge.ts";

function shownButton(): HTMLElement {
  document.body.innerHTML = '<div id="file-conflict-modal"><button id="file-conflict-merge"></button></div>';
  return document.getElementById("file-conflict-merge") as HTMLElement;
}

test("merge review wiring hands its offer to the bridge, replaces its mount and clears both when stopped", async () => {
  try {
    assert.equal(currentMergeReview(), null);
    let button = shownButton();
    resetMergeOffer();
    assert.equal(button.hidden, false, "nothing answers the bridge before the mount");
    assert.equal(await offerFileMerge(null, null), undefined);

    const first = mountMergeReviewFeature();
    assert.equal(currentMergeReview(), first);
    resetMergeOffer();
    assert.equal(button.hidden, true, "the bridge's reset reaches the mounted review");

    button = shownButton();
    await offerFileMerge(null, null);
    assert.equal(button.hidden, true, "the bridge's offer reaches the mounted review, which resets first");

    const next = mountMergeReviewFeature();
    assert.notEqual(first, next);
    assert.equal(currentMergeReview(), next);
    button = shownButton();
    resetMergeOffer();
    assert.equal(button.hidden, true);

    stopMergeReviewFeature();
    stopMergeReviewFeature();
    assert.equal(currentMergeReview(), null);
    button = shownButton();
    resetMergeOffer();
    assert.equal(button.hidden, false, "a stopped review no longer answers the bridge");
    assert.equal(await offerFileMerge(null, null), undefined);
  } finally {
    stopMergeReviewFeature();
    document.body.innerHTML = "";
  }
});
