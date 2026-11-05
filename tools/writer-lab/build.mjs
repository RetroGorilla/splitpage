import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const out = esbuild.buildSync({
  entryPoints: [join(here, "lab.ts")],
  bundle: true,
  format: "iife",
  write: false,
  charset: "utf8",
  target: "chrome120",
  loader: { ".json": "json" }
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const css = readFileSync(join(here, "lab.css"), "utf8");
const html = readFileSync(join(here, "lab.html"), "utf8")
  .replace("LAB_CSS", () => css)
  .replace("LAB_JS", () => js);
mkdirSync(join(here, "dist"), { recursive: true });
writeFileSync(join(here, "dist", "writer-lab.html"), html);
console.log("built", join(here, "dist", "writer-lab.html"), Math.round(html.length / 1024) + " KB");
