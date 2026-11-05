import type { FlowComment, FlowDoc, FlowPorts, FlowRange, FlowRow } from "../../../src/core/flow/flow.ts";
import type { DocumentScene } from "../../../src/core/document/scenes.ts";
import type { Marks, Run } from "../../../src/core/text/runs.ts";

type Character = { value: string; anchors: readonly string[]; marks: Marks };
type LinearBlock = {
  kind: "beat" | "heading";
  id: string;
  text: Character[];
  start: number;
  paragraph: number;
  flag: boolean;
  visual: readonly unknown[];
  visualAnchors: string[];
};

export interface ReferenceFlowContent {
  rows: { id: string; text: string; characters: { value: string; marks: Marks }[]; visual: readonly unknown[]; flag: boolean }[];
  headings: { id: string; name: string; firstBeat: number }[];
  comments: FlowComment[];
}

function characters(html: string | null | undefined, ports: FlowPorts): Character[] {
  return ports.cells(html).flatMap(run => run.text.split("").map(value => ({ value, anchors: run.marks.cmt ?? [], marks: { ...run.marks } })));
}

function visualOf(row: FlowRow): readonly unknown[] {
  return [row.visualText ?? "", row.imageRef ?? null, row.imageName ?? null, row.imageLinks ?? null, row.moreImages ?? null, row.imageAnnotation ?? null];
}

export function referenceReplacement(doc: FlowDoc, range: FlowRange, replacement: string | readonly Run[], ports: FlowPorts, reconcile = false): ReferenceFlowContent {
  const inserted: Character[] = (typeof replacement === "string" ? [{ text: replacement, marks: {} }] : replacement)
    .flatMap(run => run.text.split("").map(value => ({ value, anchors: run.marks.cmt ?? [], marks: { ...run.marks } })));
  const sections = (doc.sections ?? []) as readonly DocumentScene[];
  const blocks: LinearBlock[] = [];
  let cursor = 0, paragraph = -1;
  for (const row of doc.rows) {
    const scene = sections.find(item => item.firstSceneId === row.id);
    if (scene) {
      const text = scene.name.split("").map(value => ({ value, anchors: [], marks: {} }));
      blocks.push({ kind: "heading", id: scene.id, text, start: cursor, paragraph: -1, flag: false, visual: visualOf({ id: "" }), visualAnchors: [] });
      cursor += text.length + 1;
    }
    if (paragraph === -1 || scene || row.paragraphStart) paragraph++;
    const text = characters(row.audioText, ports);
    blocks.push({ kind: "beat", id: row.id, text, start: cursor, paragraph, flag: !!row.paragraphStart,
      visual: visualOf(row), visualAnchors: characters(row.visualText, ports).flatMap(char => char.anchors) });
    cursor += text.length + 1;
  }
  const position = (pos: FlowRange["head"]) => {
    const block = blocks.find(item => item.kind === pos.kind && item.id === (pos.kind === "beat" ? pos.rowId : pos.sceneId));
    if (!block) throw new Error("invalid reference position");
    return block.start + pos.offset;
  };
  const a = position(range.anchor), b = position(range.head);
  const from = Math.min(a, b), to = Math.max(a, b);
  const start = a <= b ? range.anchor : range.head;
  const end = a <= b ? range.head : range.anchor;
  const localBeat = start.kind === "beat" && end.kind === "beat" && start.rowId === end.rowId;
  const originalRows = new Set(doc.rows.map(row => row.id));
  const output: LinearBlock[] = [];
  const removedRows = new Set<string>();
  const removedHeadings = new Set<string>();
  for (const block of blocks) {
    const isStart = block.kind === start.kind && block.id === (start.kind === "beat" ? start.rowId : start.sceneId);
    const full = from <= block.start && to >= block.start + block.text.length;
    const exclusiveEmptyEndpoint = block.kind === "beat" && !block.text.length && block.start === to && !isStart
      && block.id !== doc.rows[doc.rows.length - 1]?.id;
    if (full && !exclusiveEmptyEndpoint && !(block.kind === "beat" && localBeat) && !(isStart && inserted.length)) {
      (block.kind === "heading" ? removedHeadings : removedRows).add(block.id);
      continue;
    }
    const text = block.text.filter((_, index) => block.start + index < from || block.start + index >= to);
    if (isStart && inserted.length) text.splice(start.offset, 0, ...inserted.map(char => block.kind === "heading" ? { ...char, marks: {}, anchors: [] } : char));
    if (block.kind === "heading" && !text.map(char => char.value).join("").trim()) { removedHeadings.add(block.id); continue; }
    output.push({ ...block, text });
  }
  const kept = output.filter(block => block.kind === "beat");
  for (const block of kept) {
    const members = blocks.filter(item => item.kind === "beat" && item.paragraph === block.paragraph);
    if (members[0]?.id !== block.id && removedRows.has((members[0] as LinearBlock).id) && kept.find(item => item.paragraph === block.paragraph) === block && kept.indexOf(block) > 0) block.flag = true;
  }
  const protectedBreaks = new Set<string>();
  for (const id of removedHeadings) {
    const at = blocks.findIndex(block => block.kind === "heading" && block.id === id);
    const nextHeading = blocks.findIndex((block, index) => index > at && block.kind === "heading");
    const next = blocks.slice(at + 1, nextHeading < 0 ? undefined : nextHeading).find(block => block.kind === "beat" && !removedRows.has(block.id));
    const survivor = kept.find(block => block.id === next?.id);
    if (survivor) { survivor.flag = true; protectedBreaks.add(survivor.id); }
  }
  if (start.kind === "beat" && end.kind === "beat" && start.rowId !== end.rowId && !removedRows.has(start.rowId)) {
    const tail = kept.find(block => block.id === end.rowId);
    const scene = sections.find(item => item.firstSceneId === end.rowId);
    if (tail && !protectedBreaks.has(tail.id) && (!scene || removedHeadings.has(scene.id))) tail.flag = false;
  }
  for (let i = output.length - 1; i >= 0; i--) {
    if (output[i]?.kind === "heading" && output[i + 1]?.kind !== "beat") {
      output.splice(i + 1, 0, { kind: "beat", id: "$new", text: [], start: -1, paragraph: -1, flag: false, visual: visualOf({ id: "" }), visualAnchors: [] });
    }
  }
  if (!output.some(block => block.kind === "beat")) output.push({ kind: "beat", id: "$new", text: [], start: -1, paragraph: -1, flag: false, visual: visualOf({ id: "" }), visualAnchors: [] });
  const rows = output.filter(block => block.kind === "beat");
  const survivingAnchors = new Set(rows.flatMap(block => block.text.flatMap(char => char.anchors).concat(block.visualAnchors)));
  const removedAnchors = new Set(blocks.filter(block => removedRows.has(block.id)).flatMap(block => block.text.flatMap(char => char.anchors).concat(block.visualAnchors)));
  return {
    rows: rows.map(block => ({ id: originalRows.has(block.id) ? block.id : "$new", text: block.text.map(char => char.value).join(""), characters: block.text.map(char => ({ value: char.value, marks: char.marks })), visual: block.visual, flag: block.flag })),
    headings: output.flatMap((block, index) => block.kind === "heading" ? [{ id: block.id, name: block.text.map(char => char.value).join(""), firstBeat: rows.indexOf(output[index + 1] as LinearBlock) }] : []),
    comments: doc.comments.filter(comment => {
      const anchor = comment.anchorId || comment.id;
      return survivingAnchors.has(anchor) || !(comment.rowId && removedRows.has(comment.rowId) || removedAnchors.has(anchor));
    }).map(comment => {
      const copy = JSON.parse(JSON.stringify(comment)) as FlowComment;
      if (!reconcile || (comment as { kind?: unknown }).kind === "conflict" || comment.field === "title") return copy;
      const anchor = comment.anchorId || comment.id;
      for (const block of rows) {
        if (block.visualAnchors.includes(anchor)) return { ...copy, rowId: block.id, field: "visualText" };
        if (block.text.some(char => char.anchors.includes(anchor))) return { ...copy, rowId: block.id, field: "audioText" };
      }
      return copy;
    })
  };
}

export function observedFlowContent(doc: FlowDoc, original: FlowDoc, ports: FlowPorts): ReferenceFlowContent {
  const oldIds = new Set(original.rows.map(row => row.id));
  return {
    rows: doc.rows.map(row => ({ id: oldIds.has(row.id) ? row.id : "$new", text: characters(row.audioText, ports).map(char => char.value).join(""), characters: characters(row.audioText, ports).map(char => ({ value: char.value, marks: char.marks })), visual: visualOf(row), flag: !!row.paragraphStart })),
    headings: ((doc.sections ?? []) as readonly DocumentScene[]).map(scene => ({ id: scene.id, name: scene.name, firstBeat: doc.rows.findIndex(row => row.id === scene.firstSceneId) })),
    comments: JSON.parse(JSON.stringify(doc.comments)) as FlowComment[]
  };
}
