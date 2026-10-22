export type JoinResult =
  | { readonly ok: true; readonly token: string; readonly role: string; readonly docId?: string; readonly scope?: string }
  | { readonly ok: false; readonly error: string };

export interface JoinPorts {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
}

const PAGE_FETCH: JoinPorts = Object.freeze({
  fetch: function (url: string, init: RequestInit) { return fetch(url, init); }
});

export async function joinServer(base: string | null | undefined, pin: string | null | undefined, key?: string | null, ports: JoinPorts = PAGE_FETCH): Promise<JoinResult> {
  const url = (base ? String(base).replace(/\/+$/, "") + "/" : "") + "api/join";
  let res: Response;
  try {
    res = await ports.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(key ? { key: String(key) } : { pin: String(pin || "") }),
      credentials: base ? "omit" : "same-origin",
      cache: "no-store"
    });
  } catch {
    return { ok: false, error: "offline" };
  }
  const raw: unknown = await res.json().catch(function () { return null; });
  const body: Record<string, unknown> = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  if (res.ok && body["token"]) {
    const token = body["token"];
    const role = body["role"];
    const joined: { ok: true; token: string; role: string; docId?: string; scope?: string } = {
      ok: true,
      token: token as string,
      role: (role as string) || "edit"
    };
    if (typeof body["docId"] === "string") joined.docId = body["docId"];
    if (typeof body["scope"] === "string") joined.scope = body["scope"];
    return joined;
  }
  if (res.status === 429) return { ok: false, error: "too-many-attempts" };
  if (res.status === 404 || !raw) return { ok: false, error: "not-splitpage" };
  const error = body["error"];
  return { ok: false, error: (error as string) || ("HTTP " + res.status) };
}
