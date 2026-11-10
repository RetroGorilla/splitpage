import * as Y from "yjs";
import { mapValue } from "../schema.ts";
import type { SchemaReplica } from "../schema.ts";
import { addProjectionGallerySlot, addProjectionProp } from "./document.ts";
import { projectionConcurrentSeed } from "./concurrency.ts";
import { DocumentProjectionHarness } from "./harness.ts";
import { bag, copy, rank, records, writeRecord } from "./value.ts";
import type { ProjectionBag } from "./value.ts";
import { assertProjectionInput, projectionReferences } from "./reference.ts";
import { differences } from "./experiment.ts";

export const projectionLimitFamilies = ["people", "tags", "gallery", "props", "poster", "heading"] as const;
export type ProjectionLimitFamily = typeof projectionLimitFamilies[number];

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function picture(index: number): ProjectionBag {
  return { sha256: index.toString(16).padStart(64, "0"), width: 1, height: 1, mime: "image/png" };
}

function countPictures(document: ProjectionBag): number {
  return records(document.rows).reduce((total, row) => total + (row.imageRef ? 1 : 0) + records(row.moreImages).filter(slot => slot.imageRef).length, 0);
}

export function projectionLimitMeasure(document: ProjectionBag, family: ProjectionLimitFamily): number {
  if (family === "gallery") return countPictures(document);
  if (family === "props") return records(records(document.brollShots)[0]?.props).length;
  if (family === "poster") return records(records(document.rows)[0]?.imageLinks).filter(link => link.poster === true).length;
  const counts = new Map<string, number>();
  const values = family === "people" ? records(document.people) : family === "tags" ? records(document.productionTags) : records(document.sections);
  for (const value of values) {
    const key = family === "heading" ? String(value.firstSceneId) : `${family === "tags" ? String(value.cat) + ":" : ""}${String(value.name).toLowerCase()}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

function addPerson(replica: SchemaReplica, id: string, name: string, position: number): void {
  const record = new Y.Map<unknown>();
  replica.doc.getMap("people").set(id, record);
  writeRecord(record, { id, name }, ["id", "name"]);
  record.set("rank", rank(position));
}

function addHeading(replica: SchemaReplica, row: string, id: string, name: string): void {
  const record = new Y.Map<unknown>();
  replica.doc.getMap("headings").set(id, record);
  record.set("keys", ["id", "name", "firstSceneId"]);
  if (replica.candidate === "A") {
    const location = replica.locate(row);
    location.text.insertEmbed(location.start - 1, { h: id }, {});
    location.text.insert(location.start, name, {});
  } else {
    const segment = new Y.Map<unknown>();
    const key = `seg-h-${id}`;
    replica.doc.getMap("segments").set(key, segment);
    segment.set("head", { h: id });
    const text = new Y.Text();
    segment.set("text", text);
    text.insert(0, name, {});
    const order = replica.doc.getArray<string>("order");
    order.insert(order.toArray().indexOf(`seg-b-${row}`), [key]);
  }
}

function setup(family: ProjectionLimitFamily, level: number, seed: number): ProjectionBag {
  const source = copy(projectionConcurrentSeed);
  source.comments = [];
  if (family === "tags") {
    (source.productionTags as ProjectionBag[]).push(
      { id: "t_left", cat: "prop", name: `Left ${seed}`, owner: "", notes: "", status: "needed" },
      { id: "t_right", cat: "prop", name: `Right ${seed}`, owner: "", notes: "", status: "needed" }
    );
  }
  if (family === "gallery") {
    const row = records(source.rows)[0] as ProjectionBag;
    row.imageRef = picture(seed * 1000);
    row.moreImages = Array.from({ length: level - 3 }, (_, index) => ({ imageRef: picture(seed * 1000 + index + 1) }));
  }
  if (family === "props") (records(source.brollShots)[0] as ProjectionBag).props = Array.from({ length: level - 2 }, (_, index) => ({ id: "", name: `prop-${seed}-${index}` }));
  if (family === "poster") (records(source.rows)[0] as ProjectionBag).imageLinks = [
    { href: `https://example.com/${seed}/a` }, { href: `https://example.com/${seed}/b` }
  ];
  return source;
}

function operation(replica: SchemaReplica, family: ProjectionLimitFamily, side: "A" | "B", level: number, seed: number, choice: number): void {
  const suffix = `${seed}-${side}`;
  replica.doc.transact(() => {
    if (family === "people" || family === "tags") {
      const same = level === 2 || side === "A";
      const name = same ? `New ${seed}` : `Other ${seed}`;
      if (family === "people") addPerson(replica, `new-${suffix}`, name, choice);
      else mapValue(replica.doc.getMap("tags").get(side === "A" ? "t_left" : "t_right")).set("name", name);
    } else if (family === "gallery") {
      addProjectionGallerySlot(replica.doc, "R1", { imageRef: picture(seed * 1000 + (side === "A" ? 998 : 999)) }, choice, `gallery-${suffix}`);
    } else if (family === "props") {
      const props = mapValue(mapValue(replica.doc.getMap("shots").get("s1")).get("props"));
      addProjectionProp(props, { id: "", name: `new-${suffix}` }, choice);
    } else if (family === "poster") {
      const links = mapValue(mapValue(replica.doc.getMap("gallery").get("R1:slot:0")).get("links"));
      const target = side === "B" && level === 2 ? "b" : "a";
      mapValue(links.get(`u:https://example.com/${seed}/${target}`)).set("poster", true);
    } else addHeading(replica, side === "B" && level === 1 ? "R2" : "R1", `H-${suffix}`, `Heading ${suffix}`);
  }, replica.localOrigin);
}

function limitSteps(family: ProjectionLimitFamily, level: number, seed: number, positionA: number, positionB: number): string[] {
  if (family === "people") return [`Start with person p1/A; A adds new-${seed}-A/New ${seed}; B adds new-${seed}-B/${level === 2 ? "New" : "Other"} ${seed}.`];
  if (family === "tags") return [`Start with Cup, t_left/Left ${seed}, t_right/Right ${seed}, all prop; A renames t_left to New ${seed}; B renames t_right to ${level === 2 ? "New" : "Other"} ${seed}.`];
  if (family === "gallery") return [
    `Start with ${level - 2} pictures on R1, refs with integer hashes ${seed * 1000} through ${seed * 1000 + level - 3}.`,
    `A adds gallery-${seed}-A, ref ${seed * 1000 + 998}, rank ${positionA}; B adds gallery-${seed}-B, ref ${seed * 1000 + 999}, rank ${positionB}.`
  ];
  if (family === "props") return [`Start s1 with ${level - 2} free-name props prop-${seed}-0 onward; A adds new-${seed}-A at rank ${positionA}; B adds new-${seed}-B at rank ${positionB}.`];
  if (family === "poster") return [`Start R1 links https://example.com/${seed}/a and /b, neither a poster; A marks /a; B marks /${level === 2 ? "b" : "a"}.`];
  return [`Start R1/a and R2/b without headers; A inserts H-${seed}-A/Heading ${seed}-A before R1; B inserts H-${seed}-B/Heading ${seed}-B before ${level === 2 ? "R1" : "R2"}.`];
}

export function projectionLimitCaseName(value: { family: string; seed: number; level: number; candidate: string; order: string }): string {
  return `limit/${value.family}/${value.seed}/${value.level}/${value.candidate}/${value.order}`;
}

function retainedLimitObjects(replica: SchemaReplica, family: ProjectionLimitFamily): number {
  if (family === "people" || family === "tags") return replica.doc.getMap(family).size;
  if (family === "heading") return replica.doc.getMap("headings").size;
  if (family === "props") return mapValue(mapValue(replica.doc.getMap("shots").get("s1")).get("props")).size;
  if (family === "gallery") return [...replica.doc.getMap("gallery").values()].filter(value => bag(mapValue(value).get("picture")).imageRef).length;
  const links = mapValue(mapValue(replica.doc.getMap("gallery").get("R1:slot:0")).get("links"));
  return [...links.values()].filter(value => mapValue(value).get("poster") === true).length;
}

export function projectionLimitStates(seeds = [1, 7, 23, 91, 313]) {
  const observations = [];
  const documents: ProjectionBag[] = [];
  for (const seed of seeds) {
    const next = random(seed);
    for (const family of projectionLimitFamilies) for (const level of family === "gallery" ? [60, 61, 62] : family === "props" ? [40, 41] : [1, 2]) {
      const positionA = Math.floor(next() * 1000), positionB = Math.floor(next() * 1000);
      for (const candidate of ["A", "B"] as const) for (const order of ["D1", "dup", "rev", "late-C"] as const) {
        const source = setup(family, level, seed);
        const harness = new DocumentProjectionHarness(source, candidate, seed % 2 === 1);
        try {
          operation(harness.alice, family, "A", level, seed, positionA);
          operation(harness.bob, family, "B", level, seed, positionB);
          const individually = harness.documents().map(document => projectionLimitMeasure(document, family));
          harness.queue.flush(order);
          if (order === "late-C") harness.lateJoin();
          const before = harness.replicas.map(replica => Y.encodeStateAsUpdate(replica.doc));
          const merged = harness.documents();
          harness.replicas.forEach((replica, index) => {
            if (Buffer.compare(before[index] as Uint8Array, Y.encodeStateAsUpdate(replica.doc)) !== 0) throw new Error("Limit projection wrote shared state");
          });
          const document = merged[0] as ProjectionBag;
          documents.push(document);
          observations.push({
            seed, family, level, candidate, order, individually,
            clientA: harness.alice.doc.clientID, clientB: harness.bob.doc.clientID,
            steps: limitSteps(family, level, seed, positionA, positionB),
            limit: family === "gallery" ? 61 : family === "props" ? 40 : 1,
            projected: projectionLimitMeasure(document, family),
            retainedSharedObjects: retainedLimitObjects(harness.alice, family),
            converged: merged.every(other => JSON.stringify(other) === JSON.stringify(document)),
            headings: records(document.sections).map(heading => heading.id),
            history: [...harness.queue.history]
          });
        } finally { harness.destroy(); }
      }
    }
  }
  return observations.map((observation, index) => ({ ...observation, document: documents[index] as ProjectionBag }));
}

export function runProjectionLimits() {
  const references = new Map(projectionReferences("experiment-reference.json").map(reference => [reference.name, reference]));
  return projectionLimitStates().map(({ document, ...observation }) => {
    const reference = references.get(projectionLimitCaseName(observation));
    assertProjectionInput(reference, document);
    return { ...observation,
      afterAppSave: projectionLimitMeasure(reference.document, observation.family),
      stableAppSave: reference.stableAppSave === true,
      appChanges: differences(document, reference.document)
    };
  });
}
