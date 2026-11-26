import { DEVICE_CREDENTIAL_HEADER } from "../../../../shared/link-password.ts";

type PasswordExchange =
  | { readonly kind: "credential"; readonly token: string }
  | { readonly kind: "failed"; readonly reason: string };

function requestPasswordExchange(origin: string, script: string, linkToken: string, signal: AbortSignal,
  deviceToken?: string, body?: { password: string | null }): Promise<Response> {
  return fetch(new URL("/api/scripts/" + encodeURIComponent(script) + "/password-exchange", origin), {
    method: body ? "POST" : "HEAD",
    headers: {
      Authorization: "Bearer " + linkToken,
      ...(body && { "Content-Type": "application/json" }),
      ...(deviceToken && { [DEVICE_CREDENTIAL_HEADER]: deviceToken })
    },
    ...(body && { body: JSON.stringify(body) }),
    cache: "no-store", credentials: "omit", redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])
  });
}

export async function checkLinkPasswordRecovery(origin: string, script: string, linkToken: string, signal: AbortSignal,
  deviceToken?: string): Promise<boolean> {
  try {
    return (await requestPasswordExchange(origin, script, linkToken, signal, deviceToken)).status === 204;
  } catch {
    return false;
  }
}

export async function exchangeLinkPassword(origin: string, script: string, linkToken: string, password: string | null,
  signal: AbortSignal, deviceToken?: string): Promise<PasswordExchange> {
  try {
    const response = await requestPasswordExchange(origin, script, linkToken, signal, deviceToken, { password });
    if (response.status === 428) return { kind: "failed", reason: "password-required" };
    if (response.status === 401) return { kind: "failed", reason: "wrong-password" };
    if (response.status === 403) return { kind: "failed", reason: "access-removed" };
    if (response.status === 409) return { kind: "failed", reason: "password-changed" };
    if (response.status === 429) {
      const data = await response.json().catch(() => null) as { reason?: unknown } | null;
      return { kind: "failed", reason: data?.reason === "device-limit" ? "device-limit" : "password-rate-limited" };
    }
    if (response.ok) {
      const data = await response.json() as { token?: unknown } | null;
      if (typeof data?.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(data.token)) {
        return { kind: "credential", token: data.token };
      }
    }
  } catch {
    if (signal.aborted) return { kind: "failed", reason: "cancelled" };
  }
  return { kind: "failed", reason: "relay-unreachable" };
}
