import { dom } from "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { S } = await import("../js/_state.js");
const { setHome } = await import("../js/_home.js");
const { saveDoc } = await import("../js/14-export.js");

dom.window.document.body.innerHTML =
  '<div id="toast-host"></div>' +
  '<button id="btn-save">Save</button><button id="wr-save">Save</button>' +
  '<span id="file-chip"><span id="file-chip-name"></span><span id="file-chip-state"></span></span>';

const doc = dom.window.document;
const toasts = () => Array.from(doc.querySelectorAll("#toast-host .toast"), (t) => t.textContent);

test.beforeEach(() => {
  setHome("none");
  S.state = null;
  S.saveButtonBusy = false;
  doc.getElementById("toast-host").innerHTML = "";
  for (const id of ["btn-save", "wr-save"]) {
    const b = doc.getElementById(id);
    b.textContent = "Save";
    b.disabled = false;
  }
});
test.after(() => { S.state = null; });

for (const [name, opts] of [
  ["a save", undefined],
  ["a save as", { saveAs: true }],
  ["an autosave", { auto: true }],
  ["an overwrite from the conflict dialog", { force: true }]
]) {
  test(`#276: ${name} with no document yet does not throw and touches nothing`, async () => {
    assert.equal(S.state, null);
    await assert.doesNotReject(() => saveDoc(opts));
    assert.equal(S.state, null);
    assert.equal(S.saveButtonBusy, false, "the Save buttons are not left busy");
    for (const id of ["btn-save", "wr-save"]) {
      assert.equal(doc.getElementById(id).textContent, "Save");
      assert.equal(doc.getElementById(id).disabled, false);
    }
    assert.deepEqual(toasts(), [], "the refusal is the entry point's to give, not saveDoc's");
  });
}
