import { createHash } from "node:crypto";
import * as Y from "yjs";
import { fromDocument } from "../proj/document.ts";
import { projectionReferences, serializeProjection } from "../proj/reference.ts";
import { copy, records } from "../proj/value.ts";
import type { ProjectionBag } from "../proj/value.ts";

export interface PerfFixture {
  name: string;
  document: ProjectionBag;
  copies: number;
  fileBytes: number;
  sha256: string;
}

export function scalePerfFixture(base: ProjectionBag, count: number): ProjectionBag {
  const result = copy(base);
  const rows: ProjectionBag[] = [], comments: ProjectionBag[] = [], shots: ProjectionBag[] = [];
  for (let index = 0; index < count; index++) {
    const suffix = index ? `-${index}` : "";
    const retag = (value: unknown): unknown => typeof value === "string"
      ? value.replace(/(data-cmt|data-broll-id)="([^"]*)"/g, (_whole, attribute: string, id: string) => `${attribute}="${id}${suffix}"`)
      : value;
    for (const row of records(base.rows)) rows.push({ ...copy(row), id: String(row.id) + suffix, audioText: retag(row.audioText), visualText: retag(row.visualText) });
    for (const comment of records(base.comments)) {
      const value: ProjectionBag = { ...copy(comment), id: String(comment.id) + suffix, rowId: String(comment.rowId) + suffix };
      if (comment.anchorId) value.anchorId = String(comment.anchorId) + suffix;
      comments.push(value);
    }
    for (const shot of records(base.brollShots)) shots.push({ ...copy(shot), id: String(shot.id) + suffix });
  }
  return Object.assign(result, { rows, comments, brollShots: shots });
}

export function perfFixtures(): PerfFixture[] {
  const references = projectionReferences();
  const largest = references.reduce((a, b) => a.appSaved.bytes > b.appSaved.bytes ? a : b);
  const base = references.find(item => item.name === "src/starters/long-demo.json");
  if (!base || largest.name !== base.name) throw new Error("Largest canonical fixture changed");
  const sizes = (copies: number): number[] => (["A", "B"] as const).map(candidate => {
    const replica = fromDocument(scalePerfFixture(base.document, copies), candidate);
    try { return Y.encodeStateAsUpdate(replica.doc).length; } finally { replica.destroy(); }
  });
  let copies = 47;
  while (Math.max(...sizes(copies)) > 2 * 1024 ** 2) copies--;
  while (Math.max(...sizes(copies + 1)) <= 2 * 1024 ** 2) copies++;
  return [
    { name: "largest canonical", copies: 1, document: base.document },
    { name: "large", copies: 10, document: scalePerfFixture(base.document, 10) },
    { name: "near 2 MiB", copies, document: scalePerfFixture(base.document, copies) }
  ].map(input => ({ ...input, fileBytes: Buffer.byteLength(serializeProjection(input.document)), sha256: createHash("sha256").update(JSON.stringify(input.document)).digest("hex") }));
}
