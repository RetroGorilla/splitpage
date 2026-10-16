import { deepFreeze } from "./freeze.ts";
import type { Frozen } from "./freeze.ts";
import type { DocumentComment, DocumentRow, DocumentShot, DocumentTag, ValidatedDocument } from "./validated.ts";

export type ExportPerson = { id: string; name: string; [key: string]: unknown };

export type ExportTagMention = { rowId: string; rowIndex: number; field: string; text: string };

export type ExportTagEntry = {
  key: string;
  id: string | null;
  catId: string;
  name: string;
  mentions: ExportTagMention[];
  orphaned: boolean;
  owner: string;
  notes: string;
  status: string;
};

export type ExportShotProp = { key: string; id: string; name: string; status: string; [key: string]: unknown };

export type ExportShotEntry = {
  id: string;
  name: string | undefined;
  desc: string;
  rowId: string | null;
  rowIndex: number;
  ordinal: number;
  status: string;
  reshoot: boolean;
  notes: string;
  owner: string;
  audioRef: string;
  location: string;
  props: ExportShotProp[];
  [key: string]: unknown;
};

export type ExportReadModels = {
  production: readonly ExportTagEntry[];
  commentNumbers: Readonly<Record<string, number>>;
  broll: readonly ExportShotEntry[];
};

export type ClockMode = "system" | "12" | "24";

export type ExportDocument = Frozen<{
  document: ValidatedDocument;
  title: string;
  scenes: DocumentRow[];
  people: ExportPerson[];
  tags: (DocumentTag | null | undefined)[];
  shots: DocumentShot[];
  comments: DocumentComment[];
  capturedAt: string;
  clockMode: ClockMode;
  production: ExportTagEntry[];
  commentNumbers: Record<string, number>;
  broll: ExportShotEntry[];
}>;

export interface ExportStamp {
  readonly rev: number;
  readonly lastEditedBy: string;
  readonly lastEditedAt: string;
}

export type ExportCaptureOptions = {
  docId?: string | null | undefined;
  stamp?: ExportStamp | null | undefined;
  clockMode?: ClockMode | null | undefined;
};

function jsonCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function numbering(nums: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = Object.create(null) as Record<string, number>;
  Object.keys(nums).forEach(function (id) {
    const n = nums[id];
    if (typeof n === "number") out[id] = n;
  });
  return out;
}

function shotEntry(entry: ExportShotEntry): ExportShotEntry {
  const out = Object.assign({}, entry);
  delete out.rec;
  return out;
}

export function buildExportDocument(
  source: Frozen<ValidatedDocument>,
  capturedAt: string,
  models: ExportReadModels,
  opts?: ExportCaptureOptions | null
): ExportDocument {
  const copied = jsonCopy(source);
  const forked = opts && opts.docId ? Object.assign({}, copied, { docId: opts.docId }) : copied;
  const document = opts && opts.stamp ? Object.assign({}, forked, opts.stamp) : forked;
  const people = Array.isArray(document.people) ? document.people as ExportPerson[] : [];
  return deepFreeze({
    document: document,
    title: document.title,
    scenes: document.rows,
    people: people,
    tags: document.productionTags,
    shots: document.brollShots,
    comments: document.comments,
    capturedAt: capturedAt,
    clockMode: opts && opts.clockMode ? opts.clockMode : "system",
    production: jsonCopy(models.production.slice()),
    commentNumbers: numbering(models.commentNumbers),
    broll: jsonCopy(models.broll.map(shotEntry))
  });
}
