import "./_dom.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { PREF_EVENT, preferences, startPreferences } from "../legacy/preferences-bridge.ts";
import { __init, scriptScale, setScriptScale } from "../js/05s-script-zoom.js";

const frames = new Map();
let nextFrame = 1;
globalThis.requestAnimationFrame = (fn) => {
  const id = nextFrame++;
  frames.set(id, fn);
  return id;
};
globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
let centreLookups = 0;
document.elementFromPoint = () => {
  centreLookups++;
  return null;
};

function finishFrames() {
  for (let i = 0; frames.size && i < 100; i++) {
    const due = [...frames.values()];
    frames.clear();
    for (const fn of due) fn();
  }
  assert.equal(frames.size, 0);
}

const heard = [];
const stop = startPreferences({
  storage: () => localStorage,
  watch: () => () => {},
  announce: (change) => {
    heard.push(change);
    document.dispatchEvent(new window.CustomEvent(PREF_EVENT, { detail: change }));
  }
});
after(stop);
document.body.innerHTML = '<div id="root"></div><div id="rows"></div>';
__init();

for (const now of [true, false]) {
  test(`${now ? "immediate" : "animated"} zoom keeps 1.333 and its anchor after saving`, () => {
    setScriptScale(1, { now: true, quiet: true, noStore: true });
    finishFrames();
    heard.length = 0;
    centreLookups = 0;
    setScriptScale(1.333, { now, quiet: true });
    finishFrames();
    assert.equal(scriptScale(), 1.333);
    assert.equal(document.getElementById("root").style.getPropertyValue("--script-scale"), "1.333");
    assert.equal(preferences().scriptScale(), 1.33);
    assert.deepEqual(heard, [{ key: "splitpage-script-scale", value: "1.33" }]);
    assert.equal(centreLookups, 0);
  });
}
