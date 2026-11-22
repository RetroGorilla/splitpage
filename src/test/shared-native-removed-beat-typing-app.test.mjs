import assert from "node:assert/strict";
import { after, test } from "node:test";
import { bootApp, closeApp } from "./_app-boot.mjs";
import { applyNativePeerUpdate } from "../adapters/collab/native/peer-update.ts";
import { openNativeSession } from "../adapters/collab/native/session.ts";
import { createSessionCapabilities } from "../application/session/capabilities.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { sanitizeHtml } from "../bootstrap/richtext.ts";
import { openNativeEditor } from "../bootstrap/wiring/native-shared-session.ts";
import { notices } from "../bootstrap/wiring/ports/effects.ts";
import { sharedCommandRefusalNotice } from "../bootstrap/wiring/ports/shared-command-notices.ts";
import { adoptReplacement, currentDocument, sharedSession } from "../bootstrap/wiring/session-owner.ts";
import { enterSharedSession, forceLeaveSharedSession, leaveRunningSharedSession } from "../bootstrap/wiring/shared-session.ts";
import { sharedUndoRoute } from "../bootstrap/wiring/undo.ts";
import { writerControls } from "../bootstrap/wiring/writer.ts";
import { setCellSelection } from "../features/common/cell-selection.ts";
import { nativeEntrySwitchFixture as entrySwitchFixture } from "../../tests/bootstrap/native-entry-switch-support.ts";

window.Element.prototype.scrollBy = () => {};
window.Element.prototype.scrollIntoView = () => {};
localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();
after(closeApp);

const splitCell = id => document.querySelector(`#rows .cell-editable[data-id="${id}"][data-field="audioText"]`);
const writerCell = id => document.querySelector(`#writer-doc .wr-beat[data-id="${id}"]`);
const text = node => node?.textContent.replace(/\u200b/g, "");
const shape = doc => doc.rows.map(row => [row.id, row.audioText]);
const flush = () => window.dispatchEvent(new window.Event("pagehide"));
const send = (from, to) => assert.equal(applyNativePeerUpdate(to, from.encodeState()), true);
const written = outcome => assert.equal(outcome.kind, "written");

function replica(source) {
  return openNativeSession({ kind: "state", state: source.encodeState() }, { actor: "Reader", sanitize: sanitizeHtml });
}

async function enter(t, view, rows) {
  const fixture = entrySwitchFixture(), show = t.mock.method(notices, "show", () => {});
  const ports = { ...fixture.ports, commandRefused: sharedCommandRefusalNotice(notices) };
  const writer = writerControls();
  adoptReplacement(migrateRows({ title: "Concurrent typing", paragraphsDecided: true,
    rows: rows.map(([id, audioText]) => ({ id, audioText })) }));
  let local;
  assert.deepEqual(await enterSharedSession(ports, (doc, failed) => {
    const opened = openNativeEditor(ports, doc, failed);
    local = opened.native;
    return opened.backend;
  }), { ok: true });
  const peer = replica(local);
  t.after(() => {
    if (sharedSession() && !leaveRunningSharedSession().ok) {
      forceLeaveSharedSession();
      const allowed = () => ({ allowed: true });
      adoptReplacement(migrateRows({ title: "Standby", rows: [] }),
        createSessionCapabilities("standalone", { edit: allowed, comment: allowed }));
    }
    peer.close();
    writer.closeWriter();
    assert.deepEqual(fixture.errors, []);
  });
  if (view === "Writer") writer.openWriter();
  function type(id, offset, letter) {
    const host = (view === "Writer" ? writerCell : splitCell)(id);
    const target = view === "Writer" ? document.getElementById("writer-doc") : host;
    target.focus();
    setCellSelection(host, offset);
    if (view === "Writer") document.dispatchEvent(new window.Event("selectionchange"));
    const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: letter });
    target.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    return host;
  }
  function agreeReplicas(expected) {
    assert.deepEqual(shape(local.document()), expected, "local replica");
    assert.deepEqual(shape(peer.document()), expected, "removing replica");
    for (const copy of [local, peer]) {
      const reader = replica(copy);
      try { assert.deepEqual(shape(reader.document()), expected, "fresh replica"); } finally { reader.close(); }
    }
  }
  async function agree(expected) {
    await Promise.resolve();
    agreeReplicas(expected);
    assert.deepEqual(shape(currentDocument()), expected, "published projection");
    for (const [id] of rows) {
      const value = expected.find(row => row[0] === id)?.[1];
      assert.equal(text(splitCell(id)), value, `Split ${id}`);
      if (view === "Writer") assert.equal(text(writerCell(id)), value, `Writer ${id}`);
    }
  }
  return { local, peer, type, agree, agreeReplicas, show };
}

const rows = [["r1", "Hello"], ["r2", "World"], ["r3", "Last"]];
const cases = [
  ["end of a beat before the removed beat", "r1", 5, "r2", [true, false]],
  ["start of a beat after the removed beat", "r2", 0, "r1", [true, false]],
  ["end of the last beat", "r3", 4, "r2", [true, false]],
  ["middle of the beat the peer removes", "r2", 2, "r2", [false]]
];
for (const view of ["Writer", "Split"]) {
  for (const [label, beat, offset, removed, orders] of cases) for (const removalFirst of orders) {
    test(`${view}: typing at the ${label}, removal delivered before flush=${removalFirst}`, async t => {
      const { local, peer, type, agree, show } = await enter(t, view, rows);
      await agree(rows);
      const letter = "!";
      type(beat, offset, letter);
      const updated = rows.map(([id, value]) => [id, id === beat ? value.slice(0, offset) + letter + value.slice(offset) : value]);
      if (beat === removed) {
        flush();
        send(local, peer);
        await agree(updated);
      }
      written(peer.commands.removeRows([removed]));
      if (removalFirst) send(peer, local);
      flush();
      send(local, peer);
      if (!removalFirst) send(peer, local);
      await agree(updated.filter(([id]) => id !== removed));
      written(peer.commands.undo());
      send(peer, local);
      const restored = beat === "r1" && removalFirst
        ? [[beat, rows[0][1]], [removed, rows[1][1] + letter], rows[2]]
        : updated;
      await agree(restored);
      const other = rows.find(([id]) => id !== beat && id !== removed)[0];
      type(other, 0, "?");
      assert.deepEqual(leaveRunningSharedSession(), { ok: true });
      assert.deepEqual(shape(currentDocument()), restored.map(([id, value]) => [id, id === other ? "?" + value : value]));
      assert.deepEqual(show.mock.calls, []);
    });
  }

  for (const removalFirst of [true, false]) {
    test(`${view}: committed concurrent typing follows the reading rules, removal delivered first=${removalFirst}`, async t => {
      const source = [["r1", "abcdef"], ["r2", "Gone words"], ["r3", "Last"]];
      const { local, peer, type, agree, show } = await enter(t, view, source);
      await agree(source);
      const offset = 4, letter = "x", [id, value] = source[1];
      type(id, offset, letter);
      flush();
      written(peer.commands.removeRows([id]));
      if (removalFirst) send(peer, local);
      send(local, peer);
      if (!removalFirst) send(peer, local);
      await agree([["r1", source[0][1] + letter], source[2]]);
      written(peer.commands.undo());
      send(peer, local);
      await agree([source[0], [id, value.slice(0, offset) + letter + value.slice(offset)], source[2]]);
      assert.deepEqual(leaveRunningSharedSession(), { ok: true });
      assert.deepEqual(show.mock.calls, []);
    });
  }

  for (const leaveFirst of [false, true]) {
    test(`${view}: removing the beat with pending typing clears the preview, leave flushes=${leaveFirst}`, async t => {
      const source = [["r1", "abcdef"], ["r2", "Gone words"], ["r3", "Last"]];
      const { local, peer, type, agree, agreeReplicas, show } = await enter(t, view, source);
      await agree(source);
      const preview = type("r2", source[1][1].length, "x");
      assert.equal(text(preview), source[1][1] + "x");
      assert.deepEqual(shape(local.document()), source);
      written(peer.commands.removeRows(["r2"]));
      send(peer, local);
      const remaining = source.filter(([id]) => id !== "r2");
      const withStray = [["r1", source[0][1] + "x"], source[2]];
      agreeReplicas(remaining);
      assert.equal(text(preview), source[1][1] + "x");
      if (leaveFirst) {
        assert.deepEqual(leaveRunningSharedSession(), { ok: true });
        assert.deepEqual(shape(currentDocument()), withStray);
        assert.equal(preview.isConnected, false);
      } else {
        flush();
        send(local, peer);
        await agree(withStray);
        assert.equal(preview.isConnected, false);
        type("r1", 0, "?");
        flush();
        send(local, peer);
        const updated = [["r1", "?" + source[0][1]], ["r2", source[1][1] + "x"], source[2]];
        await agree([["r1", "?" + withStray[0][1]], source[2]]);
        written(peer.commands.undo());
        send(peer, local);
        await agree(updated);
        assert.deepEqual(leaveRunningSharedSession(), { ok: true });
        assert.deepEqual(shape(currentDocument()), updated);
      }
      assert.deepEqual(show.mock.calls, []);
    });
  }

  test(`${view}: undo of pending stray typing keeps the previous edit`, async t => {
    const { local, peer, type, agree, show } = await enter(t, view, rows);
    type("r1", 0, "?");
    flush();
    send(local, peer);
    type("r2", 2, "x");
    written(peer.commands.removeRows(["r2"]));
    send(peer, local);
    assert.equal(sharedUndoRoute().actions.undo().ok, true);
    send(local, peer);
    await agree([["r1", "?Hello"], rows[2]]);
    assert.deepEqual(leaveRunningSharedSession(), { ok: true });
    assert.deepEqual(shape(currentDocument()), [["r1", "?Hello"], rows[2]]);
    assert.deepEqual(show.mock.calls, []);
  });

  test(`${view}: a removed beat and its removed next boundary leave one warning and clear the preview`, async t => {
    const { local, peer, type, agree, show } = await enter(t, view, rows);
    const preview = type("r2", 2, "x");
    written(peer.commands.removeRows(["r2", "r3"]));
    send(peer, local);
    flush();
    await agree([rows[0]]);
    assert.equal(preview.isConnected, false);
    written(peer.commands.undo());
    send(peer, local);
    await agree(rows);
    assert.deepEqual(leaveRunningSharedSession(), { ok: true });
    assert.deepEqual(show.mock.calls.map(call => call.arguments),
      [["Typing was discarded because a peer removed this beat.", "warn"]]);
  });
}
