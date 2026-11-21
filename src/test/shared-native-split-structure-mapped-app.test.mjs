import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { trackGlobalListeners } from "./_global-listener-inventory.mjs";
import { adoptReplacement, currentDocument, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { sanitizeHtml } from "../bootstrap/richtext.ts";
import { sharedCommandRefusalNotice } from "../bootstrap/wiring/ports/shared-command-notices.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { enterSharedSession, leaveRunningSharedSession } from "../bootstrap/wiring/shared-session.ts";
import { openNativeEditor } from "../bootstrap/wiring/native-shared-session.ts";
import { openNativeSession } from "../adapters/collab/native/session.ts";
import { applyNativePeerUpdate } from "../adapters/collab/native/peer-update.ts";
import { setCellSelection, cellSelection } from "../features/common/cell-selection.ts";
import { BEATS_MIME, buildBeatPayload } from "../features/clipboard/beat-clip.ts";
import { entrySwitchFixture } from "../../tests/bootstrap/shared-entry-switch-support.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
const listeners = trackGlobalListeners();
await bootApp();
after(closeApp);

const cell = id => document.querySelector('#rows .cell-editable[data-id="' + id + '"][data-field="audioText"]');
const snapshot = doc => JSON.parse(JSON.stringify(doc));
const replica = source => openNativeSession({ kind: "state", state: source.encodeState() }, { actor: "Reader", sanitize: sanitizeHtml });
const deliver = (target, source) => assert.equal(applyNativePeerUpdate(target, source.encodeState()), true);
const warning = ["This is not available in a shared session yet.", "warn"];

function press(key, modifiers) {
  const event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
  document.activeElement.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
}

function paste(payload) {
  const event = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: {
    types: [BEATS_MIME, "text/plain"],
    getData: type => type === BEATS_MIME ? payload.json : type === "text/plain" ? payload.text : ""
  } });
  document.activeElement.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
}

const scenarios = [
  { label: "split before", offset: 4, narration: ["Lead", "abcd", "efgh"] },
  { label: "split inside", offset: 6, narration: ["Lead", "abcdef", "gh"] },
  { label: "split after", offset: 7, narration: ["Lead", "abcdefg", "h"] },
  { label: "join above", offset: null, narration: ["Lead abcdefgh"] }
];

for (const { label, offset, narration } of scenarios) for (const order of ["local-first", "remote-first"]) {
  for (const caller of ["Alt+Enter", "Ctrl+Enter", "beat paste"]) test(caller + " after held peer " + label + ", " + order, async t => {
    const fixture = entrySwitchFixture();
    const ports = { ...fixture.ports, commandRefused: sharedCommandRefusalNotice(notices) };
    adoptReplacement(migrateRows({ schema: 2, title: "Shared callers", paragraphsDecided: true, wordsPerMinute: 150,
      rows: [
        { id: "r0", audioText: "Lead", visualText: "" }, { id: "r1", audioText: "abcdefgh", visualText: "Wide" },
        { id: "r2", audioText: "Other", visualText: "Cutaway" }, { id: "r3", audioText: "Third", visualText: "" }
      ], sections: [{ id: "s1", name: "Scene", firstSceneId: "r3" }]
    }));
    const baseline = listeners();
    const show = t.mock.method(notices, "show", () => {});
    let native;
    assert.deepEqual(await enterSharedSession(ports, (doc, failed) => {
      const opened = openNativeEditor(ports, doc, failed);
      native = opened.native;
      return opened.backend;
    }), { ok: true });
    const peer = replica(native);
    t.after(() => {
      peer.close();
      cell("r3").focus();
      setCellSelection(cell("r3"), 0);
      assert.deepEqual(leaveRunningSharedSession(), { ok: true });
      assert.equal(sharedSession(), false);
      assert.deepEqual(listeners(), baseline);
      assert.deepEqual(fixture.errors, []);
    });

    const before = snapshot(currentDocument());
    const payload = buildBeatPayload(before, ["r2"], {});
    const host = cell("r1");
    host.focus();
    setCellSelection(host, 1);
    assert.equal(host.dispatchEvent(new window.InputEvent("beforeinput", {
      bubbles: true, cancelable: true, inputType: "insertText", data: "X"
    })), false);
    setCellSelection(host, 6, 8);
    const anchor = offset === null ? null : peer.commands.anchorText({ beat: "r1", cell: "narration" }, offset);
    if (anchor) assert.equal(anchor.kind, "anchored");
    const change = anchor ? peer.commands.splitRow(anchor.range) : peer.commands.joinRow("r1", "r0", " ");
    assert.equal(change.kind, "written");
    const peerOnly = snapshot(peer.document());
    assert.deepEqual(peerOnly.rows.map(row => row.audioText), [...narration, "Other", "Third"]);
    assert.deepEqual(peerOnly.rows.map(row => row.visualText), offset === null ? ["Wide", "Cutaway", ""] : ["", "Wide", "", "Cutaway", ""]);
    assert.deepEqual(peerOnly.sections, before.sections);
    deliver(native, peer);
    assert.deepEqual(snapshot(currentDocument()), before);

    const typed = structuredClone(peerOnly);
    const row = typed.rows.find(row => row.id === (offset === null ? "r0" : "r1"));
    row.audioText = row.audioText.replace("abc", "aXbc");
    const exchange = () => {
      if (order === "local-first") {
        deliver(peer, native);
        deliver(native, peer);
      } else {
        deliver(native, peer);
        deliver(peer, native);
      }
    };
    const agree = expected => {
      exchange();
      const actual = snapshot(currentDocument());
      const script = doc => ({ ...doc, rows: doc.rows.map(({ updatedAt, updatedBy, ...row }) => row) });
      assert.deepEqual(script(actual), script(expected));
      assert.deepEqual(snapshot(peer.document()), actual);
      const fresh = replica(native);
      try { assert.deepEqual(snapshot(fresh.document()), actual); }
      finally { fresh.close(); }
    };
    const accepted = caller === "Alt+Enter" && offset === 7;
    if (caller === "beat paste") {
      paste(payload);
      assert.deepEqual(snapshot(currentDocument()), before);
      assert.equal(host.textContent, "aXbcdefgh");
      assert.deepEqual(cellSelection(host), { from: 6, to: 8 });
      window.dispatchEvent(new window.Event("pagehide"));
    } else {
      press("Enter", caller === "Alt+Enter" ? { altKey: true } : { ctrlKey: true });
    }

    let final = typed;
    if (accepted) {
      final = structuredClone(typed);
      const created = currentDocument().rows[2];
      assert.ok(created && !typed.rows.some(row => row.id === created.id));
      final.rows[1].audioText = "aXbcde";
      final.rows.splice(2, 0, { ...peerOnly.rows[2], id: created.id, audioText: "" });
    }
    agree(final);
    if (accepted) {
      press("z", { ctrlKey: true });
      agree(typed);
    }
    press("z", { ctrlKey: true });
    agree(peerOnly);
    press("z", { ctrlKey: true });
    agree(peerOnly);
    press("z", { ctrlKey: true, shiftKey: true });
    agree(typed);
    if (accepted) {
      press("z", { ctrlKey: true, shiftKey: true });
      agree(final);
    }
    assert.deepEqual(show.mock.calls.map(call => call.arguments), accepted ? [] : [warning]);
  });
}
