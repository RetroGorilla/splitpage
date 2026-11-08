"use strict";

type VideoPathStyle = "win32" | "posix";

const VIDEO_FILE_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|ogv|wmv|mpg|mpeg|3gp)$/i;
const VIDEO_PATH_MAX = 4096;

const BLOCKED_FILE_TYPES: readonly string[] = Object.freeze([
  "ade", "adp", "app", "appinstaller", "application", "appref-ms", "appx", "appxbundle", "asp", "aspx", "asx", "bas", "bat", "bgi",
  "cer", "chm", "cmd", "cnt", "com", "cpl", "crt", "csh", "der", "diagcab", "diagpkg", "dll", "drv", "exe", "fxp", "gadget", "grp",
  "hlp", "hpj", "hta", "htc", "img", "inf", "ins", "iso", "isp", "its", "jar", "jnlp", "js", "jse", "ksh", "library-ms", "lnk",
  "mad", "maf", "mag", "mam", "maq", "mar", "mas", "mat", "mau", "mav", "maw", "mcf", "mda", "mdb", "mde", "mdt", "mdw", "mdz",
  "msc", "msh", "msh1", "msh1xml", "msh2", "msh2xml", "mshxml", "msi", "msix", "msixbundle", "msp", "mst", "msu", "ocx", "ops",
  "osd", "pcd", "pif", "pl", "plg", "prf", "prg", "printerexport", "ps1", "ps1xml", "ps2", "ps2xml", "psc1", "psc2", "psd1",
  "psdm1", "psm1", "pst", "py", "pyc", "pyo", "pyw", "pyz", "pyzw", "rb", "rbw", "reg", "scf", "scr", "sct", "search-ms",
  "searchconnector-ms", "settingcontent-ms", "shb", "shs", "sys", "theme", "tmp", "url", "vb", "vbe", "vbp", "vbs", "vhd", "vhdx",
  "vsmacros", "vsw", "webpnp", "website", "ws", "wsb", "wsc", "wsf", "wsh", "xbap", "xll", "xnk",
  "action", "appimage", "bash", "bin", "command", "deb", "desktop", "dmg", "fileloc", "inetloc", "mpkg", "pkg", "rpm", "run", "sh",
  "terminal", "tool", "webloc", "workflow", "zsh",
  "a3x", "ahk", "air", "applescript", "au3", "btm", "cjs", "fish", "kix", "lua", "mht", "mhtml", "mjs", "phar", "php", "rdp", "rex", "rexx",
  "scpt", "scptd", "tcl", "tcsh", "vsix",
  "docm", "dotm", "xlsm", "xltm", "xlam", "xlsb", "pptm", "potm", "ppam", "ppsm", "sldm", "wll"
]);

const ATTACHABLE_FILE = new RegExp("^(?![\\s\\S]*\\.(?:" + BLOCKED_FILE_TYPES.join("|") + ")[. ]*$)[\\s\\S]*\\.[^.\\\\/:]*[^.\\\\/:\\s]$", "i");
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\.|$)/i;
const WINDOWS_FORBIDDEN = /[/<>"|?*]/;

function hasControlCharacter(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) return true;
  }
  return false;
}

function videoPathProblem(p: unknown, style: VideoPathStyle, allow: RegExp = VIDEO_FILE_EXT): string | null {
  if (typeof p !== "string" || !p) return "not a path";
  if (p.length > VIDEO_PATH_MAX) return "too long";
  if (hasControlCharacter(p)) return "a control character";
  if (!allow.test(p)) return "not a file type Splitpage opens";
  let segments: string[];
  if (style === "win32") {
    if (!/^[A-Za-z]:\\/.test(p)) return "not a local drive path";
    if (WINDOWS_FORBIDDEN.test(p) || p.indexOf(":", 2) !== -1) return "a character a Windows file name can't hold";
    segments = p.slice(3).split("\\");
  } else {
    if (p.charAt(0) !== "/" || p.charAt(1) === "/") return "not an absolute local path";
    segments = p.slice(1).split("/");
  }
  for (const s of segments) {
    if (!s || s === "." || s === "..") return "an empty, . or .. part";
    if (style === "win32" && (/[. ]$/.test(s) || WINDOWS_DEVICE_NAME.test(s))) return "a name Windows reserves";
  }
  return null;
}

function isStoredVideoPath(p: unknown, allow: RegExp = VIDEO_FILE_EXT): boolean {
  return videoPathProblem(p, "win32", allow) === null || videoPathProblem(p, "posix", allow) === null;
}

const BUNDLED_NAME_MAX = 255;
const BUNDLE_FOLDER_SUFFIX = " files";
const NAME_FORBIDDEN = /[\\/:<>"|?*]/;

function bundledNameProblem(name: unknown): string | null {
  if (typeof name !== "string" || !name) return "not a name";
  if (name.length > BUNDLED_NAME_MAX) return "too long";
  if (hasControlCharacter(name)) return "a control character";
  if (NAME_FORBIDDEN.test(name)) return "a separator or a character a Windows file name can't hold";
  if (/[. ]$/.test(name) || WINDOWS_DEVICE_NAME.test(name)) return "a name Windows reserves";
  return null;
}

function bundleFolderName(scriptName: string): string {
  const dot = scriptName.lastIndexOf(".");
  const stem = (dot > 0 ? scriptName.slice(0, dot) : scriptName).replace(/[. ]+$/, "");
  return (stem || "Script") + BUNDLE_FOLDER_SUFFIX;
}

export type { VideoPathStyle };

export {
  ATTACHABLE_FILE,
  BLOCKED_FILE_TYPES,
  BUNDLED_NAME_MAX,
  BUNDLE_FOLDER_SUFFIX,
  VIDEO_FILE_EXT,
  VIDEO_PATH_MAX,
  bundleFolderName,
  bundledNameProblem,
  hasControlCharacter,
  isStoredVideoPath,
  videoPathProblem
};
