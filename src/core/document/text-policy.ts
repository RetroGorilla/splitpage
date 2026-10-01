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

export function plainText(v: unknown): string {
  return String(v == null ? "" : v).replace(/<[^>]*>/g, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

export function plainName(v: unknown): string {
  const name = plainText(v).trim().slice(0, 80);
  return name || "Anonymous";
}

export function safeId(id: unknown, prefix: string, ids: IdSource): string {
  const clean = String(id == null ? "" : id).replace(/[^A-Za-z0-9_-]/g, "");
  return clean || ids.id(prefix);
}

function storedImageMarkup(ref: ImageRef): string {
  let html = '<img class="comment-img" data-blob="' + ref.sha256 + '"';
  if (ref.width && ref.height && ref.mime) {
    html += ' data-w="' + String(ref.width) + '" data-h="' + String(ref.height) + '" data-mime="' + ref.mime + '"';
  }
  return html + ">";
}

export function storedImageHtml(ref: unknown): string {
  const clean: ImageRef | null = normalizeImageRef(ref);
  if (!clean) return "";
  return storedImageMarkup(clean);
}
