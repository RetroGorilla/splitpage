import { SEED_TEXT, bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { table304Document } from "../../tests/application/raw-inputs.ts";

const REDRAW = "Could not draw the script. Nothing was lost — press Redraw before you start editing.";
const BROKE = "the boot render broke (#442)";

const seedTitle = JSON.parse(SEED_TEXT).title;
const events = [];
let giveDraft = null;
const draftTaken = new Promise((resolve) => { giveDraft = resolve; });
const bridge = {
  hasDraftToRestore: true,
  takeDraft: () => { events.push("takeDraft"); return draftTaken; },
  draftRestoreDone: (outcome) => { events.push("restore-done:" + outcome); },
  setDocumentState: (st) => { events.push("state:" + st.title); }
};
window.splitpageDesktop = new Proxy(bridge, {
  get(target, name) {
    if (name in target || typeof name !== "string") return target[name];
    if (/^on[A-Z]/.test(name)) return () => {};
    return async () => (/^(history|list)/.test(name) ? [] : null);
  }
});

let armed = true;
document.querySelectorAll = function (selector) {
  if (armed && String(selector).indexOf("#rows .gutter-btn") === 0) {
    armed = false;
    events.push("threw");
    throw new Error(BROKE);
  }
  return Document.prototype.querySelectorAll.call(this, selector);
};

const logged = [];
const consoles = [...new Set([window.console, globalThis.console])];
const realErrors = consoles.map((c) => c.error);
consoles.forEach((c) => { c.error = (e) => { logged.push((e && e.message) || String(e)); }; });

const idle = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const toastText = (el) => (el.classList.contains("has-action") ? el.firstChild.nodeValue : el.textContent);
const redrawToasts = () => Array.from(document.querySelectorAll("#toast-host .toast:not(.is-leaving)")).filter((el) => toastText(el) === REDRAW);

const booting = bootApp();
let bootError = null;
booting.catch((e) => { bootError = e; });
await idle();

after(() => {
  delete document.querySelectorAll;
  consoles.forEach((c, i) => { c.error = realErrors[i]; });
  closeApp();
});

test("a boot render that throws still finishes start-up: the document is loaded, Redraw is offered with the script blocked, and the desktop draft restore runs and draws it (#442)", async () => {
  assert.equal(armed, false, "the boot render ran");
  assert.equal(bootError, null, "start-up did not fail: " + (bootError && bootError.stack));
  assert.deepEqual(logged, [BROKE]);
  assert.equal(S.state.title, seedTitle);
  assert.equal(redrawToasts().length, 1, "Redraw is offered with the start-up text");
  assert.equal(Array.from(document.querySelectorAll("#toast-host .toast.error:not(.is-leaving)")).length, 1, "and with no other error toast");
  assert.equal(document.getElementById("rows").hasAttribute("inert"), true);
  assert.equal(document.getElementById("rows").children.length, 0, "nothing was drawn");
  const afterThrow = events.slice(events.indexOf("threw") + 1);
  assert.ok(afterThrow.includes("state:" + seedTitle), "start-up told the desktop app about the document: " + JSON.stringify(events));
  assert.ok(events.includes("takeDraft"));
  assert.equal(events.some((e) => e.indexOf("restore-done:") === 0), false, "the draft restore waits for the draft");

  giveDraft({ header: { origin: { kind: "untitled" } }, stateJson: JSON.stringify(table304Document("Taken draft")) });
  await booting;
  await idle();
  assert.equal(bootError, null);
  assert.deepEqual(events.filter((e) => e.indexOf("restore-done:") === 0), ["restore-done:applied"]);
  assert.equal(S.state.title, "Taken draft");
  assert.equal(document.getElementById("doc-title").value, "Taken draft", "the draft was drawn");
  assert.equal(redrawToasts().length, 0, "the clean draw took Redraw away");
  assert.equal(document.getElementById("rows").hasAttribute("inert"), false);
  assert.deepEqual(logged, [BROKE]);
});
