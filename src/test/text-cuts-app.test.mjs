import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../legacy/session-bridge.ts";
import { setHome } from "../legacy/location-bridge.ts";
import { truncateForPreview } from "../core/document/text-policy.ts";

await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { initDocIdentityChannel, reassignDocId, syncDocIdentity } = await import("../js/02b-doc-id.js");
const { videoLinkLabel } = await import("../adapters/storage/02d-gallery.js");
const { render } = await import("../js/05-render.js");
const { renderRundown } = await import("../features/rundown/rundown.js");
const { buildScenePayload, parseScenePayload } = await import("../js/05g-scene-clip.js");
const { newScriptFromSelection, selectScenes } = await import("../js/05h-scene-select.js");
const { registryKey } = await import("../core/document/tags.ts");
const { setTagNotes } = await import("../js/08-production-panels.js");
const { openBrollPanel } = await import("../js/08d-broll-panel.js");
const { sidePanels } = await import("../legacy/panels-bridge.ts");
const { closeExportDialog, openExportDialog } = await import("../bootstrap/wiring/file-menu-export-controls.ts");
const { presenceInitials } = await import("../js/13a-presence.js");
const { buildMarkdownProject, parseMarkdownProject, applyMarkdownProject } = await import("../adapters/formats/project-file.ts");
const { loadTestDocument } = await import("./_document.mjs");

after(closeApp);

if (!window.Element.prototype.scrollIntoView) window.Element.prototype.scrollIntoView = function () {};

const GRIN = String.fromCodePoint(0x1F600);
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const x = (n) => "x".repeat(n);

function load() {
  loadTestDocument(migrateRows({
    schema: 2, title: "Cuts",
    rows: [
      { id: "r1", status: "todo", audioText: "the mug", visualText: '<span class="broll-key" data-broll-id="bs1" contenteditable="false">B-roll:</span> Old shot' },
      { id: "r2", status: "todo", audioText: "two", visualText: "" }
    ],
    comments: [], people: [],
    productionTags: [{ cat: "prop", name: "Kettle" }],
    brollShots: [{ id: "bs1", name: "Old shot", origin: "script" }, { id: "bs2", name: "Listed shot", origin: "list" }]
  }));
  render();
}

function toasts() {
  return [...document.querySelectorAll("#toast-host .toast:not(.is-leaving)")].map((t) => t.textContent);
}

function panel() { return document.getElementById("broll-panel"); }
function shot(id) { return currentDocument().brollShots.filter((b) => b.id === id)[0]; }

test("02b the identity claim and the copy toast cut the title by code point (#434)", () => {
  load();
  const posted = [];
  let channel = null;
  setHome("file", { format: "html", name: "cuts.html" });
  try {
    currentDocument().title = x(299) + GRIN + "y";
    syncDocIdentity();
    initDocIdentityChannel(function () {
      channel = { postMessage: (m) => posted.push(m), close() {} };
      return channel;
    });
    assert.equal(posted[0] && posted[0].title, x(299) + GRIN);
    document.querySelectorAll("#toast-host .toast").forEach((t) => t.remove());
    channel.onmessage({ data: { type: "claim", docId: currentDocument().docId, home: "file:other.html", at: 0, nonce: "other", title: x(299) + GRIN + "z" } });
    const said = toasts().filter((t) => t.indexOf("is a copy of") !== -1);
    assert.equal(said.length, 1, JSON.stringify(toasts()));
    assert.ok(said[0].indexOf('"' + x(299) + GRIN + '"') !== -1, said[0]);
    document.querySelectorAll("#toast-host .toast").forEach((t) => t.remove());
    assert.ok(reassignDocId("d" + "7".repeat(32), { fromId: currentDocument().docId, otherTitle: " " + x(299) + "\uD83D" + "ab" }));
    const again = toasts().filter((t) => t.indexOf("is a copy of") !== -1);
    assert.ok(again[0].indexOf('"' + x(299) + "a" + '"') !== -1, again[0]);
  } finally {
    setHome("none");
    initDocIdentityChannel(function () { return null; });
  }
});

test("05g a pasted scene's source title is cut by code point (#434)", () => {
  load();
  const payload = JSON.parse(buildScenePayload(currentDocument(), ["r2"]).json);
  payload.source = { docId: null, title: x(299) + GRIN + "y" };
  assert.equal(parseScenePayload(JSON.stringify(payload)).source.title, x(299) + GRIN);
  payload.source = { docId: null, title: "a\uD83D b" };
  assert.equal(parseScenePayload(JSON.stringify(payload)).source.title, "a b");
});

test("05h a new script from selected scenes cuts its title by code point (#434)", () => {
  load();
  currentDocument().title = x(299) + GRIN;
  selectScenes("r2", "r2");
  newScriptFromSelection();
  assert.equal(currentDocument().title, x(299) + GRIN);
  assert.equal(currentDocument().rows.length, 1);
});

test("20d a Markdown project's title is cut by code point (#434)", async () => {
  load();
  const proj = parseMarkdownProject(buildMarkdownProject(exportDocumentOf(currentDocument())));
  proj.title = x(299) + GRIN + "y";
  const back = await applyMarkdownProject(proj, { noAsk: true });
  assert.equal(back.title, x(299) + GRIN);
});

test("08 a tag's notes are cut at 2000 by code point, with no lone half (#434)", () => {
  load();
  setTagNotes(registryKey("prop", "Kettle"), x(1999) + GRIN + "y");
  assert.equal(currentDocument().productionTags[0].notes, x(1999) + GRIN);
  setTagNotes(registryKey("prop", "Kettle"), " a\uD83D\n b ");
  assert.equal(currentDocument().productionTags[0].notes, " a\n b ");
});

test("08d a shot's note and its reference are cut at 2000 by code point (#434)", () => {
  load();
  openBrollPanel();
  if (!panel().querySelector('.broll-card[data-id="bs2"]')) panel().querySelector('.broll-row-main[data-id="bs2"]').click();
  const note = panel().querySelector('.broll-notes-input[data-id="bs2"]');
  assert.ok(note, "the note box shows");
  note.value = x(1999) + GRIN + "y";
  note.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
  assert.equal(shot("bs2").notes, x(1999) + GRIN);
  panel().querySelector('[data-action="broll-ref-edit"][data-id="bs2"]').click();
  const ref = panel().querySelector('.broll-ref-input[data-id="bs2"]');
  assert.ok(ref, "the reference box shows");
  ref.value = x(1999) + GRIN + "y";
  ref.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
  assert.equal(shot("bs2").audioRef, x(1999) + GRIN);
  sidePanels().close("broll-panel");
});

test("20h imported server names, hosts and onboarding values are cut by code point (#434)", async () => {
  load();
  localStorage.removeItem("splitpage-server-bookmarks");
  localStorage.removeItem("splitpage-onboarding");
  const bundle = {
    format: "splitpage-app-data", version: 1, exportedAt: new Date().toISOString(), appVersion: "", history: { docs: [], older: [] },
    bookmarks: [
      { id: "s1", name: " " + x(199) + GRIN + "y", url: "http://a.example/", ssh: { userHost: x(299) + GRIN + "y", remotePort: 8791, localPort: 8791 } },
      { id: "s2", name: "\uD83D", url: "http://b.example/", ssh: { userHost: " \uD83D ", remotePort: 8791, localPort: 8791 } }
    ],
    prefs: { onboarding: { note: x(199) + GRIN + "y", half: "a\uD83D" } }
  };
  await window.__appDataTest.importText(JSON.stringify(bundle));
  const marks = JSON.parse(localStorage.getItem("splitpage-server-bookmarks"));
  const a = marks.filter((b) => b.id === "s1")[0], b = marks.filter((m) => m.id === "s2")[0];
  assert.equal(a.name, x(199) + GRIN);
  assert.equal(a.ssh.userHost, x(299) + GRIN);
  assert.equal(b.name, "b.example");
  assert.equal(b.ssh, undefined);
  const onboarding = JSON.parse(localStorage.getItem("splitpage-onboarding"));
  assert.equal(onboarding.note, x(199) + GRIN);
  assert.equal(onboarding.half, "a");
});

test("02d a video link's label never ends in half an emoji (#434)", () => {
  assert.equal(videoLinkLabel({ href: "https://" + x(44) + GRIN + "abc" }), x(44) + "…");
  assert.equal(videoLinkLabel({ href: "https://" + x(43) + GRIN + "abcd" }), x(43) + GRIN + "…");
});

test("11 the import preview never ends in half an emoji (#434)", () => {
  assert.equal(truncateForPreview(x(33) + GRIN + "a", 34), x(33) + "…");
  assert.equal(truncateForPreview(x(32) + GRIN + "a", 34), x(32) + GRIN + "…");
});

test("13a presence initials take whole characters (#434)", () => {
  assert.equal(presenceInitials(GRIN + "abc"), GRIN + "A");
  assert.equal(presenceInitials("a" + GRIN), "A" + GRIN);
  assert.equal(presenceInitials(GRIN + "x " + GRIN + "y"), GRIN + GRIN);
  assert.equal(presenceInitials("ann lee"), "AL");
});

test("18c the export preview never cuts a name or a scene in half an emoji (#434)", () => {
  load();
  currentDocument().brollShots[1].name = x(32) + GRIN + "abc";
  currentDocument().rows[1].audioText = x(149) + GRIN + "y";
  const seen = {};
  for (const action of ["export-broll-pdf", "export-pdf"]) {
    assert.ok(openExportDialog({ action }), action);
    seen[action] = document.getElementById("export-preview").textContent;
    closeExportDialog();
  }
  assert.ok(seen["export-broll-pdf"].indexOf(x(32) + "…") !== -1, seen["export-broll-pdf"]);
  assert.ok(seen["export-pdf"].indexOf(x(149) + "…") !== -1, seen["export-pdf"]);
  assert.ok(!LONE.test(seen["export-broll-pdf"] + seen["export-pdf"]));
});

test("05f a scene's rundown snippet never ends in half an emoji (#434)", () => {
  load();
  currentDocument().rows[1].audioText = x(89) + GRIN + "y";
  const track = document.querySelector("#rundown .rundown-track");
  Object.defineProperty(track, "clientWidth", { value: 1200, configurable: true });
  try {
    render();
    renderRundown();
    const snip = document.querySelector('.rd-block[data-row="r2"] .rd-snip');
    assert.ok(snip, "the snippet is drawn");
    assert.equal(snip.textContent, x(89));
    assert.ok(!LONE.test(snip.textContent));
  } finally {
    delete track.clientWidth;
  }
});
