"use strict";

const crypto = require("node:crypto");

const LINK_ROLES = ["edit", "review"];
const LINK_ID_RE = /^[0-9a-f]{12}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const LINK_TOMBSTONE_MAX = 2000;

function sha256Of(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function isLinkId(id) {
  return LINK_ID_RE.test(id);
}

function linkAnswer(rec) {
  return { id: rec.id, role: rec.role, key: rec.key, createdAt: rec.createdAt };
}

function cleanTombstone(t) {
  if (!t || typeof t !== "object") return null;
  if (!HASH_RE.test(String(t.keyHash)) || !HASH_RE.test(String(t.tokenHash))) return null;
  return {
    id: String(t.id || ""), keyHash: t.keyHash, tokenHash: t.tokenHash,
    docId: String(t.docId || ""), role: String(t.role || ""),
    revokedAt: typeof t.revokedAt === "string" ? t.revokedAt : null
  };
}

function createLinkStore(deps) {
  const isValidId = deps.isValidId;
  const persist = deps.persist || null;

  const linksById = new Map();
  const linkByKey = new Map();
  const linkByToken = new Map();
  const linkByDocRole = new Map();
  const linkTombstones = [];
  const tombKeyHashes = new Set();
  const tombTokenHashes = new Set();
  let linksWriting = Promise.resolve();

  function docRoleKey(docId, role) {
    return docId + "/" + role;
  }

  function indexLink(rec) {
    linksById.set(rec.id, rec);
    linkByKey.set(rec.key, rec);
    linkByToken.set(rec.token, rec);
    linkByDocRole.set(docRoleKey(rec.docId, rec.role), rec);
  }

  function unindexLink(rec) {
    linksById.delete(rec.id);
    linkByKey.delete(rec.key);
    linkByToken.delete(rec.token);
    const slot = docRoleKey(rec.docId, rec.role);
    if (linkByDocRole.get(slot) === rec) linkByDocRole.delete(slot);
  }

  function addTombstone(tomb) {
    linkTombstones.push(tomb);
    tombKeyHashes.add(tomb.keyHash);
    tombTokenHashes.add(tomb.tokenHash);
    while (linkTombstones.length > LINK_TOMBSTONE_MAX) {
      const oldest = linkTombstones.shift();
      tombKeyHashes.delete(oldest.keyHash);
      tombTokenHashes.delete(oldest.tokenHash);
    }
  }

  function activeLink(docId, role) {
    return linkByDocRole.get(docRoleKey(docId, role)) || null;
  }

  function mintLink(docId, role, createdBy) {
    let id;
    do { id = crypto.randomBytes(6).toString("hex"); } while (linksById.has(id));
    const rec = {
      id,
      key: crypto.randomBytes(24).toString("hex"),
      token: crypto.randomBytes(32).toString("hex"),
      docId,
      role,
      createdAt: new Date().toISOString(),
      createdBy: createdBy || null
    };
    indexLink(rec);
    return rec;
  }

  function revokeLink(rec) {
    unindexLink(rec);
    addTombstone({
      id: rec.id,
      keyHash: sha256Of(rec.key),
      tokenHash: sha256Of(rec.token),
      docId: rec.docId,
      role: rec.role,
      revokedAt: new Date().toISOString()
    });
  }

  function serialize() {
    return JSON.stringify({
      version: 1,
      links: Array.from(linksById.values()),
      revoked: linkTombstones
    }, null, 2) + "\n";
  }

  function saveLinks() {
    if (!persist) return Promise.resolve();
    const write = () => persist(serialize());
    const next = linksWriting.then(write, write);
    linksWriting = next.catch(() => {});
    return next;
  }

  async function linkFor(docId, role, opts) {
    const existing = activeLink(docId, role);
    if (existing && !(opts && opts.replace)) return { link: existing, created: false };
    if (existing) revokeLink(existing);
    const rec = mintLink(docId, role, opts && opts.by);
    try {
      await saveLinks();
    } catch (err) {
      unindexLink(rec);
      throw err;
    }
    return { link: rec, created: true };
  }

  function revokeLinksOf(docId) {
    let n = 0;
    for (const role of LINK_ROLES) {
      const rec = activeLink(docId, role);
      if (rec) { revokeLink(rec); n++; }
    }
    return n;
  }

  function cleanLinkRecord(r) {
    if (!r || typeof r !== "object") return null;
    if (!LINK_ID_RE.test(String(r.id)) || !isValidId(r.docId) || LINK_ROLES.indexOf(r.role) === -1) return null;
    if (typeof r.key !== "string" || !/^[0-9a-f]{48,128}$/.test(r.key)) return null;
    if (typeof r.token !== "string" || !/^[0-9a-f]{64}$/.test(r.token)) return null;
    return {
      id: r.id, key: r.key, token: r.token, docId: r.docId, role: r.role,
      createdAt: typeof r.createdAt === "string" ? r.createdAt : null,
      createdBy: typeof r.createdBy === "string" ? r.createdBy : null
    };
  }

  function restore(data) {
    let skipped = 0;
    for (const t of (data && Array.isArray(data.revoked)) ? data.revoked : []) {
      const tomb = cleanTombstone(t);
      if (tomb) addTombstone(tomb); else skipped++;
    }
    for (const r of (data && Array.isArray(data.links)) ? data.links : []) {
      const rec = cleanLinkRecord(r);
      if (!rec || linksById.has(rec.id) || linkByKey.has(rec.key) || linkByToken.has(rec.token) ||
          activeLink(rec.docId, rec.role) || tombKeyHashes.has(sha256Of(rec.key))) {
        skipped++;
        continue;
      }
      indexLink(rec);
    }
    return skipped;
  }

  return {
    activeLink,
    linkFor,
    revokeLink,
    revokeLinksOf,
    saveLinks,
    restore,
    serialize,
    byId: (id) => linksById.get(id),
    byKey: (key) => linkByKey.get(key),
    byToken: (token) => linkByToken.get(token),
    keyRevoked: (key) => tombKeyHashes.has(sha256Of(key)),
    tokenRevoked: (token) => tombTokenHashes.size > 0 && tombTokenHashes.has(sha256Of(token))
  };
}

module.exports = {
  LINK_ROLES,
  LINK_TOMBSTONE_MAX,
  isLinkId,
  linkAnswer,
  createLinkStore
};
