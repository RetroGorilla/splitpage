export interface TransportConnection {
  readonly serverUrl: string;
  readonly token: string;
}

export interface ServerCaps {
  readonly blobs: boolean;
  readonly noClientHeader: boolean;
}

export interface TransportPorts {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly caps: () => ServerCaps;
}

export interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly raw?: BodyInit;
  readonly contentType?: string;
  readonly noClientHeader?: boolean;
}

export interface ApiError extends Error {
  code: string;
  payload?: unknown;
  detail?: string;
}

export interface ServerTransport {
  readonly connection: TransportConnection;
  readonly url: (path: string) => string;
  readonly request: (path: string, opts?: RequestOptions) => Promise<unknown>;
  readonly get: (path: string, accept: string) => Promise<Response | null>;
  readonly takesBlobs: () => boolean;
}

export const CLIENT_HEADER = "x-splitpage-client";
export const CLIENT_GENERATION = "2";
const TOKEN_HEADER = "x-splitpage-token";

export function apiError(code: string, message?: string): ApiError {
  const e = new Error(message || code) as ApiError;
  e.code = code;
  return e;
}

function errorOf(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const error = (body as { error?: unknown }).error;
  return typeof error === "string" ? error : "";
}

function detailOf(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const detail = (body as { detail?: unknown }).detail;
  return typeof detail === "string" ? detail : "";
}

function jsonOf(res: Response): Promise<unknown> {
  return res.json().catch(function () { return null; });
}

export function createServerTransport(connection: TransportConnection, ports: TransportPorts): ServerTransport {
  const held: TransportConnection = Object.freeze({ serverUrl: connection.serverUrl, token: connection.token });
  const base = held.serverUrl;

  function url(path: string): string {
    const rel = String(path || "").replace(/^\/+/, "");
    return base ? base + rel : rel;
  }

  function headersFor(accept: Record<string, string>, opts: RequestOptions): Record<string, string> {
    const headers: Record<string, string> = { ...accept };
    if (held.token) headers[TOKEN_HEADER] = held.token;
    if (!opts.noClientHeader && !ports.caps().noClientHeader) headers[CLIENT_HEADER] = CLIENT_GENERATION;
    return headers;
  }

  async function refuse(res: Response): Promise<void> {
    if (res.status === 401 || res.status === 403) {
      const body = await jsonOf(res);
      const error = errorOf(body);
      if (error === "read-only") throw apiError("read-only", "read-only");
      if (error === "review-only") {
        const e = apiError("review-only", "this link can comment, but not change the script");
        e.detail = detailOf(body);
        throw e;
      }
      if (error === "pin-required" || error === "bad-pin") throw apiError("pin", "this server asks for a join PIN");
      if (error === "link-off") throw apiError("link-off", "the owner turned off this link");
      if (error === "owner-only") throw apiError("owner-only", "only the script's owner can do that");
      if (error === "wrong-document") throw apiError("wrong-document", "this link opens a different script");
      throw apiError("auth", "signed out");
    }
    if (res.status === 410) {
      const body = await jsonOf(res);
      if (errorOf(body) === "link-off") throw apiError("link-off", "the owner turned off this link");
      const gone = apiError("410", errorOf(body) || "HTTP 410");
      gone.payload = body;
      throw gone;
    }
    if (res.status === 429) {
      const error = errorOf(await jsonOf(res));
      if (error === "too-many-attempts") throw apiError("pin-blocked", "too many wrong codes — wait a minute and try again");
      if (error === "review-budget") throw apiError("review-budget", "this link's image allowance is used up for now");
    }
    if (res.status === 426) throw apiError("client-too-old", "this page is out of date");
  }

  async function request(path: string, opts?: RequestOptions): Promise<unknown> {
    const o: RequestOptions = opts || {};
    const raw = o.raw !== undefined && o.raw !== null;
    const accept: Record<string, string> = raw
      ? { "Content-Type": o.contentType || "application/octet-stream", "Accept": "application/json" }
      : o.body
        ? { "Content-Type": "application/json", "Accept": "application/json" }
        : { "Accept": "application/json" };
    let res: Response;
    try {
      res = await ports.fetch(url(path), {
        method: o.method || "GET",
        headers: headersFor(accept, o),
        body: raw && o.raw !== undefined ? o.raw : o.body ? JSON.stringify(o.body) : null,
        credentials: base ? "omit" : "same-origin",
        cache: "no-store"
      });
    } catch {
      throw apiError("offline", "no answer from the server");
    }

    const ctype = res.headers.get("content-type") || "";
    if (raw && res.status === 413) throw apiError("blob-too-large", "too-large");
    if (res.redirected || (!ctype.includes("application/json") && res.status !== 204)) {
      throw apiError("auth", "signed out");
    }
    await refuse(res);

    const body = res.status === 204 ? null : await jsonOf(res);
    if (res.status === 409) {
      const c = apiError("conflict");
      c.payload = body;
      throw c;
    }
    if (res.status === 404 && errorOf(body) === "not-found") throw apiError("not-found");
    if (res.status === 422 && errorOf(body) === "missing-blobs") {
      const mb = apiError("missing-blobs", "an image in it is not on the server");
      mb.payload = body;
      throw mb;
    }
    if (raw && res.status === 415) throw apiError("blob-unsupported", errorOf(body) || "unsupported-type");
    if (!res.ok) {
      const ge = apiError(String(res.status), errorOf(body) || ("HTTP " + res.status));
      ge.payload = body;
      throw ge;
    }
    return body;
  }

  async function get(path: string, accept: string): Promise<Response | null> {
    try {
      const res = await ports.fetch(url(path), {
        method: "GET",
        headers: headersFor({ "Accept": accept }, {}),
        credentials: base ? "omit" : "same-origin"
      });
      return res.ok && !res.redirected ? res : null;
    } catch {
      return null;
    }
  }

  return Object.freeze({
    connection: held,
    url: url,
    request: request,
    get: get,
    takesBlobs: function () { return ports.caps().blobs; }
  });
}
