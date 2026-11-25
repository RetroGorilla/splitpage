const VERSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function sharedVersionHttp(origin: string, script: string, token: string) {
  const path = "/api/scripts/" + encodeURIComponent(script) + "/versions";

  async function get(suffix: string, signal: AbortSignal): Promise<Response> {
    const response = await fetch(new URL(path + suffix, origin), {
      headers: { Authorization: "Bearer " + token },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    });
    if (response.ok) return response;
    await response.body?.cancel();
    throw new Error("Could not read shared versions.");
  }

  return {
    async list(signal: AbortSignal) {
      const entries: unknown = await (await get("", signal)).json();
      if (!Array.isArray(entries)) throw new Error("Invalid versions list.");
      return entries.map((entry: { id?: unknown; createdAt?: unknown; names?: unknown }) => {
        if (!entry || typeof entry.id !== "string" || !VERSION_ID.test(entry.id) ||
            typeof entry.createdAt !== "number" || !Number.isFinite(new Date(entry.createdAt).getTime()) ||
            !Array.isArray(entry.names) || !entry.names.every(name => typeof name === "string")) {
          throw new Error("Invalid version entry.");
        }
        return { id: entry.id, at: entry.createdAt, names: entry.names as string[] };
      });
    },
    async read(id: string, signal: AbortSignal) {
      if (!VERSION_ID.test(id)) throw new Error("Invalid version.");
      return new Uint8Array(await (await get("/" + id, signal)).arrayBuffer());
    }
  };
}
