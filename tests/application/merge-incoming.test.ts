import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeIncoming } from "../../src/application/session/merge-incoming.ts";
import type { ValidatedDocument } from "../../src/core/document/validated.ts";
import type { IdSource } from "../../src/core/document/ports.ts";
import { mergeStates } from "../../src/core/merge-states.ts";
import { migrateRows } from "../../src/core/migrate.ts";
import type { LineShotIds } from "../../src/core/production/broll.ts";
import { EDITOR, fakeDecoder, fixedClock } from "../core/merge/fakes.ts";
import { fakeMigration } from "../core/migrate-ports.ts";
import { rawScript } from "./session-fakes.ts";

function isDoc(raw: unknown): boolean {
  return typeof raw === "object" && raw !== null;
}

test("#415: theirs enters before the merge, then mine and base; a base that is no document merges as none", () => {
  const order: string[] = [];
  const seen: (string | null)[] = [];
  const merged = migrateRows(rawScript("Merged"), fakeMigration().ports);
  const got = mergeIncoming({ base: null, mine: rawScript("Mine"), theirs: rawScript("Theirs") }, isDoc, {
    entry: function (raw) {
      const doc = migrateRows(raw, fakeMigration().ports);
      order.push(doc.title);
      return doc;
    },
    merge: function (base: ValidatedDocument | null, mine: ValidatedDocument, theirs: ValidatedDocument) {
      seen.push(base && base.title, mine.title, theirs.title);
      return { merged: merged, conflicts: [], stats: { rowsFromThem: 0, rowsFromMe: 0, rowsAddedByMe: 0, rowsAddedByThem: 0 } };
    }
  });
  assert.equal(got.merged, merged, "the merge's own answer is handed back, not entered again");
  assert.deepEqual(order, ["Theirs", "Mine"]);
  assert.deepEqual(seen, [null, "Mine", "Theirs"]);
});

function drawsFor(side: string): IdSource {
  let n = 0;
  return {
    id: function (prefix: string) { n++; return prefix + "-" + side + "-" + n; },
    docId: function () { return "d" + "7".repeat(32); }
  };
}

function legacyScript(title: string): Record<string, unknown> {
  return {
    schema: 5, title: title, docId: "d" + "7".repeat(32),
    rows: [{ id: "r1", visualText: "B-roll: Steam", audioText: "Kettle on.", status: "todo" }],
    brollShots: []
  };
}

function mergedShots(mine: unknown): string[] {
  const sides = ["theirs", "mine", "base"];
  const migration = fakeMigration();
  const got = mergeIncoming({ base: legacyScript("Base"), mine: mine, theirs: legacyScript("Theirs") }, isDoc, {
    entry: function (raw: unknown, lines: LineShotIds) {
      return migrateRows(raw, { ...fakeMigration().ports, ids: drawsFor(sides.shift() || "late"), brollLines: lines });
    },
    merge: function (base: ValidatedDocument | null, ours: ValidatedDocument, theirs: ValidatedDocument) {
      return mergeStates(base, ours, theirs, {
        decode: fakeDecoder([]).decode, ids: drawsFor("merge"), clock: fixedClock, editor: () => EDITOR, migrate: migration.ports
      });
    }
  });
  return got.merged.brollShots.map(function (b) { return b.id + " " + String(b.name); });
}

test("6.5 follow-up: an unkeyed b-roll line with no record on any side merges into one record, not one per side", () => {
  const shots = mergedShots(legacyScript("Mine"));
  assert.equal(shots.length, 1, shots.join(", "));
  assert.match(shots[0] as string, / Steam$/);
});

test("6.5 follow-up: when one side already holds the line's record, the sides that draw one for it take that record's id", () => {
  const live = migrateRows(legacyScript("Mine"), { ...fakeMigration().ports, ids: drawsFor("live") });
  const held = live.brollShots.map(function (b) { return b.id; });
  assert.deepEqual(held, ["bs-live-1"]);
  assert.deepEqual(mergedShots(live), ["bs-live-1 Steam"]);
});
