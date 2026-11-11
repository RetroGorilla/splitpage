import { readFlowBaseReference } from "../../../src/core/collab/base-reference.ts";
import type { SharedContentRef, SharedIdentityGap, SharedOperation, SharedTextAddress } from "../../../src/core/collab/operations.ts";
import { explode, implode } from "../../../src/core/text/edits.ts";
import type { Char } from "../../../src/core/text/edits.ts";
import { commentIds, projection, withTagStack, tagStack, OBJ } from "../../../src/core/text/runs.ts";
import type { Marks, Run } from "../../../src/core/text/runs.ts";
import { toHtml } from "../../../src/core/text/html.ts";
import { migrateGallery, rowSlots, setRowSlots, videoLinkKey } from "../../../src/core/document/gallery.ts";
import { scenesInOrder } from "../../../src/core/document/scenes.ts";
import { cappedText } from "../../../src/core/document/text-policy.ts";
import type { DocumentScene } from "../../../src/core/document/scenes.ts";
import type { FlowDoc, FlowRow } from "../../../src/core/flow/flow.ts";

interface ObservedUnit { char: Char; owner: string; offset: number; field: SharedTextAddress["field"] }

export function applyFlowOperations(base: FlowDoc, ops: readonly SharedOperation[], cells: (html: string | null | undefined) => readonly Run[]) {
  const rows = base.rows.map(row => ({ ...row })) as Record<string, unknown>[];
  let sections: DocumentScene[] = (scenesInOrder(base) ?? []).map(scene => ({ ...scene,
    name: (base.sections as DocumentScene[]).find(item => item.id === scene.id)?.name ?? scene.name }));
  const units = new Map<string, ObservedUnit[]>();
  const key = (owner: string, field: string) => JSON.stringify([owner, field]);
  const identity = (unit: ObservedUnit) => JSON.stringify([unit.owner, unit.field, unit.offset]);
  const deletedPositions = new Map<string, { before: string | null; after: string | null }>();
  const text = (owner: string, field: SharedTextAddress["field"]): ObservedUnit[] => {
    const address = key(owner, field);
    if (!units.has(address)) {
      const chars: Char[] = field === "heading" ? (sections.find(scene => scene.id === owner)?.name ?? "").split("").map(ch => ({ ch, marks: {} }))
        : explode(cells(rows.find(row => row.id === owner)?.[field] as string | undefined));
      units.set(address, chars.map((char, offset) => ({ char, owner, offset, field })));
    }
    return units.get(address) as ObservedUnit[];
  };
  const selected = (unit: ObservedUnit, refs: readonly SharedContentRef[]) => refs.some(ref => {
    const span = readFlowBaseReference(ref);
    return span.owner === unit.owner && span.field === unit.field && unit.offset >= span.from && unit.offset < span.to;
  });
  const position = (chars: ObservedUnit[], gap: SharedIdentityGap) => {
    const ref = gap.right ?? gap.left;
    if (!ref) return 0;
    const span = readFlowBaseReference(ref);
    const unit = JSON.stringify([span.owner, span.field, span.from]);
    if (deletedPositions.has(unit)) {
      const visited = new Set<string>();
      let cursor: string | null = unit;
      while (cursor !== null && !visited.has(cursor)) {
        visited.add(cursor);
        const at = chars.findIndex(char => identity(char) === cursor);
        if (at >= 0) return at + (gap.right ? 0 : 1);
        const deleted = deletedPositions.get(cursor);
        cursor = (gap.right ? deleted?.after : deleted?.before) ?? null;
      }
      return gap.right ? chars.length : 0;
    }
    const at = chars.findIndex(unit => unit.owner === span.owner && unit.field === span.field && unit.offset >= span.from);
    if (gap.right) return at < 0 ? chars.length : at;
    const left = chars.findIndex(unit => unit.owner === span.owner && unit.field === span.field && unit.offset === span.from);
    return left < 0 ? chars.length : left + 1;
  };
  const write = (owner: string, field: SharedTextAddress["field"], chars: ObservedUnit[]) => {
    units.set(key(owner, field), chars);
    if (field === "heading") sections = sections.map(scene => scene.id === owner ? { ...scene,
      name: chars.map(unit => unit.char.atom ? projection([unit.char.atom]) : unit.char.ch).join("") } : scene);
    else { const row = rows.find(item => item.id === owner); if (row) row[field] = toHtml(implode(chars.map(unit => unit.char))); }
  };
  const blank = (id: string) => ({ id, visualText: "", imageRef: null, audioText: "", status: "todo" });
  const removedRanges = new Set<string>(), reportedComments = new Set<string>();
  for (const op of ops) {
    if (op.kind === "segment-create") {
      const before = rows.findIndex(row => row.id === op.at.right), after = rows.findIndex(row => row.id === op.at.left);
      rows.splice(before >= 0 ? before : after >= 0 ? after + 1 : rows.length, 0, { id: op.beat, ...op.fields });
    } else if (op.kind === "text-delete") {
      const chars = text(op.target.owner, op.target.field), removed = chars.map(unit => selected(unit, op.observed));
      let before: string | null = null;
      const left = chars.map((unit, index) => { const prior = before; if (!removed[index]) before = identity(unit); return prior; });
      let after: string | null = null;
      // why: Deleted unit identities still name collapsed gaps in later operations from the same base.
      for (let index = chars.length - 1; index >= 0; index--) {
        const unit = chars[index] as ObservedUnit;
        if (removed[index]) deletedPositions.set(identity(unit), { before: left[index] ?? null, after });
        else after = identity(unit);
      }
      write(op.target.owner, op.target.field, chars.filter((_, index) => !removed[index]));
    } else if (op.kind === "text-insert") {
      const chars = text(op.target.owner, op.target.field).slice(), at = position(chars, op.at);
      let offset = 0;
      const inserted = op.content.flatMap(chunk => {
        const marks: Marks = {};
        for (const mark of chunk.marks) {
          if (mark.kind === "comment") marks.cmt = [...marks.cmt ?? [], mark.id];
          else if (mark.kind === "link") { if (mark.value) marks.href = mark.value; }
          else if (mark.kind === "tag") Object.assign(marks, withTagStack(marks, [...tagStack(marks), mark.id]));
          else marks[mark.kind] = true;
        }
        const value = chunk.value;
        if (typeof value !== "string" && value.atom === "broll" && value.text === undefined) throw new Error("Flow b-roll insertion needs its displayed label");
        const run: Run = typeof value === "string" ? { text: value, marks } : value.atom === "broll" ? { ...value, text: value.text ?? "B-ROLL", marks }
          : value.atom === "who" ? { ...value, text: "@" + value.name, marks } : { ...value, text: "" as const, marks };
        const chars: Char[] = op.target.field === "heading" ? (typeof value === "string" ? value : OBJ).split("").map(ch => ({ ch, marks })) : explode([run]);
        return chars.map(char => ({ char, owner: op.id, offset: offset++, field: op.target.field }));
      });
      chars.splice(at, 0, ...inserted);
      write(op.target.owner, op.target.field, chars);
    } else if (op.kind === "mark") {
      const chars = text(op.target.owner, op.target.field).map(unit => {
        if (!selected(unit, op.observed)) return unit;
        let marks: Marks = { ...(unit.char.atom ? unit.char.atom.marks : unit.char.marks) };
        const mark = op.mark;
        if (unit.char.atom && (mark.kind === "tag" || mark.kind === "dir" || mark.kind === "cue")) return unit;
        if (mark.kind === "comment") {
          const ids = (marks.cmt ?? []).filter(id => id !== mark.id);
          if (mark.value) ids.push(mark.id);
          if (ids.length) marks.cmt = ids; else delete marks.cmt;
        } else if (mark.kind === "tag") marks = withTagStack(marks, mark.value && tagStack(marks).includes(mark.value) ? tagStack(marks)
          : [...tagStack(marks).filter(id => id !== mark.id), ...(mark.value ? [mark.value] : [])]);
        else if (mark.kind === "link") { if (mark.value) marks.href = mark.value; else delete marks.href; }
        else if (mark.value) marks[mark.kind] = true; else Reflect.deleteProperty(marks, mark.kind);
        return { ...unit, char: unit.char.atom ? { atom: { ...unit.char.atom, marks } } : { ...unit.char, marks } };
      });
      write(op.target.owner, op.target.field, chars);
    } else if (op.kind === "split" || op.kind === "split-before") {
      const chars = text(op.target.owner, op.target.field), at = position(chars, op.at);
      const first = op.target.field === "heading" ? sections.find(scene => scene.id === op.target.owner)?.firstSceneId : op.target.owner;
      const index = rows.findIndex(row => row.id === first);
      const before = op.kind === "split-before";
      rows.splice(index + (before || op.target.field === "heading" ? 0 : 1), 0, { id: op.beat, ...op.fields });
      write(op.target.owner, op.target.field, before ? chars.slice(at) : chars.slice(0, at));
      write(op.beat, "audioText", before ? chars.slice(0, at) : chars.slice(at));
    } else if (op.kind === "remove") {
      for (const id of op.targets) {
        const index = rows.findIndex(row => row.id === id);
        if (op.removalKind === "range" && !op.comments) removedRanges.add(id);
        if (index >= 0) rows.splice(index, 1);
      }
      for (const id of op.comments ?? []) reportedComments.add(id);
    } else if (op.kind === "heading-create") {
      sections.push({ id: op.heading, firstSceneId: op.firstBeat, name: "" });
    } else if (op.kind === "record-create") {
      if (op.target.collection === "visuals") {
        const row = rows.find(row => row.id === op.fields.beat);
        if (!row) throw new Error("Missing visual beat");
        row.visualText = op.fields.html;
      } else if (op.target.collection !== "gallery") throw new Error("Unexpected record collection");
    } else if (op.kind === "record-set") {
      if (op.target.collection !== "visuals" || op.field !== "html") throw new Error("Unexpected record field");
      const row = rows.find(row => String(row.id) + ":visual" === op.target.record);
      if (!row) throw new Error("Missing visual record");
      row.visualText = op.clear ? "" : op.value;
    } else if (op.kind === "segment-move") {
      const moved = op.segments.map(id => rows.find(row => row.id === id));
      if (moved.some(row => !row)) throw new Error("Missing moved segment");
      for (const id of op.segments) rows.splice(rows.findIndex(row => row.id === id), 1);
      const before = rows.findIndex(row => row.id === op.at.right), after = rows.findIndex(row => row.id === op.at.left);
      rows.splice(before >= 0 ? before : after >= 0 ? after + 1 : rows.length, 0, ...moved as Record<string, unknown>[]);
    } else if (op.kind === "heading-remove") {
      const scene = sections.find(item => item.id === op.heading);
      if (op.newBeat && scene) rows.splice(rows.findIndex(row => row.id === scene.firstSceneId), 0,
        { ...blank(op.newBeat), audioText: toHtml([{ text: scene.name, marks: {} }]) });
      sections = sections.filter(item => item.id !== op.heading);
    } else if (op.kind === "heading-finalize") {
      const chars = text(op.target.owner, op.target.field);
      const name = chars.filter(unit => selected(unit, op.name)).map(unit => unit.char.atom ? projection([unit.char.atom]) : unit.char.ch).join("");
      if (op.retainedBeat === op.target.owner) write(op.target.owner, "audioText", chars.slice(position(chars, op.tail)));
      if (cappedText(name, 200)) sections.push({ id: op.heading, name, firstSceneId: (op.retainedBeat ?? op.emptyBeat) as string });
    } else if (op.kind === "scalar") {
      const target = op.target.scope === "beat" ? rows.find(row => row.id === op.target.record)
        : sections.find(scene => scene.id === op.target.record) as unknown as Record<string, unknown> | undefined;
      if (!target) throw new Error("Missing scalar target " + op.target.record);
      if (op.clear) Reflect.deleteProperty(target, op.field); else target[op.field] = op.value;
    } else if (op.kind === "join") {
      const into = rows.find(row => row.id === op.into) as FlowRow, from = rows.find(row => row.id === op.from) as FlowRow;
      const left = cells(into.audioText), right = cells(from.audioText), a = left.at(-1)?.marks, b = right[0]?.marks;
      const glueMarks: Marks = {};
      if (a?.href && a.href === b?.href) glueMarks.href = a.href;
      const comments = a?.cmt?.filter(id => b?.cmt?.includes(id));
      if (comments?.length) glueMarks.cmt = comments;
      if (a?.dir && b?.dir && !left.at(-1)?.atom && !right[0]?.atom) glueMarks.dir = true;
      const merged: Record<string, unknown> = { ...into, audioText: toHtml(implode([
        ...explode(left), ...explode(op.glue ? [{ text: op.glue, marks: glueMarks }] : []), ...explode(right)
      ])), visualText: !cells(from.visualText).length ? into.visualText ?? "" : !cells(into.visualText).length ? from.visualText ?? ""
        : (into.visualText ?? "") + "<br>" + (from.visualText ?? "") };
      const pictures: ReturnType<typeof rowSlots> = [];
      for (const slot of [...rowSlots(into), ...rowSlots(from)]) {
        const found = slot.ref && pictures.find(item => item.ref?.sha256 === slot.ref?.sha256);
        if (!found) { pictures.push(structuredClone(slot)); continue; }
        found.name ||= slot.name;
        found.annotation ||= slot.annotation;
        for (const link of slot.links) {
          const prior = found.links.find(item => videoLinkKey(item) === videoLinkKey(link));
          if (!prior) found.links.push({ ...link });
          else { if (link.poster) prior.poster = true; if (!prior.location && link.location) prior.location = link.location; }
        }
      }
      if (rowSlots(from).length) setRowSlots(merged, pictures);
      migrateGallery(merged, { known: () => null, fromDataUrl: () => null });
      const ranks = ["todo", "ready", "shot"];
      if (ranks.indexOf(String(from.status)) > ranks.indexOf(String(into.status))) merged.status = from.status;
      rows.splice(rows.findIndex(row => row.id === into.id), 1, merged);
      rows.splice(rows.findIndex(row => row.id === from.id), 1);
    } else throw new Error("Unexpected operation " + op.kind);
  }
  const ordered = sections.filter(scene => rows.some(row => row.id === scene.firstSceneId))
    .sort((a, b) => rows.findIndex(row => row.id === a.firstSceneId) - rows.findIndex(row => row.id === b.firstSceneId));
  const gone = new Set(base.rows.filter(row => removedRanges.has(row.id)).flatMap(row => [...commentIds(cells(row.audioText)), ...commentIds(cells(row.visualText))]));
  const kept = new Set(rows.flatMap(row => [...commentIds(cells(row.audioText as string)), ...commentIds(cells(row.visualText as string))]));
  const removedComments = base.comments.filter(comment => reportedComments.has(comment.id) || !kept.has(comment.anchorId || comment.id)
    && (gone.has(comment.anchorId || comment.id) || !!comment.rowId && removedRanges.has(comment.rowId))).map(comment => comment.id);
  return { rows, sections: ordered.length ? ordered : undefined, removedComments };
}
