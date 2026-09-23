/* Where the document on screen lives: ONE tagged record (#73).
 *
 * It used to be three globals — S.docFileHandle (the project file),
 * S.openedFile (a foreign file opened for round-trip export) and
 * S.serverDoc (the hosted document) — which were meant to be mutually
 * exclusive and were kept that way by hand: every path that gave the
 * document a new home had to remember to zero the other two, and several
 * did not (a Save As from a hosted document left a project file set
 * underneath it; publishing an imported .docx left the import set). Two
 * homes half-set at once is the bug this record makes impossible: there is
 * one `home`, and `setHome()` replaces it whole.
 *
 * The kinds, and what each one carries:
 *
 *   "none"    — nowhere yet: the seed, a blank document, a recovered copy.
 *               No fields.
 *
 *   "file"    — a Splitpage project file: what Save and autosave write to.
 *     handle        a File System Access handle, or a desktop handle from
 *                   makeDesktopHandle() (20f-desktop.js, `_desktopId` on
 *                   it); null for a plain <input type=file> open, where
 *                   Save has to ask where to write (14-export.js).
 *     format        "md" | "splitpage" | "html" — which serializer runs.
 *                   "html" only ever arrives by OPENING a legacy file.
 *     name          the file's name, for when there is no handle to ask
 *                   (docHomeKey, 02b-doc-id.js).
 *     lastModified  the file's timestamp as of our last read or write —
 *                   the on-disk conflict guard (checkFileConflict).
 *     diskBase      the document exactly as this file last said it was,
 *                   the ancestor "Merge them" needs (18a-local-merge.js).
 *                   On the record so it goes the moment the home changes.
 *
 *   "import"  — a foreign .docx/.csv/.md/.txt opened as a new document.
 *               Save does NOT write here (it asks for a project file); the
 *               file chip and File ▸ "Save to <name>" (saveBackToFile) do.
 *     handle        as above; null when the file arrived without one.
 *     format        "docx" | "csv" | "md" | "txt" — buildFileData's kind.
 *     name, lastModified, size   the file as it was opened or last saved.
 *     inPlace       whether saveBackToFile can write back in place.
 *     dirty         edited since it was opened or last written back.
 *
 *   "server"  — a document on a Splitpage server.
 *     id            the server's document id. Always set.
 *     rev           the DOCUMENT's compare-and-set rev: sent as `baseRev`
 *                   on every PUT, compared by the pull channel (#69).
 *     conn          the connection it was opened through (below): which
 *                   server, the token that proves this tab there, the role
 *                   the server gave that token, and the SSH tunnel it rides
 *                   on if any. Always set, and always THIS tab's `conn` —
 *                   the SAME object, so a PIN typed again or a role that
 *                   arrives late is seen by the home without a second copy
 *                   (#11). Everything that talks to the server for this
 *                   document (autosave, the presence heartbeat that is also
 *                   the pull channel, the review-role chip) reads it here.
 *
 * The record is mutated in place for the facts that move while the home
 * stays the same (a server rev, a file's timestamp after a write), and
 * replaced through setHome() whenever the home itself changes. `home` is an
 * ES live binding: every importer sees the current record, and none of
 * them can assign it — the build refuses `home = …` outside this file, so
 * setHome() is the only way to move a document.
 *
 * This module is a leaf: no imports, nothing at evaluation time but the
 * literal below, so anything importing it stays importable without a page
 * and without any module's __init() having run (#92).
 *
 * THE CONNECTION (#11). Which server this tab talks to used to be three
 * more loose globals in 13-hosted.js — serverBase, serverToken and
 * S.serverRole — and the base and a remembered token were written to
 * localStorage, which every tab of an origin shares: pointing one tab at
 * another server re-pointed the next tab to load, and a token remembered for
 * one server was sent to whichever server was current. Each tab is its own
 * page (desktop invariant #42; a browser tab likewise), so the connection is
 * this page's own record, `conn`:
 *
 *     serverUrl     "" for the server that served this page (same origin —
 *                   on desktop, this app's own document server behind
 *                   splitpage://app/api), else a normalized http(s) base
 *                   ending in exactly one "/".
 *     token         the join/review token this tab carries there, or "".
 *                   Never on disk unless the reader ticked "Remember on
 *                   this device", and then only in this origin's own
 *                   storage, keyed by serverUrl (13-hosted.js). Never in
 *                   the document, a draft header or desktop-state.json
 *                   (invariant #29).
 *     role          "edit" | "review" | "" — what the SERVER said this
 *                   token is (/api/me). Never stored, never inferred.
 *     tunnel        null, or {userHost, remotePort, localPort} when the
 *                   server is reached through an SSH forward the reader
 *                   runs themselves (the Servers dialog's SSH bookmark).
 *                   Host and ports only — never a key or a passphrase.
 *
 * setConnection() replaces it whole and refuses to while a server home is
 * holding the old one — a document on one server must never be saved
 * through another; leave the home first. updateConnection() changes the
 * token or the role IN PLACE, for the same server. Both validate every field
 * and throw on an unknown one, exactly as setHome() does.
 *
 * What is NOT here, deliberately: `docIdWrittenOut` (whether this document's
 * id has left the page — a fact about the document, true across a Save As
 * copy that leaves the home alone and set by a stash merge that changes no
 * home at all) and `baseState` (the merge ancestor; #96 and applyMerge,
 * 03-sync.js). Both stay on S.
 */

var FIELDS = {
  none: {},
  file: { handle: null, format: null, name: null, lastModified: null, diskBase: null },
  import: { handle: null, format: null, name: null, lastModified: null, size: null,
            inPlace: false, dirty: false },
  server: { id: null, rev: 0, conn: null }
};

/* Which fields must be present for the record to mean anything. A server
   home with no id, or a file home with no format, is a state the old
   globals could drift into (`{id: null}` meant "not on the server") — here
   it is "none", and asking for it by another name is a bug. */
var REQUIRED = { none: [], file: ["format"], import: ["name"], server: ["id", "conn"] };

export var HOME_KINDS = Object.keys(FIELDS);

export var home = { kind: "none" };

/* ---- the connection ---- */

var CONN_FIELDS = { serverUrl: "", token: "", role: "", tunnel: null };
var CONN_ROLES = ["", "edit", "review"];
var TUNNEL_FIELDS = ["userHost", "remotePort", "localPort"];

/* Always ends in a single slash so a path can just be concatenated, and
   always carries a scheme so a typed "192.168.1.20:8791" is not resolved as
   a relative path. "" stays "" — the same-origin server. */
export function normalizeServerUrl(input) {
  var url = String(input || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = "http://" + url;
  return url.replace(/\/+$/, "") + "/";
}

function validPort(n) { return typeof n === "number" && n % 1 === 0 && n >= 1 && n <= 65535; }

function checkTunnel(t) {
  if (t === null) return null;
  if (!t || typeof t !== "object") throw new Error("setConnection: a tunnel is null or {userHost, remotePort, localPort}");
  Object.keys(t).forEach(function (k) {
    if (TUNNEL_FIELDS.indexOf(k) === -1) throw new Error("setConnection: a tunnel has no field " + JSON.stringify(k));
  });
  /* The characters an ssh login is made of and nothing else: no space, no
     quote, nothing a shell or an option parser would read as more. */
  if (typeof t.userHost !== "string" || !/^[A-Za-z0-9._@:[\]-]{1,255}$/.test(t.userHost) || t.userHost[0] === "-") {
    throw new Error("setConnection: a tunnel needs a userHost");
  }
  if (!validPort(t.remotePort) || !validPort(t.localPort)) throw new Error("setConnection: a tunnel's ports are 1-65535");
  return { userHost: t.userHost, remotePort: t.remotePort, localPort: t.localPort };
}

/* Validates `fields` against the connection's shape; `base` supplies any
   field not given. Throws on an unknown field, a URL that is not the
   normalized form, a role the server never hands out, or a tunnel that is
   not host-and-ports. */
function buildConn(fields, base) {
  fields = fields || {};
  Object.keys(fields).forEach(function (k) {
    if (!Object.prototype.hasOwnProperty.call(CONN_FIELDS, k)) {
      throw new Error("setConnection: a connection has no field " + JSON.stringify(k));
    }
  });
  var rec = {};
  Object.keys(CONN_FIELDS).forEach(function (k) {
    rec[k] = fields[k] === undefined ? base[k] : fields[k];
  });
  if (typeof rec.serverUrl !== "string" || rec.serverUrl !== normalizeServerUrl(rec.serverUrl)) {
    throw new Error("setConnection: serverUrl " + JSON.stringify(rec.serverUrl) +
                    " is not a normalized base — pass it through normalizeServerUrl()");
  }
  if (typeof rec.token !== "string") throw new Error("setConnection: a token is a string");
  if (CONN_ROLES.indexOf(rec.role) === -1) throw new Error("setConnection: unknown role " + JSON.stringify(rec.role));
  rec.tunnel = checkTunnel(rec.tunnel);
  return rec;
}

/* This tab's connection. A live binding like `home`: only this file can
   assign it. */
export var conn = buildConn({}, CONN_FIELDS);

/* Point this tab at a server — a whole new record, every field not given
   back at its default. Refused while a server home holds the current one:
   the document would otherwise go on saving through a connection that is
   not the one it was opened through. */
export function setConnection(fields) {
  if (home.kind === "server") {
    throw new Error("setConnection: this tab has a server document open — leave it (setHome) " +
                    "before pointing the tab somewhere else, or use updateConnection()");
  }
  conn = buildConn(fields, CONN_FIELDS);
  return conn;
}

/* The same server, a fact about it moved: a token after a PIN, the role
   /api/me answered, a token cleared because the server stopped taking it.
   Mutated in place so a server home holding this record sees it. The
   server itself is not a fact that moves — that is setConnection(). */
export function updateConnection(fields) {
  fields = fields || {};
  if (fields.serverUrl !== undefined && fields.serverUrl !== conn.serverUrl) {
    throw new Error("updateConnection: the server is not a field that moves — use setConnection()");
  }
  if (fields.tunnel !== undefined) {
    throw new Error("updateConnection: the tunnel belongs to the server — use setConnection()");
  }
  var next = buildConn(fields, conn);
  conn.token = next.token;
  conn.role = next.role;
  return conn;
}

function buildHome(kind, fields) {
  var shape = FIELDS[kind];
  if (!shape) throw new Error("setHome: unknown kind " + JSON.stringify(kind));
  fields = fields || {};
  /* `kind` is the tag. The old docFileHandle used it for the file's format,
     so a `kind` that disagrees with the tag is that mistake, not a field. */
  if (fields.kind !== undefined && fields.kind !== kind) {
    throw new Error("setHome: kind " + JSON.stringify(fields.kind) + " given for a " + kind +
                    " home — a file's format is `format`");
  }
  Object.keys(fields).forEach(function (k) {
    if (k !== "kind" && !Object.prototype.hasOwnProperty.call(shape, k)) {
      throw new Error("setHome: a " + kind + " home has no field " + JSON.stringify(k));
    }
  });
  var rec = { kind: kind };
  Object.keys(shape).forEach(function (k) {
    rec[k] = fields[k] === undefined ? shape[k] : fields[k];
  });
  REQUIRED[kind].forEach(function (k) {
    if (rec[k] === null || rec[k] === undefined || rec[k] === "") {
      throw new Error("setHome: a " + kind + " home needs " + JSON.stringify(k));
    }
  });
  return rec;
}

/* The one way the document changes home. Builds a fresh record holding
   exactly the fields `kind` carries (anything else throws — a stale field
   name from the old globals is caught here, not read back as undefined
   later), puts it in place of whatever home there was, and returns it, so a
   caller that awaits can later ask "is this still the home I set?" by
   identity. */
export function setHome(kind, fields) {
  var rec = buildHome(kind, kind === "server" ? withConn(fields) : fields);
  home = rec;
  return home;
}

/* A server home is opened through THIS tab's connection and no other: one
   not given is this one, and any other one is refused. */
function withConn(fields) {
  fields = fields || {};
  if (fields.conn !== undefined && fields.conn !== conn) {
    throw new Error("setHome: a server home's conn is this tab's connection — " +
                    "setConnection() first, then open the document");
  }
  var out = {};
  Object.keys(fields).forEach(function (k) { out[k] = fields[k]; });
  out.conn = conn;
  return out;
}

/* The server home's connection, or null when the document is not on a
   server. */
export function homeConn() {
  return home.kind === "server" ? home.conn : null;
}

/* Put back a record setHome() returned earlier — the SAME object, not a
   copy, because a caller that is still holding it (a conflict modal's merge
   candidate, a save waiting on a write) compares by identity. Only saveDoc's
   undoRetarget needs this: a fresh pick that never got written is not a
   home, and the one before it still is. */
export function restoreHome(record) {
  if (!record || !FIELDS[record.kind]) throw new Error("restoreHome: not a home record");
  if (record.kind === "server" && record.conn !== conn) {
    throw new Error("restoreHome: that server home belongs to a connection this tab no longer has");
  }
  home = record;
  return home;
}

/* The hosted document's id, or null when the document does not live on a
   server. Every "is this still that server document?" check reads this,
   so against a home of another kind it compares a plain null, never
   `undefined`. */
export function serverHomeId() {
  return home.kind === "server" ? home.id : null;
}

/* The project-file record when the document lives in one, else null. The
   import home has a `handle` too, and nothing that means "the file Save
   writes to" may pick that one up by accident. */
export function fileHome() {
  return home.kind === "file" ? home : null;
}

/* The foreign-file record when the document was opened from one, else
   null. */
export function importHome() {
  return home.kind === "import" ? home : null;
}
