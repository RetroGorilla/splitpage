"use strict";

import type * as NodePath from "node:path";

const path: typeof NodePath = require("node:path");

interface DesktopReleaseAsset { name: string; browser_download_url: string; size?: number; }

const SAFE_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

const INSTALLER_EXT: Record<string, string> = { win32: ".exe", darwin: ".dmg", linux: ".appimage" };

const DEFAULT_UPDATE_API =
  "https://api.github.com/repos/RetroGorilla/splitpage-releases/releases/latest";

const CHECKSUMS_ASSET = /^SHA256SUMS(\.txt)?$/i;

const CHECKSUMS_MAX_CHARS = 200000;

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

function isAllowedDownloadHost(urlString: string, apiUrl: string) {
  let parsed;
  try { parsed = new URL(urlString); } catch { return false; }
  let api;
  try { api = new URL(apiUrl); } catch { api = null; }
  if (api && parsed.origin === api.origin) return true;
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return host === "github.com"
    || host === "api.github.com"
    || host.endsWith(".githubusercontent.com");
}

function describeAsset(asset: DesktopReleaseAsset) {
  return {
    name: path.basename(String(asset.name)),
    url: String(asset.browser_download_url),
    size: Number.isFinite(asset.size) ? asset.size as number : 0
  };
}

function pickUpdateAsset(assets: DesktopReleaseAsset[] | null | undefined, { platform, arch, apiUrl }: { platform: string; arch: string; apiUrl: string }) {
  const ext = INSTALLER_EXT[platform];
  if (!ext) return null;
  const candidates = (assets || []).filter((a) => {
    const name = String((a && a.name) || "");
    return SAFE_ASSET_NAME.test(name)
      && name.toLowerCase().endsWith(ext)
      && isAllowedDownloadHost(String((a && a.browser_download_url) || ""), apiUrl);
  });
  if (!candidates.length) return null;

  const other = ["x64", "arm64", "ia32", "armv7l"].filter((a) => a !== arch);
  const mentions = (name: string, token: string) => new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`, "i").test(name);

  const mine = candidates.filter((a) => mentions(a.name, arch));
  if (mine.length === 1) return describeAsset(mine[0] as DesktopReleaseAsset);
  if (mine.length > 1) return null;

  const neutral = candidates.filter((a) => !other.some((o) => mentions(a.name, o)));
  if (neutral.length === 1) return describeAsset(neutral[0] as DesktopReleaseAsset);
  return null;
}

function findChecksumsAsset(assets: DesktopReleaseAsset[] | null | undefined, apiUrl: string) {
  return (assets || []).find((a) => CHECKSUMS_ASSET.test(String((a && a.name) || ""))
    && isAllowedDownloadHost(String((a && a.browser_download_url) || ""), apiUrl)) || null;
}

function checksumFor(text: string, assetName: string) {
  if (text.length > CHECKSUMS_MAX_CHARS) return null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (m && path.basename(m[2] as string) === assetName) return (m[1] as string).toLowerCase();
  }
  return null;
}

export type { DEFAULT_UPDATE_API, compareVersions, isAllowedDownloadHost, pickUpdateAsset, findChecksumsAsset, checksumFor };

module.exports = {
  DEFAULT_UPDATE_API,
  compareVersions,
  isAllowedDownloadHost,
  pickUpdateAsset,
  findChecksumsAsset,
  checksumFor
};
