import { S } from "./_state.js";
import {
  conn,
  home,
  homeConn,
  normalizeServerUrl,
  serverHomeId,
  setConnection,
  setHome,
  updateConnection
} from "./_home.js";
import { escapeHtml, migrateRows } from "./02-state.js";
import {
  copyDocHistorySafe,
  migrateDocument,
  mintDocId,
  normalizeDocId
} from "./02b-doc-id.js";
import {
  applyMerge,
  clearStash,
  cloneState,
  getEditorName,
  mergeStates,
  pushSnapshot,
  readStash,
  reportMerge,
  stashLocalWork,
  updateIdentityChip
} from "./03-sync.js";
import { cssAttr, inertBody } from "./04-richtext.js";
import { withBusyBar } from "./04b-busy.js";
import { render } from "./05-render.js";
import { resetProductionPanelState } from "./07-production-tags.js";
import {
  captureReplyDrafts,
  formatTimestamp,
  getSavedAuthorName,
  nowIso,
  renderComments,
  saveAuthorName
} from "./10-comments.js";
import { clearDirty, showToast } from "./12-dirty-toast.js";
import { deliverFile, updateFileChip } from "./18-local-files.js";
import {
  joinServer,
  openPinDialog,
  openServersDialog,
  shortHost,
  tunnelCommand,
  updateConnectMenu
} from "./20e-connect.js";
import { closeNewTabPage } from "./20j-newtab.js";

/* Declared here, assigned in __init() below: these initialisers read the
   DOM, read storage, or depend on another module's value, so they have to
   run in fragment order rather than in whatever order the bundle lands in. */
var sharedDocId;

/* ================= hosted documents =================

   Everything here is additive and inert unless the page was actually served
   by a Splitpage document server (server/server.js). Opened from a file://
   path, or from any plain static host, /api/health simply fails and the app
   behaves exactly as it always has — local files, local saves, no server.

   The compare-and-set save below is what the three-way merge at the top of
   this file was written for and has been waiting for: every PUT carries the
   rev this view loaded, the server rejects the write if anyone saved in the
   meantime and hands back their version, and mergeStates() reconciles the
   two instead of either side losing work.

   WHO YOU ARE is still not this app's business. Real authentication belongs
   to Cloudflare Access (or a VPN) sitting in front of the server, and this
   code only ever *reads* who Access says you are, to fill in a name.

   What this file does now carry is a join PIN — a shared code a LAN host
   can set so a stranger on the same wifi cannot simply open the address and
   read everything. Post the PIN once, get a token, send that token with
   every request. It is a door lock, not an identity: it says you were told
   the code, nothing more, and it travels in the clear over plain HTTP. A
   server on the internet still needs Access in front of it.

   A page can also be pointed at a server that did not serve it — its
   connection's `serverUrl` — so a copy on disk, or one served by a
   different machine, can open documents from someone's shared session.
   That needs the server to allow this origin (ALLOW_ORIGINS) and, if it
   has one, the PIN.

   THE CONNECTION IS THIS TAB'S (#11). `conn` (_home.js) is the one record
   of which server this page talks to, the token it carries there, the role
   the server gave it and the SSH tunnel it rides on. Every tab is its own
   page, so two tabs can be on two servers — or one on a server and one on
   a file — at once, and pointing one somewhere else leaves the other
   exactly where it was. Before this the base and a remembered token lived
   in localStorage, which every tab of the origin shares: switching server
   in one tab re-pointed the next tab to load, and a remembered token was
   sent to whichever server happened to be current.

   ALL OF THIS IS BROWSER STATE — localStorage and sessionStorage, per
   browser, per person. None of it is ever written into the document, so
   invariant #4 (nothing may be added to the state object without going
   through migrateRows) is deliberately not in play here, and no key below
   may ever be moved into `state`. Nor into update-status.json or anything
   else the static handler serves (invariant #29). */

/* The server a FRESH page starts on: "" is same-origin, the server that
   served this page. Written when the reader picks a server in the Servers
   dialog; read only by a page that has no server of its own yet (below). */
var SERVER_BASE_KEY = "splitpage-server-base";
/* THIS tab's server, {serverUrl, tunnel}: sessionStorage, which is per tab
   — it survives this tab's reload, and another tab switching server never
   touches it. */
var TAB_SERVER_KEY = "splitpage-tab-server";
/* This tab's token, {serverUrl, token}, sessionStorage: closing the tab
   forgets the code, which is the right default for a code someone read out
   to you once. It names the server it was given for, so it can never be
   sent anywhere else. (Before #11 this key held the bare token.) */
var SERVER_TOKEN_KEY = "splitpage-server-token";
/* "Remember on this device": {serverUrl: token} in localStorage — one per
   server, never sent to any other. The legacy single remembered token
   (localStorage "splitpage-server-token") is moved in here once, under the
   base it was remembered for. */
var REMEMBERED_TOKENS_KEY = "splitpage-server-tokens";
/* Minted per launch by start.mjs, arrives in the URL fragment, lives only
   as long as this tab. */
var LAUNCH_TOKEN_KEY = "splitpage-launch-token";
/* The key a review link carries, also in the fragment and also per launch.
   Kept for this tab so a reload does not send the reviewer back to a code
   they were never told — the token it buys is sessionStorage too. */
var REVIEW_KEY_KEY = "splitpage-review-key";

var launchToken = "";
var reviewKey = "";

/* What this browser is allowed to do here, as the SERVER sees it — `conn.role`:
   "edit", "review", or "" before we have asked. It is read back from /api/me
   every time the tab connects, never stored, and never inferred from
   anything local — a review session that reconnects is still a review
   session, and nothing on this side can promote itself by editing its own
   storage. */

S.serverMode = { available: false, readOnly: false, checked: false,
                   authRequired: false, reviewAvailable: false, version: null };
/* The hosted document we are editing is `home` when its kind is "server"
   (_home.js): {kind, id, rev}. */
var serverIdentity = null;              /* { email, name } from Cloudflare Access */
export var serverSessionExpired = false;
var serverDocs = [];                    /* last listing, for the picker */

export function onServerDoc() { return home.kind === "server"; }

/* Viewing a hosted document through the review credential: the editor is
   read-only and only the comment machinery stays live. Gated on there
   being a server document open, because the same tab can still have a
   local file of its own — this browser is restricted THERE, not here. */
export function reviewMode() {
  var c = homeConn();
  return !!c && c.role === "review";
}

/* A Cloudflare Access session that has expired does not fail — it answers
   200 with an HTML sign-in page. Left undetected that lands as "unexpected
   token <" in the middle of an autosave, or worse, looks like success. Any
   answer that is redirected or is not JSON is treated as a lapsed session. */
function ApiError(code, message) {
  var e = new Error(message || code);
  e.code = code;
  return e;
}

/* ---- where the API is, and what we send with it ---- */

/* Always ends in a single slash so apiUrl() can just concatenate, and
   always carries a scheme so a typed "192.168.1.20:8791" is not resolved
   as a relative path. The one copy is _home.js's, where the connection
   record checks against it; this name stays for the callers that had it. */
export var normalizeServerBase = normalizeServerUrl;

function readJsonFrom(storage, key) {
  try {
    var raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function rememberedTokens() {
  var map = readJsonFrom(localStorage, REMEMBERED_TOKENS_KEY);
  return map && typeof map === "object" && !Array.isArray(map) ? map : {};
}

function writeRememberedTokens(map) {
  try {
    if (Object.keys(map).length) localStorage.setItem(REMEMBERED_TOKENS_KEY, JSON.stringify(map));
    else localStorage.removeItem(REMEMBERED_TOKENS_KEY);
  } catch (e) { /* it just won't be remembered */ }
}

/* The token "Remember on this device" kept for THIS server, or "". */
function rememberedTokenFor(serverUrl) {
  var t = rememberedTokens()[serverUrl];
  return typeof t === "string" ? t : "";
}

/* The one legacy remembered token, from before tokens were kept per server.
   It can only have belonged to the base that was current when it was
   remembered — switching server always cleared it — so that is where it
   goes. */
function migrateLegacyRememberedToken() {
  var legacy, base;
  try {
    legacy = localStorage.getItem(SERVER_TOKEN_KEY);
    base = normalizeServerUrl(localStorage.getItem(SERVER_BASE_KEY) || "");
  } catch (e) { return; }
  if (!legacy) return;
  var map = rememberedTokens();
  if (!map[base]) map[base] = legacy;
  writeRememberedTokens(map);
  try { localStorage.removeItem(SERVER_TOKEN_KEY); } catch (e) {}
}

/* This tab's own token, if it was given for this server. A bare string is
   the pre-#11 shape: one token for whatever server this tab was on, which
   is the server this tab is loading onto now. */
function sessionTokenFor(serverUrl) {
  var raw;
  try { raw = sessionStorage.getItem(SERVER_TOKEN_KEY); } catch (e) { return ""; }
  if (!raw) return "";
  var rec;
  try { rec = JSON.parse(raw); } catch (e) { rec = null; }
  if (rec && typeof rec === "object") {
    return rec.serverUrl === serverUrl && typeof rec.token === "string" ? rec.token : "";
  }
  return /^[A-Za-z0-9_-]+$/.test(raw) ? raw : "";
}

function saveTabServer() {
  try {
    sessionStorage.setItem(TAB_SERVER_KEY, JSON.stringify({ serverUrl: conn.serverUrl, tunnel: conn.tunnel }));
    if (conn.token) {
      sessionStorage.setItem(SERVER_TOKEN_KEY, JSON.stringify({ serverUrl: conn.serverUrl, token: conn.token }));
    } else {
      sessionStorage.removeItem(SERVER_TOKEN_KEY);
    }
  } catch (e) { /* it just won't survive a reload */ }
}

/* Where this page starts, most specific first:
     1. desktop — the tab's own source record, handed over by main at boot
        (TAB-BOOT-SYNC's `connection`). A restored or newly opened server
        tab is on the server its document lives on, whatever any other tab
        last picked. Main may also hand over the token of the tab that
        opened this one, so opening a document in a new tab does not ask
        for the PIN again.
     2. this tab's own sessionStorage — a reload stays where it was.
     3. the default a fresh page starts on (localStorage), which is
        whatever server was last deliberately picked.
   The token then comes from the boot record, this tab's session, or
   "Remember on this device" for THAT server — in that order, and never
   from anything kept for another server. */
function loadTabConnection() {
  migrateLegacyRememberedToken();
  var from = null;
  var boot = S.DESKTOP && S.DESKTOP.connection;
  if (boot && typeof boot === "object") from = boot;
  if (!from) {
    var mine = readJsonFrom(sessionStorage, TAB_SERVER_KEY);
    if (mine && typeof mine === "object") from = mine;
  }
  if (!from) {
    var fallback;
    try { fallback = localStorage.getItem(SERVER_BASE_KEY) || ""; } catch (e) { fallback = ""; }
    from = { serverUrl: fallback };
  }
  var serverUrl = normalizeServerUrl(from.serverUrl);
  var token = (typeof from.token === "string" && from.token) || sessionTokenFor(serverUrl) ||
              rememberedTokenFor(serverUrl);
  try {
    setConnection({ serverUrl: serverUrl, token: token, tunnel: from.tunnel || null });
  } catch (e) {
    /* A tunnel or an address that no longer validates is not a reason to
       fail the boot: same-origin, as a fresh copy would be. */
    setConnection({});
  }
  saveTabServer();
}

/* Point THIS tab at `serverUrl`. The caller has already left any server
   home (setConnection refuses otherwise). opts: {token, tunnel,
   makeDefault}. With no token given, the one remembered for that server —
   and only that server — is used. makeDefault also makes it where the next
   fresh page starts; nothing else about another tab changes. */
export function pointTabAt(serverUrl, opts) {
  opts = opts || {};
  var url = normalizeServerUrl(serverUrl);
  setConnection({
    serverUrl: url,
    token: opts.token || rememberedTokenFor(url),
    tunnel: opts.tunnel || null
  });
  saveTabServer();
  if (opts.makeDefault) {
    try {
      if (url) localStorage.setItem(SERVER_BASE_KEY, url);
      else localStorage.removeItem(SERVER_BASE_KEY);
    } catch (e) { /* it just won't be the default */ }
  }
  return conn;
}

export function apiUrl(path) {
  var rel = String(path || "").replace(/^\/+/, "");
  return conn.serverUrl ? conn.serverUrl + rel : rel;
}

/* A token for THIS tab's server. `remember` keeps it for this server on
   this device; not remembering forgets any copy kept for this server
   before (and no other server's). */
export function setServerToken(token, remember) {
  updateConnection({ token: String(token || "") });
  saveTabServer();
  var map = rememberedTokens();
  if (remember) map[conn.serverUrl] = conn.token;
  else delete map[conn.serverUrl];
  writeRememberedTokens(map);
}

/* This server stopped taking our token (or we are leaving it): forget it
   here, in this tab's session and on this device — for this server only. */
export function clearServerToken() {
  updateConnection({ token: "", role: "" });
  saveTabServer();
  var map = rememberedTokens();
  if (Object.prototype.hasOwnProperty.call(map, conn.serverUrl)) {
    delete map[conn.serverUrl];
    writeRememberedTokens(map);
  }
}

/* ---- the review link ----

   `#review=<key>` in the address, the same delivery as the launcher's own
   key: the fragment is the one part of a URL browsers never send to a
   server and no proxy logs. Read once, kept for this tab, and taken out of
   the address bar so it is not in a screenshot or a bookmark. */
function readReviewKey() {
  try { reviewKey = sessionStorage.getItem(REVIEW_KEY_KEY) || ""; } catch (e) { reviewKey = ""; }
  var hash = location.hash || "";
  var m = /(?:^#|&)review=([A-Za-z0-9]+)/.exec(hash);
  if (!m) return;
  reviewKey = m[1];
  try { sessionStorage.setItem(REVIEW_KEY_KEY, reviewKey); } catch (e) {}
  var rest = hash.replace(/(^#|&)review=[A-Za-z0-9]+/, "$1").replace(/^#&/, "#");
  if (rest === "#") rest = "";
  try {
    history.replaceState(null, "", location.pathname + location.search + rest);
  } catch (e) { /* file:// in some browsers — the key is already stored */ }
}

export async function apiFetch(path, opts) {
  opts = opts || {};
  var headers = opts.body
    ? { "Content-Type": "application/json", "Accept": "application/json" }
    : { "Accept": "application/json" };
  if (conn.token) headers["x-splitpage-token"] = conn.token;
  var res;
  try {
    res = await fetch(apiUrl(path), {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      /* Same-origin keeps the Cloudflare Access cookie flowing, which is
         the whole point of serving app and API together. Cross-origin it
         is switched off deliberately: the token in the header is what
         proves us there, and the server never answers with
         Allow-Credentials, so asking for cookies would only turn a working
         request into a CORS failure. */
      credentials: conn.serverUrl ? "omit" : "same-origin",
      cache: "no-store"
    });
  } catch (e) {
    throw ApiError("offline", "no answer from the server");
  }

  var ctype = res.headers.get("content-type") || "";
  if (res.redirected || (!ctype.includes("application/json") && res.status !== 204)) {
    throw ApiError("auth", "signed out");
  }
  if (res.status === 401 || res.status === 403) {
    /* a real 403 from our own server (READ_ONLY) still answers JSON, so
       separate the two rather than calling everything an auth failure */
    var body403 = await res.json().catch(function () { return null; });
    if (body403 && body403.error === "read-only") throw ApiError("read-only", "read-only");
    /* The review credential's own refusal: the token is fine, the change
       is not. Nothing to re-ask for, so it must never reach the PIN
       dialog or the lapsed-sign-in path. */
    if (body403 && body403.error === "review-only") {
      var e403 = ApiError("review-only", "this link can comment, but not change the script");
      e403.detail = body403.detail || "";
      throw e403;
    }
    /* A missing or stale join PIN is nothing like a lapsed Access session:
       it is answered right here by asking for the code, with no reload and
       no stash. Kept as its own code so handleApiError() cannot confuse
       the two. */
    if (body403 && (body403.error === "pin-required" || body403.error === "bad-pin")) {
      throw ApiError("pin", "this server asks for a join PIN");
    }
    throw ApiError("auth", "signed out");
  }
  if (res.status === 429) {
    var body429 = await res.json().catch(function () { return null; });
    if (body429 && body429.error === "too-many-attempts") {
      throw ApiError("pin-blocked", "too many wrong codes — wait a minute and try again");
    }
  }

  var body = res.status === 204 ? null : await res.json().catch(function () { return null; });
  if (res.status === 409) { var c = ApiError("conflict"); c.payload = body; throw c; }
  if (!res.ok) throw ApiError(String(res.status), (body && body.error) || ("HTTP " + res.status));
  return body;
}

/* Once the session has lapsed, every queued autosave would fire the same
   failure again. Latch it, say so once, and let a reload clear it — the
   conflict stash already carries unsaved work across that reload. */
export var SERVER_RESUME_KEY = "splitpage-server-resume";

/* The same "reopen it and merge my edits back in" job, asked for by a crash
   draft instead of by a lapsed sign-in (20g-drafts.js arms it before
   detectServer() runs at boot). It is a var rather than a second
   sessionStorage key on purpose: the draft was read from disk, it may be far
   bigger than sessionStorage would take, and stashLocalWork()'s quota
   fallback strips images — which a recovered draft must not lose.

   {id, rev, base, mine, at, onDone(outcome)}. onDone is how the restore
   learns which way this went ('server-resumed' or 'not-found'); polling
   the home's id cannot tell a resume that merged the draft from one that
   simply reopened the document. */
S.draftServerResume = null;

function flagServerSessionExpired() {
  if (serverSessionExpired) return;
  serverSessionExpired = true;
  /* Stash before promising anything. stashLocalWork() was written for the
     artifact shell's forced reload and had sat unused ever since; this is
     the same situation it was built for — the only way back is a reload,
     and everything typed since the last save would go with it. Only claim
     the work is safe if it actually got persisted. */
  var stashed = false;
  if (onServerDoc()) {
    try {
      sessionStorage.setItem(SERVER_RESUME_KEY, JSON.stringify({ id: home.id, rev: home.rev }));
      stashed = stashLocalWork();
      if (!stashed) sessionStorage.removeItem(SERVER_RESUME_KEY);
    } catch (e) { stashed = false; }
  }
  showToast(stashed
    ? "Your sign-in expired. Reload the page to sign in again — your unsaved edits are kept and will be merged back in."
    : "Your sign-in expired. Copy anything unsaved, then reload the page to sign in again.",
    "warn", true);
  updateFileChip();
}

/* Coming back after signing in again: reopen the document that was open and
   merge the stashed edits into whatever it looks like now — which may have
   moved on, since the sign-in could have taken a while. Same three-way
   merge as a save conflict, for the same reason. */
async function resumeServerDoc() {
  /* A crash draft of a server document asks for the same thing and is
     answered first: it was read from disk moments ago, so it is the more
     recent of the two, and a page that has both (a sign-in lapsed, then the
     app died) would otherwise merge the older sessionStorage stash and drop
     the draft on the floor. */
  var override = S.draftServerResume;
  var pending;
  if (override) {
    pending = { id: override.id, rev: override.rev || 0 };
  } else {
    try {
      var raw = sessionStorage.getItem(SERVER_RESUME_KEY);
      pending = raw ? JSON.parse(raw) : null;
    } catch (e) { pending = null; }
  }
  if (!pending || !pending.id) return false;

  /* init() fires detectServer() (which leads here) and loadInitialState()
     concurrently with no coordination between them — loadInitialState()
     resolves almost immediately and renders a blank, fully editable
     document, while this is still doing network round trips. Remember
     what was on screen and the edit counter before awaiting anything, so
     keystrokes typed into that transitional document during the wait can
     be recovered rather than silently overwritten below. */
  var seqAtStart = S.editSeq;
  var stateAtStart = S.state ? cloneState(S.state) : null;

  var body;
  var via = conn;
  try {
    body = await apiFetch("api/docs/" + encodeURIComponent(pending.id));
    if (via !== conn) return false;
  } catch (err) {
    /* still signed out, or the document is gone — leave SERVER_RESUME_KEY
       (and the stash it points at) alone so a later reload can still
       recover it. Removing it here, before success is known, is what
       applyStashedWork() (14-export.js) uses to decide a stash belongs to
       a fresh/local document rather than this hosted one — clear it too
       early and a later reload would splice this doc's stashed edits into
       an unrelated blank document instead. */
    /* A recovered draft is different: the document it belongs to is GONE
       from the server (deleted while the app was down), so waiting for a
       later launch would hide the work forever. Disarm and hand the restore
       back its answer — it opens the edits as an unsaved local copy. Any
       other failure (signed out, no answer yet, a PIN still to type) leaves
       the override armed: finishServerDetect() calls this again once the
       PIN dialog succeeds. The literal "404" is here because apiFetch()
       names non-ok statuses by their number; "not-found" is what
       saveToServer's own branch looks for. */
    if (override && err && (err.code === "not-found" || err.code === "404")) {
      S.draftServerResume = null;
      try { override.onDone("not-found"); } catch (e2) {}
    }
    return false;
  }
  if (override) {
    S.draftServerResume = null;
    /* Only when the lapsed-sign-in stash is about this SAME document does
       it belong to the merge below — the draft already carries everything
       that stash held, and a stash left over from a different document must
       survive for its own resume. */
    var samePending;
    try {
      var rawPending = sessionStorage.getItem(SERVER_RESUME_KEY);
      samePending = rawPending ? JSON.parse(rawPending) : null;
    } catch (e) { samePending = null; }
    if (samePending && samePending.id === pending.id) {
      try { sessionStorage.removeItem(SERVER_RESUME_KEY); } catch (e) {}
      clearStash();
    }
  } else {
    try { sessionStorage.removeItem(SERVER_RESUME_KEY); } catch (e) {}
  }

  var stash = override || readStash();
  /* A server document saved by a client older than document ids has none.
     The stash was taken from this same document before the sign-in lapsed,
     so the id this view was already using is the right one to keep;
     failing that, one derived from the server's own document id, the same
     for everyone who opens it. */
  /* `stash` is the override when there is one, so this is also the draft's
     own id — the document the draft was taken from keeps its identity and
     its history rather than deriving a second one from the server id. */
  var theirs = migrateDocument(cloneState(body.state), {
    kind: "server",
    serverId: body.id,
    fallbackId: normalizeDocId(stash && stash.mine && stash.mine.docId) || null
  });
  setHome("server", { id: body.id, rev: body.rev || 0 });
  S.docIdWrittenOut = true;
  resetProductionPanelState();
  applyReviewMode();

  var typedDuringResume = stateAtStart && S.editSeq !== seqAtStart;

  if (!stash || !stash.mine || !Array.isArray(stash.mine.rows)) {
    if (typedDuringResume) {
      /* No undo point: nothing has been filed for a document that was on
         screen for the length of a fetch, and there is no stash behind
         this — only the keystrokes typed into the interim document, which
         the merge keeps. Same rule as the main merge below for autosave:
         a restore driven by a crash draft (override) never publishes on
         its own. */
      applyMerge({
        base: stateAtStart,
        mine: S.state,
        theirs: theirs,
        source: "server-resume",
        newBase: cloneState(theirs),
        chips: true,
        noAutoSave: !!override,
        toast: {
          text: function () {
            return "Signed back in — merged what you typed while " +
              (S.state.title || body.id) + " was reopening";
          },
          tone: "warn",
          sticky: true
        }
      });
      if (override) { try { override.onDone("server-resumed"); } catch (e) {} }
      return true;
    }
    S.state = theirs;
    S.baseState = cloneState(S.state);
    clearDirty();
    render();
    updateIdentityChip();
    updateFileChip();
    showToast("Signed back in — reopened " + (S.state.title || body.id), "ok");
    /* Only reachable with an override if the draft held nothing usable; the
       document did reopen, so the restore is finished either way and must
       not be left waiting for an answer that is never coming. */
    if (override) { try { override.onDone("server-resumed"); } catch (e) {} }
    return true;
  }

  if (!override) clearStash();
  var mine = migrateRows(cloneState(stash.mine));
  if (typedDuringResume) {
    /* fold the keystrokes typed on top of the blank interim document into
       what the stash already remembers as "mine", so both survive the
       three-way merge below rather than one silently replacing the other. */
    mine = mergeStates(stateAtStart, migrateRows(cloneState(S.state)), mine, false).merged;
  }
  /* TWO snapshots, and they hold different things — filing only one of
     them was the bug. `undoPoint` captures `theirs`, the version that was
     live a moment before the merge: it is the UNDO POINT, not the
     recovered work, and applyMerge arms "Undo merge" at it, which nothing
     on this path used to do — reportMerge unhides #merge-banner, whose
     button reads lastMergeUndo, so it answered "No merge snapshot to
     undo." with the snapshot it needed already filed. `keepLabel` is the
     recovered version itself, so the draft is a version in the history
     rather than something that existed only inside this function — the
     same pair restoreFileDraft files (20g-drafts.js). Without it the
     pre-merge recovered document is nowhere: the draft on disk goes with
     the first clean save after this.

     The lapsed-sign-in path files neither: the reload it came from is
     seconds old and the stash is still in sessionStorage. A draft can be
     days old.

     That path also keeps queueing the save — the user is sitting in front
     of a seconds-old reload and the merged version is theirs. A CRASH-DRAFT
     restore is the opposite: it runs at launch with nobody having touched
     anything, so it must not publish a merge the user has not seen yet.
     The PUT would bump the rev for every other viewer, commit conflict
     comments nobody has read, and then clear dirty, which discards the
     crash draft that held the pre-merge version. Splitpage never writes
     the user's document on its own (invariant #41 / overrides §1); the
     file path has said so since step K. The user's next Save publishes it. */
  applyMerge({
    base: stash.base || null,
    mine: mine,
    theirs: theirs,
    imagesStripped: !!stash.imagesStripped,
    source: "server-resume",
    undoPoint: override ? theirs : null,
    keepLabel: override ? "Your unsaved changes, recovered" : null,
    /* if theirs won the id, the history written under mine follows it */
    historyFrom: mine.docId,
    newBase: cloneState(theirs),
    chips: true,
    noAutoSave: !!override,
    toast: {
      text: function () {
        return override
          ? "Reopened " + (S.state.title || body.id) +
            " — the changes recovered from the last session were merged back in"
          : "Signed back in — your unsaved edits were merged back in";
      }
    }
  });
  if (override) { try { override.onDone("server-resumed"); } catch (e) {} }
  return true;
}

function handleApiError(err, whatFailed) {
  if (err && err.code === "auth") { flagServerSessionExpired(); return; }
  /* Never latches serverSessionExpired: the code is one dialog away, the
     page does not have to reload to ask for it, and nothing needs stashing
     because nothing was signed out. */
  if (err && err.code === "pin") {
    clearServerToken();
    openPinDialog({ reason: "This server asks for a join PIN." });
    return;
  }
  if (err && err.code === "pin-blocked") {
    showToast("Too many wrong codes were tried — wait a minute, then try again.", "warn");
    return;
  }
  if (err && err.code === "read-only") {
    showToast("This server is published read-only — save a copy to your own disk instead.", "warn");
    return;
  }
  if (err && err.code === "review-only") {
    showToast("You are viewing this session — you can comment on it, but not change the script. " +
      "Ask whoever is hosting for the editing code.", "warn", true);
    return;
  }
  showToast(whatFailed + " — " + ((err && err.message) || "please try again") + ".", "error");
}

export async function detectServer() {
  /* A saved base is tried first and is the reason a file:// page can have
     a server at all: the old skip was "no http, no server", and that is
     only still true when nobody has pointed this copy anywhere. */
  if (!conn.serverUrl && location.protocol === "file:") { S.serverMode.checked = true; return; }
  /* Which connection this probe is for. The tab can be pointed somewhere
     else while it is in flight (the Servers dialog, or main handing this
     tab a document on another server), and an answer from the old server
     must not be written over the new one's. */
  var probing = conn;
  try {
    var health = await apiFetch("api/health");
    if (probing !== conn) return;
    S.serverMode.available = !!(health && health.ok);
    S.serverMode.readOnly = !!(health && health.readOnly);
    S.serverMode.authRequired = !!(health && health.authRequired);
    S.serverMode.reviewAvailable = !!(health && health.reviewAvailable);
    S.serverMode.version = (health && health.version) || null;
  } catch (e) {
    if (probing !== conn) return;
    S.serverMode.available = false;
  }
  if (probing !== conn) return;
  S.serverMode.checked = true;
  updateConnectMenu();
  /* Also on the no-server path: the share entry's enabled state and its
     tooltip are derived here rather than trusted from the markup, so the
     two can never drift apart (issue #19). */
  updateServerMenu();
  if (!S.serverMode.available) {
    if (conn.serverUrl) {
      /* A server reached through an SSH forward is only there while the
         reader's own ssh command is running — nothing here starts it
         (20e-connect.js's SSH helper), so say which one to start. */
      showToast("Could not reach " + conn.serverUrl +
        (conn.tunnel ? " — is the SSH tunnel to " + conn.tunnel.userHost + " running? (" +
          tunnelCommand(conn.tunnel) + ") Or" : " —") +
        " use File ▸ Servers… to pick another, or go back to this copy.", "warn");
    }
    return;
  }

  /* The server wants a code and this browser has not been given one (or
     the one it has is stale): ask before listing anything. Every route
     past here would answer 401 anyway, and a picker full of "could not
     reach the server" is a worse way to say "type the PIN". */
  if (S.serverMode.authRequired && !conn.token) {
    /* Arrived on a review link: the key in the fragment IS the code, so
       ask the server with it rather than asking the reader for something
       they were never given. A key that is no longer good (the session was
       restarted since the link was sent) simply falls through to the
       dialog, which is the only place a code is ever typed. */
    if (reviewKey) {
      var joined = await joinServer(conn.serverUrl, null, reviewKey);
      if (probing !== conn) return;
      if (joined && joined.ok) {
        setServerToken(joined.token, false);
        finishServerDetect();
        return;
      }
    }
    updateServerMenu();
    openPinDialog({ reason: (conn.serverUrl ? shortHost(conn.serverUrl) : "This server") +
      " asks for a join PIN before it will show you anything." });
    return;
  }

  finishServerDetect();
}

/* Everything that only makes sense once we are actually allowed in. Split
   out of detectServer() so the PIN dialog can call it on success without
   re-probing health. */
export async function finishServerDetect() {
  /* Access hands us a verified email; use it for attribution so reviewers
     don't have to introduce themselves, but never overwrite a name someone
     has deliberately set for themselves. */
  var asking = conn;
  try {
    var me = await apiFetch("api/me");
    /* A tab pointed elsewhere while /api/me was in flight: that answer is
       about a server this tab has left, and its role must not land on the
       connection that replaced it. */
    if (asking !== conn) return;
    serverIdentity = me;
    /* The role rides along with identity: same answer, same round trip,
       and it comes from the token rather than from anything this page
       could have decided for itself. */
    updateConnection({ role: (serverIdentity && serverIdentity.role) === "review" ? "review" : "edit" });
    if (serverIdentity && serverIdentity.name && !getSavedAuthorName()) {
      saveAuthorName(serverIdentity.name);
      updateIdentityChip();
    }
  } catch (e) { /* identity is a nicety, not a requirement */ }

  updateServerMenu();
  applyReviewMode();
  /* The link's document is opened only if nothing else claimed this page:
     resumeServerDoc() answers a crash draft or a lapsed sign-in first, and
     both are unsaved work that must not be replaced (issue #19). */
  resumeServerDoc().then(function (resumed) {
    if (!resumed) openSharedDocFromLink();
  }, function () { openSharedDocFromLink(); });
}

function updateServerMenu() {
  ["menu-server-open", "menu-server-new"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.hidden = !S.serverMode.available;
  });
  var sep = document.getElementById("menu-server-sep");
  if (sep) sep.hidden = !S.serverMode.available;
  var newBtn = document.getElementById("menu-server-new");
  /* Publishing is a write, and a review session has none. The server says
     so too (403 review-only on POST /api/docs) — this only keeps the app
     from offering something it knows will be refused. */
  if (newBtn) newBtn.disabled = S.serverMode.readOnly || conn.role === "review";
  /* The share entry is never hidden — it is how someone with no server yet
     finds out that sharing a live document is possible at all, and it says
     so and opens the Servers dialog rather than doing nothing. Read-only is
     the one state where pressing it could not work, so it is disabled with
     the reason in its tooltip. */
  var shareBtn = document.getElementById("menu-share-link");
  if (shareBtn) {
    shareBtn.disabled = S.serverMode.available && (S.serverMode.readOnly || conn.role === "review");
    shareBtn.title = shareBtn.disabled
      ? (conn.role === "review"
          ? "You are viewing this session — publishing a script needs the editing code."
          : "This server is published read-only — nothing new can be put on it.")
      : "Puts this script on the connected server and copies a link to it. " +
        "Unlike the standalone HTML export, everyone who opens the link edits the same document.";
  }
}

/* ---- viewing, comments only ----

   The badge and the body class every read-only rule in app.css hangs off.
   Called wherever the answer can change — the role arriving, a document
   opening or closing — rather than polled, and it only ever reflects what
   the SERVER said: flipping the class by hand changes what this page
   offers and nothing about what it is allowed to save. */
export function applyReviewMode() {
  var on = reviewMode();
  document.body.classList.toggle("is-review", on);
  var badge = document.getElementById("review-chip");
  if (badge) badge.hidden = !on;
  var title = document.getElementById("doc-title");
  if (title) title.readOnly = on;
}

/* Somewhere to say it once, rather than in every blocked handler. */
export function reviewBlocked() {
  if (!reviewMode()) return false;
  showToast("Viewing only — you can comment on this script, but not change it.", "warn");
  return true;
}

/* The address to hand to someone who should only read and comment on THIS
   script: this server's own, with a key minted for this document in the
   fragment. Asked for at the moment it is wanted rather than held — it is
   a credential, and a page whose owner never opens the Servers dialog
   never learns it at all.

   It needs a document open on the server, because the key is per-document
   now (#63): before, one launch-wide key opened every script on the
   server and listed the picker, while the dialog offered it as a way to
   share the one you were looking at. "" whenever there is nothing to hand
   out — no review credential, no hosted document, or this browser is
   itself a reviewer. */
export async function fetchReviewLink() {
  if (!S.serverMode.available || !S.serverMode.reviewAvailable || conn.role === "review") return "";
  if (!onServerDoc()) return "";
  var body;
  try { body = await apiFetch("api/share?doc=" + encodeURIComponent(home.id)); } catch (e) { return ""; }
  if (!body || !body.reviewKey) return "";
  var base = conn.serverUrl || (location.origin + "/");
  /* The link carries the document as well as the key: the key only opens
     that one document, so landing anywhere else would be a dead end. */
  return base + "?doc=" + encodeURIComponent(body.docId || home.id) +
         "#review=" + body.reviewKey;
}

/* ---- the picker ---- */

export async function openServerPicker() {
  var modal = document.getElementById("server-modal");
  var list = document.getElementById("server-doc-list");
  modal.hidden = false;
  list.innerHTML = '<div class="comments-empty">Loading…</div>';
  try {
    var body = await withBusyBar("Listing the documents on the server…", function () {
      return apiFetch("api/docs");
    });
    serverDocs = (body && body.docs) || [];
  } catch (err) {
    list.innerHTML = '<div class="comments-empty">Could not reach the server.</div>';
    handleApiError(err, "Could not list the documents");
    return;
  }
  renderServerPicker();
}

export function closeServerPicker() {
  document.getElementById("server-modal").hidden = true;
}

function renderServerPicker() {
  var list = document.getElementById("server-doc-list");
  if (!serverDocs.length) {
    list.innerHTML = '<div class="comments-empty">No documents on the server yet.<br><br>' +
      'Use <strong>Put this script on the server</strong> in the File menu to publish the ' +
      'one you have open.</div>';
    return;
  }
  list.innerHTML = serverDocs.map(function (d) {
    var isOpen = d.id === serverHomeId();
    return '<div class="server-doc' + (isOpen ? ' is-current' : '') + '" data-id="' + escapeHtml(d.id) + '">' +
      '<button type="button" class="server-doc-open" data-action="server-open" data-id="' +
        escapeHtml(d.id) + '">' +
        '<span class="server-doc-title">' + escapeHtml(d.title || "Untitled Script") + '</span>' +
        '<span class="server-doc-meta">' + d.rows + ' scene' + (d.rows === 1 ? '' : 's') +
          ' · v' + d.rev +
          (d.updatedBy ? ' · ' + escapeHtml(d.updatedBy) : '') +
          (d.updatedAt ? ' · ' + escapeHtml(formatTimestamp(d.updatedAt)) : '') +
        '</span>' +
      '</button>' +
      (isOpen ? '<span class="server-doc-current">Open</span>' : '') +
      (S.serverMode.readOnly || conn.role === "review" ? '' :
        '<button type="button" class="server-doc-delete" data-action="server-delete" data-id="' +
          escapeHtml(d.id) + '" title="Delete this document from the server">×</button>') +
    '</div>';
  }).join("");
}

/* → true once the document is on screen, false otherwise — so a caller
   waiting to open it (a restored desktop tab, 20f-desktop.js) can tell a
   PIN still to be typed from a document that opened. */
export async function openServerDoc(id) {
  var body;
  /* The document is on the server this tab was pointed at when it asked.
     If the tab was pointed somewhere else before the answer came back, it
     is not this tab's document any more (#11). */
  var via = conn;
  try {
    body = await apiFetch("api/docs/" + encodeURIComponent(id));
  } catch (err) {
    if (via !== conn) return false;
    handleApiError(err, "Could not open that document"); return false;
  }
  if (via !== conn) return false;
  if (!body || !body.state) { showToast("That document is empty.", "warn"); return false; }

  if (S.state && S.state.rows.length) pushSnapshot("Before opening " + (body.state.title || id));

  /* no fallback id: nothing this page holds is known to be this document,
     so an id-less server document derives one from its server id */
  S.state = migrateDocument(body.state, { kind: "server", serverId: body.id, fallbackId: null });
  S.baseState = cloneState(S.state);
  if (typeof closeNewTabPage === "function") closeNewTabPage(); /* 20j-newtab.js */
  /* a hosted document and a local file are different homes for the same
     Save button — setHome() replaces whichever one this page had, so it
     can never be ambiguous which one Save writes */
  setHome("server", { id: body.id, rev: body.rev || 0 });
  S.docIdWrittenOut = true;
  resetProductionPanelState();

  clearDirty();
  /* Before render(), not after: the rows are built editable or not from
     this same answer, so the class has to be on the body first. */
  applyReviewMode();
  render();
  updateIdentityChip();
  updateFileChip();
  closeServerPicker();
  showToast("Opened " + (S.state.title || id) + " from the server — " + S.state.rows.length +
    " scene" + (S.state.rows.length === 1 ? "" : "s"), "ok");
  return true;
}

/* → true once the document is on the server. The boolean is what
   publishAndCopyShareLink() (issue #19) needs: a link must never be
   copied for a publish that did not happen. */
export async function publishToServer() {
  if (S.serverMode.readOnly) { showToast("This server is published read-only.", "warn"); return false; }
  if (conn.role === "review") {
    showToast("You are viewing this session — publishing a script needs the editing code.", "warn");
    return false;
  }
  var published = cloneState(S.state);
  /* Publishing makes a second home for this script. If its id already
     lives somewhere else (a file on disk, another server document), the
     server copy gets a new one — otherwise two documents that will now be
     edited apart share one version history. Same rule as Save As. */
  var oldId = S.state.docId;
  var forkDocId = S.docIdWrittenOut ? mintDocId() : null;
  if (forkDocId) published.docId = forkDocId;
  var body;
  var via = conn;
  try {
    body = await withBusyBar("Publishing to the server…", function () {
      return apiFetch("api/docs", { method: "POST", body: { state: published, by: getEditorName() } });
    });
  } catch (err) { handleApiError(err, "Could not put that on the server"); return false; }
  /* Published to the server the tab WAS on; this tab has since been pointed
     elsewhere, so the copy there is not its home. */
  if (via !== conn) return false;
  setHome("server", { id: body.id, rev: body.rev || 1 });
  S.baseState = published;
  /* Adopted only after the server has it, like Save As. The id check keeps
     a document opened while the POST was in flight from being re-id'd. */
  if (forkDocId && S.state.docId === oldId) {
    S.state.docId = forkDocId;
    copyDocHistorySafe(oldId, forkDocId);
  }
  S.docIdWrittenOut = true;
  clearDirty();
  updateFileChip();
  showToast("Published to the server as “" + (S.state.title || body.id) + "” — collaborators can open it now", "ok");
  return true;
}

/* ---- "Publish and copy a link" (issue #19) ----

   The standalone HTML export stays what it has always been: a DEAD COPY.
   It carries no document id, it never connects anywhere, and the
   recipient's edits stay in their file. Shapes that would have made it a
   live client of a server — an exported page phoning home to a URL baked
   into it, or a centrally hosted Splitpage — were considered and are not
   being built (issue #19, and the note on standaloneHtmlFor in
   02b-doc-id.js, which still holds).

   What IS being built is the delivery half, because hosted mode already
   is the collaboration: one shared document, rev-based conflict
   detection, a three-way merge and attribution. What was missing was a
   way to hand someone the address of it. So this publishes to the server
   this copy is connected to and puts the open-URL on the clipboard —
   a link, not a file.

   It never connects anywhere on its own and never publishes silently:
   with no server it says so and opens the Servers dialog instead, and the
   toast names what the recipient will be asked for (a join PIN, an Access
   sign-in, or nothing at all) before they get there. */

/* conn.serverUrl is "" when this page was served BY the document server, in
   which case the address to share is this page's own. Built through the
   URL parser so a "?doc=" already in the bar, a fragment, or a path that
   is not the root all resolve the way a browser would. */
function serverDocShareUrl(id) {
  try {
    return new URL("?doc=" + encodeURIComponent(id), conn.serverUrl || location.href).href;
  } catch (e) {
    return (conn.serverUrl || "") + "?doc=" + encodeURIComponent(id);
  }
}

/* What the person opening the link will be asked for. Said out loud next
   to the link, because "just open this" and "open this, and you will need
   the six-digit code I am about to send you" are different messages. */
function shareAccessNote() {
  if (S.serverMode.authRequired) return "They'll need the join PIN to open it.";
  if (serverIdentity && serverIdentity.email) return "They'll need to sign in the same way you did.";
  return "Anyone who can reach that address can open it.";
}

function copyShareText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return copyShareTextFallback(text); });
  }
  return Promise.resolve(copyShareTextFallback(text));
}

/* An insecure origin, or a browser that refuses the async API without a
   permission: the old selection trick still works there. */
function copyShareTextFallback(text) {
  try {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "readonly");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = document.execCommand("copy");
    ta.remove();
    return !!ok;
  } catch (e) { return false; }
}

export async function publishAndCopyShareLink() {
  if (!S.serverMode.available) {
    showToast("A share link needs a Splitpage server to publish to. " +
      "Pick or add one under Servers…, then try again.", "warn");
    if (typeof openServersDialog === "function") openServersDialog(); /* 20e-connect.js */
    return false;
  }
  if (S.serverMode.readOnly) {
    showToast("This server is published read-only — nothing new can be put on it.", "warn");
    return false;
  }
  /* Already hosted: the document has an address, and the only thing that
     could be wrong with the link is that it points at a version older
     than what is on screen. Save first, then share. A save that fails has
     already said why (saveToServer / handleApiError), and a link to a
     stale version is worse than none. */
  if (onServerDoc()) {
    if (S.dirty && !(await saveToServer())) return false;
  } else if (!(await publishToServer()) || !onServerDoc()) {
    return false;
  }
  var url = serverDocShareUrl(home.id);
  var copied = await copyShareText(url);
  showToast(copied
    ? "Link copied — " + shareAccessNote()
    : "Published. Could not reach the clipboard, so here is the link: " + url,
    copied ? "ok" : "warn", !copied);
  return true;
}

/* ---- opening a shared link: ?doc=<id> ----

   The other end of the link above. Runs after the server has answered and
   after any PIN dialog, so a link opened cold asks for the code first and
   then lands on the document — rather than failing with a 401 and leaving
   the person looking at a blank script.

   A crash draft or a lapsed-sign-in resume wins: both are unsaved work
   belonging to a document that was already open here, and a link in the
   address bar must not throw them away. The parameter is stripped either
   way, so a reload is an ordinary reload of whatever is on screen. */
function readSharedDocParam() {
  var id;
  try { id = new URLSearchParams(location.search).get("doc") || ""; } catch (e) { id = ""; }
  if (!id) return "";
  try {
    var url = new URL(location.href);
    url.searchParams.delete("doc");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch (e) { /* the id is already in hand; the bar keeping it is cosmetic */ }
  return id;
}

async function openSharedDocFromLink() {
  if (!sharedDocId) return false;
  var id = sharedDocId;
  sharedDocId = "";
  if (onServerDoc()) return false;   /* a resume already took this page somewhere */
  await openServerDoc(id);
  return true;
}

export async function armServerDelete(btn, id) {
  if (btn.getAttribute("data-armed") === "1") {
    try {
      await apiFetch("api/docs/" + encodeURIComponent(id), { method: "DELETE" });
    } catch (err) { handleApiError(err, "Could not delete that document"); return; }
    if (serverHomeId() === id) setHome("none");
    serverDocs = serverDocs.filter(function (d) { return d.id !== id; });
    renderServerPicker();
    updateFileChip();
    showToast("Deleted from the server", "ok");
    return;
  }
  btn.setAttribute("data-armed", "1");
  btn.textContent = "Delete?";
  btn.classList.add("armed");
  setTimeout(function () {
    if (!btn.isConnected) return;
    btn.removeAttribute("data-armed");
    btn.textContent = "×";
    btn.classList.remove("armed");
  }, 2800);
}

/* ---- the compare-and-set save ----

   Returns true when the document is safely on the server. A 409 means
   somebody saved between our load and our write: we take their version,
   three-way merge it against the base this view still holds, and try again
   against their rev. Bounded, because a busy document could otherwise spin
   here forever — three rounds is far more contention than a script gets. */
export async function saveToServer() {
  if (serverSessionExpired) return false;
  /* A review session has no PUT: the server refuses one outright (#71).
     What it has to send is its own comments, one at a time, below. */
  if (reviewMode()) return sendReviewWrites();
  /* The server picker is never disabled while a save is in flight, so
     openServerDoc() can reassign home/state/baseState to a different
     hosted document mid-save. Remember which document THIS call is for,
     and refuse to write a result — success or conflict — into whatever
     home/state/baseState point at now if it has moved on. */
  var docId = serverHomeId();
  var attempts = 0;
  var mergeResult = null;

  while (attempts < 3) {
    attempts++;
    if (serverHomeId() !== docId) return false;
    /* `state.rev` is NOT touched here. The rev this save is judged by is
       the DOCUMENT's, which the server keeps and hands back (home.rev
       below, sent as baseRev); `state.rev` is only the merge counter
       inside the document (max-plus-one, 02-state.js). Bumping it on the
       way out and putting it back on every failure was a second, private
       counter that drifted from the server's on every 409 and told nobody
       anything (#72). */
    S.state.lastEditedBy = getEditorName();
    S.state.lastEditedAt = nowIso();
    var published = cloneState(S.state);
    var seqAtSave = S.editSeq;
    var baseRevAtSave = home.rev;

    try {
      var body = await withBusyBar("Saving to the server…", function () {
        return apiFetch("api/docs/" + encodeURIComponent(docId), {
          method: "PUT",
          body: { baseRev: baseRevAtSave, state: published, by: getEditorName() }
        });
      });
      if (serverHomeId() !== docId) return true; /* saved, but the open document has since changed */
      home.rev = body.rev;
      S.baseState = published;
      if (S.editSeq === seqAtSave) clearDirty();
      updateFileChip();
      /* reported only once the merged result is actually stored, so the
         banner can never describe a merge that failed to save */
      if (mergeResult) reportMerge(mergeResult, { alreadySaved: true });
      return true;
    } catch (err) {
      if (serverHomeId() !== docId) return false;

      if (err && err.code === "conflict" && err.payload && err.payload.state) {
        /* The id this view has been writing history under, before the merge
           below can hand the document theirs. */
        var prevDocId = S.state.docId;
        /* Their copy came from the same server document, so if a client
           older than document ids saved it without one, it is still this
           document: keep our id rather than deriving a new one and splitting
           the history on every conflict. */
        var theirs = migrateDocument(cloneState(err.payload.state), {
          kind: "server",
          serverId: docId,
          fallbackId: S.state.docId
        });
        /* The undo point here is MINE — mid-save, what is on screen is
           what this call was trying to publish, so that is the version
           the merge replaces.

           armUndo:false is this path's one divergence from every other
           merge, and it is deliberate only in the sense that it is what
           the code has always done: the snapshot is filed and "Undo merge"
           is never pointed at it, so the button reportMerge puts on screen
           below answers "No merge snapshot to undo." Arming it is a change
           to what a user can do after a save conflict, not a refactor, so
           it is left for its own issue rather than smuggled in here.

           report:false because the merged version is not on the server
           yet: the loop retries, and the 200 branch above reports it with
           {alreadySaved:true} — so the banner can never describe a merge
           that failed to save. */
        mergeResult = applyMerge({
          base: S.baseState,
          mine: S.state,
          theirs: theirs,
          source: "server-conflict",
          undoPoint: cloneState(S.state),
          armUndo: false,
          /* if theirs won the id, the history written under ours follows it */
          historyFrom: prevDocId,
          report: false
        }).result;
        /* Their rev, from their answer — the baseRev the retry is judged
           against. Nothing on the client invents one. */
        home.rev = err.payload.rev || home.rev;
        continue; /* try again against their rev */
      }

      if (err && err.code === "not-found") {
        showToast("That document is no longer on the server. Use “Put this script on the server” to publish it again.", "warn");
        setHome("none");
        updateFileChip();
        return false;
      }
      handleApiError(err, "Could not save to the server");
      return false;
    }
  }
  showToast("Someone else kept saving while we merged — try Save again in a moment.", "warn");
  return false;
}

/* ---- a reviewer's writes (#71) ----

   A review token writes through two routes and nothing else:
   POST api/docs/:id/comments (a new comment, or a reply) and
   PATCH api/docs/:id/comments/:cid (resolve / unresolve). The server
   refuses a review PUT outright — it used to diff the whole uploaded script
   against the stored one to prove only a comment had moved, and that proof
   is gone. So saveToServer() never PUTs from a review session; it comes
   here instead, and everything that makes a reviewer's comment reach the
   server — posting it, the autosave that follows, pressing Save after a
   failure, a stash merged back in after a lapsed sign-in — is the same
   path it always was, ending somewhere else.

   WHAT TO SEND is what this view holds that the server has not confirmed:
   a comment in S.state that S.baseState does not have, a reply its thread
   in the base does not have, a resolve the base does not agree with.
   S.baseState is what the server last confirmed (HANDOFF §3.6), so the
   difference IS the outbox — which is why a comment typed while offline, or
   carried across a reload in the stash, goes out on the next save without
   a queue of its own to keep. Conflict cards are never sent: they are this
   view's own record of a merge, not something a reviewer wrote. Nothing
   else a reviewer's state could differ in is sendable, and nothing else is
   looked at.

   WHAT COMES BACK is adopted, not kept alongside: the server builds the
   stored comment itself (its clock, its bounded author), so the stored copy
   replaces ours in S.state and goes into S.baseState, keeping only what
   this view has not sent yet (a reply still to go, a resolve still to go).
   Only the one comment the answer is about is folded in (with, for a placed
   anchor, the one field its span sits in and that scene's stamp) — nothing
   else of the document changes on either side, so a later merge still sees
   every other difference exactly as it was.

   THE REV. Every answer carries the DOCUMENT's rev, the one the heartbeat
   reports and the pull compares with home.rev (#69). When it is exactly
   the rev this view held plus the one write it just made, nobody else wrote
   in between: the server now holds precisely our base plus this change, so
   home.rev takes it and the next beat is quiet — a reviewer's own comment
   does not come back round as a pull-merge of itself. When it has moved
   further, somebody else saved meanwhile and this view has not seen it:
   home.rev stays where it was, so the next beat pulls their change and
   merges it against a base that already holds ours. Adopting the higher
   number there would mark their save as seen and it would never arrive.

   THE ANCHOR. The `.cmt-anchor` span a new comment wrapped around its words
   is in S.state's row, so the request carries that one field's HTML with
   every OTHER span this view has not had confirmed taken back out (a second
   comment still waiting, the one a composer that is open right now just
   wrapped) — the server places the anchor only if the words are unchanged
   apart from this comment's own span. `anchored:false` is not a failure:
   the comment landed, somebody rewrote that scene meanwhile, and the span
   comes back out of the scene on screen so this view never shows a
   highlight the server does not have. The card falls back to its scene,
   field and quoted words, as for any comment whose text has gone.

   EDITORS STAY ON PUT. The routes take an edit token too, but an editor's
   comment changes travel in the same save as their script edits, share its
   409 and its three-way merge, and include what these routes cannot say at
   all — a delete, an assignee, "use my version" on a conflict card. Moving
   only some of them to a second channel would mean ordering two kinds of
   write against each other for nothing; the issue keeps editors on PUT, and
   this does. */

/* A pull must not land in the middle of these, for the same reason it must
   not land in the middle of a PUT: it replaces S.baseState, which the
   answers below are folded into. saveDoc()'s saveButtonBusy already covers
   every path that gets here; this covers the flush itself. */
var reviewWriting = false;

/* Refused for good by the server (too large, too many, a thread that has
   been deleted): kept on screen so nothing typed is thrown away, and not
   sent again this session. Keyed by what was being sent. */
var reviewRefused = {};

function commentIndexIn(list, id) {
  for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return i;
  return -1;
}

function rowIn(state, id) {
  var rows = (state && state.rows) || [];
  for (var i = 0; i < rows.length; i++) if (rows[i] && rows[i].id === id) return rows[i];
  return null;
}

function jsonCopy(v) { return JSON.parse(JSON.stringify(v)); }

/* The next thing this view holds that the server has not confirmed, in
   document order: a comment before its replies, a reply before a resolve. */
function nextReviewWrite() {
  var base = (S.baseState && S.baseState.comments) || [];
  var list = (S.state && S.state.comments) || [];
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    if (!c || c.kind === "conflict") continue;
    var bi = commentIndexIn(base, c.id);
    if (bi === -1) {
      if (!reviewRefused["c:" + c.id]) return { kind: "comment", id: c.id, key: "c:" + c.id };
      continue; /* its replies cannot go before it does */
    }
    var was = base[bi];
    var had = {};
    (was.replies || []).forEach(function (r) { if (r) had[r.id] = true; });
    var replies = c.replies || [];
    for (var j = 0; j < replies.length; j++) {
      var r = replies[j];
      var rkey = "r:" + c.id + ":" + (r && r.id);
      if (r && !had[r.id] && !reviewRefused[rkey]) return { kind: "reply", id: c.id, replyId: r.id, key: rkey };
    }
    var xkey = "x:" + c.id + ":" + !!c.resolved;
    if (!!c.resolved !== !!was.resolved && !reviewRefused[xkey]) return { kind: "resolve", id: c.id, key: xkey };
  }
  return null;
}

/* One field's HTML as the server should see it: this comment's span in
   place, every span the server has not confirmed yet taken back out. Null
   when there is no span of this comment's to place. */
function reviewAnchorFor(c) {
  if (c.field !== "visualText" && c.field !== "audioText") return null;
  var row = rowIn(S.state, c.rowId);
  var baseRow = rowIn(S.baseState, c.rowId);
  if (!row || !baseRow) return null;
  var body = inertBody(row[c.field] || "");
  if (!body.querySelector('.cmt-anchor[data-cmt="' + cssAttr(c.id) + '"]')) return null;
  var confirmed = {};
  inertBody(baseRow[c.field] || "").querySelectorAll(".cmt-anchor").forEach(function (el) {
    confirmed[el.getAttribute("data-cmt")] = true;
  });
  confirmed[c.id] = true;
  body.querySelectorAll(".cmt-anchor").forEach(function (el) {
    if (!confirmed[el.getAttribute("data-cmt")]) unwrapElement(el);
  });
  return { rowId: c.rowId, field: c.field, html: body.innerHTML };
}

function unwrapElement(el) {
  while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
  el.parentNode.removeChild(el);
}

/* This comment's span out of the scene on screen — the anchor did not
   land. When that leaves the field as the server has it, the scene's stamp
   goes back too: the reviewer did not change it after all. */
function dropLocalAnchor(c) {
  var row = rowIn(S.state, c.rowId);
  if (!row || (c.field !== "visualText" && c.field !== "audioText")) return false;
  var body = inertBody(row[c.field] || "");
  var span = body.querySelector('.cmt-anchor[data-cmt="' + cssAttr(c.id) + '"]');
  if (!span) return false;
  unwrapElement(span);
  row[c.field] = body.innerHTML;
  var baseRow = rowIn(S.baseState, c.rowId);
  if (baseRow && baseRow[c.field] === row[c.field]) {
    row.updatedAt = baseRow.updatedAt;
    row.updatedBy = baseRow.updatedBy;
  }
  return true;
}

function reviewRequest(op, c) {
  var path = "api/docs/" + encodeURIComponent(home.id) + "/comments";
  var by = getEditorName();
  if (op.kind === "resolve") {
    return {
      path: path + "/" + encodeURIComponent(c.id),
      method: "PATCH",
      body: { resolved: !!c.resolved, by: by },
      busy: c.resolved ? "Resolving…" : "Reopening…"
    };
  }
  if (op.kind === "reply") {
    var reply = null;
    (c.replies || []).forEach(function (r) { if (r && r.id === op.replyId) reply = r; });
    return {
      path: path,
      method: "POST",
      body: { replyTo: c.id, reply: { id: reply.id, author: reply.author, body: reply.body }, by: by },
      busy: "Posting your reply…"
    };
  }
  var payload = {
    comment: {
      id: c.id, rowId: c.rowId, field: c.field, anchorId: c.anchorId,
      quotedText: c.quotedText, author: c.author, body: c.body,
      assignee: c.assignee || "", kind: c.kind
    },
    by: by
  };
  var anchor = reviewAnchorFor(c);
  if (anchor) payload.anchor = anchor;
  return { path: path, method: "POST", body: payload, busy: "Posting your comment…" };
}

/* The server's copy of the one comment an answer is about, into the base
   and onto the screen. Returns true when something visible in the script
   changed (an anchor came back out), so the caller knows to re-render. */
function adoptReviewAnswer(op, sent, body) {
  var stored = body.comment;
  var baseList = S.baseState.comments || (S.baseState.comments = []);
  var bi = commentIndexIn(baseList, stored.id);
  var wasResolved = bi === -1 ? false : !!baseList[bi].resolved;
  if (bi === -1) baseList.push(jsonCopy(stored));
  else baseList[bi] = jsonCopy(stored);

  var list = S.state.comments;
  var si = commentIndexIn(list, stored.id);
  var local = si === -1 ? null : list[si];
  if (local) {
    var next = jsonCopy(stored);
    if (!Array.isArray(next.replies)) next.replies = [];
    var have = {};
    next.replies.forEach(function (r) { if (r) have[r.id] = true; });
    /* replies still to go stay, after the ones the server has */
    (local.replies || []).forEach(function (r) { if (r && !have[r.id]) next.replies.push(r); });
    /* and so does a resolve still to go */
    if (op.kind !== "resolve" && !!local.resolved !== wasResolved) {
      next.resolved = local.resolved;
      next.resolvedBy = local.resolvedBy;
      next.resolvedAt = local.resolvedAt;
    }
    list[si] = next;
  }

  var redraw = false;
  if (op.kind === "comment" && sent.anchor) {
    if (body.anchored === true) {
      /* stamped exactly as placeAnchor() stamped it: the write's own time
         and the comment's stored author */
      var baseRow = rowIn(S.baseState, sent.anchor.rowId);
      if (baseRow) {
        baseRow[sent.anchor.field] = sent.anchor.html;
        baseRow.updatedAt = body.updatedAt;
        baseRow.updatedBy = stored.author;
      }
      var row = rowIn(S.state, sent.anchor.rowId);
      if (row) {
        row.updatedAt = body.updatedAt;
        row.updatedBy = stored.author;
      }
    } else if (local) {
      redraw = dropLocalAnchor(local);
    }
  }

  /* See above: only a rev that is exactly ours-plus-this-write is ours. */
  if (typeof body.rev === "number" && body.rev === (home.rev || 0) + (body.changed ? 1 : 0)) {
    home.rev = body.rev;
  }
  return redraw;
}

var REVIEW_REFUSALS = {
  "too-many-comments": "this script already holds as many comments as it can",
  "too-many-replies": "that thread already holds as many replies as it can",
  "no-such-comment": "the comment it belongs to has been deleted",
  "too-large": "it is too large to send",
  "bad-comment": "the server could not read it as a comment",
  "bad-anchor": "the server could not read where it goes",
  "bad-comment-id": "the server could not read it as a comment",
  "no-state": "the document on the server is empty"
};

/* A refusal that will be the same answer every time — keep the words on
   screen, stop sending them, say why once. Anything else (offline, signed
   out, a PIN to type) is worth trying again. */
function permanentReviewRefusal(err) {
  if (!err) return "";
  var reason = err.code === "conflict" ? (err.payload && err.payload.error) : err.message;
  if (err.code === "conflict" || err.code === "400" || err.code === "413" ||
      (err.code === "404" && reason === "no-such-comment")) {
    return REVIEW_REFUSALS[reason] || reason || "the server refused it";
  }
  return "";
}

/* → true once nothing this view holds is waiting for the server (anything
   it refused for good excepted), false when something is still to go. */
async function sendReviewWrites() {
  var docId = serverHomeId();
  /* openServerDoc() always sets one; without it there is no telling what
     the server has already confirmed, so nothing is sent. */
  if (!S.baseState) return false;
  var redraw = false;
  var sentAny = false;
  var sentKeys = {};
  reviewWriting = true;
  try {
    for (;;) {
      if (serverHomeId() !== docId) return false;
      var op = nextReviewWrite();
      if (!op) break;
      /* An answer that did not settle it — a stored copy whose reply list
         somehow still lacks ours — must not become a loop. */
      if (sentKeys[op.key]) { reviewRefused[op.key] = true; continue; }
      sentKeys[op.key] = true;
      var c = S.state.comments[commentIndexIn(S.state.comments, op.id)];
      var req = reviewRequest(op, c);
      var body;
      try {
        body = await withBusyBar(req.busy, function () {
          return apiFetch(req.path, { method: req.method, body: req.body });
        });
      } catch (err) {
        if (serverHomeId() !== docId) return false;
        var why = permanentReviewRefusal(err);
        if (why) {
          reviewRefused[op.key] = true;
          showToast((op.kind === "resolve" ? "That could not be marked resolved" :
                     op.kind === "reply" ? "Your reply could not be posted" :
                     "Your comment could not be posted") +
                    " — " + why + ". It stays on this screen only, so copy anything you need.",
                    "warn", true);
          continue;
        }
        if (err && err.code === "405") {
          showToast("This server is older than this copy of Splitpage and cannot take a " +
                    "comment from a review link. Ask whoever is hosting to update it.", "warn", true);
          return false;
        }
        handleApiError(err, op.kind === "reply" ? "Could not post your reply" :
                            op.kind === "resolve" ? "Could not change that comment" :
                            "Could not post your comment");
        return false;
      }
      if (serverHomeId() !== docId) return true; /* it landed; the page has moved on */
      if (!body || !body.comment) return false;
      if (adoptReviewAnswer(op, req.body, body)) redraw = true;
      sentAny = true;
    }
  } finally {
    reviewWriting = false;
  }
  if (redraw) render();
  else if (sentAny) { captureReplyDrafts(); renderComments(); }
  /* Clean unless something refused for good is still only on this screen:
     the unload guard should still say so about that. */
  var refusedHere = false;
  (S.state.comments || []).forEach(function (c) {
    if (!c) return;
    if (reviewRefused["c:" + c.id] || reviewRefused["x:" + c.id + ":" + !!c.resolved]) refusedHere = true;
    (c.replies || []).forEach(function (r) { if (r && reviewRefused["r:" + c.id + ":" + r.id]) refusedHere = true; });
  });
  if (!refusedHere) clearDirty();
  updateFileChip();
  return true;
}

/* ---- the pull channel (issue #69) ----

   Hosted mode had no way of learning that somebody else had saved. The only
   thing that ever told you was your OWN save coming back 409 — which ships
   the whole document, base64 stills and all, in both directions, files a
   snapshot into a history that holds fifty, and gives up with a toast after
   three rounds. So a second editor's scenes arrived when you typed, not
   when they wrote them, and the README's "live collaboration" was a save
   conflict wearing a merge for a hat.

   The channel already existed. The presence heartbeat round-trips every two
   seconds anyway (13a-presence.js), and it now comes back carrying
   {docId, rev} beside `here` — read off the document's head line, so no
   script is parsed to answer it (server.js's presenceRev). When that number
   has moved past the one this view is holding, and only then, we GET the
   document and merge it in.

   THE REV BEING COMPARED IS THE DOCUMENT'S — `home.rev` (_home.js), the
   compare-and-set token every PUT carries as `baseRev` and the server hands
   back with every answer. NOT `state.rev`, which is the merge counter
   inside the document (max-plus-one, 02-state.js), is private to the
   client, and plays no part in conflict detection — #72 says so at length,
   and comparing against it here would pull on a document that has not
   changed and sit still on one that has.

   NEVER DURING A SAVE. A pull that landed between saveToServer()'s
   `cloneState(S.state)` and the PUT's answer would merge into `S.state` and
   reassign `S.baseState`, and then the 200 branch would overwrite that base
   with the version it published — their changes would vanish out of the
   base and come back as a conflict on the next save. `S.saveButtonBusy`
   (12-dirty-toast.js) is true for the whole of saveDoc(), hosted branch
   included, which is exactly that window; it is checked before the GET and
   again after it, because a save can start while the GET is in the air.

   NO UNDO POINT, and this is the deliberate part. Every other merge path
   files one, because each of them replaces a whole document the user might
   want back: a save conflict, a recovered crash draft, a stash from a
   lapsed sign-in. This one runs whenever ANYBODY saves — every few seconds
   in a live session — and one snapshot per pull would fill the fifty-entry
   history in under two minutes and evict the versions the user actually
   wants (03a-history-store.js's cap). Not being able to undo the arrival of
   somebody else's scene is a far smaller loss than losing the history, and
   nothing is dropped either way: the three-way merge keeps this view's
   unsaved edits, and a field both sides changed is still kept as a review
   comment. Omitting `undoPoint` also leaves "Undo merge" pointing wherever
   it already pointed rather than at a routine pull.

   AND NO PUT. The pull publishes nothing, not even the merged result — if
   it did, every idle viewer would write back a copy of what it had just
   read, bumping the rev for everyone else, whose pulls would write in turn.
   An autosave this view's own unsaved edits had already armed still runs,
   and now goes out against the rev that just arrived instead of conflicting
   with it, which is the whole point of the exercise.

   A pull that finds nothing of theirs is silent: no render, no toast, no
   dirty mark. It takes the rev and stops. */

/* One at a time. The GET is slower than the beat that asked for it, and a
   second pull into the middle of the first would merge against a base the
   first is about to move. */
var pullInFlight = false;

/* Key order is not content. `theirs` has just been through
   migrateDocument(), and `baseState` was cloned from a document that went
   through it at some other moment, so two byte-identical documents can
   serialise with their keys in different orders. */
function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(v).sort().filter(function (k) {
    return v[k] !== undefined;
  }).map(function (k) {
    return JSON.stringify(k) + ":" + canonicalJson(v[k]);
  }).join(",") + "}";
}

/* Has the version that just arrived anything in it this view's base does
   not already have? `rev`, `lastEditedBy` and `lastEditedAt` move on every
   save whether or not a word changed, so they are not part of the answer;
   everything else is, down to a reply on a comment. */
function sameDocumentContent(a, b) {
  if (!a || !b) return false;
  function bare(s) {
    var copy = cloneState(s);
    copy.rev = 0;
    copy.lastEditedBy = "";
    copy.lastEditedAt = "";
    return canonicalJson(copy);
  }
  return bare(a) === bare(b);
}

/* The heartbeat's answer, handed over exactly as the server sent it.
   13a-presence.js paints badges and knows nothing about documents; every
   decision about what a rev means is here. */
export function notePresenceRev(body) {
  if (!body || pullInFlight || serverSessionExpired || reviewWriting) return;
  var docId = serverHomeId();
  if (!docId || body.docId !== docId) return;
  /* A document with no head line yet answers with no rev (server.js) — and
     a rev that has not moved is the ordinary case, one comparison and out. */
  if (typeof body.rev !== "number") return;
  if (body.rev <= (home.rev || 0)) return;
  if (S.saveButtonBusy) return;
  pullInFlight = true;
  pullServerDoc(docId).catch(function () {}).then(function () { pullInFlight = false; });
}

async function pullServerDoc(docId) {
  var body;
  try {
    body = await apiFetch("api/docs/" + encodeURIComponent(docId));
  } catch (err) {
    /* Deliberately never handleApiError(), for the same reason the beat
       that asked for it never does: a background poll nobody asked for must
       not put a toast on screen, reload the page or open the PIN dialog. A
       server that stopped answering, a session that lapsed, a document
       somebody deleted — the next save says so properly. */
    return;
  }
  if (!body || !body.state) return;
  /* Everything that was true before the await is checked again after it.
     The server picker is never disabled, so another document may have been
     opened; and a save may have started, in which case this pull is dropped
     and that save's own 409 does the merging instead. */
  if (serverHomeId() !== docId) return;
  if (S.saveButtonBusy || reviewWriting) return;
  var rev = body.rev || 0;
  if (rev <= (home.rev || 0)) return;   /* a save of ours landed first */

  /* Their copy came from this same server document, so an id-less one saved
     by a client older than document ids is still THIS document: keep ours
     rather than deriving a new one on every pull and splitting the history.
     Same rule, and the same arguments, as saveToServer's 409. */
  var theirs = migrateDocument(cloneState(body.state), {
    kind: "server",
    serverId: docId,
    fallbackId: S.state.docId
  });

  home.rev = rev;
  if (sameDocumentContent(theirs, S.baseState)) {
    /* Somebody saved a document that says what ours already said — their
       own pull-merge, a save that only moved `lastEditedAt`, a second
       window catching up. Take the rev, so the next beat is quiet and the
       next save is judged against it, and touch nothing else. */
    S.baseState = cloneState(theirs);
    updateFileChip();
    return;
  }

  var prevDocId = S.state.docId;
  var merged = applyMerge({
    base: S.baseState,
    mine: S.state,
    theirs: theirs,
    /* no undoPoint, and no source to label one with — see above */
    historyFrom: prevDocId,
    /* what the server last confirmed, which is what the next save's baseRev
       is measured against (HANDOFF §3.6) */
    newBase: cloneState(theirs),
    chips: true,
    report: false
  });
  /* reportMerge here rather than applyMerge's own `report`, for the sake of
     `alreadySaved`: the banner and the "Review conflicts" button it offers
     are wanted, the markDirty() and queueAutoSave() that normally follow
     them are not. This view's own unsaved edits were already dirty and
     already have an autosave armed; what came from them is on the server by
     definition. Marking a CLEAN document dirty here is the loop described
     above, in one line.

     The banner's "Undo merge" has nothing to undo, because this path files
     no snapshot. That is the same answer saveToServer's 409 gives today
     (applyMerge's armUndo:false, pinned by tests/54-server-conflict.txt),
     and it is the honest one here: undoing a pull would mean throwing away
     somebody else's work, which is not what that button promises. */
  if (merged.result) reportMerge(merged.result, { alreadySaved: true });
  showToast("Merged in changes from " + (body.updatedBy || "someone else"), "ok");
}

/* ---- the launcher's key ----

   start.mjs mints one per launch and hands it over in the URL fragment,
   which the browser never sends to a server and no proxy logs. Read it
   once, keep it for this tab only, and take it out of the address bar so
   it is not in a screenshot, a bookmark or a shared link.

   It buys exactly one thing: the loopback-only /api/launcher/* routes,
   which let the first-run wizard register this copy with Windows. Phase 4
   calls launcherFetch(); this file's job is only to hold the key. */

function readLaunchToken() {
  try { launchToken = sessionStorage.getItem(LAUNCH_TOKEN_KEY) || ""; } catch (e) { launchToken = ""; }
  var hash = location.hash || "";
  var m = /(?:^#|&)launch=([A-Za-z0-9]+)/.exec(hash);
  if (!m) return;
  launchToken = m[1];
  try { sessionStorage.setItem(LAUNCH_TOKEN_KEY, launchToken); } catch (e) {}
  /* Strip it, keeping any other fragment the URL carried. replaceState
     leaves no history entry holding the old URL either. */
  var rest = hash.replace(/(^#|&)launch=[A-Za-z0-9]+/, "$1").replace(/^#&/, "#");
  if (rest === "#") rest = "";
  try {
    history.replaceState(null, "", location.pathname + location.search + rest);
  } catch (e) { /* file:// in some browsers — the token is already stored */ }
}


/* Deliberately not apiFetch(): these routes are never on another origin
   (the server refuses them off loopback), they carry a different header,
   and a 404 from them means "not available here", not "signed out". */
export async function launcherFetch(path, opts) {
  opts = opts || {};
  if (!launchToken) throw ApiError("no-launcher", "this copy was not started by the launcher");
  var headers = { "Accept": "application/json", "x-splitpage-launch": launchToken };
  if (opts.body) headers["Content-Type"] = "application/json";
  var res;
  try {
    res = await fetch(String(path || "").replace(/^\/+/, ""), {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
      cache: "no-store"
    });
  } catch (e) {
    throw ApiError("offline", "no answer from the launcher");
  }
  var body = await res.json().catch(function () { return null; });
  if (res.status === 404) throw ApiError("no-launcher", "not available in this copy");
  if (!res.ok) throw ApiError(String(res.status), (body && body.error) || ("HTTP " + res.status));
  return body;
}

/* ================= Google Drive file manager =================

   A standalone file browser for a publicly shared Google Drive folder —
   separate from the script editor's own open/save flow above. Two
   different things need two different credentials, because Google splits
   them that way:

   - Listing a public folder and downloading its files works anonymously,
     identified only by an API key. Google still checks each file's own
     sharing permission — this only works because the folder is public.
   - Anything that changes Drive (upload, rename, delete, new folder)
     always needs a real signed-in Google account, even on a folder
     "anyone with the link" can edit — an API key alone carries no
     identity Drive will accept for a write. That needs an OAuth Client ID
     and a sign-in click (Google Identity Services' token client), and
     whoever signs in must actually have edit access to the folder.

   Splitpage has no backend of its own to hold either credential, so
   whoever uses this pastes their own, once, in a small setup form. They
   are kept in localStorage only — never sent anywhere but Google's APIs. */

/* `google` is the namespace Google Identity Services installs on window when
   loadGisScript() below has finished injecting accounts.google.com/gsi/client
   — a real runtime global that no import can declare, which is why it is
   named here rather than left to no-undef (#68). Every use is behind either
   an awaited loadGisScript() or a `window.google &&` guard; there is no code
   path that touches it before the script has run. */
/* global google -- injected at runtime by Google Identity Services; see above */

var DRIVE_KEY_STORE = "splitpage-drive-api-key";
var DRIVE_CLIENT_STORE = "splitpage-drive-client-id";
var DRIVE_FOLDER_STORE = "splitpage-drive-last-folder";
var DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

var driveCreds = { apiKey: "", clientId: "" };
var driveState = {
  connected: false,
  path: [],           /* [{id, name}], root folder first */
  items: [],           /* last listing for the folder on top of path */
  tokenClient: null,
  accessToken: "",
  tokenExpiresAt: 0,
  signedIn: false
};
var driveGisPromise = null;
var driveEditingId = null;

function loadDriveCreds() {
  try {
    driveCreds.apiKey = localStorage.getItem(DRIVE_KEY_STORE) || "";
    driveCreds.clientId = localStorage.getItem(DRIVE_CLIENT_STORE) || "";
  } catch (e) { /* private browsing etc. — just start empty */ }
}

function driveLastFolder() {
  try { return localStorage.getItem(DRIVE_FOLDER_STORE) || ""; } catch (e) { return ""; }
}

function driveHasCreds() { return !!(driveCreds.apiKey && driveCreds.clientId); }

function saveDriveCreds(apiKey, clientId) {
  driveCreds.apiKey = (apiKey || "").trim();
  driveCreds.clientId = (clientId || "").trim();
  try {
    localStorage.setItem(DRIVE_KEY_STORE, driveCreds.apiKey);
    localStorage.setItem(DRIVE_CLIENT_STORE, driveCreds.clientId);
  } catch (e) { /* not fatal — creds just won't survive a reload */ }
}

export function openDriveModal() {
  /* Google Identity Services only ever authorizes an http/https origin
     (Google Cloud Console has no "custom scheme" option for Authorized
     JavaScript origins), and this page runs at splitpage://app — the menu
     entry that reaches here is hidden on desktop for exactly that reason
     (20f-desktop.js's initDesktop()). This is the defensive half, in case
     something still calls the action directly (a native menu command, a
     stale keyboard shortcut) — say why plainly instead of opening a modal
     whose Sign in button can only ever fail. */
  if (S.DESKTOP) {
    showToast("Google Drive isn't available in the desktop app — sign-in needs a web address Google " +
      "can redirect back to. Use File ▸ Open a document… instead.", "warn");
    return;
  }
  loadDriveCreds();
  document.getElementById("drive-modal").hidden = false;
  document.getElementById("drive-folder-input").value = driveLastFolder();
  renderDriveSetup();
}

export function closeDriveModal() {
  document.getElementById("drive-modal").hidden = true;
}

export function driveShowCredsForm() {
  document.getElementById("drive-setup").hidden = false;
  document.getElementById("drive-main").hidden = true;
}

function renderDriveSetup() {
  var hasCreds = driveHasCreds();
  document.getElementById("drive-setup").hidden = hasCreds;
  document.getElementById("drive-main").hidden = !hasCreds;
  if (!hasCreds) return;
  document.getElementById("drive-api-key").value = driveCreds.apiKey;
  document.getElementById("drive-client-id").value = driveCreds.clientId;
  document.getElementById("drive-browser").hidden = !driveState.connected;
  renderDriveAccount();
}

export function driveSaveCredsFromForm() {
  var apiKey = document.getElementById("drive-api-key").value;
  var clientId = document.getElementById("drive-client-id").value;
  if (!apiKey.trim() || !clientId.trim()) { showToast("Both fields are needed.", "warn"); return; }
  saveDriveCreds(apiKey, clientId);
  renderDriveSetup();
  showToast("Saved — now paste a folder link below.", "ok");
}

/* Accepts a full folder URL (drive.google.com/drive/folders/<id>, with or
   without ?usp=sharing and the rest), or a bare folder ID pasted straight
   from one. */
function parseDriveFolderId(input) {
  input = (input || "").trim();
  if (!input) return "";
  var m = /\/folders\/([a-zA-Z0-9_-]+)/.exec(input);
  if (m) return m[1];
  m = /[?&]id=([a-zA-Z0-9_-]+)/.exec(input);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(input)) return input;
  return "";
}

function driveApiKeyParam() { return "key=" + encodeURIComponent(driveCreds.apiKey); }

async function driveFetch(url, opts) {
  opts = opts || {};
  var headers = opts.headers || {};
  if (driveState.accessToken && driveState.tokenExpiresAt > Date.now()) {
    headers = Object.assign({}, headers, { "Authorization": "Bearer " + driveState.accessToken });
  }
  var res = await fetch(url, { method: opts.method || "GET", headers: headers, body: opts.body });
  if (!res.ok) {
    var msg = "request failed (" + res.status + ")";
    try {
      var body = await res.json();
      if (body && body.error && body.error.message) msg = body.error.message;
    } catch (e) {}
    throw new Error(msg);
  }
  return res;
}

export async function driveConnect(rawInput) {
  if (!driveHasCreds()) { showToast("Add your Google API key and Client ID first.", "warn"); return; }
  var id = parseDriveFolderId(rawInput);
  if (!id) { showToast("That doesn't look like a Drive folder link or ID.", "warn"); return; }
  var btn = document.getElementById("drive-connect-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Connecting…"; }
  try {
    var url = "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(id) +
      "?fields=" + encodeURIComponent("id,name,mimeType") + "&supportsAllDrives=true&" + driveApiKeyParam();
    var res = await driveFetch(url);
    var meta = await res.json();
    if (meta.mimeType !== "application/vnd.google-apps.folder") {
      showToast("That's a file, not a folder — paste a folder link.", "warn");
      return;
    }
    driveState.connected = true;
    driveState.path = [{ id: meta.id, name: meta.name || "Drive folder" }];
    driveEditingId = null;
    try { localStorage.setItem(DRIVE_FOLDER_STORE, rawInput.trim()); } catch (e) {}
    document.getElementById("drive-browser").hidden = false;
    await driveListCurrent();
  } catch (err) {
    showToast("Could not open that folder — " + err.message, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Open folder"; }
  }
}

export async function driveListCurrent() {
  var folder = driveState.path[driveState.path.length - 1];
  var list = document.getElementById("drive-list");
  list.innerHTML = '<div class="drive-empty">Loading…</div>';
  try {
    var q = encodeURIComponent("'" + folder.id.replace(/'/g, "\\'") + "' in parents and trashed = false");
    var url = "https://www.googleapis.com/drive/v3/files?q=" + q +
      "&fields=" + encodeURIComponent("files(id,name,mimeType,size,modifiedTime,webViewLink)") +
      "&orderBy=" + encodeURIComponent("folder,name") +
      "&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&" + driveApiKeyParam();
    var res = await driveFetch(url);
    var body = await res.json();
    driveState.items = body.files || [];
    renderDriveBreadcrumb();
    renderDriveList();
  } catch (err) {
    list.innerHTML = '<div class="drive-empty">Could not load this folder — ' + escapeHtml(err.message) + '</div>';
  }
}

function renderDriveBreadcrumb() {
  var el = document.getElementById("drive-breadcrumb");
  el.innerHTML = driveState.path.map(function (p, i) {
    var isLast = i === driveState.path.length - 1;
    return isLast
      ? '<span class="drive-crumb-current">' + escapeHtml(p.name) + '</span>'
      : '<button type="button" class="drive-crumb" data-action="drive-crumb" data-index="' + i + '">' +
          escapeHtml(p.name) + '</button><span class="drive-crumb-sep">/</span>';
  }).join("");
}

export function driveCrumbTo(index) {
  driveState.path = driveState.path.slice(0, index + 1);
  driveEditingId = null;
  driveListCurrent();
}

export function driveItemById(id) {
  var found = driveState.items.filter(function (it) { return it.id === id; });
  return found[0] || null;
}

function driveIconFor(mimeType) {
  if (mimeType === "application/vnd.google-apps.folder") return "📁";
  if (mimeType === "application/vnd.google-apps.document") return "📝";
  if (mimeType === "application/vnd.google-apps.spreadsheet") return "📊";
  if (mimeType === "application/vnd.google-apps.presentation") return "📑";
  if (/^image\//.test(mimeType)) return "🖼";
  if (/^video\//.test(mimeType)) return "🎬";
  if (/^audio\//.test(mimeType)) return "🎵";
  if (mimeType === "application/pdf") return "📕";
  return "📄";
}

export function driveFormatSize(bytes) {
  var n = Number(bytes);
  if (!n) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

function renderDriveList() {
  var list = document.getElementById("drive-list");
  if (!driveState.items.length) {
    list.innerHTML = '<div class="drive-empty">This folder is empty.</div>';
    return;
  }
  var canWrite = driveState.signedIn;
  list.innerHTML = driveState.items.map(function (it) {
    var isFolder = it.mimeType === "application/vnd.google-apps.folder";
    if (driveEditingId === it.id) {
      return '<div class="drive-row is-editing" data-id="' + escapeHtml(it.id) + '">' +
        '<span class="drive-row-icon">' + driveIconFor(it.mimeType) + '</span>' +
        '<input type="text" class="drive-rename-input" data-id="' + escapeHtml(it.id) +
          '" value="' + escapeHtml(it.name) + '">' +
        '<button type="button" class="drive-row-btn" data-action="drive-rename-save" data-id="' +
          escapeHtml(it.id) + '" title="Save">✓</button>' +
        '<button type="button" class="drive-row-btn" data-action="drive-rename-cancel" title="Cancel">×</button>' +
      '</div>';
    }
    return '<div class="drive-row" data-id="' + escapeHtml(it.id) + '">' +
      '<button type="button" class="drive-row-open" data-action="drive-open-item" data-id="' + escapeHtml(it.id) + '">' +
        '<span class="drive-row-icon">' + driveIconFor(it.mimeType) + '</span>' +
        '<span class="drive-row-name">' + escapeHtml(it.name) + '</span>' +
        '<span class="drive-row-meta">' + (isFolder ? "Folder" : driveFormatSize(it.size)) +
          (it.modifiedTime ? ' · ' + escapeHtml(formatTimestamp(it.modifiedTime)) : '') + '</span>' +
      '</button>' +
      '<div class="drive-row-actions">' +
        (canWrite ? '<button type="button" class="drive-row-btn" data-action="drive-rename" data-id="' +
          escapeHtml(it.id) + '" title="Rename">✎</button>' : '') +
        (canWrite ? '<button type="button" class="drive-row-btn danger" data-action="drive-delete" data-id="' +
          escapeHtml(it.id) + '" title="Delete">×</button>' : '') +
      '</div>' +
    '</div>';
  }).join("");
}

export async function driveOpenItem(id) {
  var it = driveItemById(id);
  if (!it) return;
  if (it.mimeType === "application/vnd.google-apps.folder") {
    driveState.path.push({ id: it.id, name: it.name });
    driveEditingId = null;
    await driveListCurrent();
    return;
  }
  await driveDownloadFile(it);
}

var DRIVE_EXPORT_MIME = {
  "application/vnd.google-apps.document":
    { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: ".docx" },
  "application/vnd.google-apps.spreadsheet":
    { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: ".xlsx" },
  "application/vnd.google-apps.presentation":
    { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: ".pptx" }
};

async function driveDownloadFile(it) {
  var exportInfo = DRIVE_EXPORT_MIME[it.mimeType];
  var url, filename = it.name;
  if (exportInfo) {
    url = "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(it.id) +
      "/export?mimeType=" + encodeURIComponent(exportInfo.mime) + "&" + driveApiKeyParam();
    if (!/\.[a-z0-9]+$/i.test(filename)) filename += exportInfo.ext;
  } else if (/^application\/vnd\.google-apps\./.test(it.mimeType)) {
    /* forms, sites, drawings, and the like have no clean export — send
       the user to Drive itself rather than pretend to download something */
    window.open(it.webViewLink || ("https://drive.google.com/open?id=" + it.id), "_blank", "noopener");
    return;
  } else {
    url = "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(it.id) + "?alt=media&" + driveApiKeyParam();
  }
  try {
    var res = await driveFetch(url);
    var blob = await res.blob();
    await deliverFile(filename, blob);
  } catch (err) {
    showToast("Could not download " + it.name + " — " + err.message, "error");
  }
}

export function driveStartRename(id) {
  driveEditingId = id;
  renderDriveList();
  var input = document.querySelector('.drive-rename-input[data-id="' + id + '"]');
  if (input) { input.focus(); input.select(); }
}

export function driveCancelRename() {
  driveEditingId = null;
  renderDriveList();
}

export async function driveSaveRename(id) {
  var input = document.querySelector('.drive-rename-input[data-id="' + id + '"]');
  var name = input ? input.value.trim() : "";
  var item = driveItemById(id);
  driveEditingId = null;
  if (!name || !item || name === item.name) { renderDriveList(); return; }
  try {
    await driveFetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(id) + "?fields=id", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name })
    });
    showToast("Renamed to “" + name + "”", "ok");
  } catch (err) {
    showToast("Could not rename — " + err.message, "error");
  }
  await driveListCurrent();
}

export async function armDriveDelete(btn, item) {
  if (btn.getAttribute("data-armed") === "1") {
    try {
      await driveFetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(item.id), { method: "DELETE" });
    } catch (err) {
      showToast("Could not delete “" + item.name + "” — " + err.message, "error");
      return;
    }
    showToast("Deleted “" + item.name + "”", "ok");
    await driveListCurrent();
    return;
  }
  btn.setAttribute("data-armed", "1");
  btn.textContent = "Delete?";
  btn.classList.add("armed");
  setTimeout(function () {
    if (!btn.isConnected) return;
    btn.removeAttribute("data-armed");
    btn.textContent = "×";
    btn.classList.remove("armed");
  }, 2800);
}

var driveNewFolderOpen = false;

export function toggleDriveNewFolder(force) {
  driveNewFolderOpen = force === undefined ? !driveNewFolderOpen : force;
  var row = document.getElementById("drive-newfolder-row");
  row.hidden = !driveNewFolderOpen;
  var input = document.getElementById("drive-newfolder-input");
  if (driveNewFolderOpen) { input.value = ""; input.focus(); }
}

export async function driveCreateFolder() {
  if (!driveState.signedIn) { showToast("Sign in with Google first.", "warn"); toggleDriveNewFolder(false); return; }
  var input = document.getElementById("drive-newfolder-input");
  var name = input ? input.value.trim() : "";
  if (!name) { toggleDriveNewFolder(false); return; }
  var parent = driveState.path[driveState.path.length - 1];
  try {
    await driveFetch("https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, mimeType: "application/vnd.google-apps.folder", parents: [parent.id] })
    });
    showToast("Created “" + name + "”", "ok");
  } catch (err) {
    showToast("Could not create the folder — " + err.message, "error");
  }
  toggleDriveNewFolder(false);
  await driveListCurrent();
}

async function driveUploadOne(file, parentId) {
  var metadata = { name: file.name, parents: [parentId] };
  var boundary = "splitpage-" + Math.random().toString(36).slice(2);
  var fileBuf = await file.arrayBuffer();
  var encoder = new TextEncoder();
  var head = encoder.encode(
    "--" + boundary + "\r\n" +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata) + "\r\n" +
    "--" + boundary + "\r\n" +
    "Content-Type: " + (file.type || "application/octet-stream") + "\r\n\r\n"
  );
  var tail = encoder.encode("\r\n--" + boundary + "--");
  var body = new Blob([head, fileBuf, tail]);
  await driveFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: { "Content-Type": "multipart/related; boundary=" + boundary },
    body: body
  });
}

export async function driveUploadFiles(fileList) {
  if (!driveState.signedIn) { showToast("Sign in with Google first.", "warn"); return; }
  var parent = driveState.path[driveState.path.length - 1];
  var files = Array.prototype.slice.call(fileList || []);
  if (!files.length) return;
  var failed = 0;
  for (var i = 0; i < files.length; i++) {
    try { await driveUploadOne(files[i], parent.id); }
    catch (err) { failed++; showToast("Could not upload " + files[i].name + " — " + err.message, "error"); }
  }
  if (files.length - failed > 0) {
    showToast("Uploaded " + (files.length - failed) + " file" + (files.length - failed === 1 ? "" : "s"), "ok");
  }
  await driveListCurrent();
}

/* ---- sign-in, via Google Identity Services' token client (no backend,
   no redirect — just a popup that hands back an access token) ---- */

function loadGisScript() {
  if (driveGisPromise) return driveGisPromise;
  driveGisPromise = new Promise(function (resolve, reject) {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) { resolve(); return; }
    var s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = function () { resolve(); };
    s.onerror = function () { reject(new Error("could not reach Google's sign-in script")); };
    document.head.appendChild(s);
  });
  return driveGisPromise;
}

function renderDriveAccount() {
  var el = document.getElementById("drive-account");
  if (!el) return;
  el.innerHTML = driveState.signedIn
    ? '<span class="drive-account-status">✓ Signed in — you can make changes here.</span>' +
      '<button type="button" class="btn" data-action="drive-signout">Sign out</button>'
    : '<span class="drive-account-status">Read-only until you sign in.</span>' +
      '<button type="button" class="btn btn-accent" data-action="drive-signin">Sign in with Google</button>';
  updateDriveWriteButtons();
}

/* New folder / Upload live in the toolbar rather than per-row, so they
   can't just be left out of the markup the way rename/delete are — disable
   them instead, with a title explaining why. */
function updateDriveWriteButtons() {
  var disabled = !driveState.signedIn;
  var reason = disabled ? "Sign in with Google first" : "";
  var nf = document.getElementById("drive-newfolder-toggle");
  if (nf) { nf.disabled = disabled; nf.title = reason; }
  var up = document.querySelector('#drive-browser [data-action="drive-upload"]');
  if (up) { up.disabled = disabled; up.title = reason; }
}

export async function driveSignIn() {
  if (!driveCreds.clientId) { showToast("Add your OAuth Client ID first.", "warn"); return; }
  if (location.protocol === "file:") {
    showToast("Sign-in needs this page served over http/https, not opened from disk.", "warn");
    return;
  }
  try { await loadGisScript(); } catch (err) { showToast(err.message, "error"); return; }
  if (!driveState.tokenClient) {
    driveState.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: driveCreds.clientId,
      scope: DRIVE_SCOPE,
      callback: function (resp) {
        if (resp && resp.access_token) {
          driveState.accessToken = resp.access_token;
          driveState.tokenExpiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000 - 30000;
          driveState.signedIn = true;
          renderDriveAccount();
          renderDriveList();
          showToast("Signed in — you can now upload, rename, and delete here.", "ok");
        }
      },
      error_callback: function (err) {
        showToast("Google sign-in was cancelled or failed" + (err && err.type ? " (" + err.type + ")" : "") + ".", "warn");
      }
    });
  }
  driveState.tokenClient.requestAccessToken({ prompt: driveState.signedIn ? "" : "consent" });
}

export function driveSignOut() {
  if (driveState.accessToken && window.google && google.accounts && google.accounts.oauth2) {
    google.accounts.oauth2.revoke(driveState.accessToken, function () {});
  }
  driveState.accessToken = "";
  driveState.tokenExpiresAt = 0;
  driveState.signedIn = false;
  renderDriveAccount();
  renderDriveList();
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  loadTabConnection();

  readReviewKey();

  sharedDocId = readSharedDocParam();

  /* ---- test hook ----
     Same trick as window.__newTab / window.__updateTest: the share action's
     two pure pieces (the URL it builds and the sentence it says about
     getting in) and the mode flags they read are what a headless suite has
     to drive, and neither has a UI affordance that can be clicked into
     existence without a real document server behind it. Nothing in the app
     reads this. */
  window.__shareTest = {
    url: serverDocShareUrl,
    note: shareAccessNote,
    publishAndCopy: publishAndCopyShareLink,
    mode: function () { return S.serverMode; },
    updateMenu: updateServerMenu,
    sharedDocId: function () { return sharedDocId; },
    setIdentity: function (who) { serverIdentity = who; }
  };

  readLaunchToken();

  /* ---- test hook ----

     The harness serves static files and cannot start server.js with an
     environment, so the two halves of the review credential are tested in
     two places: what the SERVER allows a review token to write lives in
     tools/test-server.mjs, and what the EDITOR does about it lives in
     tests/43-review-mode.txt, driven through this. `setSession` says what
     /api/health, /api/join and /api/me would have said — nothing more: the
     role still only ever comes from here or from the server, never from
     anything the page stored. Nothing in the app reads this; the same trick
     window.__updateTest (20a-update.js) plays. */
  window.__hostedTest = {
    setSession: function (opts) {
      opts = opts || {};
      S.serverMode.available = true;
      S.serverMode.checked = true;
      S.serverMode.authRequired = true;
      S.serverMode.reviewAvailable = opts.reviewAvailable !== false;
      updateConnection({ role: opts.role || "edit" });
      /* `docId: null` says "not on a server document" — which leaves a
         local home exactly where it was, as zeroing serverDoc used to. */
      if (opts.docId === null) { if (home.kind === "server") setHome("none"); }
      else setHome("server", { id: opts.docId || "doc-test", rev: opts.rev || 1 });
      /* A hosted document that is open always has a base — openServerDoc()
         sets one from the answer it opened with, and every merge measures
         against it (HANDOFF §3.6). Without this the hook produced a state
         the app itself can never be in, and a suite that merged from it got
         a two-way merge: every field either side had touched came out a
         conflict rather than being reconciled against what the server last
         confirmed. `false` is for a suite that wants exactly that. */
      if (onServerDoc() && opts.base !== false) S.baseState = cloneState(S.state);
      applyReviewMode();
      updateServerMenu();
      render();
    },
    role: function () { return conn.role; },
    /* This tab's connection (#11), with the token reduced to whether there
       is one — a suite has no business reading the credential itself. */
    conn: function () {
      return { serverUrl: conn.serverUrl, hasToken: !!conn.token, role: conn.role,
               tunnel: conn.tunnel ? Object.assign({}, conn.tunnel) : null,
               homeHoldsIt: home.kind === "server" && home.conn === conn };
    },
    /* Point this tab somewhere, as the Servers dialog does, without a
       server to answer — for the per-tab storage the suites can watch. */
    pointTabAt: function (url, opts) { if (home.kind === "server") setHome("none"); return pointTabAt(url, opts).serverUrl; },
    setToken: setServerToken,
    clearToken: clearServerToken,
    reviewMode: reviewMode,
    reviewLink: fetchReviewLink,
    /* Where the document lives (_home.js), for the suites that watch the
       pull channel take a rev off a heartbeat (#69) — `rev` is the
       compare-and-set token. A copy, not the record. */
    home: function () { return Object.assign({}, home); },
    /* Hand a heartbeat's answer straight to the pull channel, so a suite can
       drive it without waiting out a real two-second beat. */
    noteRev: notePresenceRev,
    /* What the server last confirmed, and whether this view thinks it holds
       anything the server does not — for tests/57-review-comments.txt, which
       watches a reviewer's comment go out through the comment routes (#71)
       and be folded back in. Copies, not the live objects. */
    base: function () { return S.baseState ? cloneState(S.baseState) : null; },
    dirty: function () { return !!S.dirty; }
  };
}
