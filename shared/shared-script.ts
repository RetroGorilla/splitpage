export interface SharedScriptIdentity {
  readonly deployment: string;
  readonly script: string;
}

export interface SharedScriptCatalogueEntry extends SharedScriptIdentity {
  readonly relayUrl: string;
  readonly title: string;
  readonly at: number;
}

export function sharedScriptKey({ deployment, script }: SharedScriptIdentity): string {
  return `${deployment}/${script}`;
}

export function readSharedScriptIdentity(raw: unknown): SharedScriptIdentity | null {
  if (!raw || typeof raw !== "object") return null;
  const { deployment, script } = raw as Partial<SharedScriptIdentity>;
  const id = /^[A-Za-z0-9_-]{1,64}(?![\s\S])/;
  return typeof deployment === "string" && typeof script === "string" && id.test(deployment) && id.test(script)
    ? { deployment, script } : null;
}

export function readSharedScriptCatalogueEntry(raw: unknown): SharedScriptCatalogueEntry | null {
  const identity = readSharedScriptIdentity(raw);
  if (!identity) return null;
  const { relayUrl, title, at } = raw as Partial<SharedScriptCatalogueEntry>;
  if (typeof relayUrl !== "string" || typeof title !== "string" || typeof at !== "number" || !Number.isFinite(at)) return null;
  const endpoint = /^(?:wss:\/\/(?:[a-z0-9.-]+|\[[a-f0-9:.]+\])|ws:\/\/127\.0\.0\.1)(?::[0-9]{1,5})?\/(?![\s\S])/;
  if (!endpoint.test(relayUrl)) return null;
  return { ...identity, relayUrl, title: title.slice(0, 300), at };
}
