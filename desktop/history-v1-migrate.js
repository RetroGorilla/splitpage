"use strict";
/* ---------------------------------------------------------------------
 * desktop/history-v1-migrate.js: the ONE-TIME move of desktop version
 * history from the v1 folder layout to the v2 one (issue #83). TEMPORARY:
 * delete this file (and v1-backup/) in the release after the one that ships
 * it (owner decision #83-3).
 *
 * v1 (desktop/main.js §8b up to #83), under <userData>/history:
 *   FORMAT                      "1"
 *   docs/d-<docId>/index.json   {formatVersion, docId, title, lastOpenedAt,
 *                               bytes, snapshots[]}
 *   docs/d-<docId>/s-<id>.snap  "splitpage-snapshot 1\n" + meta JSON + "\n"
 *                               + the state JSON verbatim
 *   older/index.json            {formatVersion, migratedAt, expiresAt,
 *                               bytes, snapshots[]}
 *   older/s-<id>.snap
 *
 * v2 is desktop/history-fs-backend.js's (read its header): index.json with
 * every bucket in it, bodies content-addressed under bodies/.
 *
 * It runs as the backend's migrate(api) hook — the first job on the history
 * queue, before the index is loaded — and only when FORMAT is missing or
 * ≤ 1 and there is no index.json yet (never when FORMAT ≥ 3: a newer build's
 * folder is not ours to touch). In main (step 3a):
 *
 *   createHistoryFsBackend({dir, fs, fsp, path, crypto,
 *     migrate: (api) => migrateHistoryV1(api, {policy, DOC_ID_RE})})
 *
 * where policy is shared/history-policy.js and DOC_ID_RE shared/doc-id-
 * policy.js's (injected: this file ships in the asar, shared/ does not).
 *
 * THE STEPS, each idempotent, so a kill anywhere is finished by a rerun:
 *   (1) For each docs/d-<id> and older/: read index.json if it parses (for
 *       title, lastOpenedAt, migratedAt, expiresAt — the bucket's fields
 *       only), read every s-*.snap whole, one at a time. The .snap's own
 *       header meta is authoritative (so an orphan .snap that no index
 *       listed is adopted, and an index entry with no .snap is not). Body =
 *       the text after the second newline; sha = SHA-256 of its UTF-8;
 *       bodies.put is put-if-absent. A .snap that is unreadable — no magic,
 *       no header, a header that does not parse, or a body whose length is
 *       not the header's sizeBytes (truncated) — is skipped and stays in the
 *       backup. An Older bucket with no valid expiresAt is re-stamped now +
 *       90 days.
 *   (2) Verify: every entry's body is present with the right size.
 *   (3) Durably write index.json with migratedFrom: 1, and read it back.
 *   (4) Durably write FORMAT "2".
 *   (5) Rename docs/ and older/ into v1-backup/.
 *
 * NOTHING IN v1 IS TOUCHED BEFORE (3) IS DURABLE AND VERIFIED — steps (1)
 * and (2) only read v1 and only write bodies/. A kill during them leaves
 * no index.json, so the rerun starts over (the bodies already written are
 * skipped by size). A kill after (3) or (4) leaves index.json with
 * migratedFrom: 1 beside v1's folders; the rerun sees that and finishes (4)
 * and (5) without re-reading v1. A full disk (ENOSPC) aborts with code
 * 'enospc' and v1 intact: open() fails, the store answers 'enospc', the
 * renderer keeps its entries pending, and the next launch tries again.
 *
 * WHY A MISSING index.json IS FINE. v1's index held only the bucket's own
 * fields; every snapshot's meta is in its .snap header. A broken index
 * costs the title (taken from the newest snapshot that has one) and
 * lastOpenedAt (taken as the newest snapshot's atMs — the best evidence of
 * when the document was last open, where 0 would make it eviction's first
 * victim).
 * ------------------------------------------------------------------- */

const SNAP_MAGIC = "splitpage-snapshot 1";
const SNAP_FILE_RE = /^s-([a-z0-9][a-z0-9_-]{2,63})\.snap$/;
const BACKUP_DIR = "v1-backup";
const V1_DIRS = ["docs", "older"];

const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 20;

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function byAtAscending(a, b) {
  return (a.atMs - b.atMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/* A v1 .snap's text → {meta, body} or null (unreadable). sanitize is the
   policy's sanitizeHistoryMeta. */
function parseV1Snap(text, sanitize) {
  if (typeof text !== "string") return null;
  const nl1 = text.indexOf("\n");
  if (nl1 === -1 || text.slice(0, nl1).trim() !== SNAP_MAGIC) return null;
  const nl2 = text.indexOf("\n", nl1 + 1);
  if (nl2 === -1) return null;
  let parsed;
  try { parsed = JSON.parse(text.slice(nl1 + 1, nl2)); } catch (_) { return null; }
  const meta = sanitize(parsed);
  if (!meta) return null;
  const body = text.slice(nl2 + 1);
  const size = Buffer.byteLength(body, "utf8");
  if (!size) return null;
  /* Truncation. v1 always wrote sizeBytes into the header; a body shorter
     (or longer) than it is not the snapshot that was captured. A header
     without it (never written by a release, but cheap to allow) must at
     least be whole JSON. */
  if (meta.sizeBytes > 0) {
    if (meta.sizeBytes !== size) return null;
  } else {
    try { JSON.parse(body); } catch (_) { return null; }
  }
  return { meta, body };
}

async function migrateHistoryV1(api, opts) {
  const o = opts || {};
  const policy = o.policy;
  const DOC_ID_RE = o.DOC_ID_RE;
  if (!policy || typeof policy.sanitizeHistoryMeta !== "function") throw new TypeError("migrateHistoryV1: policy is required");
  if (!(DOC_ID_RE instanceof RegExp)) throw new TypeError("migrateHistoryV1: DOC_ID_RE is required");
  const { dir, fsp, path, crypto, bodies } = api;
  const now = typeof o.now === "function" ? o.now : api.now;
  /* testHooks: afterBody(k, sha), afterVerify(), afterIndex(), afterFormat(),
     afterMove(name). May be async; a throw is a kill (the run stops there
     and the test reruns on the same folder). */
  const hooks = isPlainObject(o.testHooks) ? o.testHooks : null;
  const hook = async (name, ...args) => {
    if (hooks && typeof hooks[name] === "function") await hooks[name](...args);
  };
  const OLDER = policy.HISTORY_OLDER_KEY;
  const TTL = policy.HISTORY_OLDER_TTL_MS;
  const sanitize = policy.sanitizeHistoryMeta;
  const clip = (v, n) => String(v == null ? "" : v).slice(0, n);

  async function isDir(p) {
    try { return (await fsp.stat(p)).isDirectory(); } catch (_) { return false; }
  }

  async function renameRetry(from, to) {
    for (let attempt = 1; ; attempt++) {
      try {
        await fsp.rename(from, to);
        return;
      } catch (err) {
        if (attempt >= RENAME_ATTEMPTS || !err || !RENAME_RETRY_CODES.has(err.code)) throw err;
        await new Promise((r) => setTimeout(r, RENAME_RETRY_MS));
      }
    }
  }

  async function v1Present() {
    for (const d of V1_DIRS) if (await isDir(path.join(dir, d))) return true;
    return false;
  }

  /* (5) — also what a rerun after (3)/(4) finishes with. */
  async function moveToBackup() {
    const backup = path.join(dir, BACKUP_DIR);
    const moved = [];
    for (const name of V1_DIRS) {
      const src = path.join(dir, name);
      if (!(await isDir(src))) continue;
      await fsp.mkdir(backup, { recursive: true });
      let dest = path.join(backup, name);
      for (let n = 1; await isDir(dest); n++) dest = path.join(backup, `${name}-${n}`);
      await renameRetry(src, dest);
      moved.push(name);
      await hook("afterMove", name);
    }
    return moved;
  }

  const fmtText = await api.readFormat();
  const fmt = fmtText == null ? null : parseInt(fmtText, 10);
  /* v1 read a FORMAT it could not parse as its own; so does this. */
  const fmtOld = fmt == null || !Number.isFinite(fmt) || fmt <= 1;
  if (Number.isFinite(fmt) && fmt >= 3) return { state: "newer" };

  const existing = await api.readIndex();
  if (!fmtOld) {
    /* FORMAT 2: a migration finished everything but (5). */
    if (existing && existing.migratedFrom === 1 && await v1Present()) {
      api.setMigrating(true);
      try { return { state: "finished", moved: await moveToBackup() }; } finally { api.setMigrating(false); }
    }
    return { state: "none" };
  }

  if (existing) {
    if (existing.migratedFrom !== 1) return { state: "none" };
    /* A kill after (3) or (4): the index is durable and was verified
       before it was written. Finish. */
    api.setMigrating(true);
    try {
      await api.writeFormat("2");
      await hook("afterFormat");
      return { state: "finished", moved: await moveToBackup() };
    } finally {
      api.setMigrating(false);
    }
  }

  if (!(await v1Present())) return { state: "none" };

  api.setMigrating(true);
  try {
    /* A torn index.json from a killed step (3) is moved aside, not
       rotated into index.prev.json by the write below. */
    if (await api.indexExists()) await api.moveIndexAside();

    /* ---- (1) read v1, write bodies ---- */
    const buckets = {};
    const skipped = [];
    let putCount = 0;
    const t = now();

    async function readBucket(bucket, folder, rel) {
      let v1Index = null;
      try {
        const raw = JSON.parse(await fsp.readFile(path.join(folder, "index.json"), "utf8"));
        if (isPlainObject(raw)) v1Index = raw;
      } catch (_) { /* missing or broken: the .snap headers carry the metas */ }
      let names;
      try { names = await fsp.readdir(folder); } catch (_) { return; }
      names = names.filter((n) => SNAP_FILE_RE.test(n)).sort();
      const entries = [];
      const seen = new Set();
      for (const name of names) {
        let text;
        try {
          text = await fsp.readFile(path.join(folder, name), "utf8");
        } catch (_) {
          skipped.push(rel + "/" + name);
          continue;
        }
        const snap = parseV1Snap(text, sanitize);
        if (!snap || seen.has(snap.meta.id)) {
          skipped.push(rel + "/" + name);
          continue;
        }
        const buf = Buffer.from(snap.body, "utf8");
        const sha = crypto.createHash("sha256").update(buf).digest("hex");
        const r = await bodies.put(sha, buf);
        if (!r.ok) {
          if (r.code === "TOO_LARGE") { skipped.push(rel + "/" + name); continue; }
          const code = r.code === "ENOSPC" || r.code === "EDQUOT" ? "enospc" : "io";
          throw codedError(code, `history v1 migration: body write failed (${r.code})`);
        }
        putCount++;
        await hook("afterBody", putCount, sha);
        const entry = sanitize(snap.meta);
        entry.sizeBytes = buf.length;
        entry.sha = sha;
        entries.push(entry);
        seen.add(entry.id);
      }
      if (!entries.length) return;
      entries.sort(byAtAscending);
      const newest = entries[entries.length - 1];
      if (bucket === OLDER) {
        const migratedAt = Number(v1Index && v1Index.migratedAt);
        const expiresAt = Number(v1Index && v1Index.expiresAt);
        const stamped = Number.isFinite(expiresAt) && expiresAt > 0;
        buckets[bucket] = {
          title: "",
          lastOpenedAt: 0,
          migratedAt: Number.isFinite(migratedAt) && migratedAt > 0 ? migratedAt : t,
          /* An unstamped Older bucket would never expire (the planner sweeps
             only expiresAt > 0): its 90 days start now. */
          expiresAt: stamped ? expiresAt : t + TTL,
          snapshots: entries
        };
      } else {
        let title = clip(v1Index && v1Index.title, 300);
        if (!title) {
          for (let i = entries.length - 1; i >= 0 && !title; i--) title = entries[i].title || "";
        }
        const opened = Number(v1Index && v1Index.lastOpenedAt);
        buckets[bucket] = {
          title,
          lastOpenedAt: Number.isFinite(opened) && opened > 0 ? opened : newest.atMs,
          snapshots: entries
        };
      }
    }

    let docNames = [];
    try { docNames = await fsp.readdir(path.join(dir, "docs")); } catch (_) { /* no docs/ */ }
    for (const name of docNames.sort()) {
      if (!name.startsWith("d-")) continue;
      const docId = name.slice(2);
      if (!DOC_ID_RE.test(docId)) continue;
      const folder = path.join(dir, "docs", name);
      if (await isDir(folder)) await readBucket(docId, folder, "docs/" + name);
    }
    const olderDir = path.join(dir, "older");
    if (await isDir(olderDir)) await readBucket(OLDER, olderDir, "older");

    /* ---- (2) verify ---- */
    let snapshots = 0;
    for (const b of Object.keys(buckets)) {
      for (const e of buckets[b].snapshots) {
        let size = -1;
        try { size = (await fsp.stat(bodies.pathFor(e.sha))).size; } catch (_) { /* missing */ }
        if (size !== e.sizeBytes) {
          throw codedError("io", `history v1 migration: body ${e.sha} missing or the wrong size after its write`);
        }
        snapshots++;
      }
    }
    await hook("afterVerify");

    /* ---- (3) the index, durably, read back ---- */
    const doc = { formatVersion: 2, buckets, trash: [], migratedFrom: 1 };
    await api.writeIndex(doc);
    const back = await api.readIndex();
    if (!back || JSON.stringify(back.buckets) !== JSON.stringify(buckets) || back.migratedFrom !== 1) {
      throw codedError("io", "history v1 migration: index.json did not read back as written");
    }
    await hook("afterIndex");

    /* ---- (4) FORMAT ---- */
    await api.writeFormat("2");
    await hook("afterFormat");

    /* ---- (5) v1 into the backup ---- */
    const moved = await moveToBackup();
    return {
      state: "migrated",
      buckets: Object.keys(buckets).length,
      snapshots,
      bodiesPut: putCount,
      skipped,
      moved
    };
  } finally {
    api.setMigrating(false);
  }
}

module.exports = {
  migrateHistoryV1,
  parseV1Snap,
  SNAP_MAGIC,
  SNAP_FILE_RE,
  BACKUP_DIR
};
