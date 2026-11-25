import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { transformSync } from "esbuild";
import { isMain } from "./main-module.mjs";

const desktopFile = name => new URL(`../desktop/${name}`, import.meta.url);
const source = name => readFileSync(desktopFile(name + ".ts"), "utf8");

export function collaborationPreload(name, collabUi) {
  return transformSync(source(name), {
    loader: "ts", minifySyntax: true, legalComments: "none",
    define: { SPLITPAGE_COLLAB_UI: String(collabUi) }
  }).code.replaceAll("/* @__PURE__ */ ", "");
}

export function writeDesktopBuild(directory, collabUi, testRelay, settingsDirectory = directory) {
  mkdirSync(directory, { recursive: true });
  const setup = join(directory, "relay-setup");
  rmSync(setup, { recursive: true, force: true });
  rmSync(join(directory, "preload.js"), { force: true });
  if (collabUi) {
    mkdirSync(setup);
    for (const file of ["index.html", "setup.css"]) copyFileSync(desktopFile("relay-setup/" + file), join(setup, file));
    writeFileSync(join(setup, "preload.js"), collaborationPreload("relay-setup-preload", true));
    writeFileSync(join(directory, "preload.js"), collaborationPreload("preload", true));
  }
  writeFileSync(join(settingsDirectory, "collaboration.json"), JSON.stringify({ collabUi, testRelay }) + "\n");
}

if (isMain(import.meta.url)) {
  writeFileSync(desktopFile("preload.js"), collaborationPreload("preload", false));
  for (const name of ["tabstrip-preload", "tabstrip/tabstrip"]) {
    writeFileSync(desktopFile(name + ".js"), stripTypeScriptTypes(source(name)));
  }
}
