import { build } from "esbuild";
import { readFile, writeFile, mkdir, mkdtemp, symlink, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { withSliceBrowser } from "../slice/protocol.ts";
import { redactPerfText } from "../perf/privacy.ts";
import { serializeSplitRecord } from "./records.ts";

const folder = fileURLToPath(new URL("../../", import.meta.url));
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const call = (site: string): string => `(globalThis as unknown as { __splitCall?: (site: string) => void }).__splitCall?.(${JSON.stringify(site)});`;
const probes = [
  ["src/features/rows/render.ts", "export function render(): void {", "render"],
  ["src/features/rows/render.ts", "function commitRowPatch(rowEl: SignedRow, patch: RowPatch): boolean {", "commitRowPatch"],
  ["src/features/rows/render.ts", "function commitRows(rowsEl: Element, plan: RowsPlan, pinned: Element | null | undefined): void {", "commitRows"],
  ["src/features/editing/focus.ts", "return (e: Event) => {", "editorBlur"],
  ["src/bootstrap/wiring/editor.ts", "leftEditable: function () {", "leftEditable"],
  ["src/bootstrap/wiring/editor.ts", "blurredCell: function (cellEl) {", "blurredCell"],
  ["src/application/editing/cell-editing.ts", "function syncShown(cell: E): void {", "syncShown"]
] as const;

const temporary = await mkdtemp(join(tmpdir(), "split-localize-"));
try {
  const pages: { name: string; commit: string; sourceTree: string; html: string; hash: string }[] = [];
  for (const [name, commit] of [["binding", "c67139b8806d04231d2f2c5bb89814370bab8ef6"], ["guarded", "224b60c580dd03d2541f4edd58a9324b07ff389c"], ["standalone", "efcd94c2"]] as const) {
    const directory = join(temporary, name); await mkdir(directory);
    const archive = join(temporary, `${name}.tar`);
    await writeFile(archive, execFileSync("git", ["archive", "--format=tar", commit], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }));
    execFileSync("tar", ["-xf", archive, "-C", directory], { windowsHide: true });
    await symlink(join(repo, "node_modules"), join(directory, "node_modules"), "junction");
    const buildFile = join(directory, "build.mjs");
    const builder = await readFile(buildFile, "utf8");
    if (!builder.includes("minify: true,")) throw new Error("No diagnostic build option");
    await writeFile(buildFile, builder.replace("minify: true,", "minify: false,"));
    for (const [file, entry, site] of probes) {
      const path = join(directory, file); const source = await readFile(path, "utf8");
      if (!source.includes(entry)) throw new Error(`Probe entry missing: ${site}`);
      await writeFile(path, source.replace(entry, entry + call(site)));
    }
    execFileSync(process.execPath, [buildFile, "--test"], { cwd: directory, windowsHide: true });
    let html = (await readFile(join(directory, "index.html"), "utf8")).replace(/<link[^>]*href="https:\/\/fonts[^>]*>/g, "");
    html = html.replace(/(<script id="state-data" type="application\/json">)([\s\S]*?)(<\/script>)/, (_all, start: string, data: string, end: string) => start + JSON.stringify({ ...JSON.parse(data) as Record<string, unknown>, docId: "d" + randomUUID().replaceAll("-", ""), rows: [{ id: "R1", audioText: "abcd", visualText: "", status: "todo", imageRef: null }, { id: "R2", audioText: "ef", visualText: "", status: "todo", imageRef: null }], paragraphsDecided: true }) + end);
    pages.push({ name, commit: execFileSync("git", ["rev-parse", commit], { cwd: repo, encoding: "utf8" }).trim(), sourceTree: execFileSync("git", ["rev-parse", `${commit}:src`], { cwd: repo, encoding: "utf8" }).trim(), html, hash: createHash("sha256").update(html).digest("hex") });
  }
  const traceBundle = (await build({ absWorkingDir: repo, entryPoints: [join(folder, "src/split-reconcile/trace-page.ts")], bundle: true, write: false, platform: "browser", format: "iife" })).outputFiles?.[0]?.text;
  const makeBinding = async (entry: string): Promise<string> => {
    const output = (await build({ absWorkingDir: repo, entryPoints: [join(folder, entry)], bundle: true, write: false, platform: "browser", format: "iife", target: "es2023", plugins: [{ name: "observe-binding-paint", setup(plugin) {
    plugin.onLoad({ filter: /(?:b-surfaces[\\/]split-page|split-reconcile[\\/]page)\.ts$/ }, async args => {
      const source = await readFile(args.path, "utf8");
      return { contents: source.replace("function paint(): void {", "function paint(): void {" + call("binding.paint")), loader: "ts" };
    });
    } }] })).outputFiles?.[0]?.text;
    if (!output) throw new Error("Missing diagnostic binding bundle");
    return output;
  };
  const binding = await makeBinding("src/b-surfaces/split-page.ts");
  const guarded = await makeBinding("src/split-reconcile/page.ts");
  if (!traceBundle) throw new Error("Missing trace bundle");
  const results = await withSliceBrowser(async (protocol, version, browserDirectory) => {
    await protocol.call("Page.enable");
    protocol.socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data)) as { method?: string };
      if (message.method === "Page.javascriptDialogOpening") void protocol.call("Page.handleJavaScriptDialog", { accept: true }).catch(() => undefined);
    });
    await protocol.call("Page.addScriptToEvaluateOnNewDocument", { source: "window.__splitpageNoNewTab=true;window.__splitpageNoOnboarding=true;" + traceBundle });
    const cases: unknown[] = [];
    for (const page of pages) for (const kind of page.name !== "standalone" ? ["T04", "T04 removed"] : ["composition-and-blur", "delete-focused-row"]) {
      const path = join(browserDirectory, "diagnostic.html"); await writeFile(path, page.html);
      await protocol.call("Page.navigate", { url: pathToFileURL(path).href + (page.name !== "standalone" ? "?app-binding=1" : "") });
      await protocol.evaluate("new Promise((resolve,reject)=>{const end=Date.now()+10000;const check=()=>{if(window.__renderTest&&window.__writerFlowTest)resolve(true);else if(Date.now()>end)reject(new Error('App did not start'));else setTimeout(check,20)};check()})");
      let failure: string | null = null;
      if (page.name !== "standalone") {
        await protocol.evaluate((page.name === "guarded" ? guarded : binding) + "\n//# sourceURL=split-binding.js");
        await protocol.evaluate(`appBinding.reset(${JSON.stringify(kind)},'M1',true);appBinding.select(2);appBinding.clear();splitTrace.clear()`);
        await protocol.compose("x"); await protocol.evaluate("appBinding.remote('D3')");
        await protocol.compose("xy"); await protocol.insert("xy");
        try { await protocol.evaluate("appBinding.finish('D3')"); } catch (error) { failure = String(error); }
      } else {
        await protocol.evaluate("document.querySelector('#rows .cell-editable[data-id=R1][data-field=audioText]').focus();splitTrace.clear()");
        await protocol.key("Home", 2); await protocol.key("ArrowRight"); await protocol.key("ArrowRight");
        if (kind === "composition-and-blur") {
          await protocol.compose("x"); await protocol.evaluate("__renderTest.render()"); await protocol.compose("xy"); await protocol.insert("xy");
          await protocol.evaluate("__renderTest.render();document.querySelector('#rows .cell-editable[data-id=R2][data-field=audioText]').focus()");
        } else {
          try { await protocol.evaluate("{const button=document.querySelector('#rows [data-action=delete-row][data-id=R1]');button.click();button.click()}"); } catch (error) { failure = String(error); }
        }
      }
      cases.push({ mode: page.name, kind, sourceCommit: page.commit, sourceTree: page.sourceTree, diagnosticHtmlHash: page.hash, failure,
        trace: await protocol.evaluate("splitTrace.snapshot()"), snapshot: await protocol.evaluate(page.name !== "standalone" ? "appBinding.snapshot()" : "({rows:document.querySelectorAll('#rows .row').length,model:__splitpageFormats.state().rows.map(row=>({id:row.id,audioText:row.audioText})),dom:[...document.querySelectorAll('#rows .cell-editable[data-field=audioText]')].map(el=>({id:el.dataset.id,text:el.textContent}))})") });
      process.stdout.write(`${page.name}/${kind}: ${failure ? "FAIL" : "completed"}\n`);
    }
    return { browser: version.product, diagnostic: "unminified archived source plus observational call probes and native Node wrappers; guarded mode changes only the prototype", probes: probes.map(([file, , site]) => ({ file, site })), cases };
  });
  await mkdir(join(folder, "split-reconcile"), { recursive: true });
  const redacted = JSON.parse(JSON.stringify(results, (_key, value: unknown) => typeof value === "string" ? redactPerfText(value) : value)) as unknown;
  await writeFile(join(folder, "split-reconcile/localization.json"), serializeSplitRecord(redacted));
} finally { await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
