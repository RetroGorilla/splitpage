import "./_dom.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { migrateRows } from "../js/02-state.js";
import { flushEdits, lastUndoEntry, nextRedoEntry, noteEdit, noteRemoteChange, redo, resetUndo, undo, undoSizes } from "../js/12a-undo.js";
import { cellEdit, changeSet } from "../application/session/change-set.ts";
import { createDocumentSession } from "../application/session/document-session.ts";
import { createUndoAdapter, watchUndoAdoption } from "../legacy/undo-adapter.ts";
import { loadDocumentWithoutSession } from "./_document.mjs";

const SEEDS = 60;
const OPS = 40;
const WORDS = ["a", "b", "c", " ", " net", " sea", "!"];
const STATUSES = ["todo", "ready", "shot"];

const realNow = Date.now;
let clock = 0;
Date.now = () => clock;
after(() => { Date.now = realNow; });

function seeded(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 8) / 16777216;
  };
}

const pick = (r, list) => list[Math.floor(r() * list.length)];

function script(seed) {
  const rows = [];
  for (let i = 0; i < 4; i++) rows.push({ id: "r" + i, status: "todo", visualText: "Shot " + i, audioText: "Line " + i + "." });
  return migrateRows({ schema: 5, title: "Differential " + seed, docId: "d" + "7".repeat(32), rows: rows, comments: [] });
}

function plan(r, doc) {
  const kind = r();
  if (kind < 0.45) {
    const row = pick(r, doc.rows);
    const field = r() < 0.7 ? "audioText" : "visualText";
    const add = pick(r, WORDS);
    return { name: "type", changes: cellEdit(row.id, field), apply: (s) => { const t = s.rows.find((x) => x.id === row.id); t[field] = t[field] + add; } };
  }
  if (kind < 0.55) {
    const title = "Title " + Math.floor(r() * 5);
    return { name: "title", changes: changeSet({ docFields: ["title"] }), apply: (s) => { s.title = title; } };
  }
  if (kind < 0.62) {
    const row = pick(r, doc.rows);
    const status = pick(r, STATUSES);
    return { name: "status", changes: cellEdit(row.id, "status"), apply: (s) => { s.rows.find((x) => x.id === row.id).status = status; } };
  }
  if (kind < 0.68) {
    const at = Math.floor(r() * (doc.rows.length + 1));
    const id = "n" + Math.floor(r() * 1e6);
    return {
      name: "insert", changes: changeSet({ rowsInserted: [id] }),
      apply: (s) => { s.rows.splice(at, 0, { id: id, status: "todo", visualText: "", audioText: "New.", imageRef: null, updatedAt: "", updatedBy: null }); }
    };
  }
  if (kind < 0.73 && doc.rows.length > 1) {
    const at = Math.floor(r() * doc.rows.length);
    return { name: "delete", changes: changeSet({ rowsRemoved: [doc.rows[at].id] }), apply: (s) => { s.rows.splice(at, 1); } };
  }
  if (kind < 0.78 && doc.rows.length > 1) {
    const from = Math.floor(r() * doc.rows.length), to = Math.floor(r() * doc.rows.length);
    return { name: "move", changes: changeSet({ rowsMoved: true }), apply: (s) => { s.rows.splice(to, 0, s.rows.splice(from, 1)[0]); } };
  }
  if (kind < 0.82) {
    const row = pick(r, doc.rows);
    const text = "Theirs " + Math.floor(r() * 5) + ".";
    return { name: "remote", theirs: (s) => { const t = JSON.parse(JSON.stringify(s)); t.rows.find((x) => x.id === row.id).audioText = text; return t; } };
  }
  if (kind < 0.88) return { name: "undo" };
  if (kind < 0.95) return { name: "redo" };
  return { name: "wait", ms: pick(r, [400, 900, 1200, 3000]) };
}

function snapshot(label) {
  const top = lastUndoEntry(), next = nextRedoEntry();
  return {
    label,
    sizes: undoSizes(),
    top: top ? JSON.stringify(top.steps) : null,
    next: next ? JSON.stringify(next.steps) : null,
    state: JSON.stringify(S.state)
  };
}

async function drive(seed, perform) {
  const r = seeded(seed);
  clock = 1e6;
  resetUndo();
  loadDocumentWithoutSession(script(seed));
  perform.open();
  const out = [];
  for (let n = 0; n < OPS; n++) {
    const p = plan(r, S.state);
    clock += Math.floor(r() * 300);
    if (p.name === "wait") clock += p.ms;
    else if (p.name === "undo") undo();
    else if (p.name === "redo") redo();
    else if (p.name === "remote") { const next = p.theirs(S.state); perform.remote(next); loadDocumentWithoutSession(next); }
    else perform.edit(p);
    await Promise.resolve();
    flushEdits();
    out.push(snapshot(p.name));
  }
  return out;
}

const legacy = {
  open: () => { flushEdits(); },
  edit: (p) => { p.apply(S.state); noteEdit(); },
  remote: (next) => { noteRemoteChange(next); }
};

const session = createDocumentSession({
  entry: (raw) => migrateRows(raw),
  undo: createUndoAdapter(),
  effects: { dirty() {}, draft() {}, save() {}, refresh() {} },
  capability: { edit: () => ({ allowed: true }) },
  reconcile: { anchors: () => 0 },
  attribution: { attribute: () => null },
  report: (error) => { throw error; },
  timers: { now: () => clock, start: () => 0, stop() {} }
});

let adopting = false;
watchUndoAdoption((doc) => { if (adopting) session.adopt(doc); });

const throughSession = {
  open: () => { adopting = true; flushEdits(); adopting = false; },
  edit: (p) => {
    const out = session.run({ name: p.name, needs: "edit", plan: () => ({ changes: p.changes, apply: p.apply }) });
    assert.equal(out.kind, "applied", p.name);
  },
  remote: (next) => { assert.equal(session.absorbServer(next), next); }
};

test("differential: the session's commands through the undo adapter leave 12a's stacks and the document exactly as the legacy noteEdit path does (seeded)", async () => {
  let coalesced = 0, refused = 0, forgotten = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const want = await drive(seed, legacy);
    const epoch = session.epoch(), generation = session.generation();
    const got = await drive(seed, throughSession);
    assert.deepEqual(got, want, "seed " + seed);
    assert.equal(session.epoch(), epoch + 1, "seed " + seed + ": the open was one adoption");
    const edits = want.filter((s) => !["undo", "redo", "wait", "remote"].includes(s.label)).length;
    assert.equal(session.generation(), generation + edits, "seed " + seed + ": one generation per accepted command");
    want.forEach((s, i) => {
      const prev = want[i - 1];
      if (prev && s.label === "remote" && s.sizes.undo + s.sizes.redo < prev.sizes.undo + prev.sizes.redo) forgotten++;
      if (prev && !["undo", "redo", "wait", "remote"].includes(s.label) && s.sizes.undo === prev.sizes.undo && s.sizes.redo === 0 && s.state !== prev.state) coalesced++;
      if (prev && (s.label === "undo" || s.label === "redo") && s.state === prev.state) refused++;
    });
  }
  assert.ok(coalesced > 20, "typing groups were exercised: " + coalesced);
  assert.ok(refused > 5, "empty or refused undo and redo were exercised: " + refused);
  assert.ok(forgotten > 5, "server updates forgot entries through the adapter: " + forgotten);
});
