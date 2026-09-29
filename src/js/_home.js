var FIELDS = {
  none: {},
  file: { handle: null, format: null, name: null, lastModified: null, diskBase: null },
  import: { handle: null, format: null, name: null, lastModified: null, size: null,
            inPlace: false, dirty: false },
  server: { id: null, rev: 0, conn: null }
};

var REQUIRED = { none: [], file: ["format"], import: ["name"], server: ["id", "conn"] };

export var HOME_KINDS = Object.keys(FIELDS);

export var home = { kind: "none" };

var CONN_FIELDS = { serverUrl: "", token: "", role: "", scope: "", tunnel: null };
var CONN_ROLES = ["", "edit", "review"];
var SCOPE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
var TUNNEL_FIELDS = ["userHost", "remotePort", "localPort"];

export function normalizeServerUrl(input) {
  var url = String(input || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = "http://" + url;
  return url.replace(/\/+$/, "") + "/";
}

function validPort(n) { return typeof n === "number" && n % 1 === 0 && n >= 1 && n <= 65535; }

function checkTunnel(t) {
  if (t === null) return null;
  if (!t || typeof t !== "object") throw new Error("setConnection: a tunnel is null or {userHost, remotePort, localPort}");
  Object.keys(t).forEach(function (k) {
    if (TUNNEL_FIELDS.indexOf(k) === -1) throw new Error("setConnection: a tunnel has no field " + JSON.stringify(k));
  });
  if (typeof t.userHost !== "string" || !/^[A-Za-z0-9._@:[\]-]{1,255}$/.test(t.userHost) || t.userHost[0] === "-") {
    throw new Error("setConnection: a tunnel needs a userHost");
  }
  if (!validPort(t.remotePort) || !validPort(t.localPort)) throw new Error("setConnection: a tunnel's ports are 1-65535");
  return { userHost: t.userHost, remotePort: t.remotePort, localPort: t.localPort };
}

function buildConn(fields, base) {
  fields = fields || {};
  Object.keys(fields).forEach(function (k) {
    if (!Object.prototype.hasOwnProperty.call(CONN_FIELDS, k)) {
      throw new Error("setConnection: a connection has no field " + JSON.stringify(k));
    }
  });
  var rec = {};
  Object.keys(CONN_FIELDS).forEach(function (k) {
    rec[k] = fields[k] === undefined ? base[k] : fields[k];
  });
  if (typeof rec.serverUrl !== "string" || rec.serverUrl !== normalizeServerUrl(rec.serverUrl)) {
    throw new Error("setConnection: serverUrl " + JSON.stringify(rec.serverUrl) +
                    " is not a normalized base — pass it through normalizeServerUrl()");
  }
  if (typeof rec.token !== "string") throw new Error("setConnection: a token is a string");
  if (CONN_ROLES.indexOf(rec.role) === -1) throw new Error("setConnection: unknown role " + JSON.stringify(rec.role));
  if (typeof rec.scope !== "string" || (rec.scope !== "" && !SCOPE_RE.test(rec.scope))) {
    throw new Error("setConnection: a scope is \"\" or a document id, not " + JSON.stringify(rec.scope));
  }
  rec.tunnel = checkTunnel(rec.tunnel);
  return rec;
}

export var conn = buildConn({}, CONN_FIELDS);

export function setConnection(fields) {
  if (home.kind === "server") {
    throw new Error("setConnection: this tab has a server document open — leave it (setHome) " +
                    "before pointing the tab somewhere else, or use updateConnection()");
  }
  conn = buildConn(fields, CONN_FIELDS);
  return conn;
}

export function updateConnection(fields) {
  fields = fields || {};
  if (fields.serverUrl !== undefined && fields.serverUrl !== conn.serverUrl) {
    throw new Error("updateConnection: the server is not a field that moves — use setConnection()");
  }
  if (fields.tunnel !== undefined) {
    throw new Error("updateConnection: the tunnel belongs to the server — use setConnection()");
  }
  var next = buildConn(fields, conn);
  conn.token = next.token;
  conn.role = next.role;
  conn.scope = next.scope;
  return conn;
}

function buildHome(kind, fields) {
  var shape = FIELDS[kind];
  if (!shape) throw new Error("setHome: unknown kind " + JSON.stringify(kind));
  fields = fields || {};
  if (fields.kind !== undefined && fields.kind !== kind) {
    throw new Error("setHome: kind " + JSON.stringify(fields.kind) + " given for a " + kind +
                    " home — a file's format is `format`");
  }
  Object.keys(fields).forEach(function (k) {
    if (k !== "kind" && !Object.prototype.hasOwnProperty.call(shape, k)) {
      throw new Error("setHome: a " + kind + " home has no field " + JSON.stringify(k));
    }
  });
  var rec = { kind: kind };
  Object.keys(shape).forEach(function (k) {
    rec[k] = fields[k] === undefined ? shape[k] : fields[k];
  });
  REQUIRED[kind].forEach(function (k) {
    if (rec[k] === null || rec[k] === undefined || rec[k] === "") {
      throw new Error("setHome: a " + kind + " home needs " + JSON.stringify(k));
    }
  });
  return rec;
}

export function setHome(kind, fields) {
  var rec = buildHome(kind, kind === "server" ? withConn(fields) : fields);
  home = rec;
  return home;
}

function withConn(fields) {
  fields = fields || {};
  if (fields.conn !== undefined && fields.conn !== conn) {
    throw new Error("setHome: a server home's conn is this tab's connection — " +
                    "setConnection() first, then open the document");
  }
  var out = {};
  Object.keys(fields).forEach(function (k) { out[k] = fields[k]; });
  out.conn = conn;
  return out;
}

export function homeConn() {
  return home.kind === "server" ? home.conn : null;
}

export function restoreHome(record) {
  if (!record || !FIELDS[record.kind]) throw new Error("restoreHome: not a home record");
  if (record.kind === "server" && record.conn !== conn) {
    throw new Error("restoreHome: that server home belongs to a connection this tab no longer has");
  }
  home = record;
  return home;
}

export function serverHomeId() {
  return home.kind === "server" ? home.id : null;
}

export function fileHome() {
  return home.kind === "file" ? home : null;
}

export function importHome() {
  return home.kind === "import" ? home : null;
}
