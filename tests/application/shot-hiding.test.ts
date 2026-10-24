import { test } from "node:test";
import assert from "node:assert/strict";
import { SHOT_HIDE_GRACE_MS, createShotHiding } from "../../src/application/shot-hiding.ts";
import type { ShotHiding, ShotRow } from "../../src/application/shot-hiding.ts";

interface World {
  readonly hiding: ShotHiding;
  readonly seen: string[];
  readonly timers: Map<number, { readonly run: () => void; readonly ms: number }>;
  rows: readonly ShotRow[] | null;
  flag: boolean;
}

function world(rows: readonly ShotRow[] | null, flag = false): World {
  const seen: string[] = [];
  const timers = new Map<number, { readonly run: () => void; readonly ms: number }>();
  let next = 0;
  const w: World = {
    seen: seen,
    timers: timers,
    rows: rows,
    flag: flag,
    hiding: createShotHiding({
      flags: {
        hideShot: () => w.flag,
        setHideShot: (on) => { seen.push("flag " + String(on)); w.flag = on; }
      },
      remember: (on) => { seen.push("remember " + String(on)); },
      rows: () => w.rows,
      timers: {
        start: (run, ms) => { timers.set(++next, { run: run, ms: ms }); return next; },
        stop: (handle) => { seen.push("stop " + String(handle)); timers.delete(handle as number); }
      }
    })
  };
  w.hiding.onHiding(() => { seen.push("hiding"); });
  return w;
}

const ROWS: readonly ShotRow[] = [
  { id: "a", status: "todo" },
  { id: "b", status: "shot" },
  { id: "c", status: "shot" },
  { id: "d", status: "todo" },
  { id: "e", status: "shot" }
];

function shape(hiding: ShotHiding, rows: readonly ShotRow[]): string[] {
  return hiding.groups(rows).map((item) => ("strip" in item ? "[" + item.strip.join(",") + "]" : item.row.id + "@" + String(item.index)));
}

test("shot hiding: set turns the flag on, forgets opened strips, remembers the choice and announces once", () => {
  const w = world(ROWS);
  assert.equal(w.hiding.set(false), false);
  assert.deepEqual(w.seen, []);
  assert.equal(w.hiding.set(true), true);
  assert.deepEqual(w.seen, ["flag true", "remember true", "hiding"]);
  assert.equal(w.hiding.on(), true);
  w.hiding.expand(["b"]);
  w.hiding.set(false);
  w.hiding.set(true);
  assert.deepEqual(shape(w.hiding, ROWS), ["a@0", "[b,c]", "d@3", "[e]"]);
});

test("shot hiding: groups gathers runs of hidden shot rows into strips and keeps every other row with its index", () => {
  const w = world(ROWS);
  assert.deepEqual(shape(w.hiding, ROWS), ["a@0", "b@1", "c@2", "d@3", "e@4"]);
  w.flag = true;
  assert.deepEqual(shape(w.hiding, ROWS), ["a@0", "[b,c]", "d@3", "[e]"]);
  assert.equal(w.hiding.hidden({ id: "a", status: "todo" }), false);
  assert.equal(w.hiding.hidden({ id: "b", status: "shot" }), true);
});

test("shot hiding: expand opens the named strips, skipping empty ids, and announces", () => {
  const w = world(ROWS, true);
  w.hiding.expand(["b", "", "c"]);
  assert.deepEqual(shape(w.hiding, ROWS), ["a@0", "b@1", "c@2", "d@3", "[e]"]);
  assert.deepEqual(w.seen, ["hiding"]);
});

test("shot hiding: reveal opens the whole run of shot rows around a hidden row, and does nothing otherwise", () => {
  const w = world(ROWS, true);
  w.hiding.reveal("a");
  w.hiding.reveal("missing");
  assert.deepEqual(w.seen, []);
  w.hiding.reveal("c");
  assert.deepEqual(w.seen, ["hiding"]);
  assert.deepEqual(shape(w.hiding, ROWS), ["a@0", "b@1", "c@2", "d@3", "[e]"]);
  w.seen.length = 0;
  w.hiding.reveal("b");
  assert.deepEqual(w.seen, [], "an opened row is not revealed again");
  w.rows = null;
  w.hiding.reveal("e");
  w.flag = false;
  w.rows = ROWS;
  w.hiding.reveal("e");
  assert.deepEqual(w.seen, []);
});

test("shot hiding: a grace keeps a row open, restarts when armed again, and closes it after the grace", () => {
  const w = world(ROWS, true);
  w.hiding.armGrace("e");
  assert.deepEqual(shape(w.hiding, ROWS).slice(-1), ["e@4"]);
  assert.deepEqual([...w.timers.values()].map((t) => t.ms), [SHOT_HIDE_GRACE_MS]);
  w.hiding.armGrace("e");
  assert.deepEqual(w.seen, ["stop 1"]);
  assert.deepEqual([...w.timers.keys()], [2]);
  w.timers.get(2)?.run();
  assert.deepEqual(w.seen, ["stop 1", "hiding"]);
  assert.deepEqual(shape(w.hiding, ROWS).slice(-1), ["[e]"]);
});

test("shot hiding: clearing a grace stops its timer and leaves the row open", () => {
  const w = world(ROWS, true);
  w.hiding.armGrace("b");
  w.hiding.clearGrace("b");
  w.hiding.clearGrace("b");
  assert.deepEqual(w.seen, ["stop 1"]);
  assert.equal(w.timers.size, 0);
  assert.deepEqual(shape(w.hiding, ROWS).slice(0, 3), ["a@0", "b@1", "[c]"]);
});

test("shot hiding: a listener can unsubscribe, and dispose stops every timer and drops every listener", () => {
  const w = world(ROWS, true);
  const extra: string[] = [];
  const stop = w.hiding.onHiding(() => { extra.push("x"); });
  w.hiding.expand(["b"]);
  stop();
  w.hiding.expand(["c"]);
  assert.deepEqual(extra, ["x"]);
  w.hiding.armGrace("e");
  w.seen.length = 0;
  w.hiding.dispose();
  assert.deepEqual(w.seen, ["stop 1"]);
  assert.equal(w.timers.size, 0);
  w.hiding.expand(["e"]);
  assert.deepEqual(w.seen, ["stop 1"]);
  assert.deepEqual(shape(w.hiding, ROWS), ["a@0", "[b,c]", "d@3", "e@4"]);
});
