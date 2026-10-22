import { normalizeServerUrl } from "../../../shared/server-links.js";
import { authorityOf, isReviewer } from "../collaboration/authority.ts";

export type HomeKind = "none" | "file" | "import" | "server";

export interface Tunnel {
  readonly userHost: string;
  readonly remotePort: number;
  readonly localPort: number;
}

export interface Connection {
  readonly serverUrl: string;
  readonly token: string;
  readonly role: "" | "edit" | "review";
  readonly scope: string;
  readonly tunnel: Tunnel | null;
}

export interface Home {
  readonly kind: HomeKind;
  readonly [field: string]: unknown;
}

export type HomeFields = Readonly<Record<string, unknown>>;

export type LocationChange = "home" | "connection" | "writtenOut";

export interface DocumentLocation {
  readonly home: () => Home;
  readonly connection: () => Connection;
  readonly setHome: (kind: string, fields?: HomeFields | null) => Home;
  readonly restoreHome: (record: Home) => Home;
  readonly amendHome: (record: Home, fields: HomeFields) => Home;
  readonly homeConn: () => Connection | null;
  readonly serverHomeId: () => string | null;
  readonly serverHomeRev: () => number | null;
  readonly fileHome: () => Home | null;
  readonly importHome: () => Home | null;
  readonly setConnection: (fields?: Readonly<Record<string, unknown>> | null) => Connection;
  readonly updateConnection: (fields?: Readonly<Record<string, unknown>> | null) => Connection;
  readonly serverOf: (c: unknown) => object | null;
  readonly stillOnServer: (c: unknown) => boolean;
  readonly reviewMode: () => boolean;
  readonly writtenOut: () => boolean;
  readonly markWrittenOut: (writtenOut: boolean) => void;
  readonly onChange: (listener: (change: LocationChange) => void) => () => void;
}

type Shape = Readonly<Record<string, unknown>>;

const FIELDS: Readonly<Record<HomeKind, Shape>> = Object.freeze({
  none: {},
  file: { handle: null, format: null, name: null, lastModified: null, diskBase: null },
  import: { handle: null, format: null, name: null, lastModified: null, size: null, inPlace: false, dirty: false, diskBase: null },
  server: { id: null, rev: 0, conn: null }
});

const REQUIRED: Readonly<Record<HomeKind, readonly string[]>> = Object.freeze({
  none: [],
  file: ["format"],
  import: ["name"],
  server: ["id", "conn"]
});

const AMENDABLE: Readonly<Record<HomeKind, readonly string[]>> = Object.freeze({
  none: [],
  file: ["diskBase", "lastModified"],
  import: ["dirty", "lastModified", "size", "inPlace", "diskBase"],
  server: ["rev"]
});

export const HOME_KINDS: readonly HomeKind[] = Object.freeze(["none", "file", "import", "server"]);

const CONN_FIELDS: Connection = Object.freeze({ serverUrl: "", token: "", role: "", scope: "", tunnel: null });
const CONN_ROLES: readonly string[] = ["", "edit", "review"];
const TUNNEL_FIELDS: readonly string[] = ["userHost", "remotePort", "localPort"];

function isKind(kind: string): kind is HomeKind {
  return Object.prototype.hasOwnProperty.call(FIELDS, kind);
}

function validPort(n: unknown): n is number {
  return typeof n === "number" && n % 1 === 0 && n >= 1 && n <= 65535;
}

function checkTunnel(t: unknown): Tunnel | null {
  if (t === null) return null;
  if (!t || typeof t !== "object") throw new Error("setConnection: a tunnel is null or {userHost, remotePort, localPort}");
  const given = t as Record<string, unknown>;
  Object.keys(given).forEach(function (k) {
    if (TUNNEL_FIELDS.indexOf(k) === -1) throw new Error("setConnection: a tunnel has no field " + JSON.stringify(k));
  });
  const userHost = given["userHost"];
  if (typeof userHost !== "string" || !/^[A-Za-z0-9._@:[\]-]{1,255}$/.test(userHost) || userHost[0] === "-") {
    throw new Error("setConnection: a tunnel needs a userHost");
  }
  const remotePort = given["remotePort"];
  const localPort = given["localPort"];
  if (!validPort(remotePort) || !validPort(localPort)) throw new Error("setConnection: a tunnel's ports are 1-65535");
  return { userHost: userHost, remotePort: remotePort, localPort: localPort };
}

function buildConn(fields: Readonly<Record<string, unknown>> | null | undefined, base: Connection): Record<string, unknown> {
  const given = fields || {};
  Object.keys(given).forEach(function (k) {
    if (!Object.prototype.hasOwnProperty.call(CONN_FIELDS, k)) {
      throw new Error("setConnection: a connection has no field " + JSON.stringify(k));
    }
  });
  const rec: Record<string, unknown> = {};
  (Object.keys(CONN_FIELDS) as (keyof Connection)[]).forEach(function (k) {
    rec[k] = given[k] === undefined ? base[k] : given[k];
  });
  const serverUrl = rec["serverUrl"];
  if (typeof serverUrl !== "string" || serverUrl !== normalizeServerUrl(serverUrl)) {
    throw new Error("setConnection: serverUrl " + JSON.stringify(serverUrl) +
                    " is not a normalized base — pass it through normalizeServerUrl()");
  }
  if (typeof rec["token"] !== "string") throw new Error("setConnection: a token is a string");
  if (CONN_ROLES.indexOf(rec["role"] as string) === -1) throw new Error("setConnection: unknown role " + JSON.stringify(rec["role"]));
  const scope = rec["scope"];
  if (typeof scope !== "string" || (scope !== "" && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(scope))) {
    throw new Error("setConnection: a scope is \"\" or a document id, not " + JSON.stringify(scope));
  }
  rec["tunnel"] = checkTunnel(rec["tunnel"]);
  return rec;
}

function refuseWrite(_target: Record<string, unknown>, field: string | symbol): boolean {
  throw new TypeError("A home's " + String(field) + " changes through the document location owner (amendHome)");
}

export function createDocumentLocation(): DocumentLocation {
  const readOnly: ProxyHandler<Record<string, unknown>> = { set: refuseWrite, defineProperty: refuseWrite, deleteProperty: refuseWrite };
  const serverOfConn = new WeakMap<object, object>();
  const recordOf = new WeakMap<object, Record<string, unknown>>();
  const listeners = new Set<(change: LocationChange) => void>();

  function announce(change: LocationChange): void {
    listeners.forEach(function (listener) { listener(change); });
  }

  function onNewServer(rec: Record<string, unknown>): Connection {
    serverOfConn.set(rec, Object.freeze({}));
    return Object.freeze(rec) as unknown as Connection;
  }

  function viewOf(rec: Record<string, unknown>): Home {
    const view = new Proxy(rec, readOnly) as unknown as Home;
    recordOf.set(view, rec);
    return view;
  }

  let conn: Connection = onNewServer(buildConn({}, CONN_FIELDS));
  let home: Home = viewOf({ kind: "none" });
  let writtenOut = false;

  function setConnection(fields?: Readonly<Record<string, unknown>> | null): Connection {
    if (home.kind === "server") {
      throw new Error("setConnection: this tab has a server document open — leave it (setHome) " +
                      "before pointing the tab somewhere else, or use updateConnection()");
    }
    conn = onNewServer(buildConn(fields, CONN_FIELDS));
    announce("connection");
    return conn;
  }

  function serverOf(c: unknown): object | null {
    return (c && typeof c === "object" && serverOfConn.get(c)) || null;
  }

  function stillOnServer(c: unknown): boolean {
    const server = serverOf(c);
    return server !== null && server === serverOf(conn);
  }

  function updateConnection(fields?: Readonly<Record<string, unknown>> | null): Connection {
    const given = fields || {};
    if (given["serverUrl"] !== undefined && given["serverUrl"] !== conn.serverUrl) {
      throw new Error("updateConnection: the server is not a field that moves — use setConnection()");
    }
    if (given["tunnel"] !== undefined) {
      throw new Error("updateConnection: the tunnel belongs to the server — use setConnection()");
    }
    const next = buildConn(given, conn);
    const server = serverOf(conn);
    if (server) serverOfConn.set(next, server);
    const was = conn;
    conn = Object.freeze(next) as unknown as Connection;
    const rec = recordOf.get(home);
    if (rec && rec["kind"] === "server" && rec["conn"] === was) rec["conn"] = conn;
    announce("connection");
    return conn;
  }

  function withConn(fields: HomeFields | null | undefined): HomeFields {
    const given = fields || {};
    if (given["conn"] !== undefined && given["conn"] !== conn) {
      throw new Error("setHome: a server home's conn is this tab's connection — " +
                      "setConnection() first, then open the document");
    }
    return { ...given, conn: conn };
  }

  function buildHome(kind: string, fields: HomeFields | null | undefined): Record<string, unknown> {
    if (!isKind(kind)) throw new Error("setHome: unknown kind " + JSON.stringify(kind));
    const shape = FIELDS[kind];
    const given = fields || {};
    if (given["kind"] !== undefined && given["kind"] !== kind) {
      throw new Error("setHome: kind " + JSON.stringify(given["kind"]) + " given for a " + kind +
                      " home — a file's format is `format`");
    }
    Object.keys(given).forEach(function (k) {
      if (k !== "kind" && !Object.prototype.hasOwnProperty.call(shape, k)) {
        throw new Error("setHome: a " + kind + " home has no field " + JSON.stringify(k));
      }
    });
    const rec: Record<string, unknown> = { kind: kind };
    Object.keys(shape).forEach(function (k) {
      rec[k] = given[k] === undefined ? shape[k] : given[k];
    });
    REQUIRED[kind].forEach(function (k) {
      if (rec[k] === null || rec[k] === undefined || rec[k] === "") {
        throw new Error("setHome: a " + kind + " home needs " + JSON.stringify(k));
      }
    });
    return rec;
  }

  function setHome(kind: string, fields?: HomeFields | null): Home {
    home = viewOf(buildHome(kind, kind === "server" ? withConn(fields) : fields));
    announce("home");
    return home;
  }

  function restoreHome(record: Home): Home {
    if (!record || !recordOf.has(record)) throw new Error("restoreHome: not a home record");
    if (record.kind === "server" && record["conn"] !== conn) {
      throw new Error("restoreHome: that server home belongs to a connection this tab no longer has");
    }
    home = record;
    announce("home");
    return home;
  }

  function amendHome(record: Home, fields: HomeFields): Home {
    const rec = record ? recordOf.get(record) : undefined;
    if (!rec) throw new Error("amendHome: not a home record");
    const kind = rec["kind"] as HomeKind;
    const allowed = AMENDABLE[kind];
    Object.keys(fields || {}).forEach(function (k) {
      if (allowed.indexOf(k) === -1) {
        throw new Error("amendHome: a " + kind + " home's " + JSON.stringify(k) + " is set when the home is made, not amended");
      }
    });
    Object.keys(fields || {}).forEach(function (k) { rec[k] = fields[k]; });
    if (record === home) announce("home");
    return record;
  }

  function homeConn(): Connection | null {
    return home.kind === "server" ? home["conn"] as Connection : null;
  }

  return Object.freeze({
    home: function () { return home; },
    connection: function () { return conn; },
    setHome: setHome,
    restoreHome: restoreHome,
    amendHome: amendHome,
    homeConn: homeConn,
    serverHomeId: function () { return home.kind === "server" ? home["id"] as string : null; },
    serverHomeRev: function () { return home.kind === "server" ? home["rev"] as number : null; },
    fileHome: function () { return home.kind === "file" ? home : null; },
    importHome: function () { return home.kind === "import" ? home : null; },
    setConnection: setConnection,
    updateConnection: updateConnection,
    serverOf: serverOf,
    stillOnServer: stillOnServer,
    reviewMode: function () { return isReviewer(authorityOf(homeConn())); },
    writtenOut: function () { return writtenOut; },
    markWrittenOut: function (on: boolean) {
      const next = !!on;
      if (next === writtenOut) return;
      writtenOut = next;
      announce("writtenOut");
    },
    onChange: function (listener: (change: LocationChange) => void) {
      listeners.add(listener);
      return function () { listeners.delete(listener); };
    }
  });
}
