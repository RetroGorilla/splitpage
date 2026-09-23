/* Splitpage desktop — Google Drive through a loopback OAuth redirect (#10).
 *
 * WHY MAIN OWNS ALL OF IT. The web build signs in with Google Identity
 * Services, which needs an https origin Google has been told about; the
 * desktop app's pages live at splitpage://app, which Google will never accept
 * as a redirect. Google's answer for installed apps is the loopback redirect:
 * the app listens on http://127.0.0.1:<any port>, opens the consent page in
 * the person's own browser, and Google sends the browser back to the listener
 * with a one-time code. Whoever holds the listener holds the code, so the
 * listener lives here, in the main process, and so does everything after it:
 * the code-for-token exchange, the refresh token, the access token, and every
 * Drive request. The renderer never holds a token and never names a URL
 * (invariant #28, the same rule splitpage:update-download follows).
 *
 * THE FLOW (signIn):
 *   1. A one-shot http listener on 127.0.0.1, port 0 (the OS picks).
 *   2. PKCE: a 32-byte random verifier, its S256 challenge in the auth URL.
 *      A random `state` rides along and must come back unchanged.
 *   3. The auth URL goes to openExternal (shell.openExternal in main).
 *   4. The first request to the listener's "/" is THE callback. Wrong Host
 *      header -> refused and ignored (a DNS-rebinding page cannot spend it).
 *      Wrong or missing state -> the sign-in fails with STATE_MISMATCH.
 *      error=... -> DENIED. Either way the listener closes: one callback.
 *      Anything that is not "/" (a favicon probe) gets a 404 and is ignored.
 *   5. No callback within CALLBACK_TIMEOUT_MS -> TIMEOUT, listener closed.
 *   6. Main exchanges code + verifier at the token endpoint. The refresh
 *      token is stored (see TOKENS); the access token stays in memory.
 *
 * TOKENS. The refresh token is written ONLY as a safeStorage blob
 * (TOKEN_FILE in userData) — the OS keychain / DPAPI / libsecret encrypts it.
 * If safeStorage cannot encrypt (Linux with no keyring), the token is kept in
 * memory for this session only and status() says persisted:false, so the
 * modal can tell the person they will sign in again next launch. It is never
 * in desktop-state.json, a draft, or the app-data export: those are written
 * by other code that has no way to reach this module's state. The access
 * token never leaves memory. signOut() revokes (best effort, short timeout)
 * and deletes the blob.
 *
 * CONFIG. A Desktop-type OAuth client ID (and its "secret", which Google
 * issues for installed apps and documents as not confidential) comes from
 *   SPLITPAGE_GOOGLE_CLIENT_ID / SPLITPAGE_GOOGLE_CLIENT_SECRET, or
 *   <userData>/google-oauth-client.json — either {"client_id","client_secret"}
 *   or the file Google Cloud Console downloads ({"installed": {...}}).
 * Env wins. With neither, status() says configured:false and signIn()
 * answers NOT_CONFIGURED; the modal explains where to put it.
 *
 * ENDPOINTS. Fixed Google hosts. createGoogleDrive({testEndpointsBase}) points
 * them all at one local fake instead, and is refused unless testMode is also
 * true — main passes testMode only under SPLITPAGE_TEST=1. Every outgoing
 * request is checked against the endpoint origins before it is sent.
 *
 * Plain CommonJS, Node built-ins only (global fetch), no Electron: main.js
 * injects safeStorage and shell.openExternal, and
 * desktop/test/google-drive.test.mjs drives it under plain node.
 */

"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const GOOGLE = Object.freeze({
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  drive: "https://www.googleapis.com/drive/v3",
  upload: "https://www.googleapis.com/upload/drive/v3"
});

/* The web build asks for the same scope (DRIVE_SCOPE in 13-hosted.js): the
   modal browses folders the person names, which drive.file cannot see. */
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

const TOKEN_FILE = "google-drive-token.bin";
const ENV_VARS = Object.freeze(["SPLITPAGE_GOOGLE_CLIENT_ID", "SPLITPAGE_GOOGLE_CLIENT_SECRET"]);
const CLIENT_FILE = "google-oauth-client.json";

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const REVOKE_TIMEOUT_MS = 5 * 1000;
/* Same ceiling as a teleprompter share / draft body: a script is text. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_NAME_CHARS = 255;
const MAX_LIST_PAGES = 10;

const DRIVE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,256}$/;
const CLIENT_SECRET_RE = /^[A-Za-z0-9._~-]{1,256}$/;
const FOLDER_MIME = "application/vnd.google-apps.folder";

function isDriveId(v) { return typeof v === "string" && DRIVE_ID_RE.test(v); }
/* "root" is Drive's own alias for My Drive and matches the id pattern. */

function isFileName(v) {
  return typeof v === "string" && v.length >= 1 && v.length <= MAX_NAME_CHARS &&
    !hasControlChar(v) && v.trim() === v && v !== "." && v !== "..";
}

function hasControlChar(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function toBytes(v) {
  if (typeof v === "string") return Buffer.from(v, "utf8");
  if (v instanceof ArrayBuffer) return Buffer.from(new Uint8Array(v));
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  return null;
}

function b64url(buf) { return Buffer.from(buf).toString("base64url"); }

/* ------------------------------------------------------------------ config */

function readClientConfig(opts) {
  const env = (opts && opts.env) || {};
  const dir = opts && opts.userDataDir;
  let id = String(env.SPLITPAGE_GOOGLE_CLIENT_ID || "").trim();
  let secret = String(env.SPLITPAGE_GOOGLE_CLIENT_SECRET || "").trim();
  let source = id ? "env" : null;
  if (!id && dir) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, CLIENT_FILE), "utf8"));
      const o = raw && typeof raw === "object" ? (raw.installed || raw) : null;
      if (o && typeof o.client_id === "string") {
        id = o.client_id.trim();
        secret = typeof o.client_secret === "string" ? o.client_secret.trim() : "";
        source = "file";
      }
    } catch (_) { /* absent or unreadable: not configured */ }
  }
  if (!id || !CLIENT_ID_RE.test(id)) return { configured: false, source: null };
  if (secret && !CLIENT_SECRET_RE.test(secret)) secret = "";
  return { configured: true, source, clientId: id, clientSecret: secret };
}

/* ------------------------------------------------------------------ pages */

function callbackPage(ok, message) {
  const title = ok ? "Signed in to Google Drive" : "Google Drive sign-in did not finish";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>" +
    "<title>" + esc(title) + "</title>" +
    "<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32em;margin:15vh auto;padding:0 16px;color:#222;background:#fff}" +
    "@media (prefers-color-scheme:dark){body{color:#eee;background:#1b1b1b}}</style>" +
    "<h1>" + esc(title) + "</h1><p>" + esc(message) + "</p>";
}

/* ------------------------------------------------------------------ factory */

function createGoogleDrive(opts) {
  const o = opts || {};
  if (o.testEndpointsBase && !o.testMode) throw new Error("google-drive: endpoint override outside test mode");
  const endpoints = o.testEndpointsBase
    ? (() => {
      const base = new URL(o.testEndpointsBase);
      if (base.protocol !== "http:" || !/^(127\.0\.0\.1|localhost)$/.test(base.hostname)) {
        throw new Error("google-drive: test endpoints must be on loopback");
      }
      const b = base.origin;
      return Object.freeze({
        auth: b + "/o/oauth2/v2/auth", token: b + "/token", revoke: b + "/revoke",
        drive: b + "/drive/v3", upload: b + "/upload/drive/v3"
      });
    })()
    : GOOGLE;
  const allowedOrigins = new Set(Object.values(endpoints).map((u) => new URL(u).origin));

  const userDataDir = o.userDataDir;
  const tokenPath = userDataDir ? path.join(userDataDir, TOKEN_FILE) : null;
  const storage = o.safeStorage || null;
  const openExternal = o.openExternal;
  const fetchImpl = o.fetch || globalThis.fetch;
  const env = o.env || {};
  const callbackTimeoutMs = o.callbackTimeoutMs || CALLBACK_TIMEOUT_MS;
  const log = typeof o.log === "function" ? o.log : () => {};

  let refreshToken = null;       // memory copy; the disk copy is the safeStorage blob
  let persisted = false;
  let access = null;             // { token, expiresAt }
  let account = null;            // { email, name } for the status line only
  let pending = null;            // the in-flight sign-in promise
  let pendingListener = null;    // its server, so shutdown() can close it
  let loaded = false;

  function config() { return readClientConfig({ env, userDataDir }); }
  function canEncrypt() {
    try { return !!(storage && storage.isEncryptionAvailable()); } catch (_) { return false; }
  }

  function loadStored() {
    if (loaded) return;
    loaded = true;
    if (!tokenPath || !canEncrypt()) return;
    try {
      const blob = fs.readFileSync(tokenPath);
      const rec = JSON.parse(storage.decryptString(blob));
      if (rec && typeof rec.refreshToken === "string" && rec.refreshToken) {
        refreshToken = rec.refreshToken;
        persisted = true;
        account = rec.account && typeof rec.account === "object" ? rec.account : null;
      }
    } catch (e) {
      if (e && e.code !== "ENOENT") log("google-drive: stored token unreadable, ignoring: " + (e && e.message));
    }
  }

  function saveStored() {
    persisted = false;
    if (!tokenPath || !canEncrypt() || !refreshToken) return;
    try {
      const blob = storage.encryptString(JSON.stringify({ refreshToken, account }));
      fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
      const tmp = tokenPath + ".tmp";
      fs.writeFileSync(tmp, blob, { mode: 0o600 });
      fs.renameSync(tmp, tokenPath);
      persisted = true;
    } catch (e) {
      log("google-drive: could not store the token, keeping it for this session only: " + (e && e.message));
    }
  }

  function forgetLocal() {
    refreshToken = null; access = null; account = null; persisted = false;
    if (tokenPath) { try { fs.rmSync(tokenPath, { force: true }); } catch (_) { /* gone is gone */ } }
  }

  /* Every outgoing request goes through here: fixed origins only, a timeout,
     and no redirect following (a redirect off Google's hosts would be a
     request to a URL nobody checked). */
  async function request(url, init, timeoutMs) {
    const u = new URL(url);
    if (!allowedOrigins.has(u.origin)) throw codeError("BAD_HOST", "refused request to " + u.origin);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs || REQUEST_TIMEOUT_MS);
    try {
      return await fetchImpl(u.href, Object.assign({}, init, { signal: ctl.signal, redirect: "manual" }));
    } catch (e) {
      throw codeError("NETWORK", ctl.signal.aborted ? "timed out" : String(e && e.message || e));
    } finally { clearTimeout(t); }
  }

  async function tokenRequest(params) {
    const cfg = config();
    const body = new URLSearchParams(Object.assign({ client_id: cfg.clientId }, cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}, params));
    const res = await request(endpoints.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString()
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* fall through */ }
    if (!res.ok || !json || typeof json.access_token !== "string") {
      const err = json && typeof json.error === "string" ? json.error : "http_" + res.status;
      throw codeError(err === "invalid_grant" ? "INVALID_GRANT" : "TOKEN_FAILED", err);
    }
    return json;
  }

  function takeTokens(json) {
    const ttl = Number(json.expires_in) > 0 ? Number(json.expires_in) : 3600;
    access = { token: json.access_token, expiresAt: Date.now() + (ttl - 60) * 1000 };
    if (typeof json.refresh_token === "string" && json.refresh_token) refreshToken = json.refresh_token;
  }

  async function accessToken() {
    loadStored();
    if (access && Date.now() < access.expiresAt) return access.token;
    if (!refreshToken) throw codeError("SIGNED_OUT", "not signed in");
    if (!config().configured) throw codeError("NOT_CONFIGURED", "no client ID");
    try {
      takeTokens(await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }));
    } catch (e) {
      /* Revoked in the Google account, or expired: the stored token is dead. */
      if (e.code === "INVALID_GRANT") { forgetLocal(); throw codeError("SIGNED_OUT", "Google no longer accepts this sign-in"); }
      throw e;
    }
    return access.token;
  }

  async function driveRequest(url, init, retried) {
    const token = await accessToken();
    const headers = Object.assign({}, init && init.headers, { authorization: "Bearer " + token });
    const res = await request(url, Object.assign({}, init, { headers }));
    if (res.status === 401 && !retried) { access = null; return driveRequest(url, init, true); }
    return res;
  }

  async function driveJson(url, init) {
    const res = await driveRequest(url, init);
    if (!res.ok) throw await driveError(res);
    return res.json();
  }

  async function driveError(res) {
    let reason = "";
    try { const j = await res.json(); reason = j && j.error && (j.error.message || j.error.status) || ""; } catch (_) { /* no body */ }
    const code = res.status === 404 ? "NOT_FOUND" : res.status === 403 ? "FORBIDDEN" : "DRIVE_ERROR";
    return codeError(code, String(reason || ("HTTP " + res.status)).slice(0, 300));
  }

  /* ---------------------------------------------------------------- sign-in */

  function signIn() {
    loadStored();
    if (pending) return pending;
    const cfg = config();
    if (!cfg.configured) return Promise.resolve({ ok: false, code: "NOT_CONFIGURED" });
    if (typeof openExternal !== "function") return Promise.resolve({ ok: false, code: "NO_BROWSER" });
    pending = runSignIn(cfg).finally(() => { pending = null; pendingListener = null; });
    return pending;
  }

  async function runSignIn(cfg) {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    const state = b64url(crypto.randomBytes(24));

    let settle;
    const outcome = new Promise((resolve) => { settle = resolve; });
    let done = false;
    const server = http.createServer((req, res) => {
      const port = server.address() && server.address().port;
      const host = String(req.headers.host || "").toLowerCase();
      const page = (status, ok, msg) => {
        res.writeHead(status, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
          "referrer-policy": "no-referrer",
          connection: "close"
        });
        res.end(callbackPage(ok, msg));
      };
      if (host !== "127.0.0.1:" + port && host !== "localhost:" + port) { res.writeHead(421, { connection: "close" }); res.end(); return; }
      let u;
      try { u = new URL(req.url, "http://127.0.0.1:" + port); } catch (_) { res.writeHead(400); res.end(); return; }
      if (req.method !== "GET" || u.pathname !== "/" || done) { res.writeHead(404, { connection: "close" }); res.end(); return; }
      done = true;
      const q = u.searchParams;
      if (q.get("state") !== state) {
        page(400, false, "This sign-in link did not come from the request Splitpage made, so it was refused. Return to Splitpage and try again.");
        settle({ ok: false, code: "STATE_MISMATCH" });
      } else if (q.get("error") || !q.get("code")) {
        page(200, false, "Google did not grant access. You can close this tab and return to Splitpage.");
        settle({ ok: false, code: q.get("error") === "access_denied" ? "DENIED" : "NO_CODE" });
      } else {
        page(200, true, "You can close this tab and return to Splitpage.");
        settle({ ok: true, code: q.get("code") });
      }
    });
    server.on("connection", (s) => s.setTimeout(10000, () => s.destroy()));
    pendingListener = server;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const redirectUri = "http://127.0.0.1:" + server.address().port;
    const timer = setTimeout(() => { done = true; settle({ ok: false, code: "TIMEOUT" }); }, callbackTimeoutMs);
    const cancelHook = () => { done = true; settle({ ok: false, code: "CANCELLED" }); };
    server.on("close", cancelHook);

    const auth = new URL(endpoints.auth);
    auth.search = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: DRIVE_SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      access_type: "offline",
      prompt: "consent"
    }).toString();

    let result;
    try {
      await openExternal(auth.href);
      result = await outcome;
    } catch (e) {
      result = { ok: false, code: "NO_BROWSER" };
    } finally {
      clearTimeout(timer);
      server.off("close", cancelHook);
      server.close();
      server.closeAllConnections && server.closeAllConnections();
    }
    if (!result.ok) return result;

    try {
      const json = await tokenRequest({
        grant_type: "authorization_code", code: result.code, redirect_uri: redirectUri, code_verifier: verifier
      });
      if (typeof json.refresh_token !== "string" || !json.refresh_token) {
        /* Without a refresh token the sign-in would lapse within the hour. */
        return { ok: false, code: "NO_REFRESH_TOKEN" };
      }
      takeTokens(json);
    } catch (e) {
      return { ok: false, code: e.code || "TOKEN_FAILED" };
    }
    account = null;
    try {
      const about = await driveJson(endpoints.drive + "/about?fields=" + encodeURIComponent("user(emailAddress,displayName)"));
      const u = about && about.user || {};
      account = { email: String(u.emailAddress || "").slice(0, 320), name: String(u.displayName || "").slice(0, 200) };
    } catch (_) { /* the status line just says "signed in" */ }
    saveStored();
    /* `pending` is still this promise until the caller's finally runs. */
    return Object.assign({ ok: true }, statusNow(), { signingIn: false });
  }

  function statusNow() {
    const cfg = config();
    return {
      configured: cfg.configured,
      /* Where to put the client, for the modal's not-configured message.
         Main telling the page a path is not invariant #34's concern (that
         is the page naming one to main); it is this app's own config file,
         never a document. */
      clientFilePath: userDataDir ? path.join(userDataDir, CLIENT_FILE) : CLIENT_FILE,
      envVars: ENV_VARS.slice(),
      signedIn: !!refreshToken,
      persisted: !!refreshToken && persisted,
      canPersist: canEncrypt(),
      signingIn: !!pending,
      email: account && account.email || "",
      name: account && account.name || ""
    };
  }

  function status() { loadStored(); return statusNow(); }

  async function signOut() {
    loadStored();
    closePendingListener();
    const rt = refreshToken;
    forgetLocal();
    if (rt) {
      try {
        await request(endpoints.revoke, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: rt }).toString()
        }, REVOKE_TIMEOUT_MS);
      } catch (_) { /* local sign-out stands either way */ }
    }
    return { ok: true, status: statusNow() };
  }

  /* ---------------------------------------------------------------- Drive */

  function cleanEntry(f) {
    return {
      id: isDriveId(f && f.id) ? f.id : "",
      name: String(f && f.name || "").slice(0, MAX_NAME_CHARS),
      mimeType: String(f && f.mimeType || "").slice(0, 200),
      size: f && f.size != null && /^\d{1,16}$/.test(String(f.size)) ? Number(f.size) : null,
      modifiedTime: String(f && f.modifiedTime || "").slice(0, 40)
    };
  }

  async function folder(folderId) {
    if (!isDriveId(folderId)) throw codeError("BAD_ARGS", "folder id");
    const meta = await driveJson(endpoints.drive + "/files/" + folderId +
      "?supportsAllDrives=true&fields=" + encodeURIComponent("id,name,mimeType"));
    if (meta.mimeType !== FOLDER_MIME) throw codeError("NOT_A_FOLDER", "not a folder");
    const files = [];
    let pageToken = "";
    for (let i = 0; i < MAX_LIST_PAGES; i++) {
      const q = new URLSearchParams({
        q: "'" + folderId + "' in parents and trashed = false",
        fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime)",
        orderBy: "folder,name",
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true"
      });
      if (pageToken) q.set("pageToken", pageToken);
      const page = await driveJson(endpoints.drive + "/files?" + q.toString());
      for (const f of Array.isArray(page.files) ? page.files : []) {
        const e = cleanEntry(f);
        if (e.id) files.push(e);
      }
      pageToken = typeof page.nextPageToken === "string" ? page.nextPageToken : "";
      if (!pageToken) break;
    }
    return { folder: cleanEntry(meta), files };
  }

  async function download(fileId) {
    if (!isDriveId(fileId)) throw codeError("BAD_ARGS", "file id");
    const meta = cleanEntry(await driveJson(endpoints.drive + "/files/" + fileId +
      "?supportsAllDrives=true&fields=" + encodeURIComponent("id,name,mimeType,size,modifiedTime")));
    if (meta.mimeType === FOLDER_MIME) throw codeError("IS_A_FOLDER", "folder");
    let url;
    if (meta.mimeType === "application/vnd.google-apps.document") {
      /* A Google Doc has no bytes of its own; plain text is what a script
         editor can open. Other Google-native types are not scripts. */
      url = endpoints.drive + "/files/" + fileId + "/export?mimeType=text%2Fplain";
    } else if (/^application\/vnd\.google-apps\./.test(meta.mimeType)) {
      throw codeError("UNSUPPORTED", "Google-native file");
    } else {
      if (meta.size != null && meta.size > MAX_FILE_BYTES) throw codeError("TOO_LARGE", "file too large");
      url = endpoints.drive + "/files/" + fileId + "?alt=media&supportsAllDrives=true";
    }
    const res = await driveRequest(url);
    if (!res.ok) throw await driveError(res);
    const bytes = await readCapped(res, MAX_FILE_BYTES);
    return { file: meta, bytes };
  }

  async function upload(args) {
    const a = args && typeof args === "object" ? args : {};
    const bytes = toBytes(a.bytes);
    if (!bytes || bytes.length > MAX_FILE_BYTES) throw codeError(bytes ? "TOO_LARGE" : "BAD_ARGS", "content");
    const mime = typeof a.mimeType === "string" && /^[a-z0-9.+-]{1,60}\/[a-z0-9.+-]{1,100}$/i.test(a.mimeType) ? a.mimeType : "application/octet-stream";
    let url, method, metadata;
    if (a.fileId !== undefined) {
      if (!isDriveId(a.fileId)) throw codeError("BAD_ARGS", "file id");
      if (a.name !== undefined && !isFileName(a.name)) throw codeError("BAD_ARGS", "name");
      url = endpoints.upload + "/files/" + a.fileId + "?uploadType=multipart&supportsAllDrives=true&fields=" + encodeURIComponent("id,name,mimeType,size,modifiedTime");
      method = "PATCH";
      metadata = a.name !== undefined ? { name: a.name } : {};
    } else {
      if (!isDriveId(a.parentId)) throw codeError("BAD_ARGS", "folder id");
      if (!isFileName(a.name)) throw codeError("BAD_ARGS", "name");
      url = endpoints.upload + "/files?uploadType=multipart&supportsAllDrives=true&fields=" + encodeURIComponent("id,name,mimeType,size,modifiedTime");
      method = "POST";
      metadata = { name: a.name, parents: [a.parentId] };
    }
    const boundary = "splitpage" + crypto.randomBytes(12).toString("hex");
    const body = Buffer.concat([
      Buffer.from("--" + boundary + "\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(metadata) +
        "\r\n--" + boundary + "\r\ncontent-type: " + mime + "\r\n\r\n", "utf8"),
      bytes,
      Buffer.from("\r\n--" + boundary + "--\r\n", "utf8")
    ]);
    const json = await driveJson(url, { method, headers: { "content-type": "multipart/related; boundary=" + boundary }, body });
    return { file: cleanEntry(json) };
  }

  /* Wrap each Drive call so the renderer gets {ok, ...} or {ok:false, code},
     never an exception text that might carry a URL with a token in it. */
  function answer(fn) {
    return async (...args) => {
      try { return Object.assign({ ok: true }, await fn(...args)); } catch (e) {
        if (!e || !e.code) log("google-drive: " + (e && e.stack || e));
        return { ok: false, code: e && e.code || "FAILED", message: e && e.code ? String(e.message || "").slice(0, 300) : "" };
      }
    };
  }

  /* A sign-in still waiting for its browser: stop listening now, which
     settles it as CANCELLED ('close' fires once no connection is left, so
     a browser's keep-alive socket is dropped too). */
  function closePendingListener() {
    if (!pendingListener) return;
    pendingListener.close();
    if (pendingListener.closeAllConnections) pendingListener.closeAllConnections();
  }

  function shutdown() { closePendingListener(); }

  return {
    status,
    signIn,
    signOut,
    listFolder: answer(folder),
    download: answer(download),
    upload: answer(upload),
    shutdown,
    /* For tests: where the blob lives, and the endpoint set in use. */
    tokenPath,
    endpoints
  };
}

async function readCapped(res, cap) {
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > cap) throw codeError("TOO_LARGE", "file too large");
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > cap) throw codeError("TOO_LARGE", "file too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function codeError(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

module.exports = {
  createGoogleDrive,
  readClientConfig,
  isDriveId,
  isFileName,
  GOOGLE,
  DRIVE_SCOPE,
  TOKEN_FILE,
  CLIENT_FILE,
  ENV_VARS,
  MAX_FILE_BYTES,
  MAX_NAME_CHARS
};
