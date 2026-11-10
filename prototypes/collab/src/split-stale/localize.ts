import { build } from "esbuild";
import { readFile, writeFile, mkdir, mkdtemp, symlink, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { withSliceBrowser } from "../slice/protocol.ts";
import { serializeSplitRecord } from "../split-reconcile/records.ts";
import { redactPerfText } from "../perf/privacy.ts";

const folder = fileURLToPath(new URL("../../", import.meta.url));
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const appCommit = "224b60c580dd03d2541f4edd58a9324b07ff389c";
const temporary = await mkdtemp(join(tmpdir(), "split-stale-diagnostic-"));
try {
  const archive = join(temporary, "app.tar"); const source = join(temporary, "source"); await mkdir(source);
  await writeFile(archive, execFileSync("git", ["archive", "--format=tar", appCommit], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }));
  execFileSync("tar", ["-xf", archive, "-C", source], { windowsHide: true });
  await symlink(join(repo, "node_modules"), join(source, "node_modules"), "junction");
  const builder = await readFile(join(source, "build.mjs"), "utf8");
  if (!builder.includes("minify: true,")) throw new Error("Diagnostic option missing");
  await writeFile(join(source, "build.mjs"), builder.replace("minify: true,", "minify: false,"));
  const renderPath = join(source, "src/features/rows/render.ts");
  const render = await readFile(renderPath, "utf8");
  const site = "export function render(): void {";
  if (!render.includes(site)) throw new Error("Render probe site missing");
  await writeFile(renderPath, render.replace(site, site + '(globalThis as unknown as { __splitCall?: (site: string) => void }).__splitCall?.("app.render");'));
  execFileSync(process.execPath, [join(source, "build.mjs"), "--test"], { cwd: source, windowsHide: true });
  let html = (await readFile(join(source, "index.html"), "utf8")).replace(/<link[^>]*href="https:\/\/fonts[^>]*>/g, "");
  html = html.replace(/(<script id="state-data" type="application\/json">)([\s\S]*?)(<\/script>)/, (_all, start: string, data: string, end: string) => start + JSON.stringify({ ...JSON.parse(data) as Record<string, unknown>, docId: "d" + randomUUID().replaceAll("-", "") }) + end);
  const traceBundle = (await build({ absWorkingDir: repo, entryPoints: [join(folder, "src/split-reconcile/trace-page.ts")], bundle: true, write: false, platform: "browser", format: "iife" })).outputFiles?.[0]?.text;
  if (!traceBundle) throw new Error("Trace bundle missing");
  const evidence = await withSliceBrowser(async (protocol, version, browserDirectory) => {
    const path = join(browserDirectory, "app.html"); await writeFile(path, html);
    await protocol.call("Page.enable");
    await protocol.call("Page.addScriptToEvaluateOnNewDocument", { source: "window.__splitpageNoNewTab=true;window.__splitpageNoOnboarding=true;" + traceBundle });
    const cases: unknown[] = [];
    for (const surface of ["split", "writer"]) {
      await protocol.call("Page.navigate", { url: pathToFileURL(path).href + "?app-binding=1" });
      await protocol.evaluate("new Promise((resolve,reject)=>{const end=Date.now()+10000;const check=()=>{if(window.__writerFlowTest&&window.__splitBindingTest)resolve(true);else if(Date.now()>end)reject(new Error('App did not start'));else setTimeout(check,20)};check()})");
      const bundle = (await build({ absWorkingDir: repo, entryPoints: [join(folder, `src/split-stale/${surface}-probe.ts`)], bundle: true, write: false, platform: "browser", format: "iife", target: "es2023" })).outputFiles?.[0]?.text;
      if (!bundle) throw new Error("Surface probe missing");
      await protocol.evaluate(bundle + `\n//# sourceURL=${surface}-stale-binding.js`);
      await protocol.evaluate("appBinding.reset('T02','M1',true);appBinding.select(2);appBinding.clear();staleProbe.clear();splitTrace.clear();staleProbe.mark('before-remote')");
      await protocol.evaluate("appBinding.remote('D3');staleProbe.mark('after-remote')");
      const remoteTrace = await protocol.evaluate("splitTrace.snapshot()");
      await protocol.insert("c");
      let failure: string | null = null;
      try { await protocol.evaluate("appBinding.finish('D3')"); } catch (error) { failure = String(error); }
      cases.push({ surface, bundleSha256: createHash("sha256").update(bundle).digest("hex"), failure, remoteTrace,
        probe: await protocol.evaluate("staleProbe.snapshot()"), snapshot: await protocol.evaluate("appBinding.snapshot()") });
      process.stdout.write(`${surface} T02 diagnostic: ${failure ? "FAIL" : "completed"}\n`);
    }
    return { appCommit, browser: version.product, diagnostic: "unminified app render-entry probe, native Node wrappers and observational binding port wrappers", cases };
  });
  const redacted = JSON.parse(JSON.stringify(evidence, (_key, value: unknown) => typeof value === "string" ? redactPerfText(value) : value)) as unknown;
  await mkdir(join(folder, "split-stale"), { recursive: true });
  await writeFile(join(folder, "split-stale/localization.json"), serializeSplitRecord(redacted));
} finally { await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
