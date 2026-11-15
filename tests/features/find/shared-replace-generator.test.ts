import { test } from "node:test";
import assert from "node:assert/strict";
import { cellOf } from "../../../src/bootstrap/richtext.ts";
import { encodeSharedState } from "../../../src/adapters/collab/document.ts";
import { projection } from "../../../src/core/text/runs.ts";
import { harness } from "../../application/session-fakes.ts";
import { fakeNotices } from "../fakes.ts";
import {
  FIND_ORDERS, findSource, finder, findAct, findReplicas, findCopy, rowCells, agreedRows, deliverAll, sendAs, typedAt
} from "./shared-replace-support.ts";

const LIMITS: Readonly<Record<string, number>> = {
  "the shared result differs from standalone": 0,
  "a shared Replace was refused": 0,
  "the copies disagree": 0,
  "the other copy's letter was lost": 0,
  "undo did not give back the words before the Replace": 0,
  "undo was not one step": 0
};

const WORDS = ["cup", "a", "tea", "up", "cupcup", "of"];
const NEEDLES = ["cup", "a", "up", "tea"];
const PUTS = ["mug", "", "big cup", "A"];

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generated(seed: number) {
  const next = random(seed), pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)] as T;
  const parts: string[] = [];
  const count = 2 + Math.floor(next() * 6);
  for (let index = 0; index < count; index++) {
    const word = pick(WORDS), roll = next();
    parts.push(roll < 0.2 ? "<strong>" + word + "</strong>" : roll < 0.3 ? "<em>" + word + "</em>" : word);
    parts.push(next() < 0.15 ? "<br>" : " ");
  }
  const cell = parts.join("").replace(/\s+$/, "");
  return { cell, find: pick(NEEDLES), put: pick(PUTS), all: next() < 0.5, nth: Math.floor(next() * 3), typed: next(), order: pick(FIND_ORDERS) };
}

const plain = (html: unknown) => projection(cellOf(String(html ?? "")));

test("seeded generator: shared Find replace equals standalone, keeps the other copy's typing, and undoes in one step", () => {
  const violations: Record<string, string[]> = {};
  let exercised = 0;
  const violate = (kind: string, detail: string) => { (violations[kind] ??= []).push(detail); };
  for (let seed = 1; seed <= 80; seed++) {
    const step = generated(seed), label = `seed ${seed}: ${JSON.stringify(step)}`;
    const h = harness();
    h.session.adopt(findSource(step.cell));
    const alone = finder(h.session, fakeNotices());
    try { findAct(alone, step); } finally { alone.dispose(); }
    const standalone = h.session.read(doc => doc?.rows.map(rowCells));
    const set = findReplicas(findSource(step.cell)), notices = fakeNotices(), a = findCopy(set.a, "Alice", notices);
    try {
      const route = finder(a.session, notices, a.shared);
      try { findAct(route, step); } finally { route.dispose(); }
      if (notices.shown.some(item => item.kind === "warn" && item.message.startsWith("This "))) { violate("a shared Replace was refused", label); continue; }
      deliverAll(set.queue, "D1");
      const expected = JSON.stringify(standalone), shared = JSON.stringify(agreedRows(label, set));
      if (expected !== shared) violate("the shared result differs from standalone", label + " " + expected + " " + shared);
      const replaced = a.owner.sizes().undo;
      if (replaced > 1) violate("undo was not one step", label);
      const first: unknown = (JSON.parse(shared) as { audioText?: unknown }[])[0]?.audioText;
      const before = plain(step.cell), length = plain(first).length, at = Math.floor(step.typed * (length + 1));
      if (!length) continue;
      sendAs(set.b, at < length ? typedAt(at, false, "typed", "Z") : typedAt(length - 1, true, "typed", "Z"));
      deliverAll(set.queue, step.order);
      let rows: ReturnType<typeof agreedRows> = [];
      try { rows = agreedRows(label, set, step.order); } catch { violate("the copies disagree", label); continue; }
      if (plain(rows[0]?.audioText).split("Z").length !== 2) violate("the other copy's letter was lost", label);
      if (!replaced) continue;
      exercised++;
      a.owner.undo();
      deliverAll(set.queue, step.order);
      try { rows = agreedRows(label + " undone", set, step.order); } catch { violate("the copies disagree", label + " undone"); continue; }
      if (plain(rows[0]?.audioText).replace("Z", "") !== before) violate("undo did not give back the words before the Replace", label + " " + JSON.stringify(rows[0]?.audioText));
    } finally { a.session.dispose(); set.close(); }
  }
  assert.ok(exercised >= 40, "only " + exercised + " generated cases replaced something");
  const counted = Object.fromEntries(Object.keys(LIMITS).map(kind => [kind, violations[kind]?.length ?? 0]));
  assert.deepEqual(Object.keys(violations).filter(kind => !(kind in LIMITS)), []);
  for (const kind of Object.keys(LIMITS)) assert.ok((counted[kind] ?? 0) <= (LIMITS[kind] ?? 0), kind + ": " + JSON.stringify(violations[kind]?.slice(0, 3)));
});

const SIZE_LIMITS = { replace: 350, replaceUndo: 920, replaceAll: 31400, replaceAllUndo: 96800 };

test("stored size: one Replace, Replace all over a hundred matches, and the undo of each stay within their counted byte limits", () => {
  const grown = (run: (route: ReturnType<typeof finder>) => void, cell: string) => {
    const set = findReplicas(findSource(cell)), notices = fakeNotices(), a = findCopy(set.a, "Alice", notices);
    try {
      const start = encodeSharedState(set.a).length;
      const route = finder(a.session, notices, a.shared);
      try { run(route); } finally { route.dispose(); }
      const replaced = encodeSharedState(set.a).length;
      assert.equal(a.owner.undo().ok, true);
      return { command: replaced - start, undo: encodeSharedState(set.a).length - replaced };
    } finally { a.session.dispose(); set.close(); }
  };
  const one = grown(route => { route.search("cup", "mug"); route.replace(); }, "a cup of tea");
  const all = grown(route => { route.search("cup", "mug"); route.replaceAll(); }, Array.from({ length: 100 }, () => "cup").join(" "));
  assert.ok(one.command > 0 && one.command <= SIZE_LIMITS.replace, JSON.stringify(one));
  assert.ok(one.undo > 0 && one.undo <= SIZE_LIMITS.replaceUndo, JSON.stringify(one));
  assert.ok(all.command > 0 && all.command <= SIZE_LIMITS.replaceAll, JSON.stringify(all));
  assert.ok(all.undo > 0 && all.undo <= SIZE_LIMITS.replaceAllUndo, JSON.stringify(all));
});
