import { normalizeImageRef } from "../../shared/blob-policy.js";
import { normalizeDocId } from "../../shared/doc-id-policy.js";
import { BROLL_STATUS_IDS, brollStatusId, normalizeBrollProps } from "./document/broll.ts";
import { SCHEMA_VERSION, STATE_FIELDS } from "./document/fields.ts";
import type { StateField } from "./document/fields.ts";
import { migrateGallery } from "./document/gallery.ts";
import type { GalleryRow } from "./document/gallery.ts";
import { deriveDocId, docIdEmbeddedIn } from "./document/ids.ts";
import { mediaComments } from "./document/media.ts";
import type { CellMedia, MediaComment, MediaField, MediaRow } from "./document/media.ts";
import type { IdSource, ImageSource } from "./document/ports.ts";
import { TAG_CATEGORY_IDS, TAG_STATUS_IDS, ensureTagIds, tagCategoryId, tagStatusId } from "./document/tags.ts";
import type { TagRecord } from "./document/tags.ts";
import type { ValidatedDocument } from "./document/validated.ts";
import { cappedText, legacyMdToHtml, plainName, plainText, safeId, safeImageSrc, storedImageHtml, textOf } from "./document/text-policy.ts";
import { normalizeSceneLength, rowStatusId } from "./document/timing.ts";
import type { ProductionReaders, ProductionRow } from "./production/ports.ts";
import { collectTagsFromRows, missingRegistryTags } from "./production/tags.ts";
import { syncCommentAnchors } from "./text/anchors.ts";
import { toHtml } from "./text/html.ts";
import type { DecodeOptions } from "./text/ports.ts";
import type { Run } from "./text/runs.ts";

export type MigrateDecoder = (html: string, opts: DecodeOptions) => readonly Run[];

export interface MigratePorts {
  images: ImageSource;
  sanitize: (html: unknown) => string;
  decode: MigrateDecoder;
  videoCardHtml: (href: string) => string;
  readers: ProductionReaders;
  ids: IdSource;
  fields?: readonly StateField[] | undefined;
}

export interface DocumentOrigin {
  kind: string;
  serverId?: unknown;
  fallbackId?: unknown;
}

type Bag = Record<string, unknown>;

function isObject(v: unknown): v is Bag {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function stampOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

const MEDIA_FIELDS: readonly MediaField[] = ["visualText", "audioText"];

function moveMediaOutOfCell(row: Bag, field: MediaField, ports: MigratePorts): MediaComment[] {
  const found: CellMedia[] = [];
  const cell = ports.decode(row[field] as string, { onMedia: function (m) { found.push(m); } });
  row[field] = toHtml(cell);
  return mediaComments(row as unknown as MediaRow, field, found, ports.images, ports.videoCardHtml);
}

export function migrateRows(input: unknown, ports: MigratePorts): ValidatedDocument {
  const s: Bag = isObject(input) ? input : { title: "Untitled Script", rows: [], comments: [] };
  const fields = ports.fields || STATE_FIELDS;
  const ids = ports.ids;
  const legacy = typeof s.schema !== "number" || s.schema < SCHEMA_VERSION;

  const hadTagRegistry = "productionTags" in s;

  fields.forEach(function (f) {
    if (f.def && s[f.key] === undefined) s[f.key] = f.def();
  });

  if (!Array.isArray(s.rows)) s.rows = [];
  s.rows = (s.rows as unknown[]).filter(isObject);
  let movedMedia: MediaComment[] = [];
  (s.rows as Bag[]).forEach(function (r) {
    r.id = safeId(r.id, "r", ids);
    r.status = rowStatusId(r.status) ? r.status : "todo";
    const setLength = normalizeSceneLength(r.lengthSeconds);
    if (setLength === undefined) delete r.lengthSeconds; else r.lengthSeconds = setLength;
    r.visualText = ports.sanitize(legacy ? legacyMdToHtml(r.visualText || "") : textOf(r.visualText || ""));
    r.audioText = ports.sanitize(legacy ? legacyMdToHtml(r.audioText || "") : textOf(r.audioText || ""));
    const legacyImage = safeImageSrc(r.visualImage);
    const interned = legacyImage ? ports.images.fromDataUrl(legacyImage) : null;
    r.imageRef = interned || normalizeImageRef(r.imageRef) || null;
    delete r.visualImage;
    migrateGallery(r as GalleryRow, ports.images);
    if (!r.updatedAt) r.updatedAt = "";
    r.updatedBy = r.updatedBy ? plainName(r.updatedBy) : null;
    MEDIA_FIELDS.forEach(function (field) {
      if (/<img|video-embed-card/.test(r[field] as string)) movedMedia = movedMedia.concat(moveMediaOutOfCell(r, field, ports));
    });
  });

  if (!Array.isArray(s.comments)) s.comments = [];
  s.comments = (s.comments as unknown[]).filter(isObject);
  if (movedMedia.length) {
    const haveComment: Record<string, boolean> = Object.create(null);
    (s.comments as Bag[]).forEach(function (c) { haveComment[safeId(c.id, "c", ids)] = true; });
    movedMedia.forEach(function (c) {
      if (haveComment[c.id]) return;
      haveComment[c.id] = true;
      (s.comments as unknown[]).push(c);
    });
  }
  (s.comments as Bag[]).forEach(function (c) {
    c.id = safeId(c.id, "c", ids);
    if (c.field === "title") {
      c.rowId = null;
      c.anchorId = null;
    } else {
      c.rowId = safeId(c.rowId, "r", ids);
      c.anchorId = safeId(c.anchorId || c.id, "c", ids);
      c.field = (c.field === "visualText" || c.field === "visualImage") ? c.field : "audioText";
    }
    if (!Array.isArray(c.replies)) c.replies = [];
    c.replies = (c.replies as unknown[]).filter(isObject);
    (c.replies as Bag[]).forEach(function (rep) {
      rep.id = safeId(rep.id, "rp", ids);
      rep.body = ports.sanitize(textOf(rep.body || ""));
      rep.author = plainName(rep.author);
      if (rep.createdAt !== undefined) rep.createdAt = stampOrNull(rep.createdAt);
    });
    c.body = ports.sanitize(textOf(c.body || ""));
    c.quotedText = plainText(c.quotedText);
    if (typeof c.resolved !== "boolean") c.resolved = false;
    c.author = plainName(c.author);
    if (c.createdAt !== undefined) c.createdAt = stampOrNull(c.createdAt);
    c.updatedAt = stampOrNull(c.updatedAt) || c.createdAt || null;
    if (c.kind !== "conflict") c.kind = "anchor";
    if (c.kind === "conflict" && c.field === "visualImage") {
      const bodyImg = /<img\b[^>]*\sdata-blob="([0-9a-f]{64})"/.exec(c.body as string);
      const bodyRec = bodyImg ? ports.images.known(bodyImg[1] as string) : null;
      c.imageValue = bodyRec || normalizeImageRef(c.imageValue) || null;
      c.body = c.imageValue ? storedImageHtml(c.imageValue) : "";
    } else if ("imageValue" in c) {
      delete c.imageValue;
    }
    if (!c.resolved) {
      c.resolvedBy = null;
      c.resolvedAt = null;
    } else {
      const resolvedByClean = c.resolvedBy ? cappedText(c.resolvedBy, 80) : "";
      c.resolvedBy = resolvedByClean || null;
      c.resolvedAt = (c.resolvedBy && typeof c.resolvedAt === "string" && c.resolvedAt) ? c.resolvedAt : null;
    }
    c.assignee = c.assignee ? cappedText(c.assignee, 80) : "";
  });
  syncCommentAnchors(s as ValidatedDocument, ports.readers.cellOf);

  if (!Array.isArray(s.people)) s.people = [];
  s.people = (s.people as unknown[]).filter(isObject);
  (s.people as Bag[]).forEach(function (p) {
    p.id = safeId(p.id, "p", ids);
    p.name = cappedText(p.name, 60);
  });
  s.people = (s.people as Bag[]).filter(function (p) { return p.name; });
  const knownPeople: Record<string, boolean> = Object.create(null);
  (s.people as Bag[]).forEach(function (p) { knownPeople[p.id as string] = true; });

  if (!hadTagRegistry || !Array.isArray(s.productionTags)) {
    s.productionTags = collectTagsFromRows(s.rows as ProductionRow[], ports.readers).map(function (t) {
      return { cat: t.catId, name: t.name };
    });
  }
  s.productionTags = (s.productionTags as unknown[]).filter(isObject);
  (s.productionTags as Bag[]).forEach(function (t) {
    t.cat = tagCategoryId(t.cat) || TAG_CATEGORY_IDS[0];
    t.name = cappedText(t.name, 80);
    t.status = tagStatusId(t.status) || TAG_STATUS_IDS[0];
    t.owner = typeof t.owner === "string" && knownPeople[t.owner] ? t.owner : "";
    t.notes = plainText(t.notes).slice(0, 2000);
  });
  s.productionTags = (s.productionTags as Bag[]).filter(function (t) { return t.name; });
  missingRegistryTags(s.rows as ProductionRow[], s.productionTags as TagRecord[], ports.readers).forEach(function (t) {
    (s.productionTags as unknown[]).push(t);
  });
  ensureTagIds(s.productionTags as TagRecord[]);

  if (!Array.isArray(s.brollShots)) s.brollShots = [];
  s.brollShots = (s.brollShots as unknown[]).filter(isObject);
  (s.brollShots as Bag[]).forEach(function (b) {
    b.id = safeId(b.id, "bs", ids);
    b.name = cappedText(b.name, 200);
    b.desc = plainText(b.desc).slice(0, 2000);
    b.status = brollStatusId(b.status) || BROLL_STATUS_IDS[0];
    b.reshoot = b.reshoot === true;
    b.notes = plainText(b.notes).slice(0, 2000);
    b.audioRef = plainText(b.audioRef).slice(0, 2000);
    b.location = cappedText(b.location, 80);
    b.owner = typeof b.owner === "string" && knownPeople[b.owner] ? b.owner : "";
    b.origin = b.origin === "list" ? "list" : "script";
    b.props = normalizeBrollProps(b.props, s.productionTags as TagRecord[]);
  });
  s.brollShots = (s.brollShots as Bag[]).filter(function (b) { return b.name; });

  fields.forEach(function (f) {
    if (!f.normalize || !(f.key in s)) return;
    const value = f.normalize(s[f.key]);
    if (value === undefined) Reflect.deleteProperty(s, f.key);
    else s[f.key] = value;
  });

  s.title = plainText(s.title).slice(0, 300);
  if (!Number.isFinite(s.rev)) s.rev = 0;
  s.docId = normalizeDocId(s.docId) || ids.docId();
  s.schema = SCHEMA_VERSION;
  return s as ValidatedDocument;
}

export function migrateDocument(raw: unknown, origin: DocumentOrigin | null | undefined, ports: MigratePorts): ValidatedDocument {
  const from = origin || { kind: "fresh" };
  const embedded = docIdEmbeddedIn(raw);
  let seed = "";
  if (!embedded) {
    try { seed = String(JSON.stringify(raw)); } catch { seed = ""; }
  }
  const s = migrateRows(raw, ports);
  if (embedded) return s;
  if (from.kind === "file") {
    s.docId = deriveDocId("splitpage-file", seed);
  } else if (from.kind === "server") {
    const serverId = from.serverId == null ? "" : String(from.serverId);
    const fallback = normalizeDocId(from.fallbackId);
    if (fallback) s.docId = fallback;
    else if (serverId) s.docId = deriveDocId("splitpage-server-doc", serverId);
  }
  return s;
}
