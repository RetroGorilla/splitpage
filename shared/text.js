"use strict";

function driveFormatSize(bytes) {
  var n = Number(bytes);
  if (!n) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

function formatVideoLength(sec) {
  if (!(sec > 0)) return "";
  var s = Math.round(sec);
  var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? h + ":" + (m < 10 ? "0" : "") + m : m) + ":" + (r < 10 ? "0" : "") + r;
}

function slugify(s) {
  return String(s || "splitpage")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "splitpage";
}

function checksumText(str) {
  var h = 0x811c9dc5;
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

module.exports = {
  checksumText,
  driveFormatSize,
  formatVideoLength,
  slugify
};
