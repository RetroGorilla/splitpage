import "./_dom.mjs";
import "./_project-file-services-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../bootstrap/wiring/session-owner.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { mountProductionTagsFeature as initTags } from "../bootstrap/wiring/production-tags.ts";
import { mountMergeReviewFeature } from "../bootstrap/wiring/merge-review.ts";
import { loadTestDocument } from "./_document.mjs";

initTags();
const merge = mountMergeReviewFeature();

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

async function review(mine, theirs, base) {
  shell();
  loadTestDocument(migrateRows(JSON.parse(JSON.stringify(mine))));
  const file = new File([JSON.stringify(theirs)], "disk.splitpage", { type: "application/json" });
  await merge.offer(file, base ? { diskBase: migrateRows(base) } : null);
  assert.equal(document.getElementById("file-conflict-merge").hidden, false, "the merge is offered");
  merge.open();
  const heads = Array.from(document.querySelectorAll("#merge-review-list .merge-group-head"), (el) => el.firstChild.textContent);
  const text = document.getElementById("merge-review-list").textContent;
  merge.reset();
  return { heads: heads, text: text };
}

test("merge review: thumbnail and link removal are combined, rather than both video links kept (#1278)", async () => {
  const saved = currentDocument();
  try {
    const ref = { sha256: "b".repeat(64), width: 1, height: 1, mime: "image/png" };
    const link = { href: "https://example.test/video", poster: true };
    const base = doc([{ ...row("r1", "one"), imageRef: { ...ref, sha256: "a".repeat(64) }, moreImages: [{ links: [link] }] }]);
    const removed = structuredClone(base), changed = structuredClone(base);
    delete removed.rows[0].moreImages;
    changed.rows[0].moreImages[0].imageRef = ref;
    for (const [mine, theirs] of [[removed, changed], [changed, removed]]) {
      const result = await review(mine, theirs, base);
      assert.match(result.text, /both sets of changes are combined/);
      assert.doesNotMatch(result.text, /Both sides are kept|location is kept/);
    }
  } finally {
    loadTestDocument(saved);
    document.body.innerHTML = "";
  }
});

test("merge review: a scene only I hold named constructor is listed, and a scene __proto__ gets its number (#278)", async () => {
  const saved = currentDocument();
  try {
    const r = await review(
      doc([row("r1", "one"), row("__proto__", "two, mine"), row("constructor", "MINE ONLY")]),
      doc([row("r1", "one"), row("__proto__", "two, theirs")])
    );
    assert.deepEqual(r.heads, ["Beat A.2", "Beat A.3"]);
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
