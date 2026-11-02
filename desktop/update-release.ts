"use strict";

import type * as NodePath from "node:path";

const path: typeof NodePath = require("node:path");

type DesktopReleaseAsset = { name: string; browser_download_url: string; size?: unknown };

const SAFE_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

const INSTALLER_EXT: Record<string, string> = { win32: ".exe", darwin: ".dmg", linux: ".appimage" };

const DEFAULT_UPDATE_API =
  "https://api.github.com/repos/RetroGorilla/splitpage/releases/latest";

const CHECKSUMS_ASSET = /^SHA256SUMS(\.txt)?$/i;

const CHECKSUMS_MAX_CHARS = 200000;

function hasReleaseAssets(assets: unknown, apiUrl: string = DEFAULT_UPDATE_API, testMode = false) {
  return Array.isArray(assets) && assets.length > 0 && assets.every((a) => isReleaseAsset(a, apiUrl, testMode));
}

function splitVersion(v: unknown) {
  const s = String(v).trim().replace(/\+.*$/, "");
  const dash = s.indexOf("-");
  return {
    core: (dash === -1 ? s : s.slice(0, dash)).split(".").map((n) => parseInt(n, 10) || 0),
    pre: dash === -1 ? [] : s.slice(dash + 1).split(".").filter(Boolean)
  };
}

function compareVersions(a: unknown, b: unknown) {
  const va = splitVersion(a), vb = splitVersion(b);
  for (let i = 0; i < Math.max(va.core.length, vb.core.length); i++) {
    const na = va.core[i] || 0, nb = vb.core[i] || 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  if (!va.pre.length || !vb.pre.length) return va.pre.length === vb.pre.length ? 0 : (va.pre.length ? -1 : 1);
  for (let i = 0; i < Math.max(va.pre.length, vb.pre.length); i++) {
    const x = va.pre[i], y = vb.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { if (+x !== +y) return +x < +y ? -1 : 1; continue; }
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function isAllowedReleasePath(urlString: unknown, apiUrl: unknown, testMode: boolean, kind: "download" | "tag") {
  if (typeof urlString !== "string" || urlString !== urlString.trim() || urlString.includes("\\")) return false;
  let parsed;
  try { parsed = new URL(urlString); } catch { return false; }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (testMode && typeof apiUrl === "string" && apiUrl !== DEFAULT_UPDATE_API) {
    try { if (parsed.origin === new URL(apiUrl).origin) return true; } catch { }
  }
  const pattern = kind === "download"
    ? /^\/RetroGorilla\/splitpage\/releases\/download\/[^/]+\/[^/]+$/
    : /^\/RetroGorilla\/splitpage\/releases\/tag\/[^/]+$/;
  return parsed.origin === "https://github.com" && pattern.test(parsed.pathname);
}

function isAllowedDownloadHost(urlString: unknown, apiUrl: unknown, testMode = false) {
  return isAllowedReleasePath(urlString, apiUrl, testMode, "download");
}

function isAllowedReleaseUrl(urlString: unknown, apiUrl: unknown, testMode = false) {
  return isAllowedReleasePath(urlString, apiUrl, testMode, "tag");
}

function isReleaseAsset(asset: unknown, apiUrl: string, testMode: boolean): asset is DesktopReleaseAsset {
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) return false;
  const entry = asset as Record<string, unknown>;
  return typeof entry.name === "string" && SAFE_ASSET_NAME.test(entry.name)
    && isAllowedDownloadHost(entry.browser_download_url, apiUrl, testMode);
}

function describeAsset(asset: DesktopReleaseAsset) {
  return {
    name: path.basename(asset.name),
    url: asset.browser_download_url,
    size: Number.isFinite(asset.size) ? asset.size as number : 0
  };
}

function pickUpdateAsset(assets: readonly unknown[] | null | undefined, { platform, arch, apiUrl, testMode = false }: { platform: string; arch: string; apiUrl: string; testMode?: boolean }) {
  const ext = INSTALLER_EXT[platform];
  if (!ext) return null;
  const candidates = (assets || []).filter((a): a is DesktopReleaseAsset => isReleaseAsset(a, apiUrl, testMode)
    && a.name.toLowerCase().endsWith(ext));
  if (!candidates.length) return null;

  const other = ["x64", "arm64", "ia32", "armv7l"].filter((a) => a !== arch);
  const mentions = (name: unknown, token: string) => new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`, "i").test(name as string);

  const mine = candidates.filter((a) => mentions((a as DesktopReleaseAsset).name, arch));
  if (mine.length === 1) return describeAsset(mine[0] as DesktopReleaseAsset);
  if (mine.length > 1) return null;

  const neutral = candidates.filter((a) => !other.some((o) => mentions((a as DesktopReleaseAsset).name, o)));
  if (neutral.length === 1) return describeAsset(neutral[0] as DesktopReleaseAsset);
  return null;
}

function findChecksumsAsset(assets: readonly unknown[] | null | undefined, apiUrl: string, testMode = false): unknown {
  return (assets || []).find((a) => isReleaseAsset(a, apiUrl, testMode) && CHECKSUMS_ASSET.test(a.name)) || null;
}

function checksumFor(text: string, assetName: string) {
  if (text.length > CHECKSUMS_MAX_CHARS) return null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (m && path.basename(m[2] as string) === assetName) return (m[1] as string).toLowerCase();
  }
  return null;
}

export type { DEFAULT_UPDATE_API, hasReleaseAssets, compareVersions, isAllowedDownloadHost, isAllowedReleaseUrl, pickUpdateAsset, findChecksumsAsset, checksumFor };

module.exports = {
  DEFAULT_UPDATE_API,
  hasReleaseAssets,
  compareVersions,
  isAllowedDownloadHost,
  isAllowedReleaseUrl,
  pickUpdateAsset,
  findChecksumsAsset,
  checksumFor
};
