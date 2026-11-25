import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import "../../src/test/_dom.mjs";
import { openNativeSession } from "../../src/adapters/collab/native/session.ts";
import type { PresenceLocation, PresencePeer } from "../../src/application/collaboration/presence.ts";
import { createNativePresenceCarets } from "../../src/bootstrap/wiring/native-presence-carets.ts";
import { cells } from "../adapters/collab/native/helpers.ts";
import { structureScript } from "../adapters/collab/native/structure-harness.ts";

type Session = ReturnType<typeof openNativeSession>;

const options = { actor: "Alice", sanitize: (value: unknown) => String(value ?? "") };
const narration: PresenceLocation = { view: "split", beat: "A", side: "audioText" };
const visual: PresenceLocation = { ...narration, side: "visualText" };

function copies() {
  const mine = openNativeSession({
    kind: "document", document: structureScript({ A: "Hello world" }, { A: "Wide shot" }),
    conversion: { cells, creation: "seed", at: "2026-11-25T00:00:00Z", by: "Alice" }
  }, options);
  const peer = openNativeSession({ kind: "state", state: mine.encodeState() }, { ...options, actor: "Bea" });
  return { mine, peer };
}

function painted(text: string, id = "A"): HTMLElement {
  const cell = document.createElement("div");
  cell.dataset.id = id;
  cell.textContent = text;
  return cell;
}

function type(session: Session, at: number, text: string): void {
  const anchored = session.commands.anchorText({ beat: "A", cell: "narration" }, at);
  assert(anchored.kind === "anchored");
  assert.equal(session.commands.typeText(anchored.range, text, {}).kind, "written");
}

function peerAt(caret: PresencePeer["caret"], side: PresenceLocation["side"] = "audioText"): PresencePeer {
  return { clientId: 2, name: "Bea", color: "#EF958E", view: "split", beat: "A", side, caret };
}

test("a caret sent from painted text that is ahead of the shared text lands where the peer sees it", t => {
  const { mine, peer } = copies();
  t.after(() => { mine.close(); peer.close(); });
  const send = createNativePresenceCarets(mine), show = createNativePresenceCarets(peer);
  const caret = send.caret(narration, painted("Hello there world"), { anchor: 12, head: 12 });
  assert.ok(caret);
  assert.deepEqual(show.resolve(peerAt(caret), painted("Hello world")), { anchor: 6, head: 6 });
  const selection = send.caret(narration, painted("Hello world"), { anchor: 8, head: 2 });
  assert.ok(selection);
  assert.deepEqual([selection.anchor.assoc, selection.head.assoc], [-1, 0]);
  assert.deepEqual(show.resolve(peerAt(selection), painted("Hello world")), { anchor: 8, head: 2 });
  const shot = send.caret(visual, painted("Wide shot"), { anchor: 4, head: 9 });
  assert.ok(shot);
  assert.deepEqual(show.resolve(peerAt(shot, "visualText"), painted("Wide shot")), { anchor: 4, head: 9 });
});

test("a peer's caret is drawn against the painted text while local typing or the peer's own text is held back", t => {
  const { mine, peer } = copies();
  t.after(() => { mine.close(); peer.close(); });
  type(peer, 6, "brave ");
  Y.applyUpdate(mine.ydoc, Y.encodeStateAsUpdate(peer.ydoc, Y.encodeStateVector(mine.ydoc)));
  const caret = createNativePresenceCarets(peer).caret(narration, painted("Hello brave world"), { anchor: 14, head: 14 });
  assert.ok(caret);
  const show = createNativePresenceCarets(mine);
  assert.deepEqual(show.resolve(peerAt(caret), painted("Hello brave world")), { anchor: 14, head: 14 });
  assert.deepEqual(show.resolve(peerAt(caret), painted("Hello world")), { anchor: 8, head: 8 }, "the peer's text is not painted yet");
  assert.deepEqual(show.resolve(peerAt(caret), painted("Hi! Hello brave world")), { anchor: 18, head: 18 }, "local typing is buffered");
  assert.deepEqual(show.resolve(peerAt(caret), painted("")), { anchor: 0, head: 0 }, "an emptied painted cell clamps");
  assert.equal(show.resolve(peerAt(caret), painted("Hello world", "B")), null, "another row's cell shows nothing");
  assert.equal(show.resolve(peerAt(null), painted("Hello world")), null);
});

test("nothing is sent or shown for a closed session, a cell without a beat, or an unknown row", t => {
  const { mine, peer } = copies();
  t.after(() => peer.close());
  const carets = createNativePresenceCarets(mine);
  assert.equal(carets.caret({ view: "split", beat: null, side: null }, painted("Hello world"), { anchor: 1, head: 1 }), null);
  assert.equal(carets.caret({ ...narration, beat: "missing" }, painted("Hello world"), { anchor: 1, head: 1 }), null);
  const caret = createNativePresenceCarets(peer).caret(narration, painted("Hello world"), { anchor: 3, head: 3 });
  assert.ok(caret);
  mine.close();
  assert.equal(carets.caret(narration, painted("Hello world"), { anchor: 1, head: 1 }), null);
  assert.equal(carets.resolve(peerAt(caret), painted("Hello world")), null);
});
