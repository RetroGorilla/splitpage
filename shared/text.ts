"use strict";

function driveFormatSize(bytes: unknown) {
  const n = Number(bytes);
  if (!n) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

function formatVideoLength(sec: number | undefined) {
  if (!((sec as number) > 0)) return "";
  const s = Math.round(sec as number);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return (h ? h + ":" + (m < 10 ? "0" : "") + m : m) + ":" + (r < 10 ? "0" : "") + r;
}

function slugify(s: unknown) {
  return String(s || "splitpage")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "splitpage";
}

function checksumText(str: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export {
  checksumText,
  driveFormatSize,
  formatVideoLength,
  slugify
};
