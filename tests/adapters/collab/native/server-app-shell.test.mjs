import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";
import { JSDOM } from "jsdom";
import { build } from "../../../../build.mjs";
import { NAME, serverHarness } from "./server-harness.ts";

test("the relay serves the shell and the gated app replaces the invite history entry", async t => {
  const kit = serverHarness(t);
  const shell = build(true);
  await writeFile(join(kit.directory, "index.html"), shell);
  for (const file of ["sw.js", "manifest.webmanifest", "icon.svg", "icon-maskable.svg"]) {
    await writeFile(join(kit.directory, file), await readFile(new URL("../../../../" + file, import.meta.url)));
  }
  const run = kit.launch({ SPLITPAGE_APP_DIR: kit.directory });
  const origin = "http://127.0.0.1:" + await run.port();
  const { token } = kit.invitation();
  const path = "/?join=" + NAME;
  const response = await globalThis.fetch(origin + path + "#" + token);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  const html = await response.text();
  assert.ok(html === shell);
  const head = await globalThis.fetch(origin + "/index.html", { method: "HEAD" });
  assert.equal(head.headers.get("content-length"), String(Buffer.byteLength(shell)));
  assert.equal(await head.text(), "");
  for (const file of ["sw.js", "manifest.webmanifest", "icon.svg", "icon-maskable.svg"]) {
    assert.equal((await globalThis.fetch(origin + "/" + file)).status, 200);
  }
  assert.equal(await (await globalThis.fetch(origin + "/api/index.html")).text(), "Welcome to Hocuspocus!");

  const page = new JSDOM(html, { url: origin + path + "#" + token, runScripts: "outside-only" });
  t.after(() => page.window.close());
  const script = page.window.document.querySelector("#app-logic")?.textContent ?? "";
  const bundleStart = script.indexOf("(()=>");
  assert.ok(bundleStart > 0);
  page.window.eval(script.slice(0, bundleStart));
  assert.ok(page.window.location.href === origin + path);
  assert.equal(page.window.history.length, 1);
  assert.equal(page.window.history.state, null);
  assert.equal(build(false).includes('url.searchParams.has("join")'), false);
  assert.ok(!(run.output() + run.errors()).includes(token));
});
