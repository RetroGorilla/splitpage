import { formatDuration } from "../core/production/timing.ts";
import { DEFAULT_WPM } from "../core/document/timing.ts";
import { S } from "./_state.js";
import { readDefaultWpm } from "./00p-prefs.js";
import { home } from "./_home.js";
import { SCHEMA_VERSION, loadLastFileHandle } from "./00-prelude.js";
import { wordCount } from "./01-scene-status.js";
import { escapeHtml, makeId, migrateRows } from "./02-state.js";
import { syncDocIdentity } from "./02b-doc-id.js";
import { updateIdentityChip } from "./03-sync.js";
import { renderAbsorbed } from "./05-render.js";
import { resetProductionPanelState } from "./07-production-tags.js";
import { openGdocModal, openImportModal } from "./11-import.js";
import { clearDirty, showToast, updateSaveStatus } from "./12-dirty-toast.js";
import { arrivingOnLink } from "./13-hosted.js";
import { fileKindFromName, openLocalFile, openProjectFile, updateFileChip } from "./18-local-files.js";
import { desktopAppUrl, desktopAppOffered } from "./20a-update.js";
import { seedCheckPasses } from "./20b-onboarding.js";
import { makeDesktopHandle, notifyDesktopDocumentState } from "./20f-desktop.js";
import { draftRestorePending } from "./20g-drafts.js";
import { STARTERS, starterById } from "./_starters.js";
import { appActions } from "../legacy/app-actions.ts";
import { NO_DESTINATION, documentTransitions } from "../legacy/transition-bridge.ts";

var newTabPageShown = false;

function newTabPageEl() { return document.getElementById("newtab-page"); }

function newTabSuppressed() {
  return window.__splitpageNoNewTab === true;
}

function openNewTabPage() {
  var el = newTabPageEl();
  if (!el || newTabPageShown) return;
  newTabPageShown = true;
  el.hidden = false;
  document.documentElement.classList.add("is-newtab-open");
  updateDesktopPitch();
  document.addEventListener("keydown", onNewTabKeydown, true);
  var first = el.querySelector('[data-newtab-action="new"]');
  if (first) first.focus();
  refreshRecents();
}

export function closeNewTabPage() {
  var el = newTabPageEl();
  if (!newTabPageShown) return;
  newTabPageShown = false;
  if (el) el.hidden = true;
  document.documentElement.classList.remove("is-newtab-open");
  setDropHover(false);
  document.removeEventListener("keydown", onNewTabKeydown, true);
}

function onNewTabKeydown(e) {
  if (e.key !== "Escape") return;
  if (document.querySelector(".modal-backdrop:not([hidden]), #tour-overlay:not([hidden])")) return;
  e.stopPropagation();
  e.preventDefault();
  closeNewTabPage();
}

function blankDocumentState() {
  return migrateRows({
    title: "Untitled Script",
    rows: [{ id: makeId("r"), visualText: "", imageRef: null, audioText: "" }],
    wordsPerMinute: readDefaultWpm()
  });
}

function starterDocumentState(id) {
  var starter = starterById(id);
  return starter ? migrateRows(JSON.parse(JSON.stringify(starter.state))) : null;
}

function adoptNewDocument(next, reason) {
  var leaves = home.kind === "file" || home.kind === "import";
  documentTransitions().startNew({ from: { document: next }, reason: reason, destination: leaves ? NO_DESTINATION : undefined });
  clearDirty();
  resetProductionPanelState();
  renderAbsorbed();
  updateFileChip();
  updateIdentityChip();
  updateSaveStatus();
  if (typeof syncDocIdentity === "function") syncDocIdentity();
  if (S.DESKTOP && typeof notifyDesktopDocumentState === "function") notifyDesktopDocumentState();
  closeNewTabPage();
}

function startNewDocument(makeState, reason) {
  if (!S.state && S.initialStateReady) {
    return S.initialStateReady.then(function () { return startNewDocument(makeState, reason); });
  }
  var next = makeState();
  if (!next) return Promise.resolve(false);
  adoptNewDocument(next, reason);
  return Promise.resolve(true);
}

function startBlankScript() {
  return startNewDocument(blankDocumentState, "startBlankScript: a new blank document");
}

function startStarterScript(id) {
  return startNewDocument(function () { return starterDocumentState(id); },
    "startStarterScript: a new document from the " + id + " starter");
}

function openPasteAsNewDocument() {
  openImportModal({
    intoNewDocument: function (rows, scan) {
      var next = migrateRows({ schema: SCHEMA_VERSION, title: "Untitled Script", rows: rows });
      scan(next);
      adoptNewDocument(next, "newtab paste: a new document from pasted text");
    }
  });
}

async function newTabOpenFile() {
  await openLocalFile();
  if (home.kind === "import" || home.kind === "file") closeNewTabPage();
}

function isFileDrag(e) {
  var types = e.dataTransfer && e.dataTransfer.types;
  if (!types) return false;
  for (var i = 0; i < types.length; i++) if (types[i] === "Files") return true;
  return false;
}

function setDropHover(on) {
  var zone = document.getElementById("newtab-drop");
  if (zone) zone.classList.toggle("is-over", !!on);
}

function newTabOpenDropped(file) {
  if (!file) return Promise.resolve(false);
  if (!fileKindFromName(file.name)) {
    showToast("Splitpage opens .md, .splitpage, .docx, .txt and .csv files — " +
      file.name + " isn't one of them.", "warn");
    return Promise.resolve(false);
  }
  return openProjectFile(file, null);
}

function starterSceneSeconds(state) {
  var wpm = state.wordsPerMinute || DEFAULT_WPM;
  return state.rows.map(function (row) { return wordCount(row.audioText) / wpm * 60; });
}

function starterPreviewHtml(state) {
  var secs = starterSceneSeconds(state);
  var total = secs.reduce(function (n, s) { return n + s; }, 0);
  return '<span class="newtab-preview" aria-hidden="true">' +
    '<span class="newtab-preview-bar">' + secs.map(function (s) {
      return '<i style="flex-grow:' + Math.max(1, Math.round(s)) + '"></i>';
    }).join("") + '</span>' +
    '<span class="newtab-preview-time">' + escapeHtml(formatDuration(total)) + '</span>' +
  '</span>';
}

function renderStarterCards() {
  var cards = document.getElementById("newtab-cards");
  if (!cards || cards.querySelector('[data-newtab-action="starter"]')) return;
  cards.insertAdjacentHTML("beforeend", STARTERS.map(function (s) {
    var scenes = s.state.rows.length;
    return '<button type="button" class="newtab-card" data-newtab-action="starter" data-starter="' + escapeHtml(s.id) + '">' +
      '<strong class="newtab-card-name">' + escapeHtml(s.name) + '</strong>' +
      '<span class="newtab-card-desc">' + escapeHtml(s.desc) + '</span>' +
      '<span class="newtab-card-meta">' +
        '<span class="newtab-card-doc">' + escapeHtml(s.state.title) + '</span>' +
        '<span aria-hidden="true">·</span>' +
        '<span class="newtab-card-count">' + scenes + (scenes === 1 ? ' scene' : ' scenes') + '</span>' +
      '</span>' +
      starterPreviewHtml(s.state) +
    '</button>';
  }).join(""));
}

function updateDesktopPitch() {
  var pitch = document.getElementById("newtab-desktop");
  if (!pitch) return;
  pitch.hidden = !desktopAppOffered();
  var link = document.getElementById("newtab-desktop-link");
  if (link && desktopAppOffered()) link.href = desktopAppUrl();
}

function recentsSupported() {
  return !!(S.DESKTOP && typeof S.DESKTOP.listRecents === "function");
}

function formatRecentWhen(at) {
  if (!at) return "";
  var mins = Math.floor((Date.now() - at) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return mins + " min ago";
  var hours = Math.floor(mins / 60);
  if (hours < 24) return hours + " h ago";
  var days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return days + " days ago";
  var d = new Date(at);
  return d.toLocaleDateString(undefined, d.getFullYear() === new Date().getFullYear()
    ? { day: "numeric", month: "short" }
    : { day: "numeric", month: "short", year: "numeric" });
}

function renderContinue(entry) {
  var row = document.getElementById("newtab-continue");
  var sub = document.querySelector("#newtab-page .newtab-sub");
  var btn = document.getElementById("newtab-continue-btn");
  if (!row || !btn) return;
  var has = !!(entry && entry.fileId);
  row.hidden = !has;
  if (sub) sub.hidden = !has;
  if (!has) { btn.setAttribute("data-file-id", ""); return; }
  var title = entry.title || entry.name;
  document.getElementById("newtab-continue-title").textContent = title;
  document.getElementById("newtab-continue-when").textContent = formatRecentWhen(entry.at);
  btn.setAttribute("data-file-id", entry.fileId);
  btn.setAttribute("aria-label", "Continue " + title);
  btn.title = entry.name;
}

function renderRecents(entries) {
  var col = document.getElementById("newtab-recents");
  var list = document.getElementById("newtab-recents-list");
  var main = document.querySelector("#newtab-page .newtab-main");
  if (!col || !list) return;
  col.hidden = false;
  if (main) main.classList.add("has-recents");
  renderContinue(entries[0] || null);
  var clear = document.getElementById("newtab-recents-clear");
  if (clear) clear.hidden = !entries.length;
  if (!entries.length) {
    list.innerHTML = '<div class="newtab-recents-empty">Nothing yet — what you open shows up here.</div>';
    return;
  }
  list.innerHTML = entries.map(function (r) {
    var when = formatRecentWhen(r.at);
    var title = r.title || r.name;
    return '<div class="newtab-recent">' +
      '<button type="button" class="newtab-recent-open" data-newtab-action="open-recent" ' +
        'data-file-id="' + escapeHtml(r.fileId) + '" title="' + escapeHtml(r.name) + '">' +
        '<svg class="nt-icon newtab-recent-icon" aria-hidden="true"><use href="#i-file"/></svg>' +
        '<span class="newtab-recent-text">' +
          '<span class="newtab-recent-title">' + escapeHtml(title) + '</span>' +
          '<span class="newtab-recent-meta"><span class="newtab-recent-name">' + escapeHtml(r.name) + '</span></span>' +
        '</span>' +
        (when ? '<span class="newtab-recent-when">' + escapeHtml(when) + '</span>' : '') +
      '</button>' +
      '<button type="button" class="newtab-recent-forget" data-newtab-action="forget-recent" ' +
        'data-file-id="' + escapeHtml(r.fileId) + '" title="Forget this one" ' +
        'aria-label="Forget ' + escapeHtml(title) + '">' +
        '<svg class="nt-icon" aria-hidden="true"><use href="#i-close"/></svg></button>' +
    '</div>';
  }).join("");
}

async function refreshRecents() {
  updateDesktopPitch();
  if (!recentsSupported()) { renderContinue(null); return; }
  var entries;
  try { entries = await S.DESKTOP.listRecents(); } catch (e) { return; }
  renderRecents(Array.isArray(entries) ? entries : []);
}

async function openRecent(fileId) {
  if (!fileId || !recentsSupported()) return;
  var entry;
  try {
    var r = await S.DESKTOP.routeOpen({ kind: "file", fileId: fileId });
    if (!r || r.where !== "this-tab") {
      refreshRecents();
      return;
    }
    entry = await S.DESKTOP.readFile(fileId);
  } catch (e) {
    showToast("That file isn't there any more — it may have been moved or deleted. " +
      "Use × to take it off this list.", "warn");
    refreshRecents();
    return;
  }
  var handle = makeDesktopHandle(entry);
  await openProjectFile(await handle.getFile(), handle);
}

async function forgetRecent(fileId) {
  if (!fileId || !recentsSupported() || typeof S.DESKTOP.removeRecent !== "function") return;
  var entries;
  try { entries = await S.DESKTOP.removeRecent(fileId); } catch (e) { return; }
  renderRecents(Array.isArray(entries) ? entries : []);
}

async function clearRecents() {
  if (!recentsSupported() || typeof S.DESKTOP.clearRecents !== "function") return;
  var entries;
  try { entries = await S.DESKTOP.clearRecents(); } catch (e) { return; }
  renderRecents(Array.isArray(entries) ? entries : []);
}

async function newTabEligibleForAutoShow() {
  if (newTabSuppressed()) return false;
  if (!seedCheckPasses()) return false;
  if (typeof arrivingOnLink === "function" && arrivingOnLink()) return false;
  if (S.DESKTOP && typeof draftRestorePending !== "undefined" && draftRestorePending) return false;
  if (home.kind === "server" || home.kind === "file") return false;
  if (S.DESKTOP) {
    if ((S.DESKTOP.launchIntent && S.DESKTOP.launchIntent.type !== "blank") ||
        S.DESKTOP.hasDraftToRestore) return false;
  } else {
    var handle;
    try { handle = await loadLastFileHandle(); } catch (e) { handle = null; }
    if (handle) return false;
  }
  if (home.kind !== "none") return false;
  return true;
}

async function maybeAutoShowNewTabPage() {
  var eligible;
  try { eligible = await newTabEligibleForAutoShow(); } catch (e) { eligible = false; }
  if (eligible) openNewTabPage();
}

export function __init() {
  (function wireNewTabPage() {
    var el = newTabPageEl();
    if (!el) return;
    renderStarterCards();
    el.addEventListener("click", function (e) {
      var target = e.target.closest("[data-newtab-action]");
      if (!target) return;
      var action = target.getAttribute("data-newtab-action");
      e.preventDefault();
      if (action === "new") startBlankScript();
      else if (action === "starter") startStarterScript(target.getAttribute("data-starter"));
      else if (action === "long-demo") startStarterScript("long-demo");
      else if (action === "open") newTabOpenFile();
      else if (action === "join") appActions.invoke("servers", "button");
      else if (action === "paste") openPasteAsNewDocument();
      else if (action === "gdoc") openGdocModal();
      else if (action === "dismiss") closeNewTabPage();
      else if (action === "tour") { closeNewTabPage(); appActions.invoke("tour", "button"); }
      else if (action === "open-recent") openRecent(target.getAttribute("data-file-id"));
      else if (action === "forget-recent") forgetRecent(target.getAttribute("data-file-id"));
      else if (action === "clear-recents") clearRecents();
    });

    el.addEventListener("dragover", function (e) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = "copy"; } catch (err) {}
      setDropHover(true);
    });
    el.addEventListener("dragleave", function (e) {
      if (!e.relatedTarget || !el.contains(e.relatedTarget)) setDropHover(false);
    });
    el.addEventListener("drop", function (e) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      setDropHover(false);
      newTabOpenDropped(e.dataTransfer.files && e.dataTransfer.files[0]);
    });
  })();

  maybeAutoShowNewTabPage();

  window.__newTab = {
    open: openNewTabPage,
    isOpen: function () { return newTabPageShown; },
    eligible: newTabEligibleForAutoShow,
    blankState: blankDocumentState,
    starterIds: function () { return STARTERS.map(function (s) { return s.id; }); },
    starterState: starterDocumentState,
    refreshRecents: refreshRecents
  };
}
