import { S } from "./_state.js";
import { homeConn, serverHomeId } from "./_home.js";
import {
  normalizePersonColors,
  paletteColor,
  personKey,
  readMyColor,
  resolvePersonColor
} from "./00p-prefs.js";
import { escapeHtml } from "./02-state.js";
import { cssAttr } from "./04-richtext.js";
import { render } from "./05-render.js";
import { paintRundownPresence } from "./05p-rundown-presence.js";
import { getSavedAuthorName } from "./10-comments.js";
import {
  apiFetch,
  apiUrl,
  notePresenceRev,
  onServerDoc,
  serverSessionExpired
} from "./13-hosted.js";

/* Declared here, assigned in __init() below: these initialisers read the
   DOM, read storage, or depend on another module's value, so they have to
   run in fragment order rather than in whatever order the bundle lands in. */
var presenceLastActive;

/* ================= who else is here =================

   A row of coloured initials in the header for the other people in this
   hosted document, and a dot in the gutter of the scene each of them is in —
   on the field itself when they are in the same field as you, which is the
   one collision the merge cannot resolve silently (§3.6: it keeps both
   versions and leaves one as a review comment). Seeing them arrive is
   cheaper than cleaning up after them.

   TRANSPORT IS THE ONE THE APP ALREADY HAS. Nothing here opens a socket or
   an event stream: it posts to /api/presence on a short timer and is told
   who else is there in the same answer — one round trip, no second
   connection to keep alive, and the same token, CORS and tunnel path every
   other call takes.

   AND IT IS THE PULL CHANNEL, because it is the only thing in hosted mode
   that round-trips on its own. The answer names the document's rev as well
   as the people (#69); notePresenceRev() in 13-hosted.js is handed it and
   decides whether the document needs fetching and merging. Nothing about
   that belongs in this file, and nothing of it is awaited here.

   PRESENCE IS NEVER PART OF THE DOCUMENT. It is not in `state`, so
   invariant #4 is deliberately not in play; it never dirties anything, never
   reaches a save, never lands in the history, and the marks it paints live
   outside `.cell-editable` — inside one they would be read straight back
   into the row's HTML by syncFieldFromDom() and become part of the script.
   The server keeps it in memory for seconds at a time and never writes it
   down either (server.js's "who else is here").

   AND IT IS SILENT WHEN THERE IS NOBODY TO TELL. No hosted document, no
   server, a hidden tab, or a few minutes with no typing: nothing is sent at
   all, and what was on screen goes away. */

/* Two seconds: inside the "a second or two" this is worth anything at all
   for, and a moved caret is reported sooner than that (presenceBeatSoon). */
var PRESENCE_BEAT_MS = 2000;
/* A few minutes of nothing typed and this tab stops announcing itself; the
   server's own TTL then drops it from everyone else's list. */
var PRESENCE_IDLE_MS = 4 * 60 * 1000;
/* A server that has stopped answering is not asked every 2.5 seconds. */
var PRESENCE_BACKOFF_MS = 30000;
var PRESENCE_MAX_SHOWN = 8;
/* Per tab, not per person: two windows on one document are two people as
   far as "where is the caret" is concerned. sessionStorage so a reload is
   the same tab rather than a second ghost of it for one TTL. */
var PRESENCE_ID_KEY = "splitpage-presence-id";

/* A person's colour (#169): filled circles in B's bright values with dark
   initials, the same in both themes, the way the logo is. The eight are
   PERSON_COLORS (00p-prefs.js); the initials are #0F0E0C on every one of
   them (8:1 or more). The Comments, Production, Gear, B-roll and history
   panels, the gutter's "last edited by" and the header's identity dot all
   colour a person through personColor() below. */

var presenceSelf = "";
var presenceHere = [];                       /* others, as last reported */
var presenceWhere = { rowId: null, field: null };
var presenceTimer = null;
var presenceFailures = 0;
var presenceSends = 0;
var presenceAnnounced = false;

function presenceSelfId() {
  if (presenceSelf) return presenceSelf;
  try { presenceSelf = sessionStorage.getItem(PRESENCE_ID_KEY) || ""; } catch (e) {}
  if (!presenceSelf) {
    presenceSelf = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    try { sessionStorage.setItem(PRESENCE_ID_KEY, presenceSelf); } catch (e) { /* memory only */ }
  }
  return presenceSelf;
}

/* Anonymous is "Guest", and a stable colour: the seed is the name when
   there is one (so the same person is the same colour in everybody's
   window) and the client id when there is not (so two Guests differ). */
function presenceName(p) {
  return (p && p.name) || "Guest";
}

function presenceSeed(p) {
  return (p && p.name) || (p && p.id) || "";
}

/* Someone here now who picked a colour sends it with every beat (#194);
   anyone else is coloured by name like everybody else. */
function presenceColor(p) {
  return paletteColor(p && p.color) || personColor(presenceSeed(p));
}

/* name (personKey) → colour, from the people in this document right now
   who picked one. Rebuilt from each answer; a change repaints the script,
   whose gutters name people too. */
var presenceLiveColors = {};

function noteLiveColors(list) {
  var next = {};
  (list || []).forEach(function (p) {
    var color = paletteColor(p && p.color);
    var key = personKey(p && p.name);
    if (color && key) next[key] = color;
  });
  var changed = JSON.stringify(next) !== JSON.stringify(presenceLiveColors);
  presenceLiveColors = next;
  return changed;
}

/* The colour of a person, by name (#192, #194): your own pick for you,
   then what the people here now say, then the document's own map, then
   the hash of the name — which is what everyone got before anyone could
   pick, and still gets until they do. resolvePersonColor (00p-prefs.js)
   is the order; this only gathers what it reads. */
export function personColor(seed) {
  return resolvePersonColor(seed, {
    self: getSavedAuthorName(),
    selfColor: readMyColor(),
    live: presenceLiveColors,
    doc: S.state && S.state.personColors
  });
}

/* Your pick, into the document you are editing, so everyone who opens it
   later sees the colour you chose (#194). Called from markDirty() — every
   edit ends there (invariant #53) — so a document you only read is never
   changed by it. The map is bookkeeping, not content: 12a-undo.js leaves
   it out of the undo stack. */
export function recordMyColor(state) {
  if (!state) return false;
  var name = getSavedAuthorName().trim();
  var color = readMyColor();
  if (!name || !color) return false;
  var map = state.personColors && typeof state.personColors === "object" ? state.personColors : null;
  var have = "";
  if (map) {
    Object.keys(map).forEach(function (k) { if (personKey(k) === personKey(name)) have = k; });
    if (have && map[have] === color) return false;
  }
  var next = {};
  if (map) Object.keys(map).forEach(function (k) { if (k !== have) next[k] = map[k]; });
  next[name.slice(0, 80)] = color;
  state.personColors = normalizePersonColors(next);
  return true;
}

function presenceInitials(name) {
  var words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0].charAt(0) + words[words.length - 1].charAt(0)).toUpperCase();
}

/* The whole gate, in one place: a hosted document, a server that is
   answering, a tab somebody is actually looking at, and somebody who has
   touched the keyboard in the last few minutes. */
function presenceWanted() {
  if (!onServerDoc() || !S.serverMode.available || serverSessionExpired) return false;
  if (document.hidden) return false;
  return (Date.now() - presenceLastActive) <= PRESENCE_IDLE_MS;
}

/* WHERE AM I, read from the document rather than remembered from a focus
   event. `element.focus()` on a page that has never had window focus — a
   headless browser, a background tab — moves activeElement without firing
   focusin at all, so a location tracked purely through events is both
   wrong there and impossible to drive from a test. Anything that is not a
   script cell (a panel, a modal, nothing at all) leaves the last place in
   the script standing: that is still where they are working. */
function presenceLocation() {
  var el = document.activeElement;
  var cell = el && el.closest ? el.closest("#rows .cell-editable[data-id]") : null;
  if (cell) {
    presenceWhere = { rowId: cell.getAttribute("data-id"), field: cell.getAttribute("data-field") };
  } else if (el && el.id === "doc-title") {
    presenceWhere = { rowId: null, field: "title" };
  }
  return presenceWhere;
}

function presenceWhereKey() {
  var where = presenceLocation();
  return String(where.rowId) + "/" + String(where.field);
}

function presencePayload(gone) {
  presenceLocation();
  return {
    docId: serverHomeId(),
    id: presenceSelfId(),
    /* The author-name preference, the same one comments are signed with.
       Empty is not "anonymous is a secret" — it is what makes the other
       end say "Guest". */
    name: getSavedAuthorName() || "",
    /* The colour you picked (#194), "" until you pick — the others then
       colour you by your name, exactly as before. */
    color: readMyColor(),
    rowId: presenceWhere.rowId || "",
    field: presenceWhere.field || "",
    gone: !!gone
  };
}

function clearPresence() {
  if (!presenceHere.length) { paintPresence(); return; }
  setPresenceHere([]);
}

/* Everyone the server says is here, painted; and when what they say about
   their colours changed, the script too — its gutters name people. */
function setPresenceHere(list) {
  presenceHere = list || [];
  var recolored = noteLiveColors(presenceHere);
  paintPresence();
  if (recolored && S.state) render();
}

async function presenceTick() {
  var next = PRESENCE_BEAT_MS;
  try {
    if (!presenceWanted()) { clearPresence(); return; }
    presenceSends++;
    var body = await apiFetch("api/presence", { method: "POST", body: presencePayload(false) });
    presenceFailures = 0;
    presenceAnnounced = true;
    setPresenceHere((body && body.here) || []);
    /* The beat is the pull channel too (#69): the answer names the
       document's rev, and 13-hosted.js decides whether that means going and
       getting it. Presence knows nothing about documents and is not about to
       start — it hands the whole answer over and goes back to painting
       badges. Nothing is awaited: a GET and a merge are far slower than a
       beat, and the next beat must not be held up behind them. */
    notePresenceRev(body);
  } catch (e) {
    /* Deliberately never handleApiError(): a heartbeat must not put a toast
       on screen, reload the page, or open the PIN dialog. A server that is
       gone, a session that lapsed, a document that was deleted — all of
       them mean the same thing here, which is "show nobody". */
    presenceFailures++;
    if (presenceFailures >= 3) { clearPresence(); next = PRESENCE_BACKOFF_MS; }
  } finally {
    schedulePresence(next);
  }
}

function schedulePresence(ms) {
  if (presenceTimer) clearTimeout(presenceTimer);
  presenceTimer = setTimeout(presenceTick, ms);
}

/* A caret that has just moved to another scene is the one thing worth
   reporting faster than the beat. */
function presenceBeatSoon() {
  if (!presenceWanted()) return;
  schedulePresence(300);
}

/* ---- painting ----

   Rebuilt from scratch each time rather than diffed: eight badges is
   nothing to build, and anything cleverer would have to track which gutter
   or field-wrap a render or a renderRow() just repainted (05-render.js) —
   a repainted part takes its mark with it. */
export function paintPresence() {
  var bar = document.getElementById("presence-bar");
  var list = presenceHere.slice(0, PRESENCE_MAX_SHOWN);
  var mine = presenceLocation();
  if (bar) fitPresenceBar(bar);
  /* and a dot on each one's block in the rundown (#202) */
  paintRundownPresence();
  document.querySelectorAll(".presence-mark").forEach(function (el) { el.remove(); });
  if (!list.length) return;
  list.forEach(function (p) {
    if (!p.rowId) return;
    /* In the same field as you, the dot moves onto that field — the point
       is to see it before you both type, not afterwards. The mark goes on
       the .field-wrap, never inside the .cell-editable: DOM added inside
       one is read back into the document as part of the script. */
    var sameField = !!(p.field && p.field === mine.field && p.rowId === mine.rowId);
    var target = null;
    if (sameField) {
      var cell = document.querySelector('#rows .cell-editable[data-id="' + cssAttr(p.rowId) +
        '"][data-field="' + cssAttr(p.field) + '"]');
      target = cell ? cell.closest(".field-wrap") : null;
    }
    if (!target) {
      target = document.querySelector('#rows .row[data-id="' + cssAttr(p.rowId) + '"] .gutter');
    }
    if (!target) return;
    var mark = document.createElement("span");
    mark.className = "presence-mark" + (sameField ? " is-field" : "");
    mark.style.setProperty("--presence", presenceColor(p));
    mark.title = presenceName(p) + (sameField ? " is in this field" : " is in this scene");
    mark.textContent = presenceInitials(presenceName(p));
    target.appendChild(mark);
  });
}

/* The header's avatars. The bar never shrinks (the title gives way first,
   then the facts, #183), so five to eight people on a tight row used to
   push your name, the title and the facts under Search or Present. Now,
   when the row's left half would overflow, the last avatars fold into one
   "+N" chip, one at a time until it fits (as far as the chip alone); its
   tooltip names who is in it. Anyone past PRESENCE_MAX_SHOWN is in it
   from the start. Refitted on every repaint (each beat) and on resize. */
function presenceBarHtml(shown) {
  var html = presenceHere.slice(0, shown).map(function (p) {
    var name = presenceName(p);
    return '<span class="presence-chip" style="--presence:' + presenceColor(p) +
      '" title="' + escapeHtml(name) + ' is in this document">' +
      escapeHtml(presenceInitials(name)) + '</span>';
  }).join("");
  var rest = presenceHere.slice(shown);
  if (rest.length) {
    var names = rest.map(presenceName).join(", ");
    html += '<span class="presence-more" title="' + escapeHtml(names) +
      (rest.length === 1 ? " is" : " are") + ' in this document">+' + rest.length + '</span>';
  }
  return html;
}

function fitPresenceBar(bar) {
  var shown = Math.min(presenceHere.length, PRESENCE_MAX_SHOWN);
  bar.innerHTML = presenceBarHtml(shown);
  bar.hidden = !presenceHere.length;
  var left = bar.closest(".topbar-left");
  if (!left || bar.hidden) return;
  while (shown > 0 && left.scrollWidth > left.clientWidth + 1) {
    shown--;
    bar.innerHTML = presenceBarHtml(shown);
  }
}

var presenceFitFrame = 0;
function refitPresenceBar() {
  if (presenceFitFrame || !presenceHere.length) return;
  presenceFitFrame = requestAnimationFrame(function () {
    presenceFitFrame = 0;
    var bar = document.getElementById("presence-bar");
    if (bar) fitPresenceBar(bar);
  });
}

/* The people shown, as the rundown's dots want them (#202,
   05p-rundown-presence.js): the same ones and the same colours as the
   header's avatars. */
export function presenceShown() {
  return presenceHere.slice(0, PRESENCE_MAX_SHOWN).map(function (p) {
    return {
      id: String((p && p.id) || presenceSeed(p)),
      name: presenceName(p),
      color: presenceColor(p),
      rowId: (p && p.rowId) || "",
      field: (p && p.field) || ""
    };
  });
}

/* ---- what counts as being here ---- */

/* Every one of these is "somebody is still here", and any of them may also
   have moved the caret into another field — which is the one thing worth
   telling the others about sooner than the next beat. Reading the location
   is one closest() call on activeElement, so checking it on a selection
   change costs nothing worth saving. */
function notePresenceActivity() {
  presenceLastActive = Date.now();
  var was = String(presenceWhere.rowId) + "/" + String(presenceWhere.field);
  if (presenceWhereKey() === was) return;
  paintPresence();
  presenceBeatSoon();
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  presenceLastActive = Date.now();

  (function wirePresence() {
    window.addEventListener("keydown", notePresenceActivity, true);
    window.addEventListener("pointerup", notePresenceActivity, true);
    window.addEventListener("focusin", notePresenceActivity, true);
    document.addEventListener("selectionchange", notePresenceActivity);
    /* the header's avatars fold into "+N" to fit the row (fitPresenceBar) */
    window.addEventListener("resize", refitPresenceBar);
    /* Coming back to the tab is being here again, and worth saying at once. */
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState !== "hidden") { notePresenceActivity(); presenceBeatSoon(); }
    });
    /* Going away for good. pagehide, not unload: it fires for a closed tab, a
       navigation and a page going into the back/forward cache, which is the
       whole of "this tab is no longer here". Without it the others would keep
       showing this person for one TTL. */
    window.addEventListener("pagehide", function () {
      if (!presenceAnnounced || !presenceWanted()) return;
      var payload = presencePayload(true);
      /* sendBeacon cannot set a header, so the token travels in the body for
         this one call — the same credential, and the only route that takes
         it that way (server.js's presence route). text/plain because a
         beacon is never preflighted: any other content type simply would not
         be sent to a server on another origin. */
      /* The connection the document was opened through (#11): this tab's
         own, which in another tab may be another server entirely. */
      var c = homeConn();
      if (c && c.token) payload.token = c.token;
      var url = apiUrl("api/presence");
      var text = JSON.stringify(payload);
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon(url, new Blob([text], { type: "text/plain;charset=UTF-8" }));
          return;
        }
        fetch(url, {
          method: "POST",
          body: text,
          keepalive: true,
          headers: { "Content-Type": "text/plain;charset=UTF-8" },
          credentials: c && c.serverUrl ? "omit" : "same-origin"
        });
      } catch (e) { /* the server's TTL drops this tab a few seconds later */ }
    });
    schedulePresence(PRESENCE_BEAT_MS);
  })();

  /* ---- test hook ----

     The harness cannot start server.js with an environment, so the wire is
     tested in tools/test-server.mjs and everything this side does with the
     answer is tested through here — the same split window.__hostedTest
     (13-hosted.js) and window.__updateTest (20a-update.js) draw. Nothing in
     the app reads this. */
  window.__presenceTest = {
    /* Answer as the server would have. */
    apply: function (here) { presenceFailures = 0; setPresenceHere(here || []); },
    payload: presencePayload,
    wanted: presenceWanted,
    beat: presenceTick,
    sends: function () { return presenceSends; },
    where: presenceLocation,
    /* Only ever what activeElement does not already answer: with a script
       cell focused, presenceLocation() reads the real thing straight back
       over this. */
    setWhere: function (w) { presenceWhere = w || { rowId: null, field: null }; paintPresence(); },
    goIdle: function () { presenceLastActive = 0; },
    color: presenceColor,
    id: presenceSelfId
  };
}
