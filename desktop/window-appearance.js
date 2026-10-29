"use strict";

const path = require("node:path");
const fs = require("node:fs");

function createThemeChoice({ filePath }) {
  function read() {
    try {
      const mode = JSON.parse(fs.readFileSync(filePath(), "utf8")).theme;
      return mode === "light" || mode === "dark" ? mode : "system";
    } catch { return "system"; }
  }

  function write(mode) {
    if (read() === mode) return;
    try {
      fs.mkdirSync(path.dirname(filePath()), { recursive: true });
      fs.writeFileSync(filePath(), JSON.stringify({ theme: mode }), "utf8");
    } catch { }
  }

  return { read, write };
}

function backgroundColorFor(dark) {
  return dark ? "#0F0E0C" : "#F1F0ED";
}

function titleBarOverlayFor(dark, height) {
  return dark
    ? { color: "#0F0E0C", symbolColor: "#ECEBE7", height }
    : { color: "#F1F0ED", symbolColor: "#171613", height };
}

function boundsIfVisible(b, displays) {
  if (!b || typeof b.x !== "number") return null;
  const onScreen = displays.some((d) => {
    const wa = d.workArea;
    return b.x < wa.x + wa.width && b.x + b.width > wa.x &&
           b.y < wa.y + wa.height && b.y + b.height > wa.y;
  });
  return onScreen ? b : null;
}

module.exports = { createThemeChoice, backgroundColorFor, titleBarOverlayFor, boundsIfVisible };
