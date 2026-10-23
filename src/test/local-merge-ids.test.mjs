import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../legacy/session-bridge.ts";
import { migrateRows } from "../js/02-state.js";
import { __init as initTags } from "../js/07-production-tags.js";
import { offerFileMerge, openMergeReview, resetMergeOffer } from "../js/18a-local-merge.js";
import { loadTestDocument } from "./_document.mjs";

initTags();

function shell() {
  document.body.innerHTML =
    '<div id="file-conflict-modal"><button id="file-conflict-merge" hidden></button></div>' +
    '<div id="merge-review-modal" hidden><p id="merge-review-detail"></p><div id="merge-review-list"></div>' +
    '<button id="merge-review-confirm"></button></div>';
}

function doc(rows, people) {
  return { schema: 2, title: "T", docId: "d" + "1".repeat(32), rows: rows, people: people || [], comments: [] };
}

const row = (id, text) => ({ id: id, audioText: text, visualText: "", status: "todo" });

async function review(mine, theirs) {
  shell();
  loadTestDocument(migrateRows(JSON.parse(JSON.stringify(mine))));
  const file = new File([JSON.stringify(theirs)], "disk.splitpage", { type: "application/json" });
  await offerFileMerge(file, null);
  assert.equal(document.getElementById("file-conflict-merge").hidden, false, "the merge is offered");
  openMergeReview();
  const heads = Array.from(document.querySelectorAll("#merge-review-list .merge-group-head"), (el) => el.firstChild.textContent);
  const text = document.getElementById("merge-review-list").textContent;
  resetMergeOffer();
  return { heads: heads, text: text };
}

test("merge review: a scene only I hold named constructor is listed, and a scene __proto__ gets its number (#278)", async () => {
  const saved = currentDocument();
  try {
    const r = await review(
      doc([row("r1", "one"), row("__proto__", "two, mine"), row("constructor", "MINE ONLY")]),
      doc([row("r1", "one"), row("__proto__", "two, theirs")])
    );
    assert.deepEqual(r.heads, ["Scene 02", "Scene 03"]);
    assert.match(r.text, /MINE ONLY/);
  } finally {
    loadTestDocument(saved);
    document.body.innerHTML = "";
  }
});

test("merge review: a crew member named constructor that only one side holds is listed under that name (#278)", async () => {
  const saved = currentDocument();
  try {
    const r = await review(
      doc([row("r1", "one")], [{ id: "p1", name: "Sam" }]),
      doc([row("r1", "one")], [{ id: "p1", name: "Sam" }, { id: "p2", name: "constructor" }])
    );
    assert.deepEqual(r.heads, ["Crew"]);
    assert.match(r.text, /Crew: constructor/);
    assert.doesNotMatch(r.text, /Object/);
  } finally {
    loadTestDocument(saved);
    document.body.innerHTML = "";
  }
});
