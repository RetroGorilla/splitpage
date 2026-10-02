import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { rowGroupItems, setHideShotScenes } from "../js/01b-hide-shot.js";
import { paintRowTimes } from "../js/05-render.js";
import { syncAnchorResolvedClasses } from "../js/10-comments.js";
import { PROTOTYPE_IDS } from "../core/document/id-map.ts";

const row = (id, status) => ({ id: id, status: status || "todo", visualText: "", audioText: "one two three" });

test("hide shot scenes: a shot scene with an Object.prototype id is hidden like any other (#311)", () => {
  const saved = S.state;
  S.state = null;
  setHideShotScenes(true);
  try {
    const rows = [row("r1")].concat(PROTOTYPE_IDS.map((id) => row(id, "shot")), [row("r9")]);
    const items = rowGroupItems(rows);
    assert.deepEqual(items.map((it) => it.strip || it.row.id), ["r1", PROTOTYPE_IDS, "r9"]);
  } finally {
    setHideShotScenes(false);
    S.state = saved;
  }
});

test("scene times: a scene with an Object.prototype id that is not on screen is skipped (#311)", () => {
  const saved = S.state;
  document.body.innerHTML = '<div id="rows"><div class="row" data-id="r1"><span class="row-start"></span><span class="row-read"></span></div></div>';
  S.state = { rows: [row("r1")].concat(PROTOTYPE_IDS.map((id) => row(id, "shot"))), comments: [] };
  try {
    paintRowTimes();
    assert.notEqual(document.querySelector(".row-start").textContent, "");
  } finally {
    S.state = saved;
    document.body.innerHTML = "";
  }
});

test("comment anchors: only a resolved comment's anchor is drawn resolved, whatever its id (#311)", () => {
  const saved = S.state;
  const ids = PROTOTYPE_IDS.concat(["c1"]);
  document.body.innerHTML = '<div id="rows">' +
    ids.map((id) => '<span class="cmt-anchor" data-cmt="' + id + '">x</span>').join("") + "</div>";
  S.state = { rows: [], comments: [{ id: "c1", resolved: true }, { id: "toString", resolved: false }] };
  try {
    syncAnchorResolvedClasses();
    const resolved = Array.from(document.querySelectorAll(".cmt-anchor.resolved"), (el) => el.getAttribute("data-cmt"));
    assert.deepEqual(resolved, ["c1"]);
  } finally {
    S.state = saved;
    document.body.innerHTML = "";
  }
});
