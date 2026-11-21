import type { openNativeSession } from "../../adapters/collab/native/session.ts";
import type { NativeRecordOutcome } from "../../adapters/collab/native/record-values.ts";
import type { NativeTextRange } from "../../adapters/collab/native/text-commands.ts";
import { nativeGalleryOf, sameNativeValue } from "../../adapters/collab/native/values.ts";
import type { GalleryEdit } from "../../application/commands/gallery.ts";
import type { CommentRecordWriter } from "../../application/commands/comments.ts";
import type { RegistryEditor } from "../../application/commands/registry-editor.ts";
import type { RecordCommandRun } from "../../application/commands/shared-records.ts";
import { NOTHING_RAN, RECORD_CHANGED, RECORD_REFUSED } from "../../application/commands/shared-records.ts";
import type { ReportPort } from "../../application/session/ports.ts";
import type { SharedDocumentSession } from "../../application/session/shared-session.ts";
import { cappedName, cappedText, plainText } from "../../core/document/text-policy.ts";
import { PERSON_NAME_MAX, personNamed } from "../../core/production/records.ts";
import { isBlankTagName } from "../../core/production/tags.ts";
import { normalizeTagName, registryKey } from "../../core/document/tags.ts";
import { BROLL_PROP_NAME_MAX } from "../../core/document/broll.ts";
import type { NativeRegistryChange } from "../../adapters/collab/native/registry-commands.ts";
import type { DocumentComment, DocumentReply, DocumentRow } from "../../core/document/validated.ts";
import type { RowStatusId } from "../../core/document/timing.ts";
import { addGalleryPicture, replaceGalleryPicture, rowSlots } from "../../core/document/gallery.ts";
import type { ImageRef } from "../../core/document/ports.ts";
import { compressImageFile } from "../../features/rows/beat-media.ts";
import { capabilities } from "./ports/capabilities.ts";
import { documentReader } from "./ports/document.ts";
import { notices } from "./ports/effects.ts";
import { pictures } from "./ports/pictures.ts";

type NativeRecordsSession = ReturnType<typeof openNativeSession>;
type Admission = Pick<SharedDocumentSession, "admit" | "refuse">;
const STALE_BEAT = "That beat no longer exists.";

export function createNativeEditorRecords(
  native: NativeRecordsSession, session: () => Admission | null, actor: string, now: () => number, report: ReportPort,
  settle: () => string | null = () => null
) {
  const selections = new Map<string, NativeTextRange>();
  const localAppends = new Map<string, { before: ReturnType<typeof nativeGalleryOf>; after: ReturnType<typeof nativeGalleryOf> }>();

  function refuse(reason: string, owner: Admission | null, beat = false): RecordCommandRun {
    if (reason === "full") notices.show("This shared script is full. Export a copy to keep working.", "warn");
    else if (beat && reason === "missing") notices.show(STALE_BEAT, "warn");
    else if (owner) owner.refuse(reason);
    else notices.show("This is not available in a shared session yet.", "warn");
    return RECORD_REFUSED;
  }

  function run(
    permission: "edit" | "comment", write: () => NativeRecordOutcome, done?: string, beat = false, flush?: () => string | null
  ): RecordCommandRun {
    const owner = session();
    if (!owner) return refuse("closed", owner);
    try {
      const admission = owner.admit();
      if (admission?.kind === "failed") { report(admission.error); return refuse("failed", owner); }
      if (admission) return admission.notified ? RECORD_REFUSED : refuse(admission.reason, owner);
      const capability = capabilities[permission]();
      if (!capability.allowed) return refuse(capability.reason, owner);
      const pending = flush?.();
      if (pending) return refuse(pending, owner);
      const result = write();
      if (result.kind === "refused") return refuse(result.reason, owner, beat);
      if (result.kind === "unchanged") return NOTHING_RAN;
      if (done) notices.show(done, "ok");
      return RECORD_CHANGED;
    } catch (error) {
      report(error);
      return refuse("failed", owner);
    }
  }

  const commands = native.commands;
  function writeRegistry(write: () => NativeRecordOutcome): RecordCommandRun {
    return run("edit", write, undefined, false, settle);
  }

  function changeRegistry(change: NativeRegistryChange, checked?: () => boolean): RecordCommandRun {
    return writeRegistry(() => checked && !checked() ? { kind: "refused", reason: "missing" } : commands.changeRegistry(change));
  }

  function createRegistry(change: Extract<NativeRegistryChange, { kind: "create" }>, existing?: () => string) {
    let id = "";
    const result = writeRegistry(() => {
      const outcome = commands.changeRegistry(change);
      if ("created" in outcome) id = outcome.created;
      else if (outcome.kind === "unchanged" && existing) id = existing();
      return outcome;
    });
    return { run: result, id };
  }

  const registry: RegistryEditor = {
    addPerson: raw => {
      const name = cappedText(raw, PERSON_NAME_MAX);
      if (!name) return { run: NOTHING_RAN, id: "" };
      return createRegistry({ kind: "create", collection: "people", fields: { name } },
        () => personNamed(native.document(), name)?.id ?? "");
    },
    removePerson: id => changeRegistry({ kind: "remove", collection: "people", ids: [id] }),
    registerTag: (cat, raw) => {
      const name = cappedName(String(raw ?? ""), 80);
      return isBlankTagName(name) ? NOTHING_RAN : changeRegistry({ kind: "create", collection: "tags", fields: { cat, name } });
    },
    updateTags: (tags, { owner, notes, status }) => {
      const ownerName = owner && "name" in owner ? cappedText(owner.name, PERSON_NAME_MAX) : undefined;
      if (ownerName === "") return NOTHING_RAN;
      return changeRegistry({
        kind: "updateTags",
        tags: tags.map(({ cat, name }) => ({ cat, name })),
        fields: { ...(owner && "id" in owner ? { owner: owner.id } : {}),
          ...(notes === undefined ? {} : { notes }), ...(typeof status === "string" ? { status } : {}) },
        ...(ownerName === undefined ? {} : { ownerName }), ...(typeof status === "object" ? { cycle: true } : {})
      }, () => {
        if (native.isClosingOrClosed()) return false;
        const current = new Map(native.document().productionTags.map(tag => [tag?.id, tag]));
        return tags.every(({ id, cat, name }) => {
          if (!id) return true;
          const tag = current.get(id);
          return !!tag && registryKey(tag.cat, tag.name) === registryKey(cat, name);
        });
      });
    },
    renameTag: (id, name) => name ? changeRegistry({ kind: "set", collection: "tags", ids: id ? [id] : [], fields: { name } }, () => !!id) : NOTHING_RAN,
    removeTags: ids => changeRegistry({ kind: "remove", collection: "tags", ids }),
    gear: raw => {
      const names = new Map<string, string>();
      for (const line of raw.split(/\r\n|\r|\n/)) {
        const name = cappedText(line, 80), key = normalizeTagName(name);
        if (name && !names.has(key)) names.set(key, name);
      }
      return changeRegistry({ kind: "gear", names: [...names.values()] });
    },
    addShot: name => createRegistry({ kind: "create", collection: "shots", fields: { name, origin: "list" } }),
    setShots: (ids, fields, owner) => {
      const ownerName = owner && "name" in owner ? cappedText(owner.name, PERSON_NAME_MAX) : undefined;
      if (ownerName === "") return NOTHING_RAN;
      return changeRegistry({ kind: "set", collection: "shots", ids,
        fields: owner && "id" in owner ? { ...fields, owner: owner.id } : fields,
        ...(ownerName === undefined ? {} : { ownerName }) });
    },
    removeShot: id => changeRegistry({ kind: "remove", collection: "shots", ids: [id] }),
    addShotProp: (id, raw) => {
      const prop = cappedText(raw, BROLL_PROP_NAME_MAX);
      return prop ? changeRegistry({ kind: "addProp", id, prop }) : NOTHING_RAN;
    },
    removeShotProp: (id, prop) => changeRegistry({ kind: "removeProp", id, prop })
  };
  function gallery(rowId: string, message: string, edit: GalleryEdit, append?: readonly string[]): RecordCommandRun {
    return run("edit", () => {
      if (native.isClosingOrClosed()) return { kind: "refused", reason: "closed" };
      const shown = documentReader.current()?.rows.find(row => row.id === rowId);
      const latest = native.document().rows.find(row => row.id === rowId);
      if (!shown || !latest) return { kind: "refused", reason: "missing" };
      const before = nativeGalleryOf(shown), current = nativeGalleryOf(latest);
      if (!sameNativeValue(before, current)) {
        const local = localAppends.get(rowId);
        if (append && local && sameNativeValue(local.before, before) && sameNativeValue(local.after, current)
          && append.every(sha => rowSlots(latest).some(slot => slot.ref?.sha256 === sha))) return { kind: "unchanged" };
        return { kind: "refused", reason: "value" };
      }
      const row = JSON.parse(JSON.stringify(latest)) as DocumentRow;
      if (!edit(row)) return { kind: "unchanged" };
      const after = nativeGalleryOf(row);
      const result = commands.setField({ kind: "gallery", id: rowId }, after);
      if (append && result.kind === "written") {
        const local = { before, after };
        localAppends.set(rowId, local);
        queueMicrotask(() => { if (localAppends.get(rowId) === local) localAppends.delete(rowId); });
      }
      return result;
    }, message, true);
  }

  async function storePictures(shas: readonly string[]): Promise<boolean> {
    // why: cleanup can fail after a gallery reference commits, so its bytes must already be durable
    const missing = await pictures.persist(shas);
    return !missing.length && shas.every(sha => pictures.isDurable(sha));
  }

  async function addPictures(rowId: string, files: readonly File[], slot?: number): Promise<void> {
    const shown = documentReader.current()?.rows.find(row => row.id === rowId);
    if (!shown) { refuse("missing", session(), true); return; }
    try {
      const urls = await Promise.all(files.map(file => compressImageFile(file, 1000, 0.78)));
      const refs = urls.map((url, index) => {
        const ref = pictures.internDataUrl(url);
        if (!ref) throw new Error("not a picture the registry takes");
        return { ref, name: files[index]?.name };
      });
      const shas = refs.map(({ ref }) => ref.sha256);
      if (!await storePictures(shas)) {
        notices.show("Could not store the picture, so it was not added.", "warn");
        return;
      }
      const latest = documentReader.current()?.rows.find(row => row.id === rowId);
      if (!session() || latest && slot !== undefined && !sameNativeValue(nativeGalleryOf(shown), nativeGalleryOf(latest))) {
        notices.show("The picture finished loading after the script changed, so it was not added.", "warn");
        return;
      }
      const number = documentReader.numbering().beats[rowId]?.full ?? "";
      const message = (refs.length === 1 ? "Picture" : "Pictures") + (slot === undefined ? " added to" : " replaced in") + " beat " + number;
      gallery(rowId, message, row => {
        if (slot !== undefined && refs[0]) return replaceGalleryPicture(row, slot, refs[0].ref, refs[0].name);
        for (const { ref, name } of refs) addGalleryPicture(row, ref, name);
        return true;
      }, slot === undefined ? shas : undefined);
    } catch {
      notices.show("Could not use that image.", "error");
    }
  }

  return {
    registry,
    beatField: (rowId: string, field: "status" | "lengthSeconds", value: RowStatusId | number | null) => run("edit", () => {
      const target = { kind: "editor-beat" as const, id: rowId, field };
      return value === null ? commands.clearField(target) : commands.setField(target, value);
    }, undefined, true),
    gallery: (rowId: string, message: string, edit: GalleryEdit) => gallery(rowId, message, edit),
    storePicture: async (picture: ImageRef) => await storePictures([picture.sha256]) ? picture : null,
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
    } satisfies CommentRecordWriter
  };
}

export type NativeEditorRecords = ReturnType<typeof createNativeEditorRecords>;
