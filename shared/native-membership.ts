import type { NativeMembershipRecord } from "./native-replica.d.ts";

export function readNativeMembership(value: unknown): NativeMembershipRecord | null {
  if (typeof value === "string") return value ? { token: value, role: "guest" } : null;
  if (!value || typeof value !== "object") return null;
  const { token, role, guestLinkToken } = value as Partial<NativeMembershipRecord>;
  if (typeof token !== "string" || !token || (role !== "owner" && role !== "guest")) return null;
  if (guestLinkToken === undefined) return { token, role };
  return typeof guestLinkToken === "string" && guestLinkToken
    ? { token, role, guestLinkToken } : null;
}
