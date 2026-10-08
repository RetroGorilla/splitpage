import { normalizeImageRef } from "../../../shared/blob-policy.js";
import type { IdSource, ImageRef } from "./ports.ts";

export function safeImageSrc(src: unknown): string | null {
  if (typeof src !== "string") return null;
  return /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=\s]*$/.test(src) ? src : null;
}

export function safeHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const trimmed = href.trim();
  const probe = trimmed.replace(/[\u0000-\x20]/g, "").toLowerCase();
  if (probe.indexOf("javascript:") === 0 || probe.indexOf("vbscript:") === 0) return null;
  if (probe.indexOf("data:") === 0) return null;
  if (/^https?:\/\//i.test(trimmed) || trimmed.indexOf("mailto:") === 0) return trimmed;
  return null;
}

export function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  return typeof v === "number" ? String(v) : "";
}

export function plainText(v: unknown): string {
  return textOf(v).replace(/<[^>]*>/g, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

const SURROGATE_RE = /[\uD800-\uDFFF]/;
const LONE_SURROGATE_RE = /\p{Cs}/u;
const LONE_SURROGATES_RE = /\p{Cs}/gu;

export function hasLoneSurrogate(s: string): boolean {
  return SURROGATE_RE.test(s) && LONE_SURROGATE_RE.test(s);
}

export function withoutLoneSurrogates(s: string): string {
  return hasLoneSurrogate(s) ? s.replace(LONE_SURROGATES_RE, "") : s;
}

export function codePointPrefix(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = 0;
  for (let n = 0; n < max && end < s.length; n++) {
    end += (s.codePointAt(end) as number) > 0xffff ? 2 : 1;
  }
  return s.slice(0, end);
}

export function unitSafePrefix(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = Math.max(0, max);
  const last = s.charCodeAt(end - 1), next = s.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  return s.slice(0, end);
}

export function cappedLongText(s: string, max: number): string {
  return codePointPrefix(withoutLoneSurrogates(s), max);
}

export function cappedName(s: string, max: number): string {
  return codePointPrefix(withoutLoneSurrogates(s).trim(), max).trimEnd();
}

export function cappedText(v: unknown, max: number): string {
  return cappedName(plainText(v), max);
}

export function unitCutName(s: string, max: number): string {
  return s.trim().slice(0, max).trimEnd();
}

export function brokenCutOf(stored: string, name: string, max: number): boolean {
  const s = stored.trim();
  if (s.length < max - 3 || !hasLoneSurrogate(s)) return false;
  const kept = withoutLoneSurrogates(s).trimStart();
  return name.length > kept.trimEnd().length && name.startsWith(kept);
}

const LONE_ONE_RE = /^\p{Cs}$/u;
const SPACE_RE = /^\s$/;

function keptAsStored(text: string, healed: string, max: number): string {
  if (!healed) return codePointPrefix(text, max).trimEnd();
  let seen = 0, end = 0;
  for (const ch of text) {
    end += ch.length;
    if (LONE_ONE_RE.test(ch) || (!seen && SPACE_RE.test(ch))) continue;
    seen += ch.length;
    if (seen >= healed.length) break;
  }
  let keep = end;
  for (const ch of text.slice(end)) {
    if (LONE_ONE_RE.test(ch)) { end += 1; keep = end; continue; }
    if (!SPACE_RE.test(ch)) break;
    end += ch.length;
  }
  return text.slice(0, keep);
}

export type NameKey = (name: string, at: number) => string;

export function settledNames(texts: readonly string[], max: number, keyOf: NameKey, wanted?: readonly (string | undefined)[]): string[] {
  const out: string[] = [], stored: string[] = [];
  const taken: Record<string, string> = Object.create(null), asked: Record<string, string> = Object.create(null);
  const open: number[] = [], heal: number[] = [];
  function hold(map: Record<string, string>, at: number): void {
    if (!out[at]) return;
    map[keyOf(out[at] as string, at)] = stored[at] as string;
  }
  function free(map: Record<string, string>, key: string, at: number): boolean {
    const was = map[key];
    return was === undefined || was === stored[at];
  }
  texts.forEach(function (text, at) {
    out.push(cappedName(text, max));
    stored.push(hasLoneSurrogate(text) ? keyOf(text.trim(), at) : "\u0000" + at);
    if (wanted && wanted[at]) open.push(at);
    else if (hasLoneSurrogate(text)) heal.push(at);
    else hold(taken, at);
  });
  function settle(at: number, want: string, blocked: Record<string, string>): void {
    const text = texts[at] as string, healed = out[at] as string;
    if (want && free(taken, keyOf(want, at), at) && free(blocked, keyOf(want, at), at)) { out[at] = want; return; }
    out[at] = hasLoneSurrogate(text) ? keptAsStored(text.trim(), healed, max) : healed;
    hold(taken, at);
  }
  const none: Record<string, string> = Object.create(null);
  open.forEach(function (at) {
    settle(at, (wanted as readonly (string | undefined)[])[at] as string, none);
    hold(asked, at);
  });
  heal.forEach(function (at) {
    settle(at, out[at] as string, asked);
    hold(taken, at);
  });
  return out;
}

export function plainName(v: unknown): string {
  return cappedText(v, 80) || "Anonymous";
}

export function escapeHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function legacyMdToHtml(text: unknown): string {
  if (typeof text !== "string") return "";
  let out = escapeHtml(text);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  out = out.replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/gi, "<u>$1</u>");
  out = out.replace(/&lt;mark&gt;([\s\S]*?)&lt;\/mark&gt;/gi, "<mark>$1</mark>");
  ["strong", "em", "s"].forEach(function (tag) {
    out = out.replace(new RegExp("&lt;" + tag + "&gt;([\\s\\S]*?)&lt;\\/" + tag + "&gt;", "gi"), "<" + tag + ">$1</" + tag + ">");
  });
  out = out.replace(/&lt;br\s*\/?&gt;/gi, "<br>");
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m: string, label: string, url: string) {
    const safe = safeHref(url);
    return safe ? '<a href="' + safe + '" target="_blank" rel="noopener">' + label + '</a>' : m;
  });
  out = out.replace(/\n/g, "<br>");
  return out;
}

export function safeId(id: unknown, prefix: string, ids: IdSource): string {
  const clean = textOf(id).replace(/[^A-Za-z0-9_-]/g, "");
  return clean || ids.id(prefix);
}

export type StoredImageRef = Pick<ImageRef, "sha256"> & Partial<Omit<ImageRef, "sha256">>;

export type StoredImageAttribute = readonly [name: string, value: string];

export function storedImageAttributes(ref: StoredImageRef): StoredImageAttribute[] {
  const attrs: StoredImageAttribute[] = [["class", "comment-img"], ["data-blob", ref.sha256]];
  if (ref.width && ref.height && ref.mime) {
    attrs.push(["data-w", String(ref.width)], ["data-h", String(ref.height)], ["data-mime", ref.mime]);
  }
  return attrs;
}

export function storedImageMarkup(ref: StoredImageRef): string {
  let html = "<img";
  storedImageAttributes(ref).forEach(function (attr) {
    html += " " + attr[0] + '="' + escapeHtml(attr[1]) + '"';
  });
  return html + ">";
}

export function storedImageHtml(ref: unknown): string {
  const clean: ImageRef | null = normalizeImageRef(ref);
  if (!clean) return "";
  return storedImageMarkup(clean);
}
