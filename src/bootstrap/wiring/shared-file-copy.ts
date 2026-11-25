import type { NativeReplicaInvoke } from "../../../shared/native-replica.d.ts";
import type { SharedFileInfo } from "../../../shared/shared-file-copy.d.ts";
import { fileKindFromName } from "../../../shared/file-names.ts";
import { cloneState } from "../../core/document/clone.ts";
import { createFileCopy } from "../../application/collaboration/file-copy.ts";
import type { FileCopyProblem, FileCopyWritten } from "../../application/collaboration/file-copy.ts";
import type { SharedDocumentSession } from "../../application/session/shared-session.ts";
import { buildMarkdownProject, buildSplitpageFile, fileImagesMissing } from "../../adapters/formats/project-file.ts";
import { buildPublishHtml } from "../../adapters/page/page-shell.ts";
import { makeDesktopHandle } from "../../adapters/desktop/desktop-handle.ts";
import { mintDocId } from "../../adapters/identity/ids.ts";
import { captureExportDocument } from "./export-capture.ts";
import { documentLocation, setHome } from "./location-owner.ts";
import { pictures } from "./ports/pictures.ts";
import { confirmSavedNow } from "./save-owners.ts";
import { documentReader } from "./ports/document.ts";

let active: ReturnType<typeof createFileCopy> | undefined;
let view: { file: SharedFileInfo | null; problem: FileCopyProblem | null } = { file: null, problem: null };
const listeners = new Set<() => void>();

function publish(file: SharedFileInfo | null, problem: FileCopyProblem | null) {
  view = { file, problem };
  for (const listener of listeners) listener();
}

export const sharedFileCopy = {
  read: () => view,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  async retry() { await active?.flush(false); },
  async overwrite() { await active?.flush(false, "overwrite"); },
  async saveAs() { await active?.flush(false, "new"); },
  async stop() {
    if (active && !await active.stop()) throw new Error("Could not stop keeping the file copy.");
  }
};

export function openSharedFileCopy(invoke: NativeReplicaInvoke, key: string, session: SharedDocumentSession) {
  let closed = false;
  let owner: typeof active;
  let checked = false;
  const readRevision = () => session.readAt((_document, revision) => revision);
  const ready = invoke(["file-copy-status", key]).then(result => {
    if (closed || result.kind !== "file-copy") return;
    checked = true;
    if (!result.file) return;
    owner = createFileCopy(result.file, {
      now: () => Date.now(),
      startTimer(run, delay) {
        const timer = setTimeout(run, delay);
        return () => clearTimeout(timer);
      },
      async capture(file, mode) {
        const newFile = mode === "new" || mode === "export";
        const docId = newFile ? mintDocId() : file.docId;
        const captured = session.readAt(() => captureExportDocument({ docId }));
        await pictures.ensureBytes(fileImagesMissing(captured));
        const missing = fileImagesMissing(captured).length;
        const format = newFile ? "splitpage" : fileKindFromName(file.name);
        const project = () => buildSplitpageFile(captured);
        const body = format === "md" ? buildMarkdownProject(captured)
          : format === "html" ? buildPublishHtml(project()) : project();
        return { bytes: new TextEncoder().encode(body), missing, docId };
      },
      async write(bytes, missing, mode, docId) {
        const result = await invoke(["file-copy-write", key, bytes, missing, mode, docId]);
        return result.kind === "file-copy-written" || result.kind === "file-copy-problem" || result.kind === "file-copy"
          ? result : { kind: "file-copy-problem", problem: "unavailable" };
      },
      async forget() {
        const result = await invoke(["file-copy-stop", key]);
        return result.kind === "file-copy" && !result.file;
      },
      publish
    });
    active = owner;
    owner.changed(readRevision());
  }).catch(() => {});
  const unsubscribe = session.subscribe(() => { owner?.changed(readRevision()); });
  return {
    picturesChanged() { owner?.picturesChanged(); },
    async flushOnClose(mode: "check" | "new" = "check") {
      await ready;
      if (!checked) return "unavailable";
      const revision = readRevision();
      const result = await owner?.flush(true, mode === "new" ? "export" : "check");
      return typeof result === "string" ? result : owner?.info() && revision !== readRevision() ? "unavailable" : null;
    },
    async beforeDeparture(reason: "leave" | "stop") {
      await ready;
      if (!checked) {
        const chosen = await invoke(["file-copy-choice", key, "unavailable", reason]);
        return chosen.kind === "file-copy-choice" && chosen.choice === "continue" ? null : false;
      }
      return await owner?.beforeDeparture(async problem => {
        const chosen = await invoke(["file-copy-choice", key, problem, reason]);
        return chosen.kind === "file-copy-choice" ? chosen.choice : "cancel";
      }) ?? null;
    },
    dispose() {
      closed = true;
      unsubscribe();
      owner?.dispose();
      if (active === owner && active) {
        active = undefined;
        publish(null, null);
      }
    }
  };
}

export function keepLandedFile(written: FileCopyWritten) {
  const document = documentReader.current();
  if (!document) return;
  setHome("file", {
    handle: makeDesktopHandle({ id: written.id, name: written.file.name }),
    name: written.file.name,
    format: fileKindFromName(written.file.name),
    diskBase: cloneState(document),
    lastModified: written.lastModified ?? null
  });
  documentLocation().markWrittenOut(true);
  confirmSavedNow();
}
