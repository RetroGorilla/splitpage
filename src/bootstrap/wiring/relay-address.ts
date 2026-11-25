declare const SPLITPAGE_TEST_HOOKS: boolean | undefined;

export function relayOriginAllowed(origin: string): boolean {
  return origin.startsWith("https://") || ((typeof SPLITPAGE_TEST_HOOKS === "undefined" || SPLITPAGE_TEST_HOOKS)
    && /^http:\/\/127\.0\.0\.1:[0-9]+$/.test(origin));
}

export function relayUrlAllowed(url: URL): boolean {
  if (url.username || url.password || (url.protocol !== "https:" && url.protocol !== "http:")) return false;
  // why: URL parsing drops a default :80, which the relay owner stores explicitly for a loopback test relay
  return relayOriginAllowed(url.port || url.protocol === "https:" ? url.origin : url.origin + ":80");
}

export function relaySocketUrl(address: string): string | null {
  try {
    const endpoint = new URL(address);
    if (!relayUrlAllowed(endpoint)) return null;
    const socket = new URL("/", endpoint.origin);
    socket.protocol = socket.protocol === "https:" ? "wss:" : "ws:";
    return socket.href;
  } catch { return null; }
}

export function relayHttpOrigin(relayUrl: string): string | null {
  try {
    const endpoint = new URL(relayUrl);
    if (endpoint.protocol !== "wss:" && endpoint.protocol !== "ws:") return null;
    endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
    return relayUrlAllowed(endpoint) ? endpoint.origin : null;
  } catch { return null; }
}
