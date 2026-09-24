/* ================= per-person preferences (#180, #181, #194) =================

   Three things every other module reaches for, kept here so that none of
   them has to import a module with a DOM or a document behind it:

   - writePref(): the one way a setting is changed. It writes localStorage
     and then says so on `document` as a "splitpage:pref" CustomEvent
     ({detail: {key, value}}), so whatever draws that setting — Settings,
     the rundown strip, the script zoom — can follow a change made
     anywhere else. The existing switches (the File menu, the prompter's
     own buttons) still write their keys themselves; Settings reads the
     same keys, so there is one source of truth either way.

   - formatClock() and friends: every clock time the app shows (the save
     status, Version history, comments) goes through here. By default it
     follows the system's own format — Intl.DateTimeFormat with no hour12
     forced — and `splitpage-clock` ("system" | "12" | "24") overrides it.

   - a person's colour: the eight PERSON_COLORS, the colour you picked
     (`splitpage-person-color`), and the pure halves of how a name gets its
     colour (resolvePersonColor) and how a document's name → colour map is
     read and merged (normalizePersonColors / mergePersonColors). The
     live half — who is online, which document is open — is personColor()
     in 13a-presence.js.

   Nothing here runs at evaluation time; __init() applies the theme. */

export var PREF_EVENT = "splitpage:pref";

export var CLOCK_KEY = "splitpage-clock";
export var THEME_KEY = "splitpage-theme";
export var PERSON_COLOR_KEY = "splitpage-person-color";
export var DEFAULT_WPM_KEY = "splitpage-default-wpm";
/* Other lanes' preferences, surfaced in Settings (#181): the rundown strip
   minimised ("1"/"0", #178) and the script's zoom (a number, 1 = 100 %). */
export var RUNDOWN_MIN_KEY = "splitpage-rundown-min";
export var SCRIPT_SCALE_KEY = "splitpage-script-scale";
export var SCRIPT_SCALE_MIN = 0.7, SCRIPT_SCALE_MAX = 2;
/* Settings ▸ Fetch video thumbnails (#141): "0" off, absent (or "1") on —
   whether a pasted YouTube or Vimeo link's thumbnail is fetched from the
   site (05v-video.js). */
export var VIDEO_THUMBS_KEY = "splitpage-video-thumbs";

export function readPref(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

/* On unless it was switched off. */
export function videoThumbsOn() {
  return readPref(VIDEO_THUMBS_KEY) !== "0";
}

/* `value` null removes the key. The event fires whether or not storage
   took the write, so what is on screen follows the choice for this page
   at least. */
export function writePref(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch (e) { /* storage blocked — the event still carries it */ }
  try {
    document.dispatchEvent(new CustomEvent(PREF_EVENT, { detail: { key: key, value: value == null ? null : String(value) } }));
  } catch (e) { /* no document (unit tests) */ }
}

/* The settings File ▸ Export app data… carries (#181) beside the ones it
   always had (20h-appdata.js), so moving to the desktop app keeps them.
   Each is imported only where this machine has none, and only in the shape
   the app itself writes. The names are the bundle's keys, and none of them
   may look like a credential (invariant #48). */
function isFlag(v) { return v === "0" || v === "1"; }
export var SETTINGS_APPDATA_PREFS = [
  { name: "theme", key: "splitpage-theme", valid: function (v) { return THEME_MODES.indexOf(v) !== -1; } },
  { name: "clock", key: "splitpage-clock", valid: function (v) { return CLOCK_MODES.indexOf(v) !== -1; } },
  { name: "personColor", key: "splitpage-person-color", valid: function (v) { return !!paletteColor(v); } },
  { name: "defaultWpm", key: "splitpage-default-wpm",
    valid: function (v) { var n = /^\d{2,3}$/.test(v) ? parseInt(v, 10) : NaN; return n >= 60 && n <= 400; } },
  { name: "hideShot", key: "splitpage-hide-shot", valid: isFlag },
  { name: "prompterMirror", key: "splitpage-prompter-mirror", valid: isFlag },
  { name: "prompterFlip", key: "splitpage-prompter-flip", valid: isFlag },
  { name: "prompterSceneMode", key: "splitpage-prompter-scene-mode", valid: isFlag },
  { name: "rundownMin", key: "splitpage-rundown-min", valid: isFlag },
  { name: "videoThumbs", key: "splitpage-video-thumbs", valid: isFlag },
  { name: "scriptScale", key: "splitpage-script-scale",
    valid: function (v) { var n = Number(v); return /^\d(\.\d{1,3})?$/.test(v) && n >= SCRIPT_SCALE_MIN && n <= SCRIPT_SCALE_MAX; } }
];

/* ---- the clock (#180) ---- */

export var CLOCK_MODES = ["system", "12", "24"];

export function readClockPref() {
  var v = readPref(CLOCK_KEY);
  return CLOCK_MODES.indexOf(v) === -1 ? "system" : v;
}

/* The Intl options that say 12 or 24 hours, or none at all for the system's
   own. hourCycle rather than hour12:false — some engines read hour12:false
   as "h24", which shows a quarter past midnight as 24:15. */
export function clockCycle(mode) {
  if (mode === "12") return { hourCycle: "h12" };
  if (mode === "24") return { hourCycle: "h23" };
  return {};
}

function withCycle(opts, mode) {
  var cycle = clockCycle(mode == null ? readClockPref() : mode);
  var out = {};
  Object.keys(opts).forEach(function (k) { out[k] = opts[k]; });
  Object.keys(cycle).forEach(function (k) { out[k] = cycle[k]; });
  return out;
}

function toDate(when) {
  var d = when instanceof Date ? when : new Date(when);
  return isNaN(d.getTime()) ? null : d;
}

/* "2:52 PM" or "14:52" — a time of day, nothing else. `mode` is for tests;
   the app passes nothing and gets the person's setting. */
export function formatClock(when, mode) {
  var d = toDate(when);
  if (!d) return "";
  try {
    return new Intl.DateTimeFormat(undefined, withCycle({ hour: "numeric", minute: "2-digit" }, mode)).format(d);
  } catch (e) {
    return d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes();
  }
}

/* A date and a time: "Sep 21, 2:52 PM", with the year when asked. */
export function formatDateClock(when, opts, mode) {
  var d = toDate(when);
  if (!d) return "";
  var o = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  if (opts && opts.year) o.year = "numeric";
  try {
    return new Intl.DateTimeFormat(undefined, withCycle(o, mode)).format(d);
  } catch (e) {
    return d.toDateString() + " " + formatClock(d, mode);
  }
}

/* The header's "Saved …" words (12-dirty-toast.js), as a pure function of
   when the save was and what time it is now. */
export function savedAgoPhrase(savedAt, now, mode) {
  if (!savedAt) return "";
  var mins = Math.floor((now - savedAt) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + " min ago";
  return "at " + formatClock(new Date(savedAt), mode);
}

/* ---- the theme (#181) ---- */

export var THEME_MODES = ["system", "light", "dark"];

export function readThemePref() {
  var v = readPref(THEME_KEY);
  return THEME_MODES.indexOf(v) === -1 ? "system" : v;
}

/* data-theme on <html> is what app.css's two dark blocks key on; "system"
   is no attribute at all, so prefers-color-scheme decides. The desktop
   shell is told too: its title bar and tab strip are drawn by main, and
   nativeTheme.themeSource is what they follow (desktop/main.js). */
export function applyTheme(mode) {
  mode = THEME_MODES.indexOf(mode) === -1 ? readThemePref() : mode;
  var root = document.documentElement;
  if (mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
  var bridge = typeof window !== "undefined" ? window.splitpageDesktop : null;
  if (bridge && typeof bridge.setTheme === "function") {
    try { bridge.setTheme(mode); } catch (e) { /* an older shell without the call */ }
  }
}

/* ---- default reading speed for new scripts (#181) ---- */

export function readDefaultWpm() {
  var n = parseInt(readPref(DEFAULT_WPM_KEY), 10);
  return isFinite(n) && n >= 60 && n <= 400 ? n : 150;
}

/* ---- a person's colour (#192, #194) ----

   The eight colours (#169): filled circles in B's bright values with dark
   initials, the same in both themes — preview blue and program amber
   first, then the tag palette's hues. The names are what a screen reader
   says for each swatch. */
export var PERSON_COLORS = [
  "#80BDFB", "#F9B64F", "#CBA1FA", "#73D4AC",
  "#F89DC9", "#C8DE63", "#EF958E", "#64D1D7"
];
export var PERSON_COLOR_NAMES = ["Blue", "Amber", "Violet", "Green", "Pink", "Lime", "Coral", "Teal"];

/* One of the eight, in its canonical spelling, or "". Anything else —
   another hex, a CSS expression, an object — is no colour. */
export function paletteColor(value) {
  if (typeof value !== "string") return "";
  var up = value.trim().toUpperCase();
  return PERSON_COLORS.indexOf(up) === -1 ? "" : up;
}

export function readMyColor() {
  return paletteColor(readPref(PERSON_COLOR_KEY));
}

/* The colour a name hashes to — what everybody got before #194, and what
   anyone who never picks still gets. Stable across windows and machines. */
export function hashedPersonColor(seed) {
  seed = String(seed || "");
  var hash = 0;
  for (var i = 0; i < seed.length; i++) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  return PERSON_COLORS[Math.abs(hash) % PERSON_COLORS.length];
}

/* Names compare the way people type them: trimmed, case-insensitive. */
export function personKey(name) {
  return String(name == null ? "" : name).trim().toLowerCase();
}

var PERSON_NAME_MAX = 80;
var PERSON_MAP_MAX = 200;

/* A document's `personColors` map as read from anywhere (a file, a merge,
   a server): {name: colour}, each name trimmed and at most 80 characters,
   each colour one of the eight, at most 200 entries, and the prototype's
   own names never used as keys. null when nothing valid is left, so a
   document without picks never grows the key. */
export function normalizePersonColors(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  var out = {}, seen = Object.create(null), n = 0;
  Object.keys(raw).forEach(function (name) {
    if (n >= PERSON_MAP_MAX) return;
    /* eslint-disable-next-line no-control-regex -- stripping them is the job. */
    var clean = String(name).replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, PERSON_NAME_MAX);
    var color = paletteColor(raw[name]);
    if (!clean || !color || clean === "__proto__" || clean === "constructor" || clean === "prototype") return;
    var key = personKey(clean);
    if (seen[key]) return;
    seen[key] = true;
    out[clean] = color;
    n++;
  });
  return n ? out : null;
}

function lookupByName(map, name) {
  if (!map) return "";
  if (Object.prototype.hasOwnProperty.call(map, name)) return paletteColor(map[name]);
  var key = personKey(name);
  var hit = "";
  Object.keys(map).some(function (k) {
    if (personKey(k) !== key) return false;
    hit = paletteColor(map[k]);
    return true;
  });
  return hit;
}

/* Base-aware, per name: the side that moved a name's colour off the base
   wins; both moved it — mine, since a pick is almost always about the
   person merging; a name only one side has is kept. Nothing is ever
   removed (the app never removes one). null when the result is empty. */
export function mergePersonColors(base, mine, theirs) {
  base = normalizePersonColors(base) || {};
  mine = normalizePersonColors(mine) || {};
  theirs = normalizePersonColors(theirs) || {};
  var out = {}, taken = Object.create(null);
  function put(name, color) {
    var key = personKey(name);
    if (taken[key]) return;
    taken[key] = true;
    out[name] = color;
  }
  Object.keys(mine).forEach(function (name) {
    var m = mine[name], t = lookupByName(theirs, name), b = lookupByName(base, name);
    put(name, t && m === b ? t : m);
  });
  Object.keys(theirs).forEach(function (name) { put(name, theirs[name]); });
  /* and a name only the base still has: nothing removes one on purpose,
     so it is an older copy on both sides, not a deletion */
  Object.keys(base).forEach(function (name) { put(name, base[name]); });
  return normalizePersonColors(out);
}

/* A name's colour, first match wins:
     1. your own pick, when the name is yours (you are always "live" to
        yourself, online or not);
     2. what the people in this document right now say (presence);
     3. the document's map, written by everyone who picked and edited it;
     4. the hash of the name — today's colour, for anyone who never picked.
   ctx = {self, selfColor, live: {personKey: colour}, doc: {name: colour}}. */
export function resolvePersonColor(name, ctx) {
  ctx = ctx || {};
  var key = personKey(name);
  if (key) {
    var mine = paletteColor(ctx.selfColor);
    if (mine && ctx.self && personKey(ctx.self) === key) return mine;
    var live = ctx.live && Object.prototype.hasOwnProperty.call(ctx.live, key) ? paletteColor(ctx.live[key]) : "";
    if (live) return live;
    var doc = lookupByName(ctx.doc, name);
    if (doc) return doc;
  }
  return hashedPersonColor(name);
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — right after 00-prelude captured PAGE_SHELL, so the
   theme attribute never lands in a saved copy of the page. */
export function __init() {
  applyTheme();
  /* Another tab changed it: follow, so two windows never disagree. */
  window.addEventListener("storage", function (e) {
    if (e.key === THEME_KEY) applyTheme();
  });
}
