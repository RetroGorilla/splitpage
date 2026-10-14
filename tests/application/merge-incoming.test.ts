import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeIncoming } from "../../src/application/session/merge-incoming.ts";
import type { ValidatedDocument } from "../../src/core/document/validated.ts";
import { migrateRows } from "../../src/core/migrate.ts";
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
