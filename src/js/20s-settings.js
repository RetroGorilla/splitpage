import { S } from "./_state.js";
import {
  CLOCK_KEY,
  DEFAULT_WPM_KEY,
  PERSON_COLOR_KEY,
  PREF_EVENT,
  RUNDOWN_MIN_KEY,
  SCRIPT_SCALE_KEY,
  SCRIPT_SCALE_MAX,
  SCRIPT_SCALE_MIN,
  TAG_ICONS_KEY,
  THEME_KEY,
  VIDEO_THUMBS_KEY,
  applyTagIcons,
  applyTheme,
  formatClock,
  readClockPref,
  readDefaultWpm,
  readPref,
  readThemePref,
  tagIconsOn,
  videoThumbsOn,
  writePref
} from "./00p-prefs.js";
import { setHideShotScenes } from "./01b-hide-shot.js";
import { escapeHtml } from "./02-state.js";
import { personSwatchesHtml, renderHistory, setMyColor, updateIdentityChip } from "./03-sync.js";
import { render } from "./05-render.js";
import { COMMENT_NAME_KEY, TAGGING_HELP_KEY, getSavedAuthorName, renderComments, showTaggingHelp } from "./10-comments.js";
import { showToast, updateSaveStatus } from "./12-dirty-toast.js";
import {
  COLLAB_SERVER_KEY,
  DEFAULT_COLLAB_SERVER,
  collabServerView,
  normalizeCollabServer,
  readCollabServer,
  signOutCollab,
  updateCollaborateMenu
} from "./13b-collaborate.js";
import { AUTOSAVE_KEY, setAutoSaveEnabled } from "./14-export.js";
import { toggleFileMenu } from "./18b-file-menu.js";
import { WRITER_SIZE_MAX, WRITER_SIZE_MIN, applyWriterSize, readWriterSize } from "./19-writer.js";
import { setPrompterFlip, setPrompterMirror, setPrompterSceneMode } from "./20-teleprompter.js";
import { renderDesktopAppNotice } from "./20a-update.js";
import { TOUR_DONE_KEY, startTour } from "./20c-help.js";
import { openServersDialog } from "./20e-connect.js";

var SETTINGS_ID = "settings-modal";
var settingsReturnFocus = null;

var DESKTOP_NOTICE_KEY = "splitpage-desktop-notice-dismissed";
var HIDE_SHOT_KEY = "splitpage-hide-shot";
var PROMPTER_KEYS = {
  mirror: "splitpage-prompter-mirror",
  flip: "splitpage-prompter-flip",
  scene: "splitpage-prompter-scene-mode"
};

function modal() { return document.getElementById(SETTINGS_ID); }

export function settingsOpen() {
  var m = modal();
  return !!(m && !m.hidden);
}

function flagOn(key, dflt) {
  var v = readPref(key);
  if (v === "1") return true;
  if (v === "0") return false;
  return !!dflt;
}

function readScriptScale() {
  var n = Number(readPref(SCRIPT_SCALE_KEY));
  return isFinite(n) && n >= SCRIPT_SCALE_MIN && n <= SCRIPT_SCALE_MAX ? n : 1;
}

function currentWriterSize() {
  var n = readWriterSize();
  if (n != null) return n;
  var el = document.getElementById("wr-size");
  var v = el ? parseInt(el.value, 10) : NaN;
  return isFinite(v) ? v : 20;
}

function segHtml(name, label, options, value) {
  return '<div class="settings-field">' +
    '<div class="settings-label" id="settings-' + name + '-label">' + escapeHtml(label) + '</div>' +
    '<div class="export-seg settings-seg" role="radiogroup" aria-labelledby="settings-' + name + '-label">' +
    options.map(function (o) {
      return '<label><input type="radio" name="settings-' + name + '" value="' + escapeHtml(o[0]) + '"' +
        (o[0] === value ? " checked" : "") + '>' + escapeHtml(o[1]) + '</label>';
    }).join("") +
    '</div></div>';
}

function switchHtml(id, label, hint, on) {
  return '<label class="settings-switch" for="' + id + '">' +
    '<span class="settings-switch-text"><span class="settings-switch-label">' + escapeHtml(label) + '</span>' +
      (hint ? '<span class="settings-hint">' + escapeHtml(hint) + '</span>' : '') + '</span>' +
    '<input type="checkbox" role="switch" id="' + id + '"' + (on ? " checked" : "") + '>' +
    '<span class="settings-switch-track" aria-hidden="true"><span class="settings-switch-thumb"></span></span>' +
    '</label>';
}

function section(title, body) {
  return '<section class="settings-section" aria-label="' + escapeHtml(title) + '">' +
    '<h3 class="settings-section-title">' + escapeHtml(title) + '</h3>' + body + '</section>';
}

function clockExample(mode) {
  return formatClock(new Date(2026, 0, 1, 14, 52), mode) + " · " + formatClock(new Date(2026, 0, 1, 9, 5), mode);
}

function importAvailable() {
  var btn = document.querySelector('#file-menu [data-file-action="import-app-data"]');
  return !!(btn && !btn.hidden);
}

function collaborationHtml() {
  var v = collabServerView();
  var where = v.servedHere
    ? '<p class="settings-hint settings-hint-flat">This page comes from <strong>' + escapeHtml(v.label) +
        '</strong>, so Collaborate stores scripts there.</p>'
    : '<div class="settings-field settings-inline">' +
        '<label class="settings-label" for="settings-collab-server">Server address</label>' +
        '<span class="settings-inline-control"><input type="text" id="settings-collab-server" class="settings-wide" autocomplete="off" ' +
          'spellcheck="false" autocapitalize="off" placeholder="' + escapeHtml(DEFAULT_COLLAB_SERVER) + '" value="' +
          escapeHtml(readCollabServer()) + '">' +
          (v.isDefault ? '' : '<button type="button" class="btn-outline is-small" data-settings-action="collab-default">Use the default</button>') +
        '</span>' +
      '</div>' +
      '<p class="settings-hint">Where Collaborate stores the scripts you share. Everyone you invite works on the copy there.</p>';
  return where +
    '<div class="settings-field settings-inline">' +
      '<span class="settings-label" id="settings-collab-signin">' + (v.signedIn
        ? 'Signed in on this device'
        : 'Not signed in on this device') + '</span>' +
      '<span class="settings-inline-control"><button type="button" class="btn-outline is-small" data-settings-action="collab-signout"' +
        (v.signedIn ? '' : ' disabled') + '>Sign out</button></span>' +
    '</div>' +
    '<p class="settings-hint">' + (v.signedIn
      ? 'Collaborate uses your owner key without asking. Sign out to make this device ask for it again.'
      : 'Collaborate asks for your server’s owner key the first time, and remembers it here.') + '</p>';
}

function bodyHtml() {
  var clock = readClockPref();
  var scale = readScriptScale();
  var wsize = currentWriterSize();
  var name = getSavedAuthorName();
  return section("Appearance",
      segHtml("theme", "Theme", [["system", "System"], ["light", "Light"], ["dark", "Dark"]], readThemePref()) +
      segHtml("clock", "Clock", [["system", "System"], ["12", "12-hour"], ["24", "24-hour"]], clock) +
      '<p class="settings-hint settings-clock-example" id="settings-clock-example">' + escapeHtml(clockExample(clock)) + '</p>' +
      switchHtml("settings-rundown-min", "Minimise the rundown strip", "Keep the strip of scenes under the header small.", flagOn(RUNDOWN_MIN_KEY)) +
      switchHtml("settings-tag-icons", "Show icons on tags",
        "Put a small icon for its category before each tag, as well as its colour.", tagIconsOn())) +
    section("Editor",
      switchHtml("settings-hide-shot", "Hide shot scenes", "Collapse scenes marked Shot into a thin strip.", flagOn(HIDE_SHOT_KEY)) +
      switchHtml("settings-autosave", "Autosave", "Write each change to the file you saved to, a moment after you stop typing.", flagOn(AUTOSAVE_KEY, true)) +
      switchHtml("settings-video-thumbs", "Fetch video thumbnails",
        "When you paste a YouTube or Vimeo link, ask the site for its picture once and keep it with the script.", videoThumbsOn()) +
      '<div class="settings-field settings-inline">' +
        '<label class="settings-label" for="settings-default-wpm">Reading speed for new scripts</label>' +
        '<span class="settings-inline-control"><input type="number" id="settings-default-wpm" min="60" max="400" step="5" value="' +
          readDefaultWpm() + '"><span class="settings-unit">words a minute</span></span>' +
      '</div>' +
      '<p class="settings-hint">Each script keeps its own speed — click its length on the rundown to change it.</p>' +
      '<div class="settings-field settings-inline">' +
        '<label class="settings-label" for="settings-writer-size">Writer text size</label>' +
        '<span class="settings-inline-control"><input type="range" id="settings-writer-size" min="' + WRITER_SIZE_MIN +
          '" max="' + WRITER_SIZE_MAX + '" step="1" value="' + wsize + '"><output class="settings-value" id="settings-writer-size-out" for="settings-writer-size">' +
          wsize + ' px</output></span>' +
      '</div>' +
      '<div class="settings-field settings-inline">' +
        '<label class="settings-label" for="settings-script-scale">Script zoom</label>' +
        '<span class="settings-inline-control"><input type="range" id="settings-script-scale" min="' + Math.round(SCRIPT_SCALE_MIN * 100) +
          '" max="' + Math.round(SCRIPT_SCALE_MAX * 100) + '" step="10" value="' + Math.round(scale * 100) + '">' +
          '<output class="settings-value" id="settings-script-scale-out" for="settings-script-scale">' + Math.round(scale * 100) + ' %</output>' +
          '<button type="button" class="btn-outline is-small" data-settings-action="scale-reset"' + (scale === 1 ? " disabled" : "") + '>Reset to 100 %</button></span>' +
      '</div>') +
    section("Present",
      switchHtml("settings-prompter-mirror", "Mirror", "Flip the teleprompter left to right, for a beam-splitter glass.", flagOn(PROMPTER_KEYS.mirror)) +
      switchHtml("settings-prompter-flip", "Flip", "Turn it upside down, for a monitor mounted that way.", flagOn(PROMPTER_KEYS.flip)) +
      switchHtml("settings-prompter-scene", "One scene at a time", "Pause at the end of each scene.", flagOn(PROMPTER_KEYS.scene))) +
    section("You",
      '<div class="settings-field settings-inline">' +
        '<label class="settings-label" for="settings-name">Your name</label>' +
        '<span class="settings-inline-control"><input type="text" id="settings-name" autocomplete="name" placeholder="Your name" value="' +
          escapeHtml(name) + '"></span>' +
      '</div>' +
      '<p class="settings-hint">Signs your edits and comments.</p>' +
      personSwatchesHtml(name, "settings-person-color", "settings-label")) +
    section("Collaboration", collaborationHtml()) +
    section("Help & tips",
      '<div class="settings-actions">' +
        '<button type="button" class="btn-outline" data-settings-action="tagging-help">Show the tagging reference</button>' +
        '<button type="button" class="btn-outline" data-settings-action="tour">Take the tour again</button>' +
        '<button type="button" class="btn-outline" data-settings-action="desktop-notice">Show the desktop-app notice again</button>' +
      '</div>') +
    section("Data",
      '<div class="settings-actions">' +
        '<button type="button" class="btn-outline" data-settings-action="export-app-data">Export app data…</button>' +
        (importAvailable() ? '<button type="button" class="btn-outline" data-settings-action="import-app-data">Import app data…</button>' : '') +
        '<button type="button" class="btn-outline" data-settings-action="servers">Servers…</button>' +
        '<button type="button" class="btn-outline" data-settings-action="drive">Google Drive…</button>' +
      '</div>' +
      '<p class="settings-hint">App data is your version history, server bookmarks and these settings — take it to another computer or the desktop app.</p>');
}

function ensureModal() {
  var m = modal();
  if (m) return m;
  m = document.createElement("div");
  m.className = "modal-backdrop";
  m.id = SETTINGS_ID;
  m.hidden = true;
  m.innerHTML =
    '<div class="modal-panel settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">' +
      '<div class="modal-header">' +
        '<h2 id="settings-title">Settings</h2>' +
        '<button type="button" class="modal-close" data-settings-action="close" aria-label="Close"><svg aria-hidden="true" focusable="false"><use href="#i-close"/></svg></button>' +
      '</div>' +
      '<p class="modal-hint">How Splitpage works for you, on this device. Nothing here changes the script.</p>' +
      '<div class="settings-body" id="settings-body"></div>' +
    '</div>';
  document.body.appendChild(m);
  wireModal(m);
  return m;
}

// Uncommitted typing survives redraws caused by other settings
function typedFields() {
  return { "settings-name": COMMENT_NAME_KEY, "settings-default-wpm": DEFAULT_WPM_KEY,
           "settings-collab-server": COLLAB_SERVER_KEY };
}

function renderSettings(changedKey) {
  var m = modal();
  if (!m) return;
  var bodyEl = m.querySelector("#settings-body");
  var typed = {};
  var fields = typedFields();
  Object.keys(fields).forEach(function (fid) {
    var el = document.getElementById(fid);
    if (el && fields[fid] !== changedKey) typed[fid] = el.value;
  });
  var focusedId = document.activeElement && m.contains(document.activeElement) ? document.activeElement.id : "";
  var focusedRadio = document.activeElement && document.activeElement.type === "radio" && m.contains(document.activeElement)
    ? document.activeElement.name + "=" + document.activeElement.value : "";
  var scroll = bodyEl.scrollTop;
  bodyEl.innerHTML = bodyHtml();
  bodyEl.scrollTop = scroll;
  Object.keys(typed).forEach(function (fid) {
    var el = document.getElementById(fid);
    if (el) el.value = typed[fid];
  });
  var again = null;
  if (focusedRadio) {
    var parts = focusedRadio.split("=");
    again = bodyEl.querySelector('input[name="' + parts[0] + '"][value="' + parts[1] + '"]');
  } else if (focusedId) {
    again = document.getElementById(focusedId);
  }
  if (again) { try { again.focus({ preventScroll: true }); } catch (e) { again.focus(); } }
}

export function openSettings(opts) {
  opts = opts && typeof opts === "object" && !(opts instanceof Event) ? opts : {};
  var m = ensureModal();
  if (!m.hidden) return;
  var active = document.activeElement;
  settingsReturnFocus = active && active !== document.body ? active : document.getElementById("btn-file");
  renderSettings();
  m.hidden = false;
  var wanted = opts.focus ? document.getElementById(opts.focus) : null;
  var first = wanted || m.querySelector('input[name="settings-theme"]:checked') || m.querySelector("input, button");
  if (first) first.focus();
  if (wanted) {
    try { wanted.scrollIntoView({ block: "center" }); } catch (e) { wanted.scrollIntoView(); }
    if (typeof wanted.select === "function") wanted.select();
  }
}

export function closeSettings() {
  var m = modal();
  if (!m || m.hidden) return;
  m.hidden = true;
  var back = settingsReturnFocus;
  settingsReturnFocus = null;
  if (back && back.closest && back.closest("#file-menu")) back = document.getElementById("btn-file");
  if (back && document.contains(back) && back.offsetParent !== null) {
    try { back.focus({ preventScroll: true }); } catch (e) { back.focus(); }
  }
}

function announce(key) {
  writePref(key, readPref(key));
}

function applyChange(target) {
  var id = target.id, name = target.name;
  if (name === "settings-theme") { writePref(THEME_KEY, target.value === "system" ? null : target.value); return; }
  if (name === "settings-clock") { writePref(CLOCK_KEY, target.value === "system" ? null : target.value); return; }
  if (name === "settings-person-color") { setMyColor(target.value); return; }
  if (id === "settings-rundown-min") { writePref(RUNDOWN_MIN_KEY, target.checked ? "1" : "0"); return; }
  // Default value is stored as no key at all
  if (id === "settings-tag-icons") { writePref(TAG_ICONS_KEY, target.checked ? "1" : null); return; }
  if (id === "settings-video-thumbs") { writePref(VIDEO_THUMBS_KEY, target.checked ? null : "0"); return; }
  if (id === "settings-hide-shot") { setHideShotScenes(target.checked); return; }
  if (id === "settings-autosave") { setAutoSaveEnabled(target.checked); return; }
  if (id === "settings-prompter-mirror") { setPrompterMirror(target.checked); return; }
  if (id === "settings-prompter-flip") { setPrompterFlip(target.checked); return; }
  if (id === "settings-prompter-scene") { setPrompterSceneMode(target.checked); return; }
  if (id === "settings-default-wpm") {
    var n = Math.round(Number(target.value));
    if (isFinite(n) && n >= 60 && n <= 400) writePref(DEFAULT_WPM_KEY, n === 150 ? null : String(n));
    else target.value = readDefaultWpm();
    return;
  }
  if (id === "settings-writer-size") { applyWriterSize(Number(target.value), true); return; }
  if (id === "settings-script-scale") {
    var s = Math.round(Number(target.value)) / 100;
    if (isFinite(s) && s >= SCRIPT_SCALE_MIN && s <= SCRIPT_SCALE_MAX) writePref(SCRIPT_SCALE_KEY, String(s));
    return;
  }
  if (id === "settings-name") {
    var v = (target.value || "").trim();
    if (!v || v === getSavedAuthorName()) { target.value = getSavedAuthorName(); return; }
    writePref(COMMENT_NAME_KEY, v);
    updateIdentityChip();
    if (S.state) render();
  }
  if (id === "settings-collab-server") {
    var raw = (target.value || "").trim();
    var url = raw ? normalizeCollabServer(raw) : DEFAULT_COLLAB_SERVER;
    if (!url) {
      showToast("That isn't a web address — something like https://script.example.com/", "warn");
      target.value = readCollabServer();
      return;
    }
    if (url === readCollabServer()) { target.value = url; return; }
    writePref(COLLAB_SERVER_KEY, url === DEFAULT_COLLAB_SERVER ? null : url);
  }
}

function applyInput(target) {
  if (target.id === "settings-writer-size") {
    var out = document.getElementById("settings-writer-size-out");
    if (out) out.textContent = target.value + " px";
  } else if (target.id === "settings-script-scale") {
    var o = document.getElementById("settings-script-scale-out");
    if (o) o.textContent = target.value + " %";
  }
}

function clickFileMenuItem(action) {
  var btn = document.querySelector('#file-menu [data-file-action="' + action + '"]');
  if (btn && !btn.disabled) btn.click();
}

function runAction(action) {
  if (action === "close") { closeSettings(); return; }
  if (action === "scale-reset") { writePref(SCRIPT_SCALE_KEY, "1"); return; }
  if (action === "tagging-help") {
    closeSettings();
    showTaggingHelp();
    announce(TAGGING_HELP_KEY);
    return;
  }
  if (action === "tour") {
    closeSettings();
    writePref(TOUR_DONE_KEY, null);
    startTour();
    return;
  }
  if (action === "desktop-notice") {
    writePref(DESKTOP_NOTICE_KEY, null);
    if (typeof renderDesktopAppNotice === "function") renderDesktopAppNotice();
    showToast(S.DESKTOP ? "The desktop-app notice only shows in the browser." : "The desktop-app notice will show again.", "ok");
    return;
  }
  if (action === "collab-default") { writePref(COLLAB_SERVER_KEY, null); return; }
  if (action === "collab-signout") {
    signOutCollab();
    renderSettings();
    return;
  }
  if (action === "servers") { closeSettings(); openServersDialog(); return; }
  if (action === "drive") { closeSettings(); clickFileMenuItem("drive-open"); return; }
  if (action === "export-app-data") { closeSettings(); clickFileMenuItem("export-app-data"); return; }
  if (action === "import-app-data") { closeSettings(); clickFileMenuItem("import-app-data"); }
}

function wireModal(m) {
  m.addEventListener("change", function (e) { if (e.target && e.target.closest(".settings-body")) applyChange(e.target); });
  m.addEventListener("input", function (e) { if (e.target) applyInput(e.target); });
  m.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && e.target && (e.target.id === "settings-name" || e.target.id === "settings-default-wpm" ||
        e.target.id === "settings-collab-server")) {
      e.preventDefault();
      applyChange(e.target);
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeSettings(); return; }
    if (e.key !== "Tab") return;
    var focusables = Array.prototype.filter.call(
      m.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      function (el) { return !el.disabled && el.offsetParent !== null && !(el.type === "radio" && !el.checked); }
    );
    if (!focusables.length) return;
    var first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  m.addEventListener("click", function (e) {
    if (e.target === m) { closeSettings(); return; }
    var btn = e.target.closest("[data-settings-action]");
    if (btn && !btn.disabled) runAction(btn.getAttribute("data-settings-action"));
  });
}

function onPrefChanged(key) {
  if (key === THEME_KEY) applyTheme();
  if (key === TAG_ICONS_KEY) applyTagIcons();
  if (key === CLOCK_KEY) {
    updateSaveStatus();
    if (S.state) { render(); renderComments(); }
    var hist = document.getElementById("history-panel");
    if (hist && !hist.hidden) renderHistory();
  }
  if (key === COMMENT_NAME_KEY || key === PERSON_COLOR_KEY) updateIdentityChip();
  if (key === COLLAB_SERVER_KEY) updateCollaborateMenu();
  if (settingsOpen()) renderSettings(key);
}

export function __init() {
  document.addEventListener(PREF_EVENT, function (e) {
    onPrefChanged(e.detail && e.detail.key);
  });
  window.addEventListener("storage", function (e) {
    if (e.key && e.key.indexOf("splitpage-") === 0) onPrefChanged(e.key);
  });

  var menu = document.getElementById("file-menu");
  if (menu) {
    menu.addEventListener("click", function (e) {
      var item = e.target.closest('[data-file-action="settings"]');
      if (!item) return;
      e.stopPropagation();
      toggleFileMenu(false);
      openSettings();
    }, true);
  }

  window.__settingsTest = {
    open: openSettings,
    close: closeSettings,
    isOpen: settingsOpen,
    refreshSaveStatus: updateSaveStatus
  };
}
