import assert from "node:assert/strict";
import * as Y from "yjs";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { migrateRows } from "../../../../src/bootstrap/document-ports.ts";
import type { DocumentShape, ValidatedDocument } from "../../../../src/core/document/validated.ts";
import { cells, convertedScript, joinedScript } from "./helpers.ts";

export function registrySource(overrides: Record<string, unknown> = {}): ValidatedDocument {
  return migrateRows({
    schema: 2, docId: "d0123456789abcdef0123456789abcdef", title: "Registry", rows: [], comments: [],
    people: [{ id: "p1", name: "Camera" }, { id: "p2", name: "Sound" }, { id: "p3", name: "Lights" }],
    productionTags: [
      { id: "t_lamp", name: "Lamp", cat: "prop", owner: "p1" }, { id: "t_rope", name: "Rope", cat: "prop" },
      { id: "t_case", name: "Case", cat: "prop" }, { id: "t_drone", name: "Drone", cat: "gear" }
    ],
    brollShots: [
      { id: "bs1", name: "Wide", origin: "list", owner: "p1", props: [{ id: "t_lamp", name: "Lamp" }] },
      { id: "bs2", name: "Close", origin: "list" }, { id: "bs3", name: "Medium", origin: "list" }
    ],
    ...overrides
  });
}

export function registryReload(document: DocumentShape): ValidatedDocument {
  return migrateRows(JSON.parse(JSON.stringify(document)));
}

export function registryCopies(
  run: (left: NativeScript, right: NativeScript, settle: () => void) => void,
  prepare: (seed: NativeScript) => void = () => undefined,
  document = registrySource()
): void {
  for (const reverse of [false, true]) {
    const seed = convertedScript(document);
    try {
      prepare(seed);
      const left = joinedScript(seed, 4), right = joinedScript(seed, 9), replay = joinedScript(seed, 10);
      try {
        let readLeft = Y.encodeStateVector(left.doc), readRight = Y.encodeStateVector(right.doc);
        run(left, right, () => {
          const one = Y.encodeStateAsUpdate(left.doc, readLeft), two = Y.encodeStateAsUpdate(right.doc, readRight);
          for (const update of reverse ? [two, one] : [one, two]) for (const copy of [left, right, replay]) Y.applyUpdate(copy.doc, update, "peer");
          const result = left.reader.document();
          assert.deepEqual(right.reader.document(), result);
          assert.deepEqual(replay.reader.document(), result);
          assert.deepEqual(Y.encodeStateAsUpdate(right.doc), Y.encodeStateAsUpdate(left.doc));
          assert.deepEqual(result, registryReload(result));
          readLeft = Y.encodeStateVector(left.doc);
          readRight = Y.encodeStateVector(right.doc);
        });
      } finally { for (const copy of [left, right, replay]) copy.doc.destroy(); }
    } finally { seed.doc.destroy(); }
  }
}

export function registrySession(document = registrySource()) {
  return openNativeSession({ kind: "document", document, conversion: { cells, at: "2026-11-19T00:00:00Z", by: "Writer", creation: "registry" } },
    { actor: "Writer", sanitize: html => typeof html === "string" ? html : "" });
}
