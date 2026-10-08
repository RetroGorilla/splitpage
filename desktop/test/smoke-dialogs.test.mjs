import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createDialogHelpers, modalShownExpr } from "./smoke-dialogs.mjs";

const PAGE = `
<button id="btn-file">File</button>
<div id="file-menu" hidden>
  <button data-file-action="servers">Servers</button>
  <button id="menu-server-open" hidden>Open from server</button>
</div>
<div class="modal-backdrop" id="server-modal" hidden>
  <button data-action="server-open" data-id="d1">Open</button>
</div>
<div class="modal-backdrop" id="pin-modal" hidden>
  <input id="pin-input"><button data-connect-action="pin-submit">OK</button>
</div>
<div class="modal-backdrop" id="connect-modal" hidden>
  <input id="connect-name"><input id="connect-url"><input id="connect-pin">
  <input type="checkbox" id="connect-remember">
  <input type="checkbox" id="connect-ssh-toggle">
  <input id="connect-ssh-userhost"><input id="connect-ssh-remote"><input id="connect-ssh-local">
  <button data-connect-action="add">Add</button>
  <button data-connect-action="close">Close</button>
</div>
<div class="modal-backdrop" id="late-modal" hidden></div>`;

function makePage(options) {
  const opts = options || {};
  const dom = new JSDOM(PAGE, { runScripts: "outside-only" });
  const { window } = dom;
  const doc = window.document;
  const seen = { added: [], opened: [], pins: [] };
  window.__hostedTest = { conn: () => ({ serverUrl: seen.added[0] || "", hasToken: seen.added.length > 0 }) };
  const menu = doc.getElementById("file-menu");
  if (opts.pickerItem) doc.getElementById("menu-server-open").hidden = false;
  if (opts.serversItemHidden) doc.querySelector("#file-menu [data-file-action=servers]").hidden = true;
  doc.getElementById("btn-file").addEventListener("click", () => {
    menu.hidden = !menu.hidden;
  });
  const openLater = (id) => {
    if (opts.openDelayMs) setTimeout(() => { doc.getElementById(id).hidden = false; }, opts.openDelayMs);
    else doc.getElementById(id).hidden = false;
  };
  doc.querySelector("#file-menu [data-file-action=servers]").addEventListener("click", () => {
    menu.hidden = true;
    if (opts.refuseServers) return;
    openLater("connect-modal");
  });
  doc.getElementById("menu-server-open").addEventListener("click", () => {
    menu.hidden = true;
    if (opts.refusePicker) return;
    openLater("server-modal");
  });
  doc.querySelector("#connect-modal [data-connect-action=add]").addEventListener("click", () => {
    seen.added.push(doc.getElementById("connect-url").value);
    doc.getElementById("menu-server-open").hidden = false;
  });
  doc.querySelector("#connect-modal [data-connect-action=close]").addEventListener("click", () => {
    doc.getElementById("connect-modal").hidden = true;
  });
  doc.querySelector("#server-modal [data-action=server-open]").addEventListener("click", () => {
    seen.opened.push("d1");
  });
  doc.querySelector("#pin-modal [data-connect-action=pin-submit]").addEventListener("click", () => {
    seen.pins.push(doc.getElementById("pin-input").value);
  });
  return { window, doc, seen };
}

function helpersFor(page, beforeEval) {
  const evalPage = async (cdp, expression) => {
    if (beforeEval) beforeEval(expression);
    return cdp.window.eval(expression);
  };
  const poll = async (cdp, expression, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = cdp.window.eval(expression);
      if (value) return value;
      if (Date.now() > deadline) throw new Error("timed out waiting for: " + expression);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return createDialogHelpers({ evalPage, poll, shownTimeoutMs: 60, listedTimeoutMs: 60, joinedTimeoutMs: 200 });
}

const SRV = { port: 1, url: "http://127.0.0.1:1/", pin: "1234" };

test("modalShownExpr is false for a missing or hidden dialog and true for the front one", () => {
  const { window, doc } = makePage();
  assert.equal(window.eval(modalShownExpr("nope")), false);
  assert.equal(window.eval(modalShownExpr("connect-modal")), false);
  doc.getElementById("connect-modal").hidden = false;
  assert.equal(window.eval(modalShownExpr("connect-modal")), true);
});

test("modalShownExpr is false for an open dialog with another one in front of it", () => {
  const { window, doc } = makePage();
  doc.getElementById("server-modal").hidden = false;
  doc.getElementById("pin-modal").hidden = false;
  assert.equal(window.eval(modalShownExpr("server-modal")), false);
  assert.equal(window.eval(modalShownExpr("pin-modal")), true);
});

test("connectTabViaDialog fills the shown dialog and joins", async () => {
  const page = makePage();
  const ok = await helpersFor(page).connectTabViaDialog(page, SRV, { name: "Mine" });
  assert.equal(ok, true);
  assert.deepEqual(page.seen.added, [SRV.url]);
  assert.equal(page.doc.getElementById("connect-name").value, "Mine");
  assert.equal(page.doc.getElementById("connect-modal").hidden, true);
});

test("connectTabViaDialog fails, and touches no control, when the Servers command was refused", async () => {
  const page = makePage({ refuseServers: true });
  const ok = await helpersFor(page).connectTabViaDialog(page, SRV);
  assert.equal(ok, false);
  assert.deepEqual(page.seen.added, []);
  assert.equal(page.doc.getElementById("connect-url").value, "");
});

test("connectTabViaDialog fails when the dialog opened behind another one", async () => {
  const page = makePage();
  page.doc.querySelector("#file-menu [data-file-action=servers]").addEventListener("click", () => {
    page.doc.getElementById("late-modal").hidden = false;
  });
  const ok = await helpersFor(page).connectTabViaDialog(page, SRV);
  assert.equal(ok, false);
  assert.deepEqual(page.seen.added, []);
});

test("openViaPicker clicks the row of the shown picker", async () => {
  const page = makePage({ pickerItem: true });
  assert.equal(await helpersFor(page).openViaPicker(page, "d1"), true);
  assert.deepEqual(page.seen.opened, ["d1"]);
});

test("openViaPicker fails, and clicks no row, when the picker stayed hidden although its rows exist", async () => {
  const page = makePage({ refusePicker: true, pickerItem: true });
  assert.equal(await helpersFor(page).openViaPicker(page, "d1"), false);
  assert.deepEqual(page.seen.opened, []);
});

test("openViaPicker fails when the picker sits behind another open dialog", async () => {
  const page = makePage({ pickerItem: true });
  page.doc.getElementById("pin-modal").hidden = false;
  assert.equal(await helpersFor(page).openViaPicker(page, "d1"), false);
  assert.deepEqual(page.seen.opened, []);
});

test("openViaPicker fails for a document the picker does not list", async () => {
  const page = makePage({ pickerItem: true });
  assert.equal(await helpersFor(page).openViaPicker(page, "missing"), false);
  assert.deepEqual(page.seen.opened, []);
});

test("openViaPicker fails, and opens nothing, when the picker was already open and its command is refused", async () => {
  const page = makePage({ refusePicker: true, pickerItem: true });
  page.doc.getElementById("server-modal").hidden = false;
  assert.equal(await helpersFor(page).openViaPicker(page, "d1"), false);
  assert.deepEqual(page.seen.opened, []);
});

test("openViaPicker fails when the menu item is hidden, although its handler would still open the picker", async () => {
  const page = makePage();
  assert.equal(await helpersFor(page).openViaPicker(page, "d1"), false);
  assert.equal(page.doc.getElementById("server-modal").hidden, true);
  assert.deepEqual(page.seen.opened, []);
});

test("openViaPicker waits for a picker that opens after a short delay", async () => {
  const page = makePage({ pickerItem: true, openDelayMs: 25 });
  assert.equal(await helpersFor(page).openViaPicker(page, "d1"), true);
  assert.deepEqual(page.seen.opened, ["d1"]);
});

test("connectTabViaDialog fails, and touches no control, when the dialog was already open and Servers is refused", async () => {
  const page = makePage({ refuseServers: true });
  page.doc.getElementById("connect-modal").hidden = false;
  assert.equal(await helpersFor(page).connectTabViaDialog(page, SRV), false);
  assert.deepEqual(page.seen.added, []);
  assert.equal(page.doc.getElementById("connect-url").value, "");
});

test("connectTabViaDialog fails when the Servers menu item is hidden, although its handler would still open the dialog", async () => {
  const page = makePage({ serversItemHidden: true });
  assert.equal(await helpersFor(page).connectTabViaDialog(page, SRV), false);
  assert.equal(page.doc.getElementById("connect-modal").hidden, true);
  assert.deepEqual(page.seen.added, []);
});

test("connectTabViaDialog leaves an already open File menu open for the click instead of toggling it shut", async () => {
  const page = makePage();
  page.doc.getElementById("file-menu").hidden = false;
  assert.equal(await helpersFor(page).connectTabViaDialog(page, SRV), true);
  assert.deepEqual(page.seen.added, [SRV.url]);
});

test("connectTabViaDialog waits for a dialog that opens after a short delay", async () => {
  const page = makePage({ openDelayMs: 25 });
  assert.equal(await helpersFor(page).connectTabViaDialog(page, SRV), true);
  assert.deepEqual(page.seen.added, [SRV.url]);
});

test("connectTabViaDialog fails, and fills nothing, when the dialog is gone again by the time the fields are filled", async () => {
  const page = makePage();
  const helpers = helpersFor(page, (expression) => {
    if (expression.includes("connect-name")) page.doc.getElementById("connect-modal").hidden = true;
  });
  assert.equal(await helpers.connectTabViaDialog(page, SRV), false);
  assert.equal(page.doc.getElementById("connect-url").value, "");
  assert.deepEqual(page.seen.added, []);
});

test("openViaPicker fails, and clicks no row, when the picker is gone again by the time the row is clicked", async () => {
  const page = makePage({ pickerItem: true });
  const helpers = helpersFor(page, (expression) => {
    if (expression.includes("#server-modal [data-action")) page.doc.getElementById("server-modal").hidden = true;
  });
  assert.equal(await helpers.openViaPicker(page, "d1"), false);
  assert.deepEqual(page.seen.opened, []);
});

test("submitPin fails, and submits nothing, when the prompt is gone again by the time the PIN is typed", async () => {
  const page = makePage();
  page.doc.getElementById("pin-modal").hidden = false;
  const helpers = helpersFor(page, (expression) => {
    if (expression.includes("pin-input")) page.doc.getElementById("pin-modal").hidden = true;
  });
  assert.equal(await helpers.submitPin(page, "4321"), false);
  assert.deepEqual(page.seen.pins, []);
});

test("submitPin waits for a PIN prompt that appears after a short delay", async () => {
  const page = makePage();
  setTimeout(() => { page.doc.getElementById("pin-modal").hidden = false; }, 25);
  assert.equal(await helpersFor(page).submitPin(page, "4321"), true);
  assert.deepEqual(page.seen.pins, ["4321"]);
});

test("submitPin types into and submits the shown PIN prompt", async () => {
  const page = makePage();
  page.doc.getElementById("pin-modal").hidden = false;
  assert.equal(await helpersFor(page).submitPin(page, "4321"), true);
  assert.deepEqual(page.seen.pins, ["4321"]);
});

test("submitPin fails, and submits nothing, when the PIN prompt is hidden", async () => {
  const page = makePage();
  assert.equal(await helpersFor(page).submitPin(page, "4321"), false);
  assert.deepEqual(page.seen.pins, []);
});
