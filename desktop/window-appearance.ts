"use strict";

import type { Display, NativeTheme, Rectangle } from "electron";
import type * as NodePath from "node:path";
import type * as NodeFs from "node:fs";

const path: typeof NodePath = require("node:path");
const fs: typeof NodeFs = require("node:fs");

function createThemeChoice({ filePath }: { filePath: () => string }) {
  function read() {
    try {
      const mode = (JSON.parse(fs.readFileSync(filePath(), "utf8")) as { theme?: unknown }).theme;
      return mode === "light" || mode === "dark" ? mode : "system";
    } catch { return "system"; }
  }

  function write(mode: NativeTheme["themeSource"]) {
    if (read() === mode) return;
    try {
      fs.mkdirSync(path.dirname(filePath()), { recursive: true });
      fs.writeFileSync(filePath(), JSON.stringify({ theme: mode }), "utf8");
    } catch { }
  }

  return { read, write };
}

function backgroundColorFor(dark: boolean) {
  return dark ? "#0F0E0C" : "#F1F0ED";
}

function titleBarOverlayFor(dark: boolean, height: number) {
  return dark
    ? { color: "#0F0E0C", symbolColor: "#ECEBE7", height }
    : { color: "#F1F0ED", symbolColor: "#171613", height };
}

function boundsIfVisible(b: Rectangle | null | undefined, displays: Pick<Display, "workArea">[]) {
  if (!b || typeof b.x !== "number") return null;
  const onScreen = displays.some((d) => {
    const wa = d.workArea;
    return b.x < wa.x + wa.width && b.x + b.width > wa.x &&
           b.y < wa.y + wa.height && b.y + b.height > wa.y;
  });
  return onScreen ? b : null;
}

export type { createThemeChoice, backgroundColorFor, titleBarOverlayFor, boundsIfVisible };

module.exports = { createThemeChoice, backgroundColorFor, titleBarOverlayFor, boundsIfVisible };
