import { formatClock, formatDateClock } from "../../../shared/clock.js";

export function formatTimestamp(iso, clock) {
  try {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var sameDay = d.toDateString() === new Date().toDateString();
    return sameDay ? formatClock(d, clock) : formatDateClock(d, null, clock);
  } catch (e) { return ""; }
}
