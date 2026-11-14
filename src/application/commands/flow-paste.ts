import type { DocumentView } from "../session/document-session.ts";
import type { FlowEdit, FlowOutcome, FlowPorts, FlowPos } from "../../core/flow/flow.ts";
import type { FlowOperationRequest } from "../../core/flow/operations.ts";
import { flowBaseReference, readFlowBaseReference } from "../../core/collab/base-reference.ts";
import type { FlowBaseSpan } from "../../core/collab/base-reference.ts";
import type { SharedContentRef, SharedIdentityGap, SharedInsertionChunk, SharedJsonFields, SharedMarkValue, SharedOperation, SharedRecordCollection, SharedTextAddress } from "../../core/collab/operations.ts";
import { mintTagId, normalizeTagName, registryKey } from "../../core/document/tags.ts";
import { rowSlots } from "../../core/document/gallery.ts";
import { toHtml } from "../../core/text/html.ts";
import type { Run } from "../../core/text/runs.ts";

export interface FlowPastePorts {
  readonly author: FlowOperationRequest;
  readonly cells: FlowPorts["cells"];
  readonly identity: (operation: string, role: "beat" | "heading" | "visual") => SharedContentRef;
  readonly reference: (span: FlowBaseSpan, purpose: "point" | "left" | "range") => readonly SharedContentRef[] | null;
  readonly recordField: (collection: SharedRecordCollection, field: string, value: unknown) => boolean;
}

type PasteFields = Record<string, unknown>;

class FlowPasteRefusal extends Error {}

function personIdentity(name: unknown): string {
  return "person_" + normalizeTagName(name).split("").map(unit => unit.charCodeAt(0).toString(16).padStart(4, "0")).join("");
}

function markFields(value: unknown): PasteFields {
  // why: Gallery validation compares normalized marks with key-sorted shared JSON, so the payload uses that order.
  const mark = value as PasteFields;
  return Object.fromEntries(Object.keys(mark).sort().map(key => [key, mark[key]]));
}

function jsonFields(record: PasteFields, known: readonly string[], excluded: readonly string[] = []): SharedJsonFields {
  const fields = Object.fromEntries(known.filter(key => record[key] !== undefined).map(key => [key, record[key]]));
  const extra = Object.keys(record).filter(key => !known.includes(key) && !excluded.includes(key) && record[key] !== undefined).sort();
  return { ...fields, extra: JSON.stringify(Object.fromEntries(extra.map(key => [key, record[key]]))) } as SharedJsonFields;
}

export function sharedFlowPaste(doc: DocumentView, edited: FlowEdit, ports: FlowPastePorts): FlowOutcome {
  if (!edited.clipboard || !edited.ops?.some(op => op.kind === "segment-create")) return edited;
  try {
    const clipboard = edited.clipboard, author = ports.author, records: SharedOperation[] = [], pictures: SharedOperation[] = [];
    const beats = new Map<string, SharedContentRef>(), headings = new Map<string, SharedContentRef>(), components = new Map<string, SharedContentRef>();
    const segments = new Map(edited.ops.filter(op => op.kind === "segment-create").map(op => [op.beat, op]));
    const markers = new Set([...segments.values()].filter(op => op.fields.audioText === "" && !edited.rows.some(row => row.id === op.beat)
      && edited.ops?.some(other => other.kind === "remove" && other.targets.includes(op.beat))).map(op => op.beat));
    // why: A heading-only paste removes its empty marker before final rows exist, and that marker has no gallery.
    const markerGalleries = new Set([...markers].map(beat => beat + ":gallery"));
    for (const op of edited.ops) {
      if (op.kind === "segment-create" || op.kind === "split" || op.kind === "split-before") {
        beats.set(op.beat, ports.identity(op.id, "beat")); components.set(op.beat + ":visual", ports.identity(op.id, "visual"));
      }
      if (op.kind === "heading-create" || op.kind === "heading-finalize") headings.set(op.heading, ports.identity(op.id, "heading"));
    }
    const named = (value: string): SharedContentRef => beats.get(value) ?? headings.get(value) ?? components.get(value) ?? value as SharedContentRef;
    const people = new Map<string, string>(), tags = new Map<string, string>(), shots = new Map<string, string>(), comments = new Map<string, string>();
    const id = (collection: string, index: number): string => "paste_" + author.id + "_" + collection + "_" + index;
    const create = (collection: SharedRecordCollection, record: string, fields: SharedJsonFields, into = records): void => {
      if (!Object.entries(fields).every(([field, value]) => ports.recordField(collection, field, value))) {
        throw new FlowPasteRefusal("paste-" + collection + "-fields-unavailable");
      }
      into.push({ kind: "record-create", id: (author.id + ":paste:" + (records.length + pictures.length)) as SharedContentRef, by: author.by,
        target: { collection, record: record as SharedContentRef }, fields });
    };
    const additions = (collection: keyof typeof clipboard): PasteFields[] => {
      const before = doc[collection] as unknown as readonly PasteFields[], after = clipboard[collection] as unknown as readonly PasteFields[];
      for (const old of before) {
        const kept = after.find(record => record.id === old.id);
        if (JSON.stringify(kept) !== JSON.stringify(old)) throw new FlowPasteRefusal("paste-" + collection + "-replacement-unavailable");
      }
      return after.filter(record => !before.some(old => old.id === record.id));
    };
    for (const [index, person] of additions("people").entries()) {
      const existing = doc.people.find(other => normalizeTagName(other.name) === normalizeTagName(person.name));
      const record = existing?.id ?? personIdentity(person.name); people.set(String(person.id), record);
      if (!existing) create("people", record, { name: String(person.name), rank: String(doc.people.length + index).padStart(10, "0"), extra: "{}" });
    }
    const owner = (value: unknown): string => typeof value === "string" ? people.get(value) ?? value : "";
    const registry = doc.productionTags.slice();
    for (const [index, tag] of additions("productionTags").entries()) {
      const existing = registry.find(other => other && registryKey(other.cat, other.name) === registryKey(String(tag.cat), tag.name));
      const record = existing?.id ?? mintTagId(String(tag.cat), tag.name, registry); tags.set(String(tag.id), record as string);
      if (!existing) {
        registry.push({ id: record, cat: String(tag.cat), name: String(tag.name) });
        create("tags", record as string, { ...jsonFields({ ...tag, owner: owner(tag.owner) }, ["cat", "name", "owner", "notes", "status"], ["id"]),
          rank: String(doc.productionTags.length + index).padStart(10, "0") });
      }
    }
    for (const [index, shot] of additions("brollShots").entries()) {
      const record = id("shot", index); shots.set(String(shot.id), record);
      const props = (shot.props ?? []) as { id: string; name: string }[];
      create("shots", record, { ...jsonFields({ ...shot, owner: owner(shot.owner), props: props.map(prop => ({ id: tags.get(prop.id) ?? prop.id, name: prop.name })) },
        ["name", "desc", "status", "reshoot", "notes", "audioRef", "location", "owner", "origin", "props"], ["id"]),
        rank: String(doc.brollShots.length + index).padStart(10, "0") });
    }
    const addedComments = additions("comments");
    for (const [index, comment] of addedComments.entries()) {
      if (comment.author !== author.by) throw new FlowPasteRefusal("paste-comments-foreign-author");
      const record = id("comment", index); comments.set(String(comment.id), record);
      if (typeof comment.anchorId === "string") comments.set(comment.anchorId, record);
    }
    for (const [index, comment] of addedComments.entries()) {
      const record = comments.get(String(comment.id)) as string, replies = (comment.replies ?? []) as PasteFields[];
      const resolution = Object.fromEntries(["resolved", "resolvedAt", "resolvedBy"].filter(key => comment[key] !== undefined).map(key => [key, comment[key]]));
      create("comments", record, { ...jsonFields({ ...comment, rowId: typeof comment.rowId === "string" ? named(comment.rowId) : comment.rowId,
        anchorId: record, text: comment.body, quote: comment.quotedText }, ["rowId", "field", "anchorId", "author", "createdAt", "updatedAt", "assignee", "kind", "imageValue", "conflictField", "emptyValue", "titleValue", "text", "quote"],
      ["id", "body", "quotedText", "replies", "resolved", "resolvedAt", "resolvedBy"]), resolution: { resolved: false, ...resolution } as SharedJsonFields,
      rank: String(doc.comments.length + index).padStart(10, "0") });
      for (const [replyIndex, reply] of replies.entries()) {
        if (reply.author !== author.by) throw new FlowPasteRefusal("paste-replies-foreign-author");
        const replyId = id("reply", index) + "_" + replyIndex;
        create("replies", JSON.stringify([record, replyId]), { ...jsonFields({ ...reply, id: replyId, commentId: record, text: reply.body },
          ["id", "commentId", "author", "createdAt", "text"], ["body"]), rank: String(replyIndex).padStart(10, "0") });
      }
    }
    const rewriteRun = (run: Run): Run => ({ ...run, ...(run.atom === "broll" ? { id: shots.get(run.id) ?? run.id } : {}), marks: { ...run.marks,
      ...(run.marks.tag ? { tag: tags.get(run.marks.tag) ?? run.marks.tag } : {}),
      ...(run.marks.innerTags ? { innerTags: run.marks.innerTags.map(tag => tags.get(tag) ?? tag) } : {}),
      ...(run.marks.cmt ? { cmt: run.marks.cmt.map(comment => comments.get(comment) ?? comment) } : {}) } }) as Run;
    const html = (value: string | null | undefined): string => toHtml(ports.cells(value).map(rewriteRun));
    const rows = edited.rows.map(row => ({ ...row, id: named(row.id), audioText: html(row.audioText), visualText: html(row.visualText) }));
    const references = (reference: SharedContentRef, purpose: "point" | "left" | "range"): readonly SharedContentRef[] => {
      if (!reference.startsWith('["flow-base",')) return [reference];
      const span = readFlowBaseReference(reference);
      if (doc.rows.some(row => row.id === span.owner) || Array.isArray(doc.sections) && doc.sections.some((scene: { id: string }) => scene.id === span.owner)) {
        const captured = ports.reference(span, purpose); if (!captured) throw new FlowPasteRefusal("paste-references-unavailable"); return captured;
      }
      return [flowBaseReference(named(span.owner), span.field, span.from, span.to)];
    };
    const gap = (at: SharedIdentityGap): SharedIdentityGap => ({ left: at.left === null ? null : references(at.left, "left")[0] ?? null,
      right: at.right === null ? null : references(at.right, "point")[0] ?? null, affinity: at.affinity });
    const target = (value: SharedTextAddress): SharedTextAddress => ({ ...value, owner: named(value.owner), segment: named(value.segment) });
    const mark = (value: SharedMarkValue): SharedMarkValue => value.kind === "comment" ? { ...value, id: (comments.get(value.id) ?? value.id) as SharedContentRef }
      : value.kind === "tag" ? { ...value, id: (tags.get(value.id) ?? value.id) as SharedContentRef, value: value.value === null ? null : (tags.get(value.value) ?? value.value) as SharedContentRef } : value;
    const chunk = (value: SharedInsertionChunk): SharedInsertionChunk => ({ value: typeof value.value !== "string" && value.value.atom === "broll"
      ? { ...value.value, id: (shots.get(value.value.id) ?? value.value.id) as SharedContentRef } : value.value, marks: value.marks.map(mark) });
    const operations: SharedOperation[] = [];
    for (const op of edited.ops) {
      if (op.kind === "segment-move") throw new FlowPasteRefusal("move-in-shared-session");
      if (op.kind === "text-insert" && segments.has(op.target.owner)) continue;
      if (op.kind === "text-insert" && op.target.field === "heading" && headings.has(op.target.owner)) continue;
      if (op.kind === "record-create" && (op.target.collection === "visuals" || op.target.collection === "gallery") && segments.has(op.fields.beat as SharedContentRef)) continue;
      if (op.kind === "segment-create") {
        const original = edited.rows.find(row => row.id === op.beat) ?? (markers.has(op.beat) ? { ...op.fields, id: op.beat, audioText: "",
          visualText: typeof op.fields.visualText === "string" ? op.fields.visualText : "" } : null);
        if (!original) throw new FlowPasteRefusal("paste-beats-unavailable");
        if (original.visualImage) throw new FlowPasteRefusal("paste-gallery-legacy-image");
        for (const [slotIndex, slot] of rowSlots(original).entries()) {
          if (slot.dataUrl || slot.links.some(link => link.location)) throw new FlowPasteRefusal("paste-gallery-local-file");
          create("gallery", id("picture", pictures.length), { beat: named(op.beat), rank: String(slotIndex).padStart(10, "0"),
            picture: { ...(slot.ref ? { imageRef: slot.ref } : {}), name: slot.name,
              ...(slot.annotation ? { annotation: { ...slot.annotation, marks: slot.annotation.marks.map(markFields) } } : {}) }, links: slot.links } as unknown as SharedJsonFields, pictures);
        }
        const fields = Object.fromEntries(Object.entries(op.fields).filter(([field]) => !["imageRef", "imageName", "imageAnnotation", "imageLinks", "moreImages", "visualImage"].includes(field))) as SharedJsonFields;
        operations.push({ ...op, beat: named(op.beat), segment: named(op.segment), at: { ...op.at, left: op.at.left === null ? null : named(op.at.left), right: op.at.right === null ? null : named(op.at.right) },
          fields: { ...fields, audioText: html(original.audioText), visualText: html(original.visualText) } });
      } else if (op.kind === "text-insert") operations.push({ ...op, target: target(op.target), at: gap(op.at), content: op.content.map(chunk) });
      else if (op.kind === "text-delete" || op.kind === "mark") operations.push({ ...op, target: target(op.target), observed: op.observed.flatMap(ref => references(ref, "range")), ...(op.kind === "mark" ? { mark: mark(op.mark) } : {}) } as SharedOperation);
      else if (op.kind === "split" || op.kind === "split-before") operations.push({ ...op, target: target(op.target), at: gap(op.at), observed: op.observed.flatMap(ref => references(ref, "range")), beat: named(op.beat), boundary: named(op.boundary) });
      else if (op.kind === "heading-create") {
        // why: A heading needs a name at transaction end; finalizing a complete line also works as separate operations.
        const scene = edited.sections?.find(scene => scene.id === op.heading); if (!scene) throw new FlowPasteRefusal("paste-headings-unavailable");
        const sourceId = op.id + "_source", source = ports.identity(sourceId, "beat"), length = scene.name.length;
        operations.push({ kind: "segment-create", id: sourceId as SharedContentRef, by: op.by, segment: source, beat: source,
          at: { left: null, right: named(op.firstBeat), affinity: "before" }, fields: { audioText: "# " + toHtml([{ text: scene.name, marks: {} }]) + "<br>", visualText: "", status: "todo" } },
        { kind: "heading-finalize", id: op.id, by: op.by, target: { owner: source, segment: source, field: "audioText" }, heading: named(op.heading),
          prefix: [flowBaseReference(source, "audioText", 0, 2)], name: [flowBaseReference(source, "audioText", 2, length + 2)],
          separator: [flowBaseReference(source, "audioText", length + 2, length + 3)], tail: { left: null, right: flowBaseReference(source, "audioText", length + 3, length + 3), affinity: "before" },
          retainedBeat: named(op.firstBeat), emptyBeat: null });
      }
      else if (op.kind === "scalar") operations.push({ ...op, target: { ...op.target, record: named(op.target.record) }, ...(!op.clear && op.field === "firstSceneId" && typeof op.value === "string" ? { value: named(op.value) } : {}) });
      else if (op.kind === "remove") operations.push({ ...op, targets: op.targets.map(named), boundaries: op.boundaries.map(named), components: op.components.map(named), gallery: op.gallery.filter(ref => !markerGalleries.has(ref)).map(named), observed: op.observed.flatMap(ref => references(ref, "range")) });
      else if (op.kind === "heading-remove") operations.push({ ...op, heading: named(op.heading), observed: op.observed.flatMap(ref => references(ref, "range")), newBeat: op.newBeat === null ? null : named(op.newBeat), nextBeat: op.nextBeat === null ? null : named(op.nextBeat) });
      else operations.push(op);
    }
    const position = (value: FlowPos): FlowPos => value.kind === "beat" ? { ...value, rowId: named(value.rowId) } : { ...value, sceneId: named(value.sceneId) };
    return { rows, removedComments: edited.removedComments, notice: edited.notice, sections: edited.sections?.map(scene => ({ ...scene, id: named(scene.id), firstSceneId: named(scene.firstSceneId) })),
      selection: { anchor: position(edited.selection.anchor), head: position(edited.selection.head) }, ops: [...records, ...operations, ...pictures] };
  } catch (error) { if (error instanceof FlowPasteRefusal) return { refused: error.message }; throw error; }
}
