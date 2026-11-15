import { test } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../bootstrap/wiring/session-owner.ts";
import { applySharedUpdate, encodeSharedState } from "../adapters/collab/document.ts";
import { ORDERS, PENDING_CALLERS, REFUSED, SOURCE, agree, cellOf, clearWarnings, enter, exchange, kinds, pendingTyping, redoOnce, remoteJoin, remoteSplit,
  select, tail, undoOnce, warnings } from "./_shared-split-callers.mjs";

const STRUCTURE = { ...SOURCE, rows: [{ id: "r0", audioText: "Lead", visualText: "", status: "todo" },
  { ...SOURCE.rows[0], audioText: "abcdefgh" }, ...SOURCE.rows.slice(1)] };

const PEER_STRUCTURE = {
  "a split before the selection": peer => { remoteSplit(peer, "r1", 4); },
  "a split inside the selection": peer => { remoteSplit(peer, "r1", 6); },
  "a split after the selection": peer => { remoteSplit(peer, "r1", 7); },
  "a join of the row into the one before": peer => { remoteJoin(peer, "r1", "r0"); }
};

const PEER_TYPED = {
  "a split before the selection": tail([["r0", "Lead"], ["r1", "aXbcd"], ["bob", "efgh"]]),
  "a split inside the selection": tail([["r0", "Lead"], ["r1", "aXbcdef"], ["bob", "gh"]]),
  "a split after the selection": tail([["r0", "Lead"], ["r1", "aXbcdefg"], ["bob", "h"]]),
  "a join of the row into the one before": tail([["r0", "Lead aXbcdefgh"]])
};
const PEER_UNTYPED = Object.fromEntries(Object.entries(PEER_TYPED).map(([name, rows]) => [name, rows.map(([kind, text]) => [kind, text.replace("aX", "a")])]));
const SPLIT_FOLLOWS = {
  "a split before the selection": tail([["r0", "Lead"], ["r1", "aXbcd"], ["bob", "e"], ["mine", "h"]]),
  "a split after the selection": tail([["r0", "Lead"], ["r1", "aXbcde"], ["mine", ""], ["bob", "h"]]),
  "a join of the row into the one before": tail([["r0", "Lead aXbcde"], ["mine", "h"]])
};
const STRUCTURE_RESULT = {
  "Alt+Enter": SPLIT_FOLLOWS,
  "the split core": SPLIT_FOLLOWS,
  "Ctrl+Enter": {
    "a split before the selection": tail([["r0", "Lead"], ["r1", "aXbcd"], ["bob", "efgh"], ["mine", ""]]),
    "a split after the selection": tail([["r0", "Lead"], ["r1", "aXbcdefg"], ["mine", ""], ["bob", "h"]]),
    "a join of the row into the one before": tail([["r0", "Lead aXbcdefgh"], ["mine", ""]])
  },
  "an in-cell beat paste": {}
};

for (const caller of PENDING_CALLERS) for (const order of ORDERS) for (const [name, remote] of Object.entries(PEER_STRUCTURE)) {
  const expected = STRUCTURE_RESULT[caller.name][name], refused = !expected;
  test(`C7 rule 201: ${caller.name} over fg with typing pending and ${name} held ${refused ? "is refused with one notice" : "follows the text"}, ${order}`, async () => {
    const f = await enter(STRUCTURE);
    try {
      const data = caller.arrange?.();
      const sizes = f.parts.undo.sizes();
      pendingTyping(cellOf("audioText"), 1);
      select(cellOf("audioText"), 6, 8);
      remote(f.peer);
      assert.equal(applySharedUpdate(f.parts.handle, encodeSharedState(f.peer)).ok, true);
      assert.equal(currentDocument().rows.length, 4, "the peer's change is held until admission");
      clearWarnings();
      caller.act(cellOf("audioText"), f, data, refused);
      assert.deepEqual(warnings(), refused ? [REFUSED] : []);
      clearWarnings();
      exchange(f, order);
      agree(f, expected ?? PEER_TYPED[name], kinds);
      assert.deepEqual(f.parts.undo.sizes(), { ...sizes, undo: sizes.undo + (refused ? 1 : 2) });
      if (!refused) {
        undoOnce(f, order);
        agree(f, PEER_TYPED[name], kinds);
      }
      undoOnce(f, order);
      agree(f, PEER_UNTYPED[name], kinds);
      redoOnce(f, order);
      agree(f, PEER_TYPED[name], kinds);
      assert.deepEqual(warnings(), []);
    } finally { clearWarnings(); f.close(); }
  });
}
