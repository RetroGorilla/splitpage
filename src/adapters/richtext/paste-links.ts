import { normalizeCell } from "../../core/text/runs.ts";
import type { Run } from "../../core/text/runs.ts";

const TRACKING_NAME = /^(?:utm_[\s\S]*|fbclid|gclid|mc_eid|mc_cid|msclkid)$/i;
const SIGNATURE_NAME = /^(?:Signature|Key-Pair-Id|Policy|X-Amz-Signature|X-Goog-Signature)$/i;

export function cleanPastedHref(href: string): string {
  if (!/^https?:\/\/[^/?#\\]/i.test(href)) return href;
  const fragmentAt = href.indexOf("#");
  const end = fragmentAt < 0 ? href.length : fragmentAt;
  const queryAt = href.indexOf("?");
  if (queryAt < 0 || queryAt >= end) return href;
  const params = href.slice(queryAt + 1, end).split("&");
  const kept: string[] = [];
  try {
    for (const param of params) {
      const equals = param.indexOf("=");
      const name = decodeURIComponent(equals < 0 ? param : param.slice(0, equals));
      if (SIGNATURE_NAME.test(name)) return href;
      if (!TRACKING_NAME.test(name)) kept.push(param);
    }
    if (kept.length === params.length) return href;
    if (/[\s\\]/.test(href) || /%(?![a-f\d]{2})/i.test(href)) return href;
    for (let i = 0; i < href.length; i++) {
      if (href.charCodeAt(i) < 32 || href.charCodeAt(i) === 127) return href;
    }
    const url = new URL(href);
    if (!url.hostname) return href;
  } catch {
    return href;
  }
  return href.slice(0, queryAt) + (kept.length ? "?" + kept.join("&") : "") + href.slice(end);
}

export function cleanPastedLinks(cell: readonly Run[]): Run[] {
  let changed = false;
  const next = cell.map((run) => {
    const href = run.marks.href;
    if (!href) return run;
    const clean = cleanPastedHref(href);
    if (clean === href) return run;
    changed = true;
    return { ...run, marks: { ...run.marks, href: clean } };
  });
  return changed ? normalizeCell(next) : next;
}
