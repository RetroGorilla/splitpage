declare const SPLITPAGE_TEST_HOOKS: boolean | undefined;

export function relayOriginAllowed(origin: string): boolean {
  return origin.startsWith("https://") || ((typeof SPLITPAGE_TEST_HOOKS === "undefined" || SPLITPAGE_TEST_HOOKS)
    && /^http:\/\/127\.0\.0\.1:[0-9]+$/.test(origin));
}

export function relaySocketUrl(address: string): string | null {
  try {
    const endpoint = new URL(address);
    if (endpoint.username || endpoint.password || !relayOriginAllowed(endpoint.origin)) return null;
    const socket = new URL("/", endpoint.origin);
    socket.protocol = socket.protocol === "https:" ? "wss:" : "ws:";
    return socket.href;
  } catch { return null; }
}

export function relayHttpOrigin(relayUrl: string): string | null {
  try {
    const endpoint = new URL(relayUrl);
    if (endpoint.username || endpoint.password || (endpoint.protocol !== "wss:" && endpoint.protocol !== "ws:")) return null;
    endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
    return relayOriginAllowed(endpoint.origin) ? endpoint.origin : null;
  } catch { return null; }
}
