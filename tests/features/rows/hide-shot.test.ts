import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHideShot, hiddenShotStripHtml, mountHideShotSwitch } from "../../../src/features/rows/hide-shot.ts";
import type { ShotGroup, ShotRow } from "../../../src/application/shot-hiding.ts";
import { fakeNotices } from "../fakes.ts";

function setup() {
  document.body.innerHTML = '<button id="hide-shot-toggle" role="switch" aria-checked="false"></button>';
  let on = false;
  const expanded: string[][] = [];
  const notices = fakeNotices();
  const controls = createHideShot({
    shots: {
      on: () => on,
      set: (next) => {
        if (next === on) return false;
        on = next;
        return true;
      },
      expand: (ids) => { expanded.push([...ids]); },
      groups: <R extends ShotRow>(rows: readonly R[]): ShotGroup<R>[] =>
        on ? [{ strip: rows.filter((r) => r.status === "shot").map((r) => r.id) }, ...rows.filter((r) => r.status !== "shot").map((row) => ({ row, index: rows.indexOf(row) }))]
          : rows.map((row, index) => ({ row, index }))
    },
    notices: notices.notices,
    switchButton: () => document.getElementById("hide-shot-toggle")
  });
  return { controls, notices, expanded };
}

test("hide shot: toggling sets the owner, flips the header switch and says what changed", () => {
  const { controls, notices } = setup();
  controls.toggle();
  assert.equal(document.getElementById("hide-shot-toggle")?.getAttribute("aria-checked"), "true");
  controls.toggle();
  assert.equal(document.getElementById("hide-shot-toggle")?.getAttribute("aria-checked"), "false");
  assert.deepEqual(notices.shown.map((n) => n.message), [
    "Hiding filmed beats — collapsed into strips you can click open.",
    "Showing every beat again."
  ]);
});

test("hide shot: the header switch runs its toggle on each click and refreshes when focus leaves, until it is unmounted", () => {
  setup();
  const button = document.getElementById("hide-shot-toggle");
  let runs = 0;
  let refreshes = 0;
  const unmount = mountHideShotSwitch(button, () => { runs++; }, () => { refreshes++; });
  button?.click();
  button?.click();
  const focusOut = () => new (document.defaultView as Window & typeof globalThis).Event("focusout", { bubbles: true });
  button?.dispatchEvent(focusOut());
  unmount();
  button?.click();
  button?.dispatchEvent(focusOut());
  assert.equal(runs, 2);
  assert.equal(refreshes, 1);
  assert.doesNotThrow(() => { mountHideShotSwitch(null, () => { runs++; }, () => { refreshes++; })(); });
});

test("hide shot: a strip's ids expand through the owner, and groups render as strips and rows", () => {
  const { controls, expanded } = setup();
  controls.expand("r1,r2");
  controls.expand("");
  assert.deepEqual(expanded, [["r1", "r2"]]);
  controls.set(true);
  const html = controls.renderGroups([{ id: "r1", status: "shot" }, { id: "r2", status: "todo" }], (row, index) => "[" + row.id + "@" + index + "]");
  assert.equal(html, hiddenShotStripHtml(["r1"]) + "[r2@1]");
});
