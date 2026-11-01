import { formatClock, formatDateClock } from "../../../shared/clock.js";

export function formatTimestamp(iso: unknown, clock?: string) {
  try {
    const d = new Date(iso as string);
    if (isNaN(d.getTime())) return "";
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay ? formatClock(d, clock) : formatDateClock(d, null, clock);
  } catch (e) { return ""; }
}
