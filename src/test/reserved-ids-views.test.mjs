import "./_dom.mjs";
import "./_preferences-started.mjs";
import "./_shot-hiding-started.mjs";
import "./_hide-shot-mounted.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../legacy/session-bridge.ts";
import { setHideShotScenes } from "../legacy/hide-shot-bridge.ts";
import { shotHiding } from "../legacy/shot-hiding-bridge.ts";
import { paintRowTimes } from "../js/05-render.js";
import { syncAnchorResolvedClasses } from "../js/10-comments.js";
import { PROTOTYPE_IDS } from "../core/document/id-map.ts";
import { loadTestDocument } from "./_document.mjs";

const row = (id, status) => ({ id: id, status: status || "todo", visualText: "", audioText: "one two three" });

test("hide shot scenes: a shot scene with an Object.prototype id is hidden like any other (#311)", () => {
  const saved = currentDocument();
  loadTestDocument(null);
  setHideShotScenes(true);
  try {
    const rows = [row("r1")].concat(PROTOTYPE_IDS.map((id) => row(id, "shot")), [row("r9")]);
    const items = shotHiding().groups(rows);
    assert.deepEqual(items.map((it) => it.strip || it.row.id), ["r1", PROTOTYPE_IDS, "r9"]);
  } finally {
    setHideShotScenes(false);
    loadTestDocument(saved);
  }
});

test("scene times: a scene with an Object.prototype id that is not on screen is skipped (#311)", () => {
  const saved = currentDocument();
  document.body.innerHTML = '<div id="rows"><div class="row" data-id="r1"><span class="row-start"></span><span class="row-read"></span></div></div>';
  loadTestDocument({ rows: [row("r1")].concat(PROTOTYPE_IDS.map((id) => row(id, "shot"))), comments: [] });
  try {
    paintRowTimes();
    assert.notEqual(document.querySelector(".row-start").textContent, "");
  } finally {
    loadTestDocument(saved);
    document.body.innerHTML = "";
  }
});

test("comment anchors: only a resolved comment's anchor is drawn resolved, whatever its id (#311)", () => {
  const saved = currentDocument();
  const ids = PROTOTYPE_IDS.concat(["c1"]);
  document.body.innerHTML = '<div id="rows">' +
    ids.map((id) => '<span class="cmt-anchor" data-cmt="' + id + '">x</span>').join("") + "</div>";
  loadTestDocument({ rows: [], comments: [{ id: "c1", resolved: true }, { id: "toString", resolved: false }] });
  try {
    syncAnchorResolvedClasses();
    const resolved = Array.from(document.querySelectorAll(".cmt-anchor.resolved"), (el) => el.getAttribute("data-cmt"));
    assert.deepEqual(resolved, ["c1"]);
  } finally {
    loadTestDocument(saved);
    document.body.innerHTML = "";
  }
});
