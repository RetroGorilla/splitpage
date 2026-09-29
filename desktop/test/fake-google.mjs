import http from "node:http";
import crypto from "node:crypto";

export const FOLDER_MIME = "application/vnd.google-apps.folder";

export async function startFakeGoogle(opts) {
  const o = opts || {};
  const clientId = o.clientId || "123-fake.apps.googleusercontent.com";
  const clientSecret = o.clientSecret || "fake-secret";
  const codes = new Map();
  const refreshTokens = new Map();
  const accessTokens = new Set();
  const log = [];
  let seq = 0;
  const nextId = () => "f" + (++seq).toString(36).padStart(6, "0") + crypto.randomBytes(3).toString("hex");

  const files = new Map();
  const add = (f) => { files.set(f.id, Object.assign({ modifiedTime: new Date().toISOString() }, f)); return f.id; };
  add({ id: "root", name: "My Drive", mimeType: FOLDER_MIME, parents: [] });
  const scriptsId = add({ id: "scriptsFolder01", name: "Scripts", mimeType: FOLDER_MIME, parents: ["root"] });
  const pilotId = add({ id: "pilotFile01", name: "Pilot.fountain", mimeType: "text/plain", parents: [scriptsId],
    data: Buffer.from("INT. KITCHEN - DAY\n\nA fake scene from a fake Drive.\n", "utf8") });
  add({ id: "gdoc01", name: "Notes", mimeType: "application/vnd.google-apps.document", parents: [scriptsId],
    data: Buffer.from("Notes exported as text.\n", "utf8") });
  add({ id: "sheet01", name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet", parents: [scriptsId] });

  const meta = (f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime,
    ...(f.data && !/^application\/vnd\.google-apps\./.test(f.mimeType) ? { size: String(f.data.length) } : {}) });

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }
  const json = (res, status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  const b64url = (b) => Buffer.from(b).toString("base64url");

  function issueTokens(withRefresh) {
    const at = "ya29.fake-" + crypto.randomBytes(18).toString("hex");
    accessTokens.add(at);
    const out = { access_token: at, expires_in: 3599, token_type: "Bearer", scope: "https://www.googleapis.com/auth/drive" };
    if (withRefresh) {
      const rt = "1//fake-refresh-" + crypto.randomBytes(18).toString("hex");
      refreshTokens.set(rt, { revoked: false });
      out.refresh_token = rt;
    }
    return out;
  }

  function parseMultipart(req, body) {
    const m = /boundary=([^;]+)/.exec(String(req.headers["content-type"] || ""));
    if (!m) return null;
    const sep = Buffer.from("--" + m[1]);
    const parts = [];
    let at = body.indexOf(sep);
    while (at !== -1) {
      const start = at + sep.length;
      if (body.slice(start, start + 2).toString() === "--") break;
      const next = body.indexOf(sep, start);
      if (next === -1) break;
      const part = body.slice(start + 2, next - 2);
      const split = part.indexOf("\r\n\r\n");
      parts.push({ headers: part.slice(0, split).toString(), data: part.slice(split + 4) });
      at = next;
    }
    if (parts.length !== 2) return null;
    return { metadata: JSON.parse(parts[0].data.toString("utf8") || "{}"), data: parts[1].data, mime: /content-type:\s*([^\r\n;]+)/i.exec(parts[1].headers)?.[1] || "" };
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://fake");
    log.push(req.method + " " + u.pathname);
    const body = await readBody(req);
    try {
      if (u.pathname === "/o/oauth2/v2/auth") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("fake consent screen — tests call approve() instead");
        return;
      }
      if (u.pathname === "/token" && req.method === "POST") {
        const p = new URLSearchParams(body.toString("utf8"));
        if (p.get("client_id") !== clientId || p.get("client_secret") !== clientSecret) return json(res, 401, { error: "invalid_client" });
        if (p.get("grant_type") === "authorization_code") {
          const rec = codes.get(p.get("code"));
          if (!rec || rec.used) return json(res, 400, { error: "invalid_grant" });
          rec.used = true;
          const want = b64url(crypto.createHash("sha256").update(String(p.get("code_verifier") || "")).digest());
          if (want !== rec.challenge) return json(res, 400, { error: "invalid_grant", error_description: "code_verifier" });
          if (p.get("redirect_uri") !== rec.redirectUri) return json(res, 400, { error: "redirect_uri_mismatch" });
          return json(res, 200, issueTokens(true));
        }
        if (p.get("grant_type") === "refresh_token") {
          const rec = refreshTokens.get(p.get("refresh_token"));
          if (!rec || rec.revoked) return json(res, 400, { error: "invalid_grant" });
          return json(res, 200, issueTokens(false));
        }
        return json(res, 400, { error: "unsupported_grant_type" });
      }
      if (u.pathname === "/revoke" && req.method === "POST") {
        const t = new URLSearchParams(body.toString("utf8")).get("token");
        const rec = refreshTokens.get(t);
        if (rec) rec.revoked = true;
        accessTokens.delete(t);
        return json(res, rec ? 200 : 400, rec ? {} : { error: "invalid_token" });
      }

      const auth = /^Bearer (.+)$/.exec(String(req.headers.authorization || ""));
      if (!auth || !accessTokens.has(auth[1])) return json(res, 401, { error: { code: 401, message: "Invalid Credentials" } });

      if (u.pathname === "/drive/v3/about") {
        return json(res, 200, { user: { emailAddress: "writer@example.com", displayName: "Fake Writer" } });
      }
      let m;
      if (u.pathname === "/drive/v3/files" && req.method === "GET") {
        const q = /^'([A-Za-z0-9_-]+)' in parents and trashed = false$/.exec(u.searchParams.get("q") || "");
        if (!q) return json(res, 400, { error: { message: "bad q" } });
        const list = [...files.values()].filter((f) => f.parents.includes(q[1]))
          .sort((a, b) => ((b.mimeType === FOLDER_MIME) - (a.mimeType === FOLDER_MIME)) || a.name.localeCompare(b.name));
        return json(res, 200, { files: list.map(meta) });
      }
      if ((m = /^\/drive\/v3\/files\/([A-Za-z0-9_-]+)(\/export)?$/.exec(u.pathname)) && req.method === "GET") {
        const f = files.get(m[1]);
        if (!f) return json(res, 404, { error: { code: 404, message: "File not found: " + m[1] } });
        if (m[2]) {
          if (f.mimeType !== "application/vnd.google-apps.document") return json(res, 403, { error: { message: "export not supported" } });
          res.writeHead(200, { "content-type": "text/plain" });
          return res.end(f.data);
        }
        if (u.searchParams.get("alt") === "media") {
          if (!f.data) return json(res, 403, { error: { message: "no content" } });
          res.writeHead(200, { "content-type": f.mimeType, "content-length": f.data.length });
          return res.end(f.data);
        }
        return json(res, 200, meta(f));
      }
      if (u.pathname === "/upload/drive/v3/files" && req.method === "POST" && u.searchParams.get("uploadType") === "multipart") {
        const mp = parseMultipart(req, body);
        if (!mp || !mp.metadata.name || !Array.isArray(mp.metadata.parents)) return json(res, 400, { error: { message: "bad upload" } });
        const parent = files.get(mp.metadata.parents[0]);
        if (!parent || parent.mimeType !== FOLDER_MIME) return json(res, 404, { error: { message: "parent not found" } });
        const id = add({ id: nextId(), name: mp.metadata.name, mimeType: mp.mime || "application/octet-stream", parents: [parent.id], data: mp.data });
        return json(res, 200, meta(files.get(id)));
      }
      if ((m = /^\/upload\/drive\/v3\/files\/([A-Za-z0-9_-]+)$/.exec(u.pathname)) && req.method === "PATCH") {
        const f = files.get(m[1]);
        if (!f) return json(res, 404, { error: { code: 404, message: "File not found" } });
        const mp = parseMultipart(req, body);
        if (!mp) return json(res, 400, { error: { message: "bad upload" } });
        if (mp.metadata.name) f.name = mp.metadata.name;
        f.data = mp.data;
        f.modifiedTime = new Date().toISOString();
        return json(res, 200, meta(f));
      }
      return json(res, 404, { error: { message: "fake google: no route " + req.method + " " + u.pathname } });
    } catch (e) {
      return json(res, 500, { error: { message: String(e && e.stack || e) } });
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;

  return {
    base,
    clientId,
    clientSecret,
    files,
    log,
    ids: { scripts: scriptsId, pilot: pilotId },
    approve(authUrl, override) {
      const a = new URL(authUrl);
      const p = a.searchParams;
      if (a.origin !== base || a.pathname !== "/o/oauth2/v2/auth") throw new Error("approve: not this fake's auth URL: " + authUrl);
      if (p.get("client_id") !== clientId) throw new Error("approve: wrong client_id");
      if (p.get("code_challenge_method") !== "S256" || !p.get("code_challenge")) throw new Error("approve: no S256 PKCE");
      const redirectUri = p.get("redirect_uri");
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(redirectUri)) throw new Error("approve: redirect_uri is not loopback: " + redirectUri);
      const code = "4/fake-code-" + crypto.randomBytes(12).toString("hex");
      codes.set(code, { challenge: p.get("code_challenge"), redirectUri, used: false });
      const back = new URL(redirectUri + "/");
      const ov = override || {};
      if (ov.error) back.searchParams.set("error", ov.error);
      else back.searchParams.set("code", code);
      back.searchParams.set("state", ov.state !== undefined ? ov.state : p.get("state"));
      back.searchParams.set("scope", p.get("scope") || "");
      return back.href;
    },
    secrets() { return [...refreshTokens.keys(), ...accessTokens]; },
    isRevoked(rt) { const r = refreshTokens.get(rt); return !!(r && r.revoked); },
    close() { return new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }); }
  };
}
