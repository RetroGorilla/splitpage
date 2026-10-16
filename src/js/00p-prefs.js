import {
  PERSON_COLORS,
  lookupByName,
  mergePersonColors,
  normalizePersonColors,
  paletteColor,
  personKey
} from "../core/document/person-colors.ts";
export { PERSON_COLORS, mergePersonColors, normalizePersonColors, paletteColor, personKey };

export var PREF_EVENT = "splitpage:pref";

export var CLOCK_KEY = "splitpage-clock";
export var THEME_KEY = "splitpage-theme";
export var PERSON_COLOR_KEY = "splitpage-person-color";
export var DEFAULT_WPM_KEY = "splitpage-default-wpm";
export var RUNDOWN_MIN_KEY = "splitpage-rundown-min";
export var SCRIPT_SCALE_KEY = "splitpage-script-scale";
export var SCRIPT_SCALE_MIN = 0.7, SCRIPT_SCALE_MAX = 2;
export var VIDEO_THUMBS_KEY = "splitpage-video-thumbs";
export var TAG_ICONS_KEY = "splitpage-tag-icons";

export function readPref(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

export function videoThumbsOn() {
  return readPref(VIDEO_THUMBS_KEY) !== "0";
}

export function tagIconsOn() {
  return readPref(TAG_ICONS_KEY) === "1";
}

export function applyTagIcons() {
  if (tagIconsOn()) document.documentElement.setAttribute("data-tag-icons", "");
  else document.documentElement.removeAttribute("data-tag-icons");
}

export function writePref(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch (e) { }
  try {
    document.dispatchEvent(new CustomEvent(PREF_EVENT, { detail: { key: key, value: value == null ? null : String(value) } }));
  } catch (e) { }
}

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
  { name: "tagIcons", key: "splitpage-tag-icons", valid: isFlag },
  { name: "scriptScale", key: "splitpage-script-scale",
    valid: function (v) { var n = Number(v); return /^\d(\.\d{1,3})?$/.test(v) && n >= SCRIPT_SCALE_MIN && n <= SCRIPT_SCALE_MAX; } }
];

export var CLOCK_MODES = ["system", "12", "24"];

export function readClockPref() {
  var v = readPref(CLOCK_KEY);
  return CLOCK_MODES.indexOf(v) === -1 ? "system" : v;
}

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

export function formatClock(when, mode) {
  var d = toDate(when);
  if (!d) return "";
  try {
    return new Intl.DateTimeFormat(undefined, withCycle({ hour: "numeric", minute: "2-digit" }, mode)).format(d);
  } catch (e) {
    return d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes();
  }
}

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

export var SAVED_JUST_NOW_MS = 60000;
export function savedStatusText(savedAt, now) {
  return savedAt && now - savedAt < SAVED_JUST_NOW_MS ? "Saved just now" : "All changes saved";
}

export function savedWhenText(savedAt, now, mode) {
  if (!savedAt) return "";
  var at = new Date(savedAt);
  return at.toDateString() === new Date(now).toDateString()
    ? formatClock(at, mode) : formatDateClock(at, null, mode);
}

export var THEME_MODES = ["system", "light", "dark"];

export function readThemePref() {
  var v = readPref(THEME_KEY);
  return THEME_MODES.indexOf(v) === -1 ? "system" : v;
}

export function applyTheme(mode) {
  mode = THEME_MODES.indexOf(mode) === -1 ? readThemePref() : mode;
  var root = document.documentElement;
  if (mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
  var bridge = typeof window !== "undefined" ? window.splitpageDesktop : null;
  if (bridge && typeof bridge.setTheme === "function") {
    try { bridge.setTheme(mode); } catch (e) { }
  }
}

export function readDefaultWpm() {
  var n = parseInt(readPref(DEFAULT_WPM_KEY), 10);
  return isFinite(n) && n >= 60 && n <= 400 ? n : 150;
}

export var PERSON_COLOR_NAMES = ["Blue", "Amber", "Violet", "Green", "Pink", "Lime", "Coral", "Teal"];

export function readMyColor() {
  return paletteColor(readPref(PERSON_COLOR_KEY));
}

export function hashedPersonColor(seed) {
  seed = String(seed || "");
  var hash = 0;
  for (var i = 0; i < seed.length; i++) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  return PERSON_COLORS[Math.abs(hash) % PERSON_COLORS.length];
}

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

export function __init() {
  applyTheme();
  applyTagIcons();
  window.addEventListener("storage", function (e) {
    if (e.key === THEME_KEY) applyTheme();
    if (e.key === TAG_ICONS_KEY) applyTagIcons();
  });
}
