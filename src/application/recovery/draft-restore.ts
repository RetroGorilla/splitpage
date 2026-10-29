import { normalizeDocId } from "../../../shared/doc-id-policy.js";
import { cloneState } from "../../core/document/clone.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import type { DocumentView } from "../session/document-session.ts";

export interface TakenServer {
  readonly base: string;
  readonly docId: string;
  readonly rev: number;
}

export interface TakenOrigin {
  readonly kind?: string | undefined;
  readonly fileName?: string | undefined;
  readonly importName?: string | undefined;
  readonly server?: TakenServer | undefined;
}

export interface TakenHeader {
  readonly origin?: TakenOrigin | undefined;
  readonly writtenAt?: number | undefined;
  readonly title?: string | undefined;
  readonly docIdWrittenOut?: boolean | undefined;
}

export interface TakenDraft {
  readonly header?: TakenHeader | undefined;
  readonly stateJson?: unknown;
  readonly baseJson?: unknown;
  readonly ageMs?: number | null | undefined;
  readonly previousSession?: string | undefined;
  readonly browserKey?: string | undefined;
  readonly unsupported?: boolean | undefined;
  readonly corrupt?: boolean | undefined;
  readonly file?: unknown;
  readonly fileProblem?: string | undefined;
}

export interface HeaderedDraft extends TakenDraft {
  readonly header: TakenHeader;
}

export type DraftRestoreOutcome = "nothing-unsaved" | "failed" | "untitled-copy" | "unreadable" | "kept" | "applied" | "merged";

export type DraftRoute = "server" | "file" | "import" | "untitled";

export type TakenDraftFate =
  | { readonly kind: "settled"; readonly outcome: DraftRestoreOutcome; readonly notice: string | null }
  | {
    readonly kind: "restore";
    readonly route: DraftRoute;
    readonly draft: HeaderedDraft;
    readonly mine: ValidatedDocument;
    readonly base: ValidatedDocument | null;
    readonly origin: TakenOrigin;
  };

export interface DraftCopy {
  readonly notice: string;
  readonly outcome: DraftRestoreOutcome;
}

export interface DiskRead {
  readonly state: ValidatedDocument;
  readonly docIdEmbedded: boolean;
}

export type DraftMigrate = (raw: unknown) => ValidatedDocument;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const UNREADABLE_NOTICE = "The changes recovered from the last session couldn't be read — they have been kept for the next launch.";

export const KEPT_NOTICE = "Another script was opened while the changes from the last session were being restored — they have been kept for the next launch.";

export const RESTORE_FAILED_NOTICE = "Could not restore the changes from the last session — they have been kept for the next launch.";

function fieldOf(value: unknown, name: string): unknown {
  const field: unknown = Reflect.get(Object(value), name);
  return field;
}

function draftParse(json: unknown): unknown {
  if (typeof json !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed;
  } catch (e) { return null; }
}

export function draftMigrate(json: unknown, migrate: DraftMigrate): ValidatedDocument | null {
  const raw = draftParse(json);
  if (!raw || typeof raw !== "object" || !Array.isArray(fieldOf(raw, "rows"))) return null;
  return migrate(raw);
}

function draftStableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) {
    const items = v.map(function (x: unknown) { return draftStableJson(x); });
    return "[" + items.join(",") + "]";
  }
  const keys = Object.keys(v).sort();
  const parts = keys.map(function (k) {
    return JSON.stringify(k) + ":" + draftStableJson(fieldOf(v, k));
  });
  return "{" + parts.join(",") + "}";
}

export function sameDocContent(a: DocumentView | null | undefined, b: DocumentView | null | undefined, migrate: DraftMigrate): boolean {
  if (!a || !b) return false;
  function normalized(s: DocumentView): string {
    const c: Mutable<ValidatedDocument> = migrate(cloneState(s));
    c.rev = 0;
    c.lastEditedBy = "";
    c.lastEditedAt = "";
    c.docId = "";
    return draftStableJson(c);
  }
  try {
    return normalized(a) === normalized(b);
  } catch (e) { return false; }
}

export function draftAgeText(ageMs: unknown): string {
  if (typeof ageMs !== "number" || !isFinite(ageMs) || ageMs < 0) return "";
  const mins = Math.round(ageMs / 60000);
  if (mins < 1) return "from a moment ago";
  if (mins < 60) return "from " + mins + " minute" + (mins === 1 ? "" : "s") + " ago";
  const hours = Math.round(mins / 60);
  if (hours < 24) return "from " + hours + " hour" + (hours === 1 ? "" : "s") + " ago";
  const days = Math.round(hours / 24);
  return "from " + days + " day" + (days === 1 ? "" : "s") + " ago";
}

export function draftWhenText(t: TakenDraft | null | undefined): string {
  const age = draftAgeText(t && t.ageMs);
  let why = "";
  if (t && t.previousSession === "running") why = "before Splitpage closed unexpectedly";
  else if (t && t.previousSession === "session-end") why = "before Windows signed you out";
  else if (t && t.previousSession === "clean-exit") why = "before Splitpage closed";
  if (age && why) return age + ", " + why;
  return age || why;
}

function withWhen(t: TakenDraft): string {
  return draftWhenText(t) ? " " + draftWhenText(t) : "";
}

export function draftTitleOf(s: DocumentView | null | undefined, fallback?: string): string {
  return (s && s.title) || fallback || "this script";
}

export function draftReasonFor(code: string): string {
  switch (code) {
    case "HELD": return "the changes recovered from the last session are being kept";
    case "ENOSPC": return "this disk is full";
    case "EACCES":
    case "EPERM": return "this computer would not let Splitpage write it";
    case "EBUSY": return "another program is using the file";
    case "EIO": return "the disk reported an error";
    case "TOO_LARGE": return "this document is too large to copy";
    case "QUOTA": return "this browser's storage is full";
    case "offline": return "the app did not answer";
    default: return "the copy was refused";
  }
}

export function hasHeader(t: TakenDraft): t is HeaderedDraft {
  return !!t.header;
}

function routeOf(origin: TakenOrigin): DraftRoute {
  if (origin.kind === "server") return "server";
  if (origin.kind === "file") return "file";
  if (origin.kind === "import") return "import";
  return "untitled";
}

export function takenDraftFate(t: TakenDraft | null | undefined, migrate: DraftMigrate): TakenDraftFate {
  if (!t) return { kind: "settled", outcome: "nothing-unsaved", notice: null };
  if (t.unsupported) {
    return {
      kind: "settled",
      outcome: "failed",
      notice: "The changes recovered from the last session were saved by a newer version of " +
        "Splitpage — they have been kept, untouched."
    };
  }
  if (t.corrupt) return { kind: "settled", outcome: "failed", notice: UNREADABLE_NOTICE };
  if (!hasHeader(t) || typeof t.stateJson !== "string") return { kind: "settled", outcome: "failed", notice: null };
  const mine = draftMigrate(t.stateJson, migrate);
  if (!mine) return { kind: "settled", outcome: "failed", notice: UNREADABLE_NOTICE };
  const base = t.baseJson ? draftMigrate(t.baseJson, migrate) : null;
  const origin: TakenOrigin = t.header.origin || { kind: "untitled" };
  return { kind: "restore", route: routeOf(origin), draft: t, mine: mine, base: base, origin: origin };
}

export function serverCopy(mine: ValidatedDocument): DraftCopy {
  return {
    notice: "Your unsaved changes to “" + draftTitleOf(mine) + "” were recovered. It was a document on a " +
      "Splitpage server, which this version no longer opens, so they are open here as an unsaved copy. " +
      "Save them wherever you want them.",
    outcome: "untitled-copy"
  };
}

export function importCopy(origin: TakenOrigin): DraftCopy {
  return {
    notice: "Your unsaved changes to " + (origin.importName || "an imported file") + " were recovered. " +
      "They are open here as an unsaved copy — save them as a Splitpage script to keep them.",
    outcome: "untitled-copy"
  };
}

export function missingFileName(mine: ValidatedDocument, origin: TakenOrigin): string {
  const title = draftTitleOf(mine, origin.fileName);
  return origin.fileName || title;
}

export function missingFileCopy(t: TakenDraft, missingName: string): DraftCopy {
  const gone = t.fileProblem === "unreadable"
    ? "couldn't be read"
    : "isn't where it was";
  return {
    notice: "The file these recovered changes belong to (" + missingName + ") " + gone +
      " — they are open here as an unsaved copy.",
    outcome: t.fileProblem === "unreadable" ? "unreadable" : "untitled-copy"
  };
}

export function unreadableFileCopy(missingName: string): DraftCopy {
  return {
    notice: "The file these recovered changes belong to (" + missingName + ") could not be read — they " +
      "are open here as an unsaved copy.",
    outcome: "unreadable"
  };
}

export function draftRefId(mine: ValidatedDocument, base: ValidatedDocument | null): string {
  return normalizeDocId((base && base.docId) || mine.docId);
}

export function differentScriptCopy(disk: DiskRead, refId: string, missingName: string): DraftCopy | null {
  if (!(disk.docIdEmbedded && refId && normalizeDocId(disk.state.docId) !== refId)) return null;
  return {
    notice: "A different script has been saved as " + missingName + " — the changes recovered from the " +
      "last session are open here as an unsaved copy.",
    outcome: "untitled-copy"
  };
}

export function alreadySavedNotice(disk: DocumentView, fileName: string): string {
  return "Opened " + (disk.title || fileName) + " — the changes from the last session were already saved";
}

export function restoredFileNotice(t: TakenDraft, title: string, fileName: string): string {
  return "Restored your unsaved changes to " + (title || fileName) + withWhen(t);
}

export function mergedFileNotice(fileName: string): string {
  return (fileName || "That file") + " had changed since the last session — your recovered " +
    "changes were merged into it. Nothing has been saved yet.";
}

export function untitledRestoredNotice(t: TakenDraft): string {
  return "Restored your unsaved script" + withWhen(t) + " — it has never been saved, so save it somewhere.";
}
