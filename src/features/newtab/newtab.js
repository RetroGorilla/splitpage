import { formatDuration } from "../../core/production/timing.ts";
import { DEFAULT_WPM } from "../../core/document/timing.ts";
import { SCHEMA_VERSION } from "../../core/document/fields.ts";
import { escapeHtml } from "../../core/document/text-policy.ts";
import { NO_DESTINATION } from "../../application/transitions/ports.ts";
import { fileKindFromName } from "../../../shared/file-names.js";

var ports = null;
var activeMount = null;
var listeners = [];

function listen(target, type, listener) {
  target.addEventListener(type, listener);
  listeners.push(function () { target.removeEventListener(type, listener); });
}

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

function closeNewTabPage() {
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
  return ports.prepareDocument({
    title: "Untitled Script",
    rows: [{ id: ports.ids.id("r"), visualText: "", imageRef: null, audioText: "" }],
    wordsPerMinute: ports.preferences.defaultWpm()
  });
}

function starterDocumentState(id) {
  var starter = ports.findStarter(id);
  return starter ? ports.prepareDocument(JSON.parse(JSON.stringify(starter.state))) : null;
}

function adoptNewDocument(next, reason) {
  var leaves = ports.place.home().kind === "file" || ports.place.home().kind === "import";
  ports.resetProductionPanel();
  ports.transitions.startNew({ from: { document: next }, reason: reason, destination: leaves ? NO_DESTINATION : undefined });
  ports.saving.confirmSavedNow();
  if (typeof ports.syncIdentity === "function") ports.syncIdentity();
  closeNewTabPage();
}

function startNewDocument(makeState, reason) {
  var mounted = activeMount;
  var ready = ports.document.current() ? null : ports.startup.ready();
  if (ready) {
    return ready.then(function () { return activeMount === mounted ? startNewDocument(makeState, reason) : false; });
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
  var mounted = activeMount;
  ports.importText({
    intoNewDocument: function (rows, scan) {
      if (activeMount !== mounted) return;
      var next = ports.prepareDocument({ schema: SCHEMA_VERSION, title: "Untitled Script", rows: rows });
      scan(next);
      adoptNewDocument(next, "newtab paste: a new document from pasted text");
    }
  });
}

async function newTabOpenFile() {
  var mounted = activeMount;
  await ports.openFile();
  if (activeMount !== mounted) return;
  if (ports.place.home().kind === "import" || ports.place.home().kind === "file") closeNewTabPage();
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
    ports.notices.show("Splitpage opens .md, .splitpage, .docx, .txt and .csv files — " +
      file.name + " isn't one of them.", "warn");
    return Promise.resolve(false);
  }
  return ports.opening.open({ kind: "file", file: file, handle: null });
}

function starterSceneSeconds(state) {
  var wpm = state.wordsPerMinute || DEFAULT_WPM;
  return state.rows.map(function (row) { return ports.text.productionReaders.wordCount(row.audioText) / wpm * 60; });
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
  cards.insertAdjacentHTML("beforeend", ports.starters.map(function (s) {
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
  pitch.hidden = !ports.desktopDownload.offered();
  var link = document.getElementById("newtab-desktop-link");
  if (link && ports.desktopDownload.offered()) link.href = ports.desktopDownload.url();
}

function recentsSupported() {
  return !!(ports.desktop() && ports.recents.available());
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
  var mounted = activeMount;
  updateDesktopPitch();
  if (!recentsSupported()) { renderContinue(null); return; }
  var entries;
  try { entries = await ports.recents.list(); } catch (e) { return; }
  if (activeMount !== mounted) return;
  renderRecents(Array.isArray(entries) ? entries : []);
}

async function openRecent(fileId) {
  var mounted = activeMount;
  if (!fileId || !recentsSupported()) return;
  var entry;
  try {
    var r = await ports.recents.routeOpen({ kind: "file", fileId: fileId });
    if (activeMount !== mounted) return;
    if (!r || r.where !== "this-tab") {
      refreshRecents();
      return;
    }
    entry = await ports.recents.read(fileId);
  } catch (e) {
    if (activeMount !== mounted) return;
    ports.notices.show("That file isn't there any more — it may have been moved or deleted. " +
      "Use × to take it off this list.", "warn");
    refreshRecents();
    return;
  }
  if (activeMount !== mounted) return;
  var handle = ports.recentHandle(entry);
  var file = await handle.getFile();
  if (activeMount !== mounted) return;
  await ports.opening.open({ kind: "file", file: file, handle: handle });
}

async function forgetRecent(fileId) {
  var mounted = activeMount;
  if (!fileId || !recentsSupported() || !ports.recents.canRemove()) return;
  var entries;
  try { entries = await ports.recents.remove(fileId); } catch (e) { return; }
  if (activeMount !== mounted) return;
  renderRecents(Array.isArray(entries) ? entries : []);
}

async function clearRecents() {
  var mounted = activeMount;
  if (!recentsSupported() || !ports.recents.canClear()) return;
  var entries;
  try { entries = await ports.recents.clear(); } catch (e) { return; }
  if (activeMount !== mounted) return;
  renderRecents(Array.isArray(entries) ? entries : []);
}

async function newTabEligibleForAutoShow() {
  var mounted = activeMount;
  if (newTabSuppressed()) return false;
  if (!ports.seedCheck.passes()) return false;
  if (ports.desktop() && ports.draftResume.restorePending()) return false;
  if (ports.place.home().kind === "file") return false;
  if (ports.desktop()) {
    if ((ports.launch.launchIntent() && ports.launch.launchIntent().type !== "blank") ||
        ports.launch.hasDraftToRestore()) return false;
  } else {
    var handle;
    try { handle = await ports.lastFile.load(); } catch (e) { handle = null; }
    if (activeMount !== mounted) return false;
    if (handle) return false;
  }
  if (ports.place.home().kind !== "none") return false;
  return true;
}

async function maybeAutoShowNewTabPage() {
  var mounted = activeMount;
  var eligible;
  try { eligible = await newTabEligibleForAutoShow(); } catch (e) { eligible = false; }
  if (eligible && activeMount === mounted) openNewTabPage();
}

export function startNewTab(given) {
  ports = given;
  var mounted = {};
  activeMount = mounted;
  (function wireNewTabPage() {
    var el = newTabPageEl();
    if (!el) return;
    renderStarterCards();
    listen(el, "click", function (e) {
      var target = e.target.closest("[data-newtab-action]");
      if (!target) return;
      var action = target.getAttribute("data-newtab-action");
      e.preventDefault();
      if (action === "new") startBlankScript();
      else if (action === "starter") startStarterScript(target.getAttribute("data-starter"));
      else if (action === "long-demo") startStarterScript("long-demo");
      else if (action === "open") newTabOpenFile();
      else if (action === "paste") openPasteAsNewDocument();
      else if (action === "gdoc") ports.actions.invoke("show-gdoc-import", "button");
      else if (action === "dismiss") closeNewTabPage();
      else if (action === "tour") { closeNewTabPage(); ports.actions.invoke("tour", "button"); }
      else if (action === "open-recent") openRecent(target.getAttribute("data-file-id"));
      else if (action === "forget-recent") forgetRecent(target.getAttribute("data-file-id"));
      else if (action === "clear-recents") clearRecents();
    });

    listen(el, "dragover", function (e) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = "copy"; } catch (err) {}
      setDropHover(true);
    });
    listen(el, "dragleave", function (e) {
      if (!e.relatedTarget || !el.contains(e.relatedTarget)) setDropHover(false);
    });
    listen(el, "drop", function (e) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      setDropHover(false);
      newTabOpenDropped(e.dataTransfer.files && e.dataTransfer.files[0]);
    });
  })();

  maybeAutoShowNewTabPage();

  window.__newTab = {
    open: function () { if (activeMount === mounted) openNewTabPage(); },
    isOpen: function () { return activeMount === mounted && newTabPageShown; },
    eligible: function () { return activeMount === mounted ? newTabEligibleForAutoShow() : Promise.resolve(false); },
    blankState: function () { return activeMount === mounted ? blankDocumentState() : null; },
    starterIds: function () { return activeMount === mounted ? ports.starters.map(function (s) { return s.id; }) : []; },
    starterState: function (id) { return activeMount === mounted ? starterDocumentState(id) : null; },
    refreshRecents: function () { return activeMount === mounted ? refreshRecents() : Promise.resolve(); }
  };
  var probe = window.__newTab;
  var disposed = false;
  return {
    closeNewTabPage: function () { if (!disposed) closeNewTabPage(); },
    dispose: function () {
      if (disposed) return;
      disposed = true;
      while (listeners.length) listeners.pop()();
      closeNewTabPage();
      if (window.__newTab === probe) delete window.__newTab;
      activeMount = null;
      ports = null;
    }
  };
}
