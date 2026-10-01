export const ROW_STATUS_IDS = ["todo", "ready", "shot"] as const;

export type RowStatusId = (typeof ROW_STATUS_IDS)[number];

export interface LengthHolder {
  lengthSeconds?: unknown;
}

export interface TargetHolder {
  targetSeconds?: unknown;
}

export function rowStatusId(id: unknown): RowStatusId | null {
  for (const status of ROW_STATUS_IDS) {
    if (status === id) return status;
  }
  return null;
}

export function nextRowStatus(id: unknown): RowStatusId {
  for (let i = 0; i < ROW_STATUS_IDS.length; i++) {
    if (ROW_STATUS_IDS[i] === id) return ROW_STATUS_IDS[(i + 1) % ROW_STATUS_IDS.length] as RowStatusId;
  }
  return ROW_STATUS_IDS[0];
}

export const DEFAULT_WPM = 150;

export function normalizeWordsPerMinute(v: unknown): number {
  const wpm = Number(v);
  return (isFinite(wpm) && wpm >= 60 && wpm <= 400) ? Math.round(wpm) : DEFAULT_WPM;
}

export const SCENE_LENGTH_MAX = 24 * 3600;

export function hasSetLength(row: LengthHolder | null | undefined): row is LengthHolder & { lengthSeconds: number } {
  return !!row && typeof row.lengthSeconds === "number" && isFinite(row.lengthSeconds) &&
    row.lengthSeconds >= 0 && row.lengthSeconds <= SCENE_LENGTH_MAX;
}

export function normalizeSceneLength(v: unknown): number | undefined {
  if (typeof v !== "number" || !isFinite(v) || v < 0 || v > SCENE_LENGTH_MAX) return undefined;
  return Math.round(v);
}

type LengthUnit = "h" | "m" | "s";

const LENGTH_UNITS: Record<LengthUnit, number> = { h: 3600, m: 60, s: 1 };

function lengthUnit(word: string | undefined): LengthUnit | "" | null {
  if (!word) return "";
  if (/^(h|hr|hrs|hour|hours)$/.test(word)) return "h";
  if (/^(m|min|mins|minute|minutes)$/.test(word)) return "m";
  if (/^(s|sec|secs|second|seconds)$/.test(word)) return "s";
  return null;
}

export function parseSceneLength(text: unknown): number | null {
  const s = String(text == null ? "" : text).trim().toLowerCase();
  if (!s) return null;
  let total;
  const clock = /^(\d+):([0-5]\d)(?::([0-5]\d))?$/.exec(s);
  if (clock) {
    total = clock[3] != null
      ? (+(clock[1] as string)) * 3600 + (+(clock[2] as string)) * 60 + (+clock[3])
      : (+(clock[1] as string)) * 60 + (+(clock[2] as string));
  } else {
    const re = /(\d+(?:\.\d+)?|\.\d+)\s*([a-z]*)\s*/g;
    let pos = 0, m, last: LengthUnit | "" = "", parts = 0;
    const order: LengthUnit[] = ["h", "m", "s"];
    total = 0;
    while (pos < s.length) {
      re.lastIndex = pos;
      m = re.exec(s);
      if (!m || m.index !== pos) return NaN;
      pos = re.lastIndex;
      let unit = lengthUnit(m[2]);
      if (unit === null) return NaN;
      if (!unit) {
        if (!parts) unit = "s";
        else if (last === "m") unit = "s";
        else if (last === "h") unit = "m";
        else return NaN;
        if (pos < s.length) return NaN;
      }
      if (last && order.indexOf(unit) <= order.indexOf(last)) return NaN;
      total += parseFloat(m[1] as string) * LENGTH_UNITS[unit];
      last = unit;
      parts++;
    }
    if (!parts) return NaN;
  }
  total = Math.round(total);
  if (!isFinite(total) || total < 0 || total > SCENE_LENGTH_MAX) return NaN;
  return total;
}

export function normalizeTargetLength(v: unknown): number | undefined {
  if (typeof v !== "number" || !isFinite(v)) return undefined;
  const whole = Math.round(v);
  return whole >= 1 && whole <= SCENE_LENGTH_MAX ? whole : undefined;
}

export function targetLengthOf(s: TargetHolder | null | undefined): number | null {
  const v = s ? normalizeTargetLength(s.targetSeconds) : undefined;
  return v === undefined ? null : v;
}
