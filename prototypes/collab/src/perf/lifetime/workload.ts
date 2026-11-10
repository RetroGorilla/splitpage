import * as Y from "yjs";
import { addProjectionGallerySlot, createProjectionReplica, fromDocument } from "../../proj/document.ts";
import { projectionReferences } from "../../proj/reference.ts";
import { htmlToDelta } from "../../proj/richtext.ts";
import { copy, records } from "../../proj/value.ts";
import type { ProjectionBag } from "../../proj/value.ts";
import { mapValue, textValue } from "../../schema.ts";
import type { SchemaReplica } from "../../schema.ts";
import { scalePerfFixture } from "../fixtures.ts";
import { splitPerfBeat, writePerfStatus } from "../operations.ts";

export const lifetimePlan = {
  version: 1, candidate: "B", writers: [2, 6], correctionEvery: 55, revisionBeats: 5, revisionDivisor: 2,
  splits: 5, joins: 5, joinRetirements: 5, moves: 5, removals: 2, restores: 1, statusesPerBeat: 2,
  commentsPerBlock: 4, tagsPerBlock: 31, picturesOnce: 10, maxBlocks: 80, capBytes: 2 * 1024 ** 2,
  sources: {
    correctionEvery: "artifact 7 section 4: 55-character typing case; one correction per case is a stated scenario, not telemetry",
    revisionBeats: "tools/perf-record.mjs SPLITS=5 out of the canonical 30 beats; reuse that intervention count",
    revisionDivisor: "artifact 8 T01 replaces original bc in abcd: half the original characters",
    structure: "five recorder splits, their five T06 joins/semantic retirements, five supported whole-segment MOVE interventions",
    removals: "T10 retained removal, plus one remove/restore control; one of each per canonical block",
    status: "todo/ready/shot workflow: two transitions on each canonical beat",
    commentsAndTags: "largest canonical fixture has four comments and 31 production tags; one review change each per block",
    pictures: "artifact 7 images fixture inserts ten pictures; once per script, references only",
    writers: "plan trusted group is two to six; writers take consecutive beats, with causal delivery at beat boundaries",
    horizon: "one block is one canonical draft plus its partial revision; append canonical blocks as SCALE.grow does until the cap"
  }
} as const;

export interface LifetimeOperations {
  typing: number; correctionDeletes: number; correctionRetypes: number; revisionDeletes: number; revisionTyping: number;
  atoms: number; splits: number; joins: number; joinRetirements: number; moves: number; removals: number; restores: number;
  statuses: number; comments: number; tags: number; pictures: number;
}

export interface LifetimeInterventions { correctionsPer55: number; revisionBeats: number; statusesPerBeat: number; removals: number }

export const defaultLifetimeInterventions: LifetimeInterventions = { correctionsPer55: 1, revisionBeats: lifetimePlan.revisionBeats,
  statusesPerBeat: lifetimePlan.statusesPerBeat, removals: lifetimePlan.removals };

export function emptyLifetimeOperations(): LifetimeOperations {
  return { typing: 0, correctionDeletes: 0, correctionRetypes: 0, revisionDeletes: 0, revisionTyping: 0, atoms: 0,
    splits: 0, joins: 0, joinRetirements: 0, moves: 0, removals: 0, restores: 0, statuses: 0, comments: 0, tags: 0, pictures: 0 };
}

export function canonicalLifetimeSource(): ProjectionBag {
  const source = projectionReferences().reduce((a, b) => a.appSaved.bytes > b.appSaved.bytes ? a : b);
  if (source.name !== "src/starters/long-demo.json" || records(source.document.rows).length !== 30) throw new Error("Canonical workload changed");
  return source.document;
}

function blockSource(base: ProjectionBag, block: number): ProjectionBag {
  const scaled = scalePerfFixture(base, block + 1);
  return { ...scaled, rows: records(scaled.rows).slice(-30), comments: records(scaled.comments).slice(-4),
    brollShots: records(scaled.brollShots).slice(-records(base.brollShots).length) };
}

export class LifetimeHistory {
  readonly master: SchemaReplica;
  readonly writers: SchemaReplica[];
  readonly operations = emptyLifetimeOperations();
  readonly base: ProjectionBag;
  readonly undo: Y.UndoManager[];
  readonly interventions: LifetimeInterventions;
  blocks = 0;
  onStep: (() => void) | undefined;
  private turn = 0;

  constructor(writers: number, base = canonicalLifetimeSource(), retainUndo = false, interventions: Partial<LifetimeInterventions> = {}) {
    this.base = base;
    this.interventions = { ...defaultLifetimeInterventions, ...interventions };
    this.master = fromDocument({ ...copy(base), rows: [], comments: [], brollShots: [] }, "B", 100);
    this.writers = Array.from({ length: writers }, (_, index) => createProjectionReplica("B", index + 1));
    this.undo = retainUndo ? this.writers.map(writer => new Y.UndoManager([
      ...writer.doc.share.values()
    ], { trackedOrigins: new Set([null, writer.localOrigin]), captureTimeout: 1000 })) : [];
  }

  private edit(action: (replica: SchemaReplica) => void): void {
    const writer = this.writers[this.turn++ % this.writers.length];
    if (!writer) throw new Error("No writer");
    Y.applyUpdate(writer.doc, Y.encodeStateAsUpdate(this.master.doc, Y.encodeStateVector(writer.doc)), "delivery");
    this.undo[(this.turn - 1) % this.writers.length]?.stopCapturing();
    action(writer);
    Y.applyUpdate(this.master.doc, Y.encodeStateAsUpdate(writer.doc, Y.encodeStateVector(this.master.doc)), "delivery");
    this.onStep?.();
  }

  appendBlock(): void {
    const block = this.blocks;
    const source = blockSource(this.base, block);
    const rows = records(source.rows);
    const blank = fromDocument({ ...copy(source), rows: rows.map(row => ({ ...row, audioText: "", visualText: "" })) }, "B", 101);
    try {
      this.master.doc.transact(() => {
        for (const root of ["segments", "beats", "visuals", "gallery", "comments", "replies", "shots", "headings"]) {
          for (const [key, value] of blank.doc.getMap(root)) {
            if (!(value instanceof Y.AbstractType)) throw new Error("Expected cloneable shared record");
            this.master.doc.getMap(root).set(key, (value as Y.Map<unknown>).clone());
          }
        }
        this.master.doc.getArray<string>("order").push(blank.doc.getArray<string>("order").toArray());
      }, "draft-structure");
    } finally { blank.destroy(); }
    this.onStep?.();
    for (const row of rows) this.edit(writer => {
      for (const field of ["audioText", "visualText"]) {
        const location = field === "audioText" ? writer.locate(String(row.id)) : { text: textValue(mapValue(writer.doc.getMap("visuals").get(`visual-${String(row.id)}`)).get("text")), start: 0 };
        let index = location.start;
        for (const delta of htmlToDelta(String(row[field] ?? ""), source.productionTags, source.comments)) {
          if (typeof delta.insert !== "string") { location.text.insertEmbed(index++, delta.insert, delta.attributes); this.operations.atoms++; continue; }
          for (const character of delta.insert.split("")) {
            location.text.insert(index++, character, delta.attributes ?? {});
            this.operations.typing++;
            if (Math.floor(this.operations.typing * this.interventions.correctionsPer55 / lifetimePlan.correctionEvery)
              > Math.floor((this.operations.typing - 1) * this.interventions.correctionsPer55 / lifetimePlan.correctionEvery)) {
              location.text.delete(--index, 1); this.operations.correctionDeletes++;
              location.text.insert(index++, character, delta.attributes ?? {}); this.operations.correctionRetypes++;
            }
          }
        }
      }
    });
    for (let index = 0; index < this.interventions.revisionBeats; index++) this.edit(writer => {
      const row = rows[index], next = rows[index + 1];
      if (!row || !next) throw new Error("Missing revision beat");
      const location = writer.locate(String(row.id));
      const length = Math.floor((location.end - location.start) / lifetimePlan.revisionDivisor);
      const words = htmlToDelta(String(next.audioText), source.productionTags, source.comments).map(item => typeof item.insert === "string" ? item.insert : "").join("");
      const replacement = words.repeat(Math.ceil(length / words.length)).slice(0, length);
      location.text.delete(location.start, length); this.operations.revisionDeletes++;
      for (let offset = 0; offset < replacement.length; offset++) { location.text.insert(location.start + offset, replacement[offset] as string, {}); this.operations.revisionTyping++; }
    });
    for (let index = 0; index < lifetimePlan.splits; index++) this.edit(writer => {
      const id = String(rows[index]?.id), split = `draft-${block}-split-${index}`;
      const location = writer.locate(id);
      splitPerfBeat(writer, id, Math.floor((location.end - location.start) / 2), split); this.operations.splits++;
      const join = `writer-${writer.doc.clientID}-join-${block}-${index}`;
      writer.join(split, id, join); this.operations.joins++;
      writer.doc.getMap("retiredJoins").set(join, true); this.operations.joinRetirements++;
    });
    for (let index = 0; index < lifetimePlan.moves; index++) this.edit(writer => {
      writer.doc.getArray<string>("order").insert(0, [`seg-b-${String(rows[29 - index]?.id)}`]); this.operations.moves++;
    });
    for (let index = 0; index < this.interventions.removals; index++) this.edit(writer => {
      const id = String(rows[29 - index]?.id), removal = `draft-${block}-removal-${index}`;
      const location = writer.locate(id), observed = [];
      for (let at = location.start; at < location.end; at++) {
        const item = Y.createRelativePositionFromTypeIndex(location.text, at, 0).item;
        if (item) observed.push({ client: item.client, clock: item.clock });
      }
      writer.remove(id, removal, `writer-${writer.doc.clientID}`, observed); this.operations.removals++;
      if (index === 0) { writer.restore(id, removal); this.operations.restores++; }
    });
    for (const row of rows) this.edit(writer => {
      for (let index = 0; index < this.interventions.statusesPerBeat; index++) {
        const value = index % 2 ? "shot" : "ready", suffix = index < 2 ? value : `${value}-${index}`;
        writePerfStatus(writer, String(row.id), `draft-${block}-status-${row.id}-${suffix}`, value); this.operations.statuses++;
      }
    });
    for (const comment of records(source.comments)) this.edit(writer => {
      mapValue(writer.doc.getMap("comments").get(String(comment.id))).set("text", String(comment.body) + ` Review ${block}.`); this.operations.comments++;
    });
    for (const tag of records(source.productionTags)) this.edit(writer => {
      mapValue(writer.doc.getMap("tags").get(String(tag.id))).set("notes", `Review ${block}.`); this.operations.tags++;
    });
    if (block === 0) for (let index = 0; index < lifetimePlan.picturesOnce; index++) this.edit(writer => {
      addProjectionGallerySlot(writer.doc, String(rows[index]?.id), { imageRef: { sha256: (index + 1).toString(16).padStart(64, "0"), width: 1, height: 1, mime: "image/png" } }, 1, `draft-picture-${index}`);
      this.operations.pictures++;
    });
    this.blocks++;
  }

  synchronize(): void { for (const writer of this.writers) Y.applyUpdate(writer.doc, Y.encodeStateAsUpdate(this.master.doc, Y.encodeStateVector(writer.doc)), "delivery"); }

  destroy(): void { for (const manager of this.undo) manager.destroy(); for (const writer of this.writers) writer.destroy(); this.master.destroy(); }
}
