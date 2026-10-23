import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { documentLocation, serverStatus } = await import("../legacy/location-bridge.ts");
const { PREF_EVENT, preferences } = await import("../legacy/preferences-bridge.ts");
const { adoptReplacement, onSessionChange } = await import("../legacy/session-bridge.ts");
const { migrateRows } = await import("../js/02-state.js");
const { flushEdits } = await import("../js/12a-undo.js");

after(closeApp);

const idle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const item = (id) => document.getElementById(id);
const label = (id) => item(id).querySelector(".mi-label").textContent;
const reason = (id) => item(id).querySelector(".mi-why").textContent;

function open() {
  documentLocation().setHome("none");
  documentLocation().setConnection({ serverUrl: "https://menus.example/", token: "owner", role: "edit", scope: "" });
  serverStatus().recordMode({ available: true, checked: true, readOnly: false, links: true });
  preferences().setCollabServer("https://collaboration.example/");
}

test("collaborate follows the connection and document location synchronously without a refresh call", () => {
  open();
  assert.match(item("menu-collaborate").title, /collaboration\.example/);
  documentLocation().setHome("server", { id: "menu-script", rev: 1 });
  assert.match(item("menu-collaborate").title, /menus\.example/);
  documentLocation().updateConnection({ role: "review" });
  assert.equal(item("menu-collaborate").disabled, true);
  assert.equal(item("btn-collab").getAttribute("aria-disabled"), "true");
  assert.equal(reason("menu-collaborate"), "Only the script's owner can invite people");
  documentLocation().updateConnection({ role: "edit" });
  assert.equal(item("menu-collaborate").disabled, false);
  assert.equal(item("btn-collab").hasAttribute("aria-disabled"), false);
  documentLocation().setHome("none");
  assert.match(item("menu-collaborate").title, /collaboration\.example/);
});

test("collaborate follows server health and its preference synchronously without legacy preference events", (t) => {
  open();
  const dispatch = document.dispatchEvent;
  t.mock.method(document, "dispatchEvent", function (event) {
    return event.type === PREF_EVENT ? true : dispatch.call(this, event);
  });
  preferences().setCollabServer("https://invites.example/");
  assert.match(item("menu-collaborate").title, /invites\.example/);
  documentLocation().setHome("server", { id: "menu-script", rev: 1 });
  serverStatus().recordMode({ readOnly: true });
  assert.equal(item("menu-collaborate").disabled, true);
  assert.equal(reason("menu-collaborate"), "This server is read-only");
  serverStatus().recordMode({ readOnly: false });
  assert.equal(item("menu-collaborate").disabled, false);
});

test("connect follows connection and bookmark owner changes synchronously without a refresh call", () => {
  open();
  assert.equal(label("menu-servers"), "Servers… (menus.example)");
  serverStatus().addBookmarks([{ id: "menu-server", name: "Studio", url: "https://menus.example/" }]);
  assert.equal(label("menu-servers"), "Servers… (Studio)");
  serverStatus().removeBookmark("menu-server");
  assert.equal(label("menu-servers"), "Servers… (menus.example)");
  documentLocation().setConnection({ serverUrl: "" });
  assert.equal(label("menu-servers"), "Servers…");
});

test("the server menu follows health and authority owners synchronously without a refresh call", () => {
  open();
  assert.equal(item("menu-server-open").hidden, false);
  assert.equal(item("menu-server-new").hidden, false);
  assert.equal(item("menu-server-new").disabled, false);
  serverStatus().recordMode({ readOnly: true });
  assert.equal(item("menu-server-new").disabled, true);
  assert.equal(reason("menu-server-new"), "This server is read-only");
  serverStatus().recordMode({ readOnly: false });
  documentLocation().updateConnection({ scope: "menu-script" });
  assert.equal(item("menu-server-open").disabled, true);
  assert.equal(reason("menu-server-open"), "Your link opens this one script");
  assert.equal(item("menu-server-new").disabled, true);
  documentLocation().updateConnection({ scope: "", role: "review" });
  assert.equal(item("menu-server-open").disabled, false);
  assert.equal(reason("menu-server-new"), "Viewing only — publishing needs the editing code");
  serverStatus().recordMode({ available: false });
  assert.equal(item("menu-server-open").hidden, true);
  assert.equal(item("menu-server-new").hidden, true);
});

async function typingMakesNoMenuPaints(home) {
  open();
  adoptReplacement(migrateRows({
    title: "Menu listeners",
    rows: [{ id: "menu-row", visualText: "", audioText: "One.", status: "todo" }]
  }));
  if (home === "import") documentLocation().setHome("import", { name: "menu.txt", format: "txt" });
  flushEdits();
  await idle(300);
  const cell = document.querySelector('#rows .cell-editable[data-id="menu-row"][data-field="audioText"]');
  cell.focus();
  const walker = document.createTreeWalker(cell, 4);
  let node = null;
  while (walker.nextNode()) node = walker.currentNode;
  assert.ok(node);
  const paints = [];
  let edits = 0;
  const stop = onSessionChange((change) => { if (change.kind === "edit") edits++; });
  const observer = new window.MutationObserver((records) => { paints.push(...records); });
  for (const id of ["menu-collaborate", "btn-collab", "menu-servers", "menu-server-open", "menu-server-new"]) {
    observer.observe(item(id), { attributes: true, childList: true, characterData: true, subtree: true });
  }
  try {
    for (const ch of " nine ten eleven twelve thirteen fourteen fifteen sixteen") {
      node.data += ch;
      const range = document.createRange();
      range.setStart(node, node.data.length);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      cell.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
    }
    assert.ok(edits > 0);
    assert.equal(paints.length + observer.takeRecords().length, 0);
    await idle(400);
    assert.equal(paints.length + observer.takeRecords().length, 0);
  } finally {
    stop();
    observer.disconnect();
  }
}

for (const home of ["none", "import"]) {
  test("typing with home " + home + " makes no collaborate, connect or server menu paints, including the idle refresh", () => typingMakesNoMenuPaints(home));
}

test("collaborate follows a link being turned off by its owner without a refresh call", () => {
  open();
  assert.equal(item("menu-collaborate").disabled, false);
  serverStatus().turnLinkOff();
  assert.equal(item("menu-collaborate").disabled, true);
  assert.equal(reason("menu-collaborate"), "Only the script's owner can invite people");
});
