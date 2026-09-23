import { S } from "./_state.js";
import { fileHome } from "./_home.js";
import { legacyMdToHtml, makeId, migrateRows } from "./02-state.js";
import {
  adoptRestoredState,
  deriveDocId,
  docIdEmbeddedIn,
  docIdEvents,
  initDocIdentityChannel,
  migrateDocument,
  reassignDocId,
  standaloneHtmlFor
} from "./02b-doc-id.js";
import { inlineStateImages, internDataUrl, missingInlineImages, queuePersist, rowImageDataUrl } from "./02c-blobs.js";
import { cloneState, setBaseState, stashLocalWork } from "./03-sync.js";
import { plainText, safeImageSrc, sanitizeHtml } from "./04-richtext.js";
import { tagFieldOccurrences } from "./07-production-tags.js";
import { handleImportFile, parseMarkdownTable } from "./11-import.js";
import {
  autoSaveEnabled,
  autoSaveHalt,
  autoSaveIdleTimer,
  autoSaveMaxTimer,
  autoSaveTarget,
  autoSaveTiming,
  flushAutoSave,
  mdSceneCellSource,
  saveDoc,
  toMarkdownTableDoc,
  toggleAutoSave
} from "./14-export.js";
import { openProjectFile } from "./18-local-files.js";

/* ================= document file formats =================

   Two formats, one document. Both are plain text, neither carries a copy
   of the app, and both go through migrateRows() on the way in like
   everything else from outside this page (invariant #2).

     .splitpage   the state object itself, pretty-printed. No envelope and
                  no translation: what the server stores, what #state-data
                  holds at boot, and what this file contains are the same
                  object (invariant #31).

     .md          a Markdown table a human (or Obsidian, or GitHub) can
                  read, followed by that same JSON in a fenced block. The
                  table is what you edit elsewhere; the block is what the
                  table cannot say — tags, comment anchors, images, ids,
                  statuses, people, reading speed (invariant #32).

   The old .html "save the whole app with the script inside it" format is
   still READ here (openProjectFile, 18-local-files.js) and can still be
   written by Export ▸ Standalone HTML, but Save never produces it. */

/* ---- the native format ---- */

/* The pictures go into the file inline, as they always have (#82 D1):
   `visualImage: data:…` on the row, so the file is self-contained and an
   older client reads it whole. The page itself names them by imageRef;
   inlineStateImages turns one into the other, which is synchronous — a
   caller that may not hold every picture's bytes awaits
   ensureBytes(refsIn(state)) first (saveDoc does). One nobody has stays a
   ref with no picture in the file; fileImagesMissing() says how many. */
export function fileStateFor(s) {
  var copy = migrateRows(cloneState(s || S.state));
  inlineStateImages(copy);
  return copy;
}

export function buildSplitpageFile(s) {
  return JSON.stringify(fileStateFor(s), null, 2);
}

/* The shas a file written from `s` right now could not carry. */
export function fileImagesMissing(s) {
  return missingInlineImages(s || S.state);
}

/* Throws on anything that isn't one of ours; the caller decides what to
   say about it. Deliberately does NOT migrate — every entry point wants
   to do that itself, at the one moment it is actually adopting the
   document, so there is never a half-trusted object in flight. */
export function parseSplitpageFile(text) {
  var parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.rows)) {
    throw new Error("not-a-splitpage-file");
  }
  return parsed;
}

/* ---- the Markdown project ---- */

var MD_DATA_INFO = "splitpage";
var MD_DATA_NOTE = "<!-- splitpage: everything below is Splitpage's own record of this " +
  "script. Edit the text above freely; leave this block alone. -->";

/* CommonMark closes a tilde fence on the first line of at least as many
   tildes as opened it, so a fence is only safe if it is longer than any
   run of tildes the content contains. Four is the floor (JSON of
   sanitised HTML has no tildes at all in the ordinary case); a script
   with "~~~~~" typed into it gets a longer one rather than a data block
   that ends in the middle of somebody's dialogue. */
function splitpageDataFence(json) {
  var longest = 3, re = /~{3,}/g, m;
  while ((m = re.exec(json)) !== null) {
    if (m[0].length > longest) longest = m[0].length;
  }
  return new Array(Math.max(4, longest + 1) + 1).join("~");
}

export function buildMarkdownProject(s) {
  s = s || S.state;
  var json = buildSplitpageFile(s);
  var fence = splitpageDataFence(json);
  return toMarkdownTableDoc(s) + "\n" + MD_DATA_NOTE + "\n" +
    fence + MD_DATA_INFO + "\n" + json + "\n" + fence + "\n";
}

/* The LAST opening fence wins: a script that quotes this very block as an
   example earlier in its prose must not be able to shadow the real one.
   An opener can never occur inside the block itself — JSON.stringify
   escapes every newline, so every line of the JSON begins with the
   pretty-printer's indent, never with a tilde. */
function findMarkdownDataBlock(text) {
  var lines = String(text || "").replace(/\r\n|\r/g, "\n").split("\n");
  var openAt = -1, fenceLen = 0, i;
  for (i = 0; i < lines.length; i++) {
    var m = /^(~{3,})\s*splitpage\s*$/.exec(lines[i]);
    if (m) { openAt = i; fenceLen = m[1].length; }
  }
  if (openAt === -1) return null;
  var closeRe = new RegExp("^~{" + fenceLen + ",}\\s*$");
  var closeAt = -1;
  for (i = openAt + 1; i < lines.length; i++) {
    if (closeRe.test(lines[i])) { closeAt = i; break; }
  }
  return {
    json: lines.slice(openAt + 1, closeAt === -1 ? lines.length : closeAt).join("\n"),
    before: lines.slice(0, openAt).join("\n")
  };
}

/* Returns null for Markdown that is not one of ours — a script someone
   wrote in a text editor, an export from something else — so the caller
   falls through to the ordinary lossy import, unchanged. A block that is
   present but unreadable reads the same way: the table is still there and
   still worth importing, and refusing the file outright would help nobody. */
export function parseMarkdownProject(text) {
  var block = findMarkdownDataBlock(text);
  if (!block) return null;
  var parsed;
  try { parsed = parseSplitpageFile(block.json); } catch (e) { return null; }

  /* Only the scene table. The breakdown and the comments appendix are
     pipe tables too, and parseMarkdownTable reads every pipe line it is
     given — they sit under "## " headings, and the scene table is
     everything before the first one. */
  var sceneSection = block.before.split(/^##\s/m)[0];
  var heading = /^#\s+(.+)$/m.exec(block.before);
  /* Read BEFORE migrateDocument: migrateRows mutates `parsed` and always
     leaves a valid id on it, so asking afterwards would say "embedded" for
     every file. docIdEmbedded tells a draft restore whether the id came
     from the file itself or was derived from its content (a legacy file
     changed on disk derives a different one, and must still merge). */
  var docIdEmbedded = docIdEmbeddedIn(parsed);
  return {
    state: migrateDocument(parsed, { kind: "file" }),
    docIdEmbedded: docIdEmbedded,
    /* keepEmpty: a scene with nothing typed in it yet is still a row of
       the table, and dropping it here would misread every later row as
       shifted and pop the "scenes were added or removed" question on
       every open of a document with one blank scene in it. */
    table: parseMarkdownTable(sceneSection, { keepEmpty: true }),
    title: heading ? heading[1].trim() : null
  };
}

/* ---- reconciling hand edits made outside Splitpage ---- */

export var MD_IMAGE_PREFIX_RE = /^!\[[^\]]*\]\((data:image\/[^)\s]+)\)\s*(?:<br\s*\/?>)?\s*/i;

/* A cell that was edited elsewhere is plain Markdown again: it has lost
   its tag spans and its comment anchors, because neither survives
   htmlToMarkdown(). Rebuild the rich text, then re-wrap every name the
   breakdown still tracks — a tag survives a wording tweak that way, which
   is the whole point of keeping the registry as real storage (§3.4).
   Comment anchors on the cell are gone for good; the comments themselves
   keep their quotedText and show as not-in-script in the panel. */
function markdownCellToHtml(s, md) {
  /* contenteditable sprays non-breaking spaces into anything typed at the
     end of a line, and they travel out into the Markdown as-is. A tag name
     in the registry has ordinary spaces in it, so leaving them would mean
     "gaffer tape" quietly failing to re-attach to text that looks
     identical. Nothing downstream wants a nbsp in rebuilt prose either. */
  var html = sanitizeHtml(legacyMdToHtml(String(md == null ? "" : md).replace(/\u00A0/g, " ")));
  var names = (s.productionTags || []).slice().sort(function (a, b) {
    return String(b.name || "").length - String(a.name || "").length;
  });
  names.forEach(function (t) {
    var name = String(t.name || "").trim();
    if (!name) return;
    var res = tagFieldOccurrences(html, name, t.cat, name, false);
    if (res.hits) html = res.html;
  });
  return sanitizeHtml(html);
}

/* The Visual cell can carry an inline image ahead of its text — today's
   foreign import throws that away, but in one of our own files it is the
   picture the scene was storyboarded with. */
function applyMarkdownVisualCell(s, row, md) {
  var text = String(md == null ? "" : md);
  var m = MD_IMAGE_PREFIX_RE.exec(text);
  var rec = m ? internDataUrl(safeImageSrc(m[1]) || "") : null;
  if (rec) queuePersist([rec.sha256]);
  /* A picture the file could not carry (its bytes were missing when it was
     written) is not in the cell, and that is not the cell deleting it. */
  var uncarried = !m && row.imageRef && !rowImageDataUrl(row);
  delete row.visualImage;
  if (!uncarried) row.imageRef = rec || null;
  if (m) text = text.slice(m[0].length);
  row.visualText = markdownCellToHtml(s, text);
}

function markdownCellChanged(cellText, was) {
  return String(cellText == null ? "" : cellText).trim() !== was;
}

/* The visual cell compared as what it shows: when the text differs only
   in how the picture is spelled — an older client wrote the data: URI it
   was handed, not the canonical one this page writes — the cell is the
   same picture and the same words, and is unchanged (#82). */
function markdownVisualCellChanged(cellText, was) {
  if (!markdownCellChanged(cellText, was.visual)) return false;
  var text = String(cellText == null ? "" : cellText).trim();
  var m = MD_IMAGE_PREFIX_RE.exec(text);
  if (!m) return true;
  var rec = internDataUrl(safeImageSrc(m[1]) || "");
  if (!rec || rec.sha256 !== was.image) return true;
  return text.slice(m[0].length).trim() !== was.visualText;
}

/* Which of a scene's two table cells were edited outside Splitpage. A cell
   is unchanged if it says what this copy writes for the block's row
   (mdSceneCellSource) or what the document model's toMarkdown() would —
   the second so that a later copy can write that instead without this one
   rebuilding its cells (see mdSceneCellSource, 14-export.js). The second
   is only worked out for a cell the first does not match. */
function sceneCellEdits(row, i, cells) {
  var was = mdSceneCellSource(row, i), model = null;
  function modelWas() { return model || (model = mdSceneCellSource(row, i, true)); }
  return {
    visual: markdownVisualCellChanged(cells.visualText, was) && markdownVisualCellChanged(cells.visualText, modelWas()),
    audio: markdownCellChanged(cells.audioText, was.audio) && markdownCellChanged(cells.audioText, modelWas().audio)
  };
}

/* Same row count on both sides: the block is authoritative except where
   the table disagrees, cell by cell. An untouched cell keeps the block's
   HTML exactly — tags, anchors, links, formatting — because rebuilding it
   from the table would be a lossy no-op. */
function reconcileMarkdownRows(s, table) {
  var changed = 0;
  s.rows.forEach(function (row, i) {
    var cells = table[i];
    if (!cells) return;
    var edits = sceneCellEdits(row, i, cells);
    if (edits.visual) {
      applyMarkdownVisualCell(s, row, cells.visualText);
      changed++;
    }
    if (edits.audio) {
      row.audioText = markdownCellToHtml(s, cells.audioText);
      changed++;
    }
  });
  return changed;
}

/* "Use the table's text": the table decides how many scenes there are and
   what they say; everything the table cannot say is kept by position —
   ids (so comments stay attached), statuses, images, timestamps. */
function rowsFromMarkdownTable(s, table) {
  return table.map(function (cells, i) {
    var old = s.rows[i] || null;
    var row = old || { id: makeId(), status: "todo", imageRef: null, updatedAt: "", updatedBy: null };
    var edits = old ? sceneCellEdits(old, i, cells) : { visual: true, audio: true };
    if (edits.visual) {
      applyMarkdownVisualCell(s, row, cells.visualText);
    }
    if (edits.audio) {
      row.audioText = markdownCellToHtml(s, cells.audioText);
    }
    return row;
  });
}

/* ---- "the scenes don't line up" question ---- */

var pendingMdRowChoice = null;

function askMarkdownRowChoice(blockRows, tableRows) {
  return new Promise(function (resolve) {
    var modal = document.getElementById("md-rows-modal");
    if (!modal) { resolve("keep"); return; }
    document.getElementById("md-rows-detail").textContent =
      "This file's own record has " + blockRows + " scene" + (blockRows === 1 ? "" : "s") +
      ", but the table in it now has " + tableRows + ". Scenes were added or removed " +
      "somewhere other than Splitpage, so the two can no longer be lined up scene by scene.";
    pendingMdRowChoice = resolve;
    modal.hidden = false;
  });
}

/* Never resolved twice: whichever of the two buttons (or Esc, which means
   "keep", the choice that changes nothing) gets here first takes the
   resolver with it. */
export function finishMarkdownRowChoice(choice) {
  var modal = document.getElementById("md-rows-modal");
  if (modal) modal.hidden = true;
  var resolve = pendingMdRowChoice;
  pendingMdRowChoice = null;
  if (resolve) resolve(choice === "table" ? "table" : "keep");
}

/* Turn a parsed project into the state to adopt. Async only because the
   row-count question is a real modal — no silent choice.

   `opts.noAsk` is the one exception, and it is not a silent choice made on
   the user's behalf: a caller only asking what is in a file (the merge
   review's probe, 18a-local-merge.js) must not throw a modal over one the
   user is already looking at, so it takes "keep the record" — exactly what
   Esc means here — and the file is never adopted from that read. */
export async function applyMarkdownProject(proj, opts) {
  var s = proj.state;
  if (proj.title && proj.title !== s.title) s.title = plainText(proj.title).slice(0, 300);

  if (proj.table.length === s.rows.length) {
    reconcileMarkdownRows(s, proj.table);
  } else if (opts && opts.noAsk) {
    /* keep the record */
  } else {
    var choice = await askMarkdownRowChoice(s.rows.length, proj.table.length);
    if (choice === "table") s.rows = rowsFromMarkdownTable(s, proj.table);
  }
  /* Everything that enters `state` goes through the one door, including
     what we just rebuilt out of a text file (invariant #2). */
  return migrateRows(s);
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  /* ---- test hook ----
     Neither file picker can run headless, so the regression suite
     (17-formats.txt) drives the serializers and the open path directly.
     Nothing in the app reads this; it is the same trick 03-exports.txt
     plays on URL.createObjectURL, one level up. */
  window.__splitpageFormats = {
    buildSplitpage: buildSplitpageFile,
    buildMarkdown: buildMarkdownProject,
    /* parseMarkdown is here for ONE live-flow guard: 22-doc-id.txt builds a
       legacy .md by cutting the docId line out of a real one at runtime and
       checks the result is still one of ours before opening it. Its own
       rules — what parses, what returns null, which fence wins — are
       src/test/formats.test.mjs, and parseSplitpage/migrateDocument left
       with #67 because nothing drove them but their own assertions. */
    parseMarkdown: parseMarkdownProject,
    buildStandaloneHtml: function () { return standaloneHtmlFor(S.state); },
    /* Document identity (02b-doc-id.js), for 22-doc-id.txt and friends. */
    docId: function () { return S.state ? S.state.docId : null; },
    writtenOut: function () { return S.docIdWrittenOut; },
    /* deriveDocId stays because 22-doc-id.txt uses it as an ORACLE inside a
       live flow — the id a losing tab re-derives for itself over the fake
       BroadcastChannel — not because the function needs driving. Its own
       vectors, sha256Hex's, mergedDocId's truth table, mergeStates and
       decideDuplicateLoser left with #67: they are pure, and they are unit
       tests now (src/test/doc-id.test.mjs, merge-states.test.mjs). */
    deriveDocId: deriveDocId,
    adoptRestoredState: adoptRestoredState,
    reassignDocId: reassignDocId,
    docIdEvents: docIdEvents,
    initDocIdentityChannel: initDocIdentityChannel,
    /* `handle` is optional — a real Open never has one either — but
       19-save-conflict.txt passes a fake FileSystemFileHandle-shaped object
       (name + getFile() + createWritable()) so the on-disk-conflict guard in
       saveDoc() (14-export.js) has something to compare against, exactly
       the way a real handle from showOpenFilePicker would. */
    openFile: function (file, handle) { return openProjectFile(file, handle || null, { skipSnapshot: true }); },
    /* The Paste/Import modal's file picker (handleImportFile, 11-import.js).
       Headless cannot run a real <input type=file>, and this is the half of
       issue #7 that keeps the document — so it needs driving directly, the
       same way openFile above stands in for File ▸ Open. */
    importFile: function (file) { return handleImportFile(file); },
    /* Drives Save the same way the header/File-menu buttons do, so the
       on-disk-conflict check saveDoc() runs before writing is exercised
       without a real file picker (headless can't run one). */
    save: function (opts) { return saveDoc(opts || {}); },
    /* Autosave (14-export.js), for 28-autosave.txt. `timing` hands back the
       live object rather than a copy on purpose: a suite shortens the pause
       to a few milliseconds instead of sleeping through a real one. The rest
       is read-only state to assert against, plus the two entry points the
       File menu and the window's own blur already use. */
    autosave: {
      timing: function () { return autoSaveTiming; },
      enabled: function () { return autoSaveEnabled; },
      halt: function () { return autoSaveHalt; },
      target: function () { return autoSaveTarget(); },
      pending: function () { return !!(autoSaveIdleTimer || autoSaveMaxTimer); },
      toggle: toggleAutoSave,
      flush: flushAutoSave
    },
    /* Still here because __norm (17-formats.txt, 40-comment-assign-filter
       .txt) migrates a clone of the LIVE state to compare two round trips
       of it; migrateRows' own rules are src/test/migrate-rows.test.mjs.
       The state field registry left with #67 — STATE_FIELDS and
       missingStateFields never needed a page (src/test/state-fields.test
       .mjs). */
    migrate: migrateRows,
    /* The crash/sign-in stash (03-sync.js), for 68-images.txt: what it
       carries across a reload now that images are refs (#82). */
    stash: stashLocalWork,
    clone: cloneState,
    state: function () { return S.state; },
    /* The project-file home (_home.js), in the shape the suites have always
       read: `kind` here is the file's FORMAT ("md" | "splitpage" | "html"),
       null when the document does not live in a project file. */
    docFile: function () {
      var f = fileHome();
      return { name: f && f.handle ? f.handle.name : null, kind: f ? f.format : null,
               lastModified: f ? f.lastModified : null };
    },
    /* The local-file merge (18a-local-merge.js), for 42-local-merge.txt.
       `hasDiskBase` proves the ancestor is being retained at open and at
       save; `forgetDiskBase` drops it, which is the only way to drive the
       two-way fallback from outside — once a file has been opened, nothing
       a user can do takes the ancestor away again. */
    hasDiskBase: function () { return !!(fileHome() && fileHome().diskBase); },
    forgetDiskBase: function () { if (fileHome()) fileHome().diskBase = null; setBaseState(null, "__splitpageFormats.forgetDiskBase: test hook, drives the two-way fallback"); return true; }
  };
}
