import { test } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../bootstrap/wiring/session-owner.ts";
import { applySharedUpdate, encodeSharedState } from "../adapters/collab/document.ts";
import { projectSharedDocument } from "../adapters/collab/project.ts";
import { ORDERS, PENDING_CALLERS, UNSPLIT, agree, base, cellOf, clearWarnings, enter, exchange, minted, pendingTyping, press, redoOnce, remoteErase,
  remoteInsert, row, select, undoOnce, warnings } from "./_shared-split-callers.mjs";

for (const order of ORDERS) test(`C7 rule 200: Alt+Enter over cXd keeps a peer's Z held between c and d, which begins the new beat, ${order}`, async () => {
  const f = await enter();
  try {
    pendingTyping(cellOf("audioText"), 3);
    select(cellOf("audioText"), 2, 5);
    remoteInsert(f.peer, "r1", "audioText", 3, "Z");
    assert.equal(applySharedUpdate(f.parts.handle, encodeSharedState(f.peer)).ok, true);
    assert.equal(press(cellOf("audioText"), "Enter", { altKey: true }), true);
    exchange(f, order);
    const id = minted(f);
    agree(f, base([row("r1", "ab", "Wide"), row(id, "Zef"), row("r2", "Other"), row("r3", "Third")]));
    assert.deepEqual(warnings(), []);
  } finally { f.close(); }
});

const BOUNDARY = {
  "the first selected character (the review's schedule)": { erase: [[2, 3]], text: "abZdef", cut: ["ab", "ZefX"] },
  "the last selected character": { erase: [[4, 5]], text: "abcZef", cut: ["ab", "ZefX"] },
  "every selected character": { erase: [[2, 3], [3, 4]], text: "abZef", cut: ["ab", "ZefX"] },
  "the character just before the selection": { erase: [[1, 2]], text: "acZdef", cut: ["a", "ZefX"] },
  "the character just after the selection": { erase: [[5, 6]], text: "abcZdf", cut: ["ab", "ZfX"] }
};
const rest = [row("r2", "Other"), row("r3", "Third")];
for (const caller of PENDING_CALLERS.filter(entry => !entry.refused)) for (const order of ORDERS) for (const [name, peer] of Object.entries(BOUNDARY)) {
  test(`C7 rule 200 boundaries: ${caller.name} over cd with X pending after f, a peer's Z held inside the selection and an unseen deletion of ${name}, ${order}`, async () => {
    const f = await enter();
    try {
      const sizes = f.parts.undo.sizes();
      pendingTyping(cellOf("audioText"), 6);
      select(cellOf("audioText"), 2, 4);
      remoteInsert(f.peer, "r1", "audioText", 3, "Z");
      for (const [from, to] of peer.erase) remoteErase(f.peer, "r1", from, to);
      assert.equal(projectSharedDocument(f.peer).rows[0].audioText, peer.text);
      assert.equal(applySharedUpdate(f.parts.handle, encodeSharedState(f.peer)).ok, true);
      assert.equal(currentDocument().rows[0].audioText, "abcdef", "the peer's changes are held until admission");
      clearWarnings();
      caller.act(cellOf("audioText"), f);
      assert.deepEqual(warnings(), []);
      exchange(f, order);
      const id = minted(f);
      const after = caller.name === "Ctrl+Enter" ? [row("r1", peer.text + "X", "Wide"), row(id, "")] : [row("r1", peer.cut[0], "Wide"), row(id, peer.cut[1])];
      agree(f, base([...after, ...rest]));
      assert.deepEqual(f.parts.undo.sizes(), { ...sizes, undo: sizes.undo + 2 });
      undoOnce(f, order);
      agree(f, UNSPLIT(peer.text + "X"));
      undoOnce(f, order);
      agree(f, UNSPLIT(peer.text));
      redoOnce(f, order);
      agree(f, UNSPLIT(peer.text + "X"));
      assert.deepEqual(warnings(), []);
    } finally { clearWarnings(); f.close(); }
  });
}
