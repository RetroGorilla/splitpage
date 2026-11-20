import type { openNativeSession } from "../../adapters/collab/native/session.ts";
import type { NativeRecordOutcome } from "../../adapters/collab/native/record-values.ts";
import type { NativeTextRange } from "../../adapters/collab/native/text-commands.ts";
import { nativeGalleryOf, sameNativeValue } from "../../adapters/collab/native/values.ts";
import type { GalleryEdit } from "../../application/commands/gallery.ts";
import type { RecordCommandRun } from "../../application/commands/shared-records.ts";
import { NOTHING_RAN, RECORD_CHANGED, RECORD_REFUSED } from "../../application/commands/shared-records.ts";
import type { ReportPort } from "../../application/session/ports.ts";
import type { SharedDocumentSession } from "../../application/session/shared-session.ts";
import { plainText } from "../../core/document/text-policy.ts";
import type { DocumentComment, DocumentReply, DocumentRow } from "../../core/document/validated.ts";
import type { RowStatusId } from "../../core/document/timing.ts";
import { addGalleryPicture, replaceGalleryPicture } from "../../core/document/gallery.ts";
import { compressImageFile } from "../../features/rows/beat-media.ts";
import { capabilities } from "./ports/capabilities.ts";
import { documentReader } from "./ports/document.ts";
import { notices } from "./ports/effects.ts";
import { pictures } from "./ports/pictures.ts";

type NativeRecordsSession = ReturnType<typeof openNativeSession>;
type Admission = Pick<SharedDocumentSession, "admit" | "refuse">;

export function createNativeEditorRecords(
  native: NativeRecordsSession, session: () => Admission | null, actor: string, now: () => number, report: ReportPort
) {
  const selections = new Map<string, NativeTextRange>();

  function refuse(reason: string, owner: Admission | null): RecordCommandRun {
    if (reason === "full") notices.show("This shared script is full. Export a copy to keep working.", "warn");
    else if (owner) owner.refuse(reason);
    else notices.show("This is not available in a shared session yet.", "warn");
    return RECORD_REFUSED;
  }

  function run(
    permission: "edit" | "comment", write: () => NativeRecordOutcome, done?: string
  ): RecordCommandRun {
    const owner = session();
    if (!owner) return refuse("closed", owner);
    try {
      const admission = owner.admit();
      if (admission?.kind === "failed") { report(admission.error); return refuse("failed", owner); }
      if (admission) return admission.notified ? RECORD_REFUSED : refuse(admission.reason, owner);
      const capability = capabilities[permission]();
      if (!capability.allowed) return refuse(capability.reason, owner);
      const result = write();
      if (result.kind === "refused") return refuse(result.reason, owner);
      if (result.kind === "unchanged") return NOTHING_RAN;
      if (done) notices.show(done, "ok");
      return RECORD_CHANGED;
    } catch (error) {
      report(error);
      return refuse("failed", owner);
    }
  }

  const commands = native.commands;
  function gallery(rowId: string, message: string, edit: GalleryEdit): RecordCommandRun {
    return run("edit", () => {
      if (native.isClosingOrClosed()) return { kind: "refused", reason: "closed" };
      const shown = documentReader.current()?.rows.find(row => row.id === rowId);
      const latest = native.document().rows.find(row => row.id === rowId);
      if (!shown || !latest) return { kind: "refused", reason: "missing" };
      if (!sameNativeValue(nativeGalleryOf(shown), nativeGalleryOf(latest))) return { kind: "refused", reason: "value" };
      const row = JSON.parse(JSON.stringify(latest)) as DocumentRow;
      if (!edit(row)) return { kind: "unchanged" };
      return commands.setField({ kind: "gallery", id: rowId }, nativeGalleryOf(row));
    }, message);
  }

  async function addPictures(rowId: string, files: readonly File[], slot?: number): Promise<void> {
    const shown = documentReader.current()?.rows.find(row => row.id === rowId);
    if (!shown) { refuse("missing", session()); return; }
    try {
      const urls = await Promise.all(files.map(file => compressImageFile(file, 1000, 0.78)));
      const latest = documentReader.current()?.rows.find(row => row.id === rowId);
      if (!session() || !latest || slot !== undefined && !sameNativeValue(nativeGalleryOf(shown), nativeGalleryOf(latest))) {
        notices.show("The picture finished loading after the script changed, so it was not added.", "warn");
        return;
      }
      const refs = urls.map((url, index) => {
        const ref = pictures.internDataUrl(url);
        if (!ref) throw new Error("not a picture the registry takes");
        return { ref, name: files[index]?.name };
      });
      const number = documentReader.numbering().beats[rowId]?.full ?? "";
      const message = (refs.length === 1 ? "Picture" : "Pictures") + (slot === undefined ? " added to" : " replaced in") + " beat " + number;
      if (gallery(rowId, message, row => {
        if (slot !== undefined && refs[0]) return replaceGalleryPicture(row, slot, refs[0].ref, refs[0].name);
        for (const { ref, name } of refs) addGalleryPicture(row, ref, name);
        return true;
      }).changed) pictures.persist(refs.map(({ ref }) => ref.sha256));
    } catch {
      notices.show("Could not use that image.", "error");
    }
  }

  return {
    beatField: (rowId: string, field: "status" | "lengthSeconds", value: RowStatusId | number | null) => run("edit", () => {
      const target = { kind: "beat" as const, id: rowId, field, allJoined: field === "status" };
      return value === null ? commands.clearField(target) : commands.setField(target, value);
    }),
    gallery,
    addPictures,
    anchor: (id: string, rowId: string, field: "audioText" | "visualText", from: number, to: number, html: string) => run("comment", () => {
      if (native.isClosingOrClosed()) return { kind: "refused", reason: "closed" };
      if (native.document().rows.find(row => row.id === rowId)?.[field] !== html) return { kind: "refused", reason: "anchor" };
      const result = commands.anchorText({ beat: rowId, cell: field === "audioText" ? "narration" : "visual" }, from, to);
      if (result.kind === "refused") return result;
      selections.clear();
      selections.set(id, result.range);
      return { kind: "written" };
    }).changed,
    comments: {
      add: (comment: DocumentComment) => run("comment", () => {
        const { id, rowId, field, body, quotedText, createdAt } = comment;
        const range = selections.get(id);
        if ((field !== "audioText" && field !== "visualText") || !rowId || !range) return { kind: "refused", reason: "anchor" };
        const result = commands.createComment({ field, rowId, anchorId: id, quotedText: plainText(quotedText),
          author: actor, body: String(body), createdAt: String(createdAt), range });
        if (result.kind === "written") selections.delete(id);
        return result;
      }),
      cancel: (id: string) => { selections.delete(id); },
      reply: (id: string, reply: DocumentReply) => run("comment", () =>
        commands.createReply(id, { author: actor, body: String(reply.body), createdAt: String(reply.createdAt) })),
      author: actor,
      body: (id: string, reply: string | undefined, html: string) => run("edit", () =>
        commands.setCommentBody(reply === undefined ? { comment: id } : { comment: id, reply }, html)),
      resolve: (id: string, resolved: boolean) => run("edit", () => resolved
        ? commands.resolveComment({ comment: id }, { by: actor, at: new Date(now()).toISOString() })
        : commands.reopenComment({ comment: id })),
      remove: (id: string) => run("edit", () => commands.removeComment({ comment: id }))
    }
  };
}

export type NativeEditorRecords = ReturnType<typeof createNativeEditorRecords>;
