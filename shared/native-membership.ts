import type { NativeMembershipRecord } from "./native-replica.d.ts";

export function readNativeMembership(value: unknown): NativeMembershipRecord | null {
  if (typeof value === "string") return value ? { token: value, role: "guest" } : null;
  if (!value || typeof value !== "object") return null;
  const { token, role, guestLinkToken, linkPasswordRequired } = value as Partial<NativeMembershipRecord>;
  if (typeof token !== "string" || !token || (role !== "owner" && role !== "guest")) return null;
  if (guestLinkToken !== undefined && (typeof guestLinkToken !== "string" || !guestLinkToken)) return null;
  if (linkPasswordRequired !== undefined && (role !== "owner" || typeof linkPasswordRequired !== "boolean")) return null;
  return { token, role, ...(guestLinkToken && { guestLinkToken }),
    ...(linkPasswordRequired !== undefined && { linkPasswordRequired }) };
}
