import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readBuiltCss, repoUrl, compareCssColours, cssRules } from "./css-colours.mjs";

const { path, css } = readBuiltCss();
const revision = process.argv.slice(2).find((arg) => arg !== "--built") || "HEAD";
const original = execFileSync("git", ["show", `${revision}:${path}`], { cwd: fileURLToPath(repoUrl), encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const differences = compareCssColours(original, css);
if (differences.length) {
  console.error(differences.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`${cssRules(css).length} selector blocks unchanged in light, dark, system-dark and prompter contexts, including every media block; all resolved declarations match ${revision}:${path}`);
}

if (process.argv.includes("--built")) {
  const html = readFileSync(new URL("index.html", repoUrl), "utf8");
  const inlineCss = html.match(/<style>\r?\n([\s\S]*?)<\/style>/);
  assert.ok(inlineCss, "Generated inline CSS is missing");
  const normalise = (text) => text.replace(/\r\n/g, "\n").trimEnd();
  assert.equal(normalise(inlineCss[1]), normalise(css));
  const script = html.match(/<script id="app-logic">([\s\S]*?)<\/script>/);
  assert.ok(script, "Generated app script is missing");
  const parsed = script[1].replace(/\r\n?/g, "\n").replaceAll(String.fromCharCode(0), "\uFFFD");
  const hash = createHash("sha256").update(parsed, "utf8").digest("base64");
  assert.ok(html.includes("'sha256-" + hash + "'"), "Generated script CSP hash differs");
  const version = readFileSync(new URL("VERSION", repoUrl), "utf8").trim();
  assert.ok(readFileSync(new URL("sw.js", repoUrl), "utf8").includes('var CACHE = "splitpage-' + version + '";'), "Worker version stamp differs");
  console.log("Generated inline CSS matches build input; script CSP hash and worker version stamp match");
}
