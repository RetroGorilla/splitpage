"use strict";

type HistoryPolicyFields = Record<string, unknown>;
export type SharedHistoryMeta = {
  id: string; label: string; at: string; atMs: number; by: string; rows: number;
  title: string; sizeBytes: number; kind: "legacy" | "snapshot"; formatVersion: 1; legacyId?: string;
};
type HistoryPolicyStamp = Pick<SharedHistoryMeta, "atMs">;
type HistoryPolicyMutableStamp<T extends HistoryPolicyStamp> = { atMs: T["atMs"] };
type HistoryPolicySame<X, Y> = (<K>() => [K extends X ? 1 : 2, K]) extends
  (<K>() => [K extends Y ? 1 : 2, K]) ? true : false;
type HistoryPolicyWritableStamp<T extends HistoryPolicyStamp> =
  HistoryPolicySame<Pick<T, "atMs">, HistoryPolicyMutableStamp<T>> extends true ? unknown : never;
type HistoryEvictionSnapshot = { id: string; atMs: number; size: number };
type HistoryEvictionEntry = { docId: string; lastOpenedAt: number; expiresAt: number; snaps: HistoryEvictionSnapshot[] };
type HistoryEvictionOptions = { perDoc?: unknown; olderKey?: unknown; protect?: unknown };

const HISTORY_PER_DOC = 50;
const HISTORY_OLDER_KEY = "_older";
const HISTORY_SNAP_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const HISTORY_OLDER_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function historyClip(v: unknown, n: number) {
  return String(v == null ? "" : v).slice(0, n);
}

function historyUtf8Length(str: string) {
  let n = 0, c: number, i: number;
  for (i = 0; i < str.length; i++) {
    c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length &&
             str.charCodeAt(i + 1) >= 0xdc00 && str.charCodeAt(i + 1) <= 0xdfff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

function historyOlderExpired(rec: unknown, nowMs: unknown): boolean {
  if (!rec || (rec as HistoryPolicyFields).expiresAt == null) return false;
  const expiresAt = Number((rec as HistoryPolicyFields).expiresAt);
  if (!isFinite(expiresAt) || expiresAt <= 0) return false;
  const now = Number(nowMs);
  return isFinite(now) && now >= expiresAt;
}

function sanitizeHistoryMeta(m: unknown): SharedHistoryMeta | null {
  if (!m || typeof m !== "object") return null;
  const id = typeof (m as HistoryPolicyFields).id === "string" ? (m as HistoryPolicyFields).id as string : "";
  if (!HISTORY_SNAP_ID_RE.test(id)) return null;
  let atMs = Number((m as HistoryPolicyFields).atMs);
  if (!Number.isFinite(atMs)) atMs = Date.parse((m as HistoryPolicyFields).at as string) || 0;
  const out: SharedHistoryMeta = {
    id: id,
    label: historyClip((m as HistoryPolicyFields).label, 300),
    at: typeof (m as HistoryPolicyFields).at === "string" && (m as HistoryPolicyFields).at ? historyClip((m as HistoryPolicyFields).at, 40) : new Date(atMs).toISOString(),
    atMs: atMs,
    by: historyClip((m as HistoryPolicyFields).by, 100),
    rows: Math.max(0, Math.floor(Number((m as HistoryPolicyFields).rows) || 0)),
    title: historyClip((m as HistoryPolicyFields).title, 300),
    sizeBytes: Math.max(0, Math.floor(Number((m as HistoryPolicyFields).sizeBytes) || 0)),
    kind: (m as HistoryPolicyFields).kind === "legacy" ? "legacy" : "snapshot",
    formatVersion: 1
  };
  if ((m as HistoryPolicyFields).legacyId != null) out.legacyId = historyClip((m as HistoryPolicyFields).legacyId, 100);
  return out;
}

function historyStampAfter<T extends HistoryPolicyStamp>(m: T & HistoryPolicyWritableStamp<T>, newestAtMs: unknown): T {
  const n = Number(newestAtMs);
  if (newestAtMs != null && Number.isFinite(n) && !(m.atMs > n)) m.atMs = n + 1;
  return m;
}

function planHistoryEviction(docs: unknown, capBytes: unknown, nowMs: unknown, opts?: HistoryEvictionOptions | null) {
  opts = opts || {};
  const perDoc = Number(opts.perDoc) > 0 ? Math.floor(Number(opts.perDoc)) : HISTORY_PER_DOC;
  const olderKey = typeof opts.olderKey === "string" ? opts.olderKey : HISTORY_OLDER_KEY;
  const cap = (typeof capBytes === "number" && capBytes >= 0) ? capBytes : Infinity;
  const now = (typeof nowMs === "number" && isFinite(nowMs)) ? nowMs : 0;
  const protect: Record<string, true | undefined> = Object.create(null);
  (Array.isArray(opts.protect) ? opts.protect as unknown[] : []).forEach(function (p) {
    if (p && typeof (p as HistoryPolicyFields).docId === "string" && typeof (p as HistoryPolicyFields).id === "string") protect[(p as HistoryPolicyFields).docId + "\n" + (p as HistoryPolicyFields).id] = true;
  });
  function toMs(v: unknown) {
    if (typeof v === "number") return isFinite(v) ? v : 0;
    if (typeof v === "string" && v) { const p = Date.parse(v); return isFinite(p) ? p : 0; }
    return 0;
  }
  const list: HistoryEvictionEntry[] = [];
  let older: HistoryEvictionEntry | null = null, total = 0;
  const deletes: { docId: string; id: string }[] = [];
  (Array.isArray(docs) ? docs as unknown[] : []).forEach(function (d) {
    if (!d || typeof (d as HistoryPolicyFields).docId !== "string") return;
    const snaps: HistoryEvictionSnapshot[] = [];
    (Array.isArray((d as HistoryPolicyFields).snapshots) ? (d as HistoryPolicyFields).snapshots as unknown[] : []).forEach(function (s) {
      if (!s || typeof (s as HistoryPolicyFields).id !== "string") return;
      const size = Number((s as HistoryPolicyFields).sizeBytes);
      snaps.push({ id: (s as HistoryPolicyFields).id as string, atMs: toMs((s as HistoryPolicyFields).atMs), size: isFinite(size) && size > 0 ? size : 0 });
    });
    snaps.sort(function (a, b) { return (a.atMs - b.atMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    snaps.forEach(function (s) { total += s.size; });
    const entry = { docId: (d as HistoryPolicyFields).docId as string, lastOpenedAt: toMs((d as HistoryPolicyFields).lastOpenedAt), expiresAt: toMs((d as HistoryPolicyFields).expiresAt), snaps: snaps };
    if ((d as HistoryPolicyFields).docId === olderKey) older = entry; else list.push(entry);
  });
  const totalBefore = total;
  function dropOldest(entry: HistoryEvictionEntry, keepNewest: boolean) {
    const end = keepNewest ? entry.snaps.length - 1 : entry.snaps.length;
    for (let j = 0; j < end; j++) {
      const s = entry.snaps[j] as HistoryEvictionSnapshot;
      if (protect[entry.docId + "\n" + s.id]) continue;
      entry.snaps.splice(j, 1);
      total -= s.size;
      deletes.push({ docId: entry.docId, id: s.id });
      return true;
    }
    return false;
  }
  if (older && historyOlderExpired(older, now)) {
    while (dropOldest(older, false)) { /* condition does the work */ }
  }
  list.forEach(function (e) {
    while (e.snaps.length > perDoc && dropOldest(e, true)) { /* condition does the work */ }
  });
  if (older) {
    while (total > cap && dropOldest(older, false)) { /* condition does the work */ }
  }
  list.sort(function (a, b) {
    return (a.lastOpenedAt - b.lastOpenedAt) || (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0);
  });
  for (let i = 0; i < list.length && total > cap; i++) {
    while (total > cap && dropOldest(list[i] as HistoryEvictionEntry, true)) { /* condition does the work */ }
  }
  return { deletes: deletes, totalBefore: totalBefore, totalAfter: total, overCap: total > cap };
}

export {
  HISTORY_OLDER_KEY,
  HISTORY_OLDER_TTL_MS,
  HISTORY_PER_DOC,
  HISTORY_SNAP_ID_RE,
  historyClip,
  historyOlderExpired,
  historyStampAfter,
  historyUtf8Length,
  planHistoryEviction,
  sanitizeHistoryMeta
};
