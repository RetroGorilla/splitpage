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
 *   "server"  — a document on the connected Splitpage server.
 *     id            the server's document id. Always set.
 *     rev           the DOCUMENT's compare-and-set rev: sent as `baseRev`
 *                   on every PUT, compared by the pull channel (#69).
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
  server: { id: null, rev: 0 }
};

/* Which fields must be present for the record to mean anything. A server
   home with no id, or a file home with no format, is a state the old
   globals could drift into (`{id: null}` meant "not on the server") — here
   it is "none", and asking for it by another name is a bug. */
var REQUIRED = { none: [], file: ["format"], import: ["name"], server: ["id"] };

export var HOME_KINDS = Object.keys(FIELDS);

export var home = { kind: "none" };

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
  home = buildHome(kind, fields);
  return home;
}

/* Put back a record setHome() returned earlier — the SAME object, not a
   copy, because a caller that is still holding it (a conflict modal's merge
   candidate, a save waiting on a write) compares by identity. Only saveDoc's
   undoRetarget needs this: a fresh pick that never got written is not a
   home, and the one before it still is. */
export function restoreHome(record) {
  if (!record || !FIELDS[record.kind]) throw new Error("restoreHome: not a home record");
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
