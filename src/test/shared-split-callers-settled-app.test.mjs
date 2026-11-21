import { test } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../bootstrap/wiring/session-owner.ts";
import { armDelete } from "../bootstrap/wiring/rows.ts";
import { applySharedUpdate, encodeSharedState } from "../adapters/collab/document.ts";
import { ORDERS, PENDING_CALLERS, MERGED, REFUSED, SOURCE, UNSPLIT, agree, base, cellOf, clearWarnings, enter, exchange, kinds, minted, pendingTyping, press,
  redoOnce, remoteCreate, remoteInsert, remoteJoin, row, select, tail, undoOnce, warnings } from "./_shared-split-callers.mjs";

for (const order of ORDERS) test(`C7 settled offsets: the delete button finds its beat after a held peer beat lands before it, and only arms, ${order}`, async () => {
  const f = await enter();
  try {
    pendingTyping(cellOf("audioText"), 6);
    remoteCreate(f.peer, "r1", "r2", "before");
    assert.equal(applySharedUpdate(f.parts.handle, encodeSharedState(f.peer)).ok, true);
    assert.equal(currentDocument().rows.length, 3, "the peer's beat is held until admission");
    const button = document.createElement("button");
    armDelete(button, "r2");
    exchange(f, order);
    const peer = currentDocument().rows[1].id;
    agree(f, base([row("r1", "abcdefX", "Wide"), row(peer, ""), row("r2", "Other"), row("r3", "Third")]));
    assert.deepEqual(warnings(), []);
  } finally { f.close(); }
});

const deleteButton = id => document.querySelector(`#rows .row[data-id="${id}"] [data-action="delete-row"]`);
for (const order of ORDERS) test(`C7 delete button: a held peer beat that redraws the rows arms the live button, and a second click deletes, ${order}`, async () => {
  const f = await enter();
  try {
    pendingTyping(cellOf("audioText"), 6);
    remoteCreate(f.peer, "r1", "r2", "before");
    assert.equal(applySharedUpdate(f.parts.handle, encodeSharedState(f.peer)).ok, true);
    const clicked = deleteButton("r2");
    armDelete(clicked, "r2");
    const live = deleteButton("r2");
    assert.equal(clicked.isConnected, false, "the held beat redrew the rows");
    assert.deepEqual([live.classList.contains("armed"), document.querySelectorAll(".armed").length], [true, 1]);
    exchange(f, order);
    agree(f, tail([["r1", "abcdefX"], ["bob", ""]]), kinds);
    armDelete(deleteButton("r2"), "r2");
    exchange(f, order);
    agree(f, [["r1", "abcdefX"], ["bob", ""], ["r3", "Third"]], kinds);
    assert.deepEqual(warnings(), []);
  } finally { f.close(); }
});
for (const order of ORDERS) test(`C7 delete button: a held peer join that removes the beat arms nothing and writes nothing, ${order}`, async () => {
  const f = await enter();
  try {
    pendingTyping(cellOf("audioText"), 6);
    remoteJoin(f.peer, "r2", "r1");
    assert.equal(applySharedUpdate(f.parts.handle, encodeSharedState(f.peer)).ok, true);
    const sizes = f.parts.undo.sizes();
    armDelete(deleteButton("r2"), "r2");
    assert.deepEqual([deleteButton("r2"), document.querySelectorAll(".armed").length], [null, 0]);
    exchange(f, order);
    agree(f, base([row("r1", "abcdefX Other", "Wide"), row("r3", "Third")]));
    assert.deepEqual(f.parts.undo.sizes(), { ...sizes, undo: sizes.undo + 1 });
    assert.deepEqual(warnings(), []);
  } finally { f.close(); }
});

const LONG = { ...SOURCE, rows: [{ ...SOURCE.rows[0], audioText: "abcdefgh" }, ...SOURCE.rows.slice(1)] };
const TYPED = { before: 1, inside: 4, after: 7 }, PEER = { before: 0, inside: 3, after: 8 };
const SELECTED = { before: [3, 7], inside: [2, 7], after: [2, 6] };

const UNTYPED = { before: "Zabcdefgh", inside: "abcZdefgh", after: "abcdefghZ" };

async function settledCase(caller, order, typed, peer) {
  const f = await enter(LONG);
  try {
    const data = caller.arrange?.();
    const sizes = f.parts.undo.sizes(), text = LONG.rows[0].audioText;
    pendingTyping(cellOf("audioText"), TYPED[typed]);
    select(cellOf("audioText"), ...SELECTED[typed]);
    remoteInsert(f.peer, "r1", "audioText", PEER[peer], "Z");
    assert.equal(applySharedUpdate(f.parts.handle, encodeSharedState(f.peer)).ok, true);
    assert.equal(currentDocument().rows[0].audioText, text, "the peer's text is held until admission");
    clearWarnings();
    caller.act(cellOf("audioText"), f, data);
    assert.deepEqual(warnings(), caller.refused ? [REFUSED] : []);
    clearWarnings();
    exchange(f, order);
    const id = caller.refused ? null : minted(f);
    agree(f, caller.after(id, typed, peer));
    assert.deepEqual(f.parts.undo.sizes(), { ...sizes, undo: sizes.undo + (caller.refused ? 1 : 2) });
    if (!caller.refused) {
      undoOnce(f, order);
      agree(f, UNSPLIT(MERGED[typed][peer]));
    }
    undoOnce(f, order);
    agree(f, UNSPLIT(UNTYPED[peer]));
    redoOnce(f, order);
    agree(f, UNSPLIT(MERGED[typed][peer]));
    assert.deepEqual(warnings(), []);
  } finally { clearWarnings(); f.close(); }
}
for (const caller of PENDING_CALLERS) for (const order of ORDERS) for (const typed of Object.keys(TYPED)) for (const peer of Object.keys(PEER)) {
  test(`C7 settled offsets: ${caller.name} with typing pending ${typed} the selection and a peer's insertion held ${peer} it, ${order}`, async () => {
    await settledCase(caller, order, typed, peer);
  });
}
for (const order of ORDERS) test(`C7 settled offsets: Alt+Enter over cXd with a peer's Z held at the start leaves Zab and ef, ${order}`, async () => {
  const f = await enter();
  try {
    pendingTyping(cellOf("audioText"), 3);
    select(cellOf("audioText"), 2, 5);
    remoteInsert(f.peer, "r1", "audioText", 0, "Z");
    assert.equal(applySharedUpdate(f.parts.handle, encodeSharedState(f.peer)).ok, true);
    assert.equal(press(cellOf("audioText"), "Enter", { altKey: true }), true);
    exchange(f, order);
    const id = minted(f);
    agree(f, base([row("r1", "Zab", "Wide"), row(id, "ef"), row("r2", "Other"), row("r3", "Third")]));
    assert.deepEqual(warnings(), []);
  } finally { f.close(); }
});
