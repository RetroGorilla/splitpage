import type { MergeUndoRecord } from "../../application/session/apply-merge.ts";

export interface MergeReportStats {
  readonly rowsFromMe?: number;
  readonly rowsAddedByMe?: number;
  readonly rowsFromThem?: number;
  readonly rowsAddedByThem?: number;
}

export interface MergeReport {
  readonly stats: MergeReportStats;
  readonly conflicts: readonly { readonly rowId: string }[];
}

export type RestoreAnswer = "ok" | "busy" | "missing" | "corrupt" | "changed" | "no-backup" | string;

export interface RestoreRequest {
  readonly force: boolean;
  readonly local: boolean;
  readonly restoredText: string | undefined;
}

export interface MergeBannerPorts {
  readonly lastUndo: () => MergeUndoRecord | null;
  readonly sameDocument: (docId: string | null | undefined) => boolean;
  readonly restore: (id: string, request: RestoreRequest) => PromiseLike<RestoreAnswer>;
  readonly warn: (message: string) => void;
  readonly openComments: () => void;
  readonly rowElement: (rowId: string) => Element | null;
  readonly logError: (e: unknown) => void;
  readonly install: (banner: MergeBanner) => () => void;
}

export interface MergeBannerMount {
  readonly window: Window;
  readonly ports: MergeBannerPorts;
}

export interface ShowOptions {
  readonly undo?: boolean | "saved";
}

export interface MergeBanner {
  readonly show: (result: MergeReport, opts?: ShowOptions) => boolean;
  readonly undoMerge: () => void;
  readonly dispose: () => void;
}

export const ARM_MS = 3000;
const UNDO_LABEL = "Undo merge";

const UNDO_SAVED_NOTE = "Undo merge puts your version back here; the next save replaces the merged copy on the server.";
const UNDO_SAVED_TITLE = "Go back to the version you were saving, before someone else's changes were merged into it. " +
  "It stays unsaved until the next save, which replaces the merged copy on the server. Recoverable from Version history.";

const UNDO_CONFIRM: Readonly<Record<string, string>> = { "server-conflict": "Drop their changes?" };
const UNDO_LOCAL: Readonly<Record<string, boolean>> = { "server-conflict": true };
const UNDO_RESTORED: Readonly<Record<string, string>> = {
  "server-conflict": "Your version is back, unsaved. The next save replaces the merged copy on the server."
};

const RESTORE_SAYS: Readonly<Record<string, string>> = {
  "missing": "The snapshot from before the merge is no longer in the history.",
  "corrupt": "The snapshot from before the merge could not be read, so nothing was undone.",
  "changed": "A different document was opened while undoing, so nothing was undone."
};

function plural(n: number, one: string): string {
  return n + " " + one + (n === 1 ? "" : "s");
}

export function mergeSummary(result: MergeReport): string | null {
  const s = result.stats;
  const bits: string[] = [];
  if (s.rowsFromMe) bits.push(plural(s.rowsFromMe, "row") + " you edited");
  if (s.rowsAddedByMe) bits.push(plural(s.rowsAddedByMe, "row") + " you added");
  if (s.rowsFromThem) bits.push(s.rowsFromThem + " changed by someone else");
  if (s.rowsAddedByThem) bits.push(s.rowsAddedByThem + " added by someone else");
  if (!bits.length && !result.conflicts.length) return null;

  let summary = bits.length ? "Kept " + bits.join(", ") + "." : "Nothing was lost.";
  const n = result.conflicts.length;
  if (n) summary += " " + n + " edit" + (n === 1 ? " was" : "s were") + " changed on both sides — your version is saved as a comment.";
  return summary;
}

export function mountMergeBanner(mount: MergeBannerMount): MergeBanner {
  const ports = mount.ports;
  const realm = mount.window;
  const doc = realm.document;
  const el = (id: string): HTMLElement => doc.getElementById(id) as HTMLElement;
  const banner = el("merge-banner");
  const undoBtn = el("merge-undo");
  const reviewBtn = el("merge-review");
  const dismissBtn = el("merge-dismiss");
  const undoTitleDefault = undoBtn.title;
  let open = true;
  let armed = false;
  let armTimer: ReturnType<Window["setTimeout"]> | null = null;
  let forceFor: MergeUndoRecord | null = null;

  function disarm(): void {
    if (armTimer !== null) realm.clearTimeout(armTimer);
    armTimer = null;
    armed = false;
    undoBtn.textContent = UNDO_LABEL;
    undoBtn.classList.remove("armed");
  }

  function show(result: MergeReport, opts?: ShowOptions): boolean {
    if (!open) return false;
    let summary = mergeSummary(result);
    if (summary === null) return false;
    const undo = opts?.undo;
    const offerUndo = undo !== false && !!ports.lastUndo();
    undoBtn.hidden = !offerUndo;
    undoBtn.title = undo === "saved" ? UNDO_SAVED_TITLE : undoTitleDefault;
    if (offerUndo && undo === "saved") summary += " " + UNDO_SAVED_NOTE;

    el("merge-summary").textContent = " " + summary;
    reviewBtn.hidden = !result.conflicts.length;
    banner.classList.toggle("notice-warn", !!result.conflicts.length);
    banner.hidden = false;

    result.conflicts.forEach((c) => {
      const row = ports.rowElement(c.rowId);
      if (row) row.classList.add("just-merged");
    });
    return true;
  }

  function undoMerge(): void {
    if (!open) return;
    const undo = ports.lastUndo();
    if (!undo) { ports.warn("No merge snapshot to undo."); return; }
    if (!ports.sameDocument(undo.docId)) {
      ports.warn("That merge belongs to a different document, so there is nothing to undo here.");
      return;
    }
    if (armed) {
      disarm();
      const force = forceFor === undo;
      forceFor = null;
      const source = undo.source ?? "";
      ports.restore(undo.id, {
        force: force,
        local: !!UNDO_LOCAL[source],
        restoredText: UNDO_RESTORED[source]
      }).then((r) => {
        if (!open) return;
        if (r === "no-backup") {
          forceFor = undo;
          ports.warn("Could not keep a backup of your current version. Undo the merge again to discard your edits anyway.");
        } else if (RESTORE_SAYS[r]) {
          ports.warn(RESTORE_SAYS[r]);
        }
      }, (e: unknown) => { ports.logError(e); });
      return;
    }
    armed = true;
    undoBtn.textContent = UNDO_CONFIRM[undo.source ?? ""] || "Discard my edits?";
    undoBtn.classList.add("armed");
    if (armTimer !== null) realm.clearTimeout(armTimer);
    armTimer = realm.setTimeout(disarm, ARM_MS);
  }

  function onDismiss(): void {
    banner.hidden = true;
  }

  function onReview(): void {
    banner.hidden = true;
    ports.openComments();
  }

  dismissBtn.addEventListener("click", onDismiss);
  undoBtn.addEventListener("click", undoMerge);
  reviewBtn.addEventListener("click", onReview);

  const self: MergeBanner = {
    show: show,
    undoMerge: undoMerge,
    dispose(): void {
      if (!open) return;
      disarm();
      open = false;
      forceFor = null;
      dismissBtn.removeEventListener("click", onDismiss);
      undoBtn.removeEventListener("click", undoMerge);
      reviewBtn.removeEventListener("click", onReview);
      const done = release;
      release = null;
      done?.();
    }
  };
  let release: (() => void) | null = ports.install(self);
  return self;
}
