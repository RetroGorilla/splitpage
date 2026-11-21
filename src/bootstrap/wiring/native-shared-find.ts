import type { openNativeSession } from "../../adapters/collab/native/session.ts";
import type { NativeEditStamp, NativeTextRange, NativeTextTarget } from "../../adapters/collab/native/text-commands.ts";
import { REWRITE_CELL_CHANGED } from "../../application/commands/document-edit.ts";
import type { ReportPort } from "../../application/session/ports.ts";
import type { SharedDocumentSession } from "../../application/session/shared-session.ts";
import { storedSceneName } from "../../core/document/scenes.ts";
import { deleteRange, replaceText, sliceCell } from "../../core/text/edits.ts";
import { cellLength, projection } from "../../core/text/runs.ts";
import { findInCell } from "../../core/text/search.ts";
import type { FindNativeAccess } from "../../features/find/ports.ts";
import type { WriterSearchMatch } from "../../features/common/writer-find.ts";
import { scriptCellOf } from "../richtext.ts";
import type { mountNativeSharedInput } from "./native-shared-input.ts";
import { documentReader } from "./ports/document.ts";
import { editAllowed } from "./session-owner.ts";

interface NativeFindPorts {
  readonly native: ReturnType<typeof openNativeSession>;
  readonly session: () => SharedDocumentSession | null;
  readonly input: () => ReturnType<typeof mountNativeSharedInput> | null;
  readonly editAttribution: () => NativeEditStamp;
  readonly publish: () => void;
  readonly report: ReportPort;
}

const UNAVAILABLE = "native-command-unavailable";
type MatchRange = { readonly target: NativeTextTarget; readonly start: number; readonly end: number };
type AnchoredMatch = { readonly target: NativeTextTarget; readonly range: NativeTextRange; readonly text: string };
type FoundMatch = AnchoredMatch | "unsupported" | null;

function matchRange(match: WriterSearchMatch): MatchRange | null {
  if (match.kind === "visual") return { target: { beat: match.rowId, cell: "visual" }, start: match.from, end: match.to };
  const { anchor, head } = match.range;
  if (anchor.kind === "heading" && head.kind === "heading" && anchor.sceneId === head.sceneId) {
    return { target: { beat: anchor.sceneId, cell: "name" }, start: anchor.offset, end: head.offset };
  }
  return anchor.kind === "beat" && head.kind === "beat" && anchor.rowId === head.rowId
    ? { target: { beat: anchor.rowId, cell: "narration" }, start: anchor.offset, end: head.offset } : null;
}

function cellText(doc: ReturnType<NativeFindPorts["native"]["document"]> | NonNullable<ReturnType<typeof documentReader.current>>,
  rows: ReadonlyMap<string, typeof doc.rows[number]>, { beat, cell }: NativeTextTarget) {
  if (cell === "name") return storedSceneName(doc, beat);
  const row = rows.get(beat);
  return cell === "visual" ? row?.visualText : row?.audioText;
}

export function createNativeEditorFind({ native, session, input, editAttribution, publish, report }: NativeFindPorts): FindNativeAccess {
  return {
    cells: scriptCellOf,
    capture(matches, needle, matchCase) {
      const shown = documentReader.current(), current = native.document();
      const shownRows = new Map(shown?.rows.map(row => [row.id, row]));
      const currentRows = new Map(current.rows.map(row => [row.id, row]));
      const projected = new Map<string, string>();
      const found = matches.map((match): FoundMatch => {
        const hit = matchRange(match);
        if (!hit) return "unsupported";
        const { target, start, end } = hit, key = JSON.stringify(target);
        let text = projected.get(key);
        if (text === undefined) {
          const html = shown && cellText(shown, shownRows, target);
          if (typeof html !== "string" || html !== cellText(current, currentRows, target)) return null;
          text = target.cell === "name" ? html : projection(scriptCellOf(html));
          projected.set(key, text);
        }
        const from = target.cell === "narration" ? native.narrationCaret(target.beat, start, true) : { beat: target.beat, offset: start };
        const to = target.cell === "narration" ? native.narrationCaret(target.beat, end) : { beat: target.beat, offset: end };
        if (!from || !to) return null;
        if (from.beat !== to.beat) return "unsupported";
        const anchor = native.commands.anchorText({ ...target, beat: from.beat }, from.offset, to.offset);
        if (anchor.kind === "anchored") return { target, range: anchor.range, text: text.slice(start, end) };
        return target.cell === "visual" && anchor.reason === "range" ? "unsupported" : null;
      });
      return (index, text) => {
        const owner = session(), typing = input();
        if (!owner || !typing) return null;
        try {
          const admission = owner.admit();
          if (admission?.kind === "failed") throw admission.error;
          if (admission) { if (!admission.notified) owner.refuse(admission.reason); return null; }
          if (!editAllowed()) { owner.refuse(UNAVAILABLE); return null; }
          if (typing.beforePress()) return null;
          const hits = index === null ? found : [found[index]];
          if (hits.some(hit => hit === "unsupported" || index === null && hit?.range.target.cell === "name")) {
            owner.refuse(UNAVAILABLE);
            return null;
          }

          const doc = native.document(), rows = new Map(doc.rows.map(row => [row.id, row]));
          const read = new Map<string, { text: string; cell: ReturnType<typeof scriptCellOf>; ends: Map<number, number> }>();
          const valid = hits.flatMap(hit => {
            if (!hit || hit === "unsupported") return [];
            const { range, target } = hit;
            const selection = native.resolveTextSelection(range);
            if (!selection || selection.anchor.target.beat !== range.target.beat || selection.head.target.beat !== range.target.beat) return [];
            const start = target.cell === "narration" ? native.narrationOffset(target.beat, range) : selection.anchor.offset;
            const end = target.cell === "narration" ? native.narrationOffset(target.beat, { from: range.to }, -1) : selection.head.offset;
            if (start === null || end === null || end <= start) return [];
            const key = JSON.stringify(target);
            let source = read.get(key);
            if (!source) {
              const html = cellText(doc, rows, target);
              if (typeof html !== "string") return [];
              const cell = target.cell === "name" ? [] : scriptCellOf(html);
              source = { text: target.cell === "name" ? html : projection(cell), cell,
                ends: new Map(findInCell(cell, needle, matchCase).map(({ from, to }) => [from, to])) };
              read.set(key, source);
            }
            if (source.text.slice(start, end) !== hit.text || target.cell !== "name" && source.ends.get(start) !== end) return [];
            return [{ target, start, end, source, range, selection }];
          });
          const first = valid[0];
          if (!first) {
            if (index !== null) owner.refuse(REWRITE_CELL_CHANGED);
            publish();
            return 0;
          }
          const { target, start, end, source, range } = first;
          let length = text.length;
          let step;
          if (index === null) {
            step = native.commands.replaceAll.withSelection(range, valid.map(({ range, selection }) => ({
              row: range.target.beat, cell: range.target.cell === "visual" ? "visual" : "narration",
              start: selection.anchor.offset, end: selection.head.offset
            })), text);
          } else if (target.cell === "name") {
            const name = source.text.slice(0, start) + text + source.text.slice(end);
            if (!name.trim() || [...name].length > 200) { owner.refuse(UNAVAILABLE); return null; }
            step = native.commands.renameHeading.withSelection(range, range, text);
          } else {
            const next = replaceText(source.cell, start, end, text);
            length = cellLength(next) - cellLength(deleteRange(source.cell, start, end));
            const insert = sliceCell(next, start, start + length);
            step = native.commands.replaceText.withSelection(range, range, insert, editAttribution());
          }
          if (step.result.kind === "refused" || step.result.kind === "recovery") { owner.refuse(step.result.reason); return null; }
          if (step.result.kind === "unchanged") return 0;
          const landing = start + length;
          const point = target.cell === "narration" ? native.narrationCaret(target.beat, landing) : { beat: target.beat, offset: landing };
          const after = point && native.commands.anchorText({ ...target, beat: point.beat }, point.offset);
          if (after?.kind === "anchored") step.recordAfter(after.range);
          publish();
          if (after?.kind === "anchored") {
            const selection = native.resolveTextSelection(after.range);
            const active = document.activeElement;
            if (selection) typing.show(selection);
            if (active instanceof HTMLElement && active.closest("#findbar")) active.focus({ preventScroll: true });
          }
          return valid.length;
        } catch (error) {
          report(error);
          owner.refuse(UNAVAILABLE);
          return null;
        }
      };
    }
  };
}
