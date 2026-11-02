import type { ScenePaste, ScenePastePlan } from "../../application/commands/scenes.ts";

type SceneCloned<T> = T extends readonly (infer V)[] ? SceneCloned<V>[] : T extends object ? { -readonly [K in keyof T]: SceneCloned<T[K]> } : T;
type SceneWireData = Pick<DocumentShape, "rows" | "comments" | "people" | "productionTags" | "brollShots">;
interface SceneWirePayload extends SceneWireData {
  format: string;
  version: number;
  source: { docId: string | null; title: string };
  blobs: Record<string, string>;
  blobsLeftOut: string[];
  cut?: string | undefined;
}
interface ParsedSceneClipboard extends SceneWireData {
  cut: string | null;
  source: SceneWirePayload["source"];
  carried: string[];
  refs: string[];
}
type ScenePayloadInput = { [K in keyof SceneWirePayload]?: unknown };
interface SceneInsertOptions {
  state?: ValidatedDocument | null | undefined;
  rowMap?: Record<string, string> | undefined;
  afterRowId?: string | null | undefined;
  replaceRowId?: string | null | undefined;
  move?: boolean | undefined;
  mint?: SceneClipPorts["ids"]["id"] | undefined;
  stamp?: ((row: DocumentRow) => void) | undefined;
}
type ScenePasteOptions = Pick<SceneInsertOptions, "afterRowId" | "mint" | "stamp"> & { title?: string | undefined };
import type { SceneClipPorts } from "./ports.ts";
import type { DocumentView } from "../../application/session/document-session.ts";
import type { DocumentShape, DocumentComment, DocumentTag, DocumentShot, ValidatedDocument, DocumentRow } from "../../core/document/validated.ts";
import type { Run } from "../../core/text/runs.ts";
import { normalizeBrollProps } from "../../core/document/broll.ts";
import { mintTagId, normalizeTagName, registryKey } from "../../core/document/tags.ts";
import { isSha256Hex, refsIn } from "../../../shared/blob-policy.js";
import { commentIds, normalizeCell } from "../../core/text/runs.ts";
import { toHtml } from "../../core/text/html.ts";
import { toPlainText } from "../../core/text/projections.ts";
import { syncCommentAnchors } from "../../core/text/anchors.ts";
import { brollIdsTaken, clipboardOfCell, freshBrollIds } from "./cell-clipboard.ts";
import { SCHEMA_VERSION } from "../../core/document/fields.ts";
import { cappedLongText } from "../../core/document/text-policy.ts";
import { isBlankScene } from "../../application/commands/rows.ts";

export const SCENES_MIME = "application/x-splitpage-scenes";
export const SCENES_ATTR = "data-splitpage-scenes";
const FORMAT = "splitpage-scenes";
const VERSION = 1;

const SCENE_BLOB_CAP = 16 * 1024 * 1024;

let ports: SceneClipPorts | null = null;
let liveCut: { nonce: string; docId: string | null } | null = null;

export function setLiveCut(nonce: string | null, docId: string | null) { liveCut = nonce ? { nonce: String(nonce), docId: docId || null } : null; }

export function isMove(clip: SceneClip | null, state: DocumentView | null) {
  return !!(liveCut && clip && clip.cut && clip.cut === liveCut.nonce && state && state.docId === liveCut.docId) &&
    scenesAway(clip, state);
}

function scenesAway(clip: SceneClip, state: DocumentView | null) {
  const here = Object.create(null) as Record<string, boolean>;
  ((state as DocumentView).rows || []).forEach(function (r) { if (r) here[r.id] = true; });
  return !clip.rows.some(function (r) { return here[r.id]; });
}

function clone<T>(v: T): SceneCloned<T> { return (v === undefined ? undefined : JSON.parse(JSON.stringify(v))) as SceneCloned<T>; }

function cellIdsOf(rows: readonly DocumentRow[], pick: (cell: readonly Run[], out: Record<string, boolean>) => void) {
  const out = Object.create(null) as Record<string, boolean>;
  rows.forEach(function (row) {
    ["visualText", "audioText"].forEach(function (f) { pick((ports as SceneClipPorts).text.cellOf(row[f] || ""), out); });
  });
  return out;
}

export function buildScenePayload(state: DocumentView | null, rowIds: readonly string[], opts?: { cut?: string | null; dataUrl?: SceneClipPorts["pictures"]["dataUrlFor"]; cap?: number }) {
  opts = opts || {};
  const want = Object.create(null) as Record<string, boolean>;
  (rowIds || []).forEach(function (id) { want[id] = true; });
  const rows = ((state as DocumentView).rows || []).filter(function (r) { return r && want[r.id]; }).map(clone);
  const rowSet = Object.create(null) as Record<string, boolean>;
  rows.forEach(function (r) { rowSet[r.id] = true; });

  const marked = cellIdsOf(rows, function (cell, out) {
    commentIds(cell).forEach(function (id) { out[id] = true; });
  });
  const comments = ((state as DocumentView).comments || []).filter(function (c) {
    if (!c || c.field === "title") return false;
    return rowSet[c.rowId as string] || marked[c.anchorId || c.id];
  }).map(clone);

  const tagKeys = Object.create(null) as Record<string, boolean>;
  (ports as SceneClipPorts).tagsInRows(rows).forEach(function (t) { tagKeys[registryKey((t.cat as NonNullable<typeof t.cat>).id, t.name)] = true; });
  const keyIds = cellIdsOf(rows, function (cell, out) {
    cell.forEach(function (r) { if (r.atom && r.id) out[r.id] = true; });
  });
  const brollShots = ((state as DocumentView).brollShots || []).filter(function (b) { return b && keyIds[b.id]; }).map(clone);
  const propIds = Object.create(null) as Record<string, boolean>;
  brollShots.forEach(function (b) { (b.props || []).forEach(function (p) { if (p && p.id) propIds[p.id] = true; }); });
  const productionTags = ((state as DocumentView).productionTags || []).filter(function (t) {
    return t && (tagKeys[registryKey(t.cat, t.name)] || propIds[t.id as string]);
  }).map(clone) as DocumentTag[];

  const owners = Object.create(null) as Record<string, boolean>;
  (productionTags as (DocumentTag | DocumentShot)[]).concat(brollShots).forEach(function (x) { if (x.owner) owners[x.owner] = true; });
  const people = ((state as DocumentView).people || []).filter(function (p) { return p && owners[p.id]; }).map(clone);

  const dataUrl = opts.dataUrl || (ports as SceneClipPorts).pictures.dataUrlFor;
  const cap = typeof opts.cap === "number" ? opts.cap : SCENE_BLOB_CAP;
  const blobs: Record<string, string> = {}; const leftOut: string[] = []; let used = 0;
  refsIn({ rows: rows, comments: comments }).forEach(function (sha: string) {
    const uri = dataUrl(sha);
    const size = uri ? Math.floor((uri.length - uri.indexOf(",") - 1) * 3 / 4) : 0;
    if (!uri || used + size > cap) { leftOut.push(sha); return; }
    used += size;
    blobs[sha] = uri;
  });

  const payload: SceneWirePayload = {
    format: FORMAT, version: VERSION,
    source: { docId: (state as DocumentView).docId || null, title: (state as DocumentView).title || "" },
    rows: rows, comments: comments, people: people,
    productionTags: productionTags, brollShots: brollShots,
    blobs: blobs, blobsLeftOut: leftOut
  };
  if (opts.cut) payload.cut = String(opts.cut);
  return {
    payload: payload,
    json: JSON.stringify(payload),
    html: scenesTableHtml(rows, payload),
    text: scenesPlainText(rows),
    rows: rows.length,
    leftOut: leftOut
  };
}

const NBSP_RE = new RegExp(String.fromCharCode(160), "g");

function plainOf(html: string | null | undefined) {
  return toPlainText((ports as SceneClipPorts).text.cellOf(html || "")).replace(NBSP_RE, " ");
}

function scenesPlainText(rows: readonly DocumentRow[]) {
  return rows.map(function (r) {
    return "Visual: " + plainOf(r.visualText) + "\nAudio: " + plainOf(r.audioText);
  }).join("\n\n");
}

function escAttr(s: unknown) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function scenesTableHtml(rows: readonly DocumentRow[], payload: SceneWirePayload) {
  let marker = "";
  if (payload) {
    const lean = Object.assign({}, payload, {
      blobs: {},
      blobsLeftOut: Object.keys(payload.blobs || {}).concat(payload.blobsLeftOut || [])
    });
    marker = " " + SCENES_ATTR + '="' + escAttr(JSON.stringify(lean)) + '"';
  }
  const cell = function (html: string | null | undefined) { return clipboardOfCell((ports as SceneClipPorts).text.cellOf(html || "")).html; };
  return '<table border="1" cellpadding="6" style="border-collapse:collapse"' + marker + ">" +
    "<thead><tr><th>Visual</th><th>Audio</th></tr></thead><tbody>" +
    rows.map(function (r) {
      return '<tr><td style="vertical-align:top">' + cell(r.visualText) + '</td><td style="vertical-align:top">' + cell(r.audioText) + "</td></tr>";
    }).join("") +
    "</tbody></table>";
}

function readType(getData: (type: string) => string, type: string) {
  try { return String(getData(type) || ""); } catch (e) { return ""; }
}

export function scenesOnClipboard(getData: (type: string) => string) {
  const json = readType(getData, SCENES_MIME);
  if (json) {
    const clip = parseScenePayload(json);
    if (clip) return clip;
  }
  const html = readType(getData, "text/html");
  if (html.indexOf(SCENES_ATTR) === -1) return null;
  const el = (ports as SceneClipPorts).text.inertBody(html).querySelector("[" + SCENES_ATTR + "]");
  return el ? parseScenePayload(el.getAttribute(SCENES_ATTR)) : null;
}

export function parseScenePayload(json: unknown): ParsedSceneClipboard | null {
  let p: ScenePayloadInput | null;
  try { p = (typeof json === "string" ? JSON.parse(json) : json) as ScenePayloadInput | null; } catch (e) { return null; }
  if (!p || typeof p !== "object" || p.format !== FORMAT || typeof p.version !== "number" || p.version < 1) return null;
  if (!Array.isArray(p.rows) || !p.rows.length) return null;
  const carried: string[] = [];
  const blobs = p.blobs && typeof p.blobs === "object" ? p.blobs as Record<string, unknown> : {};
  Object.keys(blobs).forEach(function (sha) {
    if (!isSha256Hex(sha) || typeof blobs[sha] !== "string") return;
    const rec = (ports as SceneClipPorts).pictures.internDataUrl(blobs[sha]);
    if (rec && rec.sha256 === sha) carried.push(sha);
  });
  if (carried.length) (ports as SceneClipPorts).pictures.queuePersist(carried);
  const list = function (v: unknown) { return Array.isArray(v) ? clone(v as unknown[]) : []; };
  const doc = (ports as SceneClipPorts).migrate({
    schema: SCHEMA_VERSION,
    title: "",
    rows: list(p.rows),
    comments: list(p.comments),
    people: list(p.people),
    productionTags: list(p.productionTags),
    brollShots: list(p.brollShots)
  });
  if (!doc.rows.length) return null;
  const source = p.source && typeof p.source === "object" ? p.source as Record<string, unknown> : {};
  return {
    rows: doc.rows,
    comments: doc.comments,
    people: doc.people,
    productionTags: doc.productionTags,
    brollShots: doc.brollShots,
    cut: typeof p.cut === "string" && /^[A-Za-z0-9]{1,64}$/.test(p.cut) ? p.cut : null,
    source: {
      docId: typeof source.docId === "string" ? source.docId : null,
      title: typeof source.title === "string" ? cappedLongText(source.title, 300) : ""
    },
    carried: carried,
    refs: refsIn(doc)
  };
}

function mintFree(prefix: string, taken: Record<string, boolean>, mint: (prefix: string) => string) {
  let id, guard = 0;
  do { id = mint(prefix); } while (taken[id] && ++guard < 100);
  taken[id] = true;
  return id;
}

function sceneRowIds(clip: SceneClip, state: DocumentView | null, move: boolean, mint: (prefix: string) => string) {
  const rowTaken = Object.create(null) as Record<string, boolean>;
  (state as DocumentView).rows.forEach(function (r) { rowTaken[r.id] = true; });
  const rowMap = Object.create(null) as Record<string, string>;
  clip.rows.forEach(function (r) {
    if (move && !rowTaken[r.id]) { rowTaken[r.id] = true; rowMap[r.id] = r.id; }
    else rowMap[r.id] = mintFree("r", rowTaken, mint);
  });
  return rowMap;
}

type SceneClip = NonNullable<ReturnType<typeof parseScenePayload>>;

export function scenePaste(clip: SceneClip, opts?: ScenePasteOptions) {
  opts = opts || {};
  const mint = opts.mint || (ports as SceneClipPorts).ids.id;
  let planned: { move: boolean; rowMap: Record<string, string>; replaceRowId: string | null } | null = null;
  let result: ReturnType<typeof insertScenes> | null = null;
  return {
    plan: function (doc: Parameters<ScenePaste["plan"]>[0]): ScenePastePlan | null {
      if (!clip || !clip.rows || !clip.rows.length) return null;
      const row = doc.rows.filter(function (r) { return r.id === opts.afterRowId; })[0];
      const move = isMove(clip, doc);
      const rowMap = sceneRowIds(clip, doc, move, mint);
      planned = { move: move, rowMap: rowMap, replaceRowId: row && isBlankScene(doc, row, (ports as SceneClipPorts).text) ? row.id : null };
      return {
        inserted: clip.rows.map(function (r) { return rowMap[r.id] as string; }),
        replaced: (planned as NonNullable<typeof planned>).replaceRowId,
        title: !!opts.title,
        saveNow: true
      };
    },
    apply: function (live: Parameters<ScenePaste["apply"]>[0]) {
      result = insertScenes(clip, {
        state: live,
        rowMap: (planned as NonNullable<typeof planned>).rowMap,
        afterRowId: opts.afterRowId,
        replaceRowId: (planned as NonNullable<typeof planned>).replaceRowId,
        move: (planned as NonNullable<typeof planned>).move,
        mint: mint,
        stamp: opts.stamp
      });
      if (opts.title) live.title = opts.title;
    },
    result: function () { return result; }
  };
}

export function insertScenes(clip: SceneClip, opts?: SceneInsertOptions) {
  opts = opts || {};
  const state = opts.state || (ports as SceneClipPorts).document.current();
  const mint = opts.mint || (ports as SceneClipPorts).ids.id;
  const move = !!opts.move && scenesAway(clip, state);
  const list = function <K extends keyof SceneWireData>(k: K): ValidatedDocument[K] { if (!Array.isArray((state as ValidatedDocument)[k])) (state as ValidatedDocument)[k] = []; return (state as ValidatedDocument)[k]; };

  const rowMap = opts.rowMap || sceneRowIds(clip, state, move, mint);
  const firstRowId = rowMap[(clip.rows[0] as DocumentRow).id];

  const comments = list("comments");
  const cmtTaken = Object.create(null) as Record<string, boolean>;
  comments.forEach(function (c) { if (c) { cmtTaken[c.id] = true; if (c.anchorId) cmtTaken[c.anchorId] = true; } });
  const liveRows = Object.create(null) as Record<string, boolean>;
  (state as ValidatedDocument).rows.forEach(function (r) { liveRows[r.id] = true; });
  const anchorMap = Object.create(null) as Record<string, string>;
  const added: DocumentComment[] = [];
  const rpTaken = Object.create(null) as Record<string, boolean>;
  clip.comments.forEach(function (c) {
    const anchor = c.anchorId || c.id;
    if (move) {
      const here = comments.filter(function (x) { return x && x.id === c.id; })[0];
      if (here) {
        anchorMap[anchor] = here.anchorId || here.id;
        if (!liveRows[here.rowId as string] && rowMap[c.rowId as string]) here.rowId = rowMap[c.rowId as string];
        return;
      }
      if (!cmtTaken[c.id] && !cmtTaken[anchor]) {
        cmtTaken[c.id] = true;
        anchorMap[anchor] = anchor;
        added.push(Object.assign(clone(c), { rowId: rowMap[c.rowId as string] || firstRowId }));
        return;
      }
    }
    const id = mintFree("c", cmtTaken, mint);
    anchorMap[anchor] = id;
    const copy = clone(c);
    copy.id = id;
    copy.anchorId = id;
    copy.rowId = rowMap[c.rowId as string] || firstRowId;
    copy.replies = (copy.replies || []).map(function (rep) {
      return Object.assign(rep, { id: mintFree("rp", rpTaken, mint) });
    });
    added.push(copy);
  });

  const takenKeys = brollIdsTaken(state, null, null, null, move);
  const kept: string[] = []; let minted: string[] = [];
  const mintedByRow = Object.create(null) as Record<string, { cell: Run[]; ids: string[] }>;
  const rows = clip.rows.map(function (r) {
    const row = clone(r);
    row.id = rowMap[r.id] as string;
    ["visualText", "audioText"].forEach(function (f) {
      const cell = (ports as SceneClipPorts).text.fromHtml(row[f] || "").map(function (run) {
        if (!run.marks || !run.marks.cmt) return run;
        const marks = Object.assign({}, run.marks);
        marks.cmt = (marks.cmt as NonNullable<typeof marks.cmt>).map(function (id) { return anchorMap[id]; }).filter(Boolean) as string[];
        return Object.assign({}, run, { marks: marks });
      });
      const fresh = freshBrollIds(normalizeCell(cell), takenKeys, function () { return mint("bs"); });
      fresh.cell.forEach(function (run) {
        if (!run.atom || !run.id) return;
        takenKeys[run.id] = true;
        if (fresh.minted.indexOf(run.id) === -1) kept.push(run.id);
      });
      minted = minted.concat(fresh.minted);
      if (f === "visualText" && fresh.minted.length) mintedByRow[row.id] = { cell: fresh.cell, ids: fresh.minted };
      row[f] = toHtml(fresh.cell);
    });
    if (opts.stamp) opts.stamp(row);
    return row;
  });

  let at = (state as ValidatedDocument).rows.length;
  const replaceAt = opts.replaceRowId ? (state as ValidatedDocument).rows.findIndex(function (r) { return r.id === opts.replaceRowId; }) : -1;
  if (replaceAt !== -1) {
    at = replaceAt;
    (state as ValidatedDocument).rows.splice(replaceAt, 1);
  } else if (opts.afterRowId) {
    const after = (state as ValidatedDocument).rows.findIndex(function (r) { return r.id === opts.afterRowId; });
    if (after !== -1) at = after + 1;
  }
  Array.prototype.splice.apply((state as ValidatedDocument).rows, ([at, 0] as (number | DocumentRow)[]).concat(rows) as [number, number, ...DocumentRow[]]);

  const people = list("people");
  const personMap = Object.create(null) as Record<string, string>;
  const peopleTaken = Object.create(null) as Record<string, boolean>;
  people.forEach(function (p) { peopleTaken[p.id] = true; });
  function ownerFor(id: string | undefined) {
    if (!id) return "";
    if (personMap[id] !== undefined) return personMap[id];
    const theirs = clip.people.filter(function (p) { return p.id === id; })[0];
    if (!theirs) return (personMap[id] = "");
    const norm = normalizeTagName(theirs.name);
    let mine = people.filter(function (p) { return normalizeTagName(p.name) === norm; })[0];
    if (!mine) {
      mine = { id: peopleTaken[theirs.id] ? mintFree("p", peopleTaken, mint) : theirs.id, name: theirs.name };
      peopleTaken[mine.id] = true;
      people.push(mine);
    }
    return (personMap[id] = mine.id);
  }

  const registry = list("productionTags");
  const haveTag = Object.create(null) as Record<string, boolean>;
  registry.forEach(function (t) { haveTag[registryKey((t as NonNullable<typeof t>).cat, (t as NonNullable<typeof t>).name)] = true; });
  clip.productionTags.forEach(function (t) {
    const key = registryKey((t as NonNullable<typeof t>).cat, (t as NonNullable<typeof t>).name);
    if (haveTag[key]) return;
    haveTag[key] = true;
    registry.push({ id: mintTagId((t as NonNullable<typeof t>).cat, (t as NonNullable<typeof t>).name, registry), cat: (t as NonNullable<typeof t>).cat, name: (t as NonNullable<typeof t>).name,
                    owner: ownerFor((t as NonNullable<typeof t>).owner), notes: (t as NonNullable<typeof t>).notes || "", status: (t as NonNullable<typeof t>).status });
  });

  const shots = list("brollShots");
  const haveShot = Object.create(null) as Record<string, boolean>;
  shots.forEach(function (b) { haveShot[b.id] = true; });
  const keptSet = Object.create(null) as Record<string, boolean>;
  kept.forEach(function (id) { keptSet[id] = true; });
  clip.brollShots.forEach(function (b) {
    if (!keptSet[b.id] || haveShot[b.id]) return;
    haveShot[b.id] = true;
    const rec = clone(b);
    rec.owner = ownerFor(b.owner);
    rec.props = normalizeBrollProps((b.props || []).map(function (p) { return { id: "", name: (p as NonNullable<typeof p>).name }; }), registry);
    shots.push(rec);
  });
  Object.keys(mintedByRow).forEach(function (rowId) {
    (ports as SceneClipPorts).recordPastedBroll(state, rowId, (mintedByRow[rowId] as NonNullable<typeof mintedByRow[string]>).cell, (mintedByRow[rowId] as NonNullable<typeof mintedByRow[string]>).ids);
  });

  added.forEach(function (c) { comments.push(c); });
  syncCommentAnchors(state, (ports as SceneClipPorts).text.cellOf);

  return {
    rowIds: rows.map(function (r) { return r.id; }),
    comments: added.length,
    broll: { kept: kept, minted: minted }
  };
}

export function startSceneClip(given: SceneClipPorts) {
  ports = given;
  liveCut = null;
  return { dispose: function () { liveCut = null; } };
}
