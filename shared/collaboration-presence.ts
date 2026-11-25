export const PRESENCE_FIELD = "splitpagePresence";
export const PRESENCE_NAME_MAX = 80;

export function presenceName(value: unknown): string {
  if (typeof value !== "string") return "";
  const clean = value.replace(/[\p{Cs}\p{Cc}]/gu, "").trim();
  return clean.length <= PRESENCE_NAME_MAX ? clean : Array.from(clean).slice(0, PRESENCE_NAME_MAX).join("").trimEnd();
}
