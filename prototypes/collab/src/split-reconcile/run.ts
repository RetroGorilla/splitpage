import { build } from "esbuild";
import { readFile, writeFile, mkdir, mkdtemp, symlink, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { withSliceBrowser } from "../slice/protocol.ts";
import { bufferOracles, bufferTraceOrder } from "../../test/buffer-oracles.ts";
import type { BufferTrace } from "../../test/buffer-oracles.ts";
import type { BMatrixCase, BMatrixSnapshot } from "../b-surfaces/run.ts";
import { publicBEvidence } from "../b-surfaces/public.ts";

const folder = fileURLToPath(new URL("../../", import.meta.url));
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const appCommit = "224b60c580dd03d2541f4edd58a9324b07ff389c";
const built = await build({ absWorkingDir: repo, entryPoints: [join(folder, "src/split-reconcile/page.ts")], bundle: true, write: false, platform: "browser", format: "iife", target: "es2023" });
const script = built.outputFiles?.[0]?.text;
if (!script) throw new Error("Missing Split reconciliation bundle");
const temporary = await mkdtemp(join(tmpdir(), "split-reconcile-app-"));
try {
  const archive = join(temporary, "app.tar"); const source = join(temporary, "source");
  await mkdir(source);
  await writeFile(archive, execFileSync("git", ["archive", "--format=tar", appCommit], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }));
  execFileSync("tar", ["-xf", archive, "-C", source], { windowsHide: true });
  await symlink(join(repo, "node_modules"), join(source, "node_modules"), "junction");
  execFileSync(process.execPath, [join(source, "build.mjs"), "--test"], { cwd: source, windowsHide: true });
  let html = (await readFile(join(source, "index.html"), "utf8")).replace(/<link[^>]*href="https:\/\/fonts[^>]*>/g, "");
  html = html.replace(/(<script id="state-data" type="application\/json">)([\s\S]*?)(<\/script>)/, (_all, start: string, data: string, end: string) => start + JSON.stringify({ ...JSON.parse(data) as Record<string, unknown>, docId: "d" + randomUUID().replaceAll("-", "") }) + end);
  const evidence = await withSliceBrowser(async (protocol, version, browserDirectory) => {
    const page = join(browserDirectory, "app.html"); await writeFile(page, html);
    await protocol.call("Page.enable");
    await protocol.call("Page.addScriptToEvaluateOnNewDocument", { source: "window.__splitpageNoNewTab=true;window.__splitpageNoOnboarding=true" });
    const navigate = async (binding: boolean): Promise<void> => {
      await protocol.call("Page.navigate", { url: pathToFileURL(page).href + (binding ? "?app-binding=1" : "") });
      await protocol.evaluate("new Promise((resolve,reject)=>{const end=Date.now()+10000;const check=()=>{if(window.__writerFlowTest&&window.__renderTest)resolve(true);else if(Date.now()>end)reject(new Error('App did not start'));else setTimeout(check,20)};check()})");
    };
    await navigate(false);
    const off = await protocol.evaluate("({rows:document.querySelectorAll('#rows .row').length,writer:__writerFlowTest.experiment,split:__splitBindingTest})");
    const run = async (coordinate: boolean, traces: readonly BufferTrace[]): Promise<BMatrixCase[]> => {
      const cases: BMatrixCase[] = [];
      for (const trace of traces) {
        for (const order of bufferOracles[trace].orders) {
          const stages: BMatrixSnapshot[] = []; let difference: string | null = null;
          const snap = (): Promise<BMatrixSnapshot> => protocol.evaluate("appBinding.snapshot()");
          try {
            await navigate(true); await protocol.evaluate(script);
            await protocol.evaluate(`appBinding.coordinatePaint(${coordinate});appBinding.reset(${JSON.stringify(trace)},'M1',true);appBinding.select(${bufferOracles[trace].from},${bufferOracles[trace].to});appBinding.clear()`);
            stages.push(await snap());
            if (trace === "T02") await protocol.evaluate(`appBinding.remote(${JSON.stringify(order)})`);
            if (trace === "T04" || trace === "T04 removed") await protocol.compose("x");
            else if (trace === "T01 composition") await protocol.compose("β");
            else if (trace === "T01") await protocol.key("Backspace");
            else if (trace === "T03") { for (let i = 0; i < 4; i++) await protocol.key("Backspace"); }
            else await protocol.insert(trace === "T02" ? "c" : trace === "T02 boundary" ? "Z" : "a");
            stages.push(await snap());
            if (trace !== "T02") await protocol.evaluate(`appBinding.remote(${JSON.stringify(order)})`);
            stages.push(await snap());
            if (trace === "T04" || trace === "T04 removed") { await protocol.compose("xy"); await protocol.insert("xy"); }
            else if (trace === "T01 composition") await protocol.insert("β");
            stages.push(await snap());
            if (stages.at(-1)?.errors.length) throw new Error(stages.at(-1)?.errors.join("; "));
            await protocol.evaluate(`appBinding.finish(${JSON.stringify(order)})`); stages.push(await snap());
            await protocol.key("z", 2); await protocol.evaluate(`appBinding.checkUndo(${JSON.stringify(order)})`); stages.push(await snap());
            if (stages.at(-1)?.errors.length) throw new Error(stages.at(-1)?.errors.join("; "));
          } catch (error) { difference = String(error); try { stages.push(await snap()); } catch {} }
          cases.push({ trace, mechanism: "M1", order, status: difference ? "FAIL" : "PASS", difference, stages });
        }
        process.stdout.write(`coordinate=${coordinate} ${trace}: ${cases.filter(item => item.trace === trace && item.status === "PASS").length}/${cases.filter(item => item.trace === trace).length}\n`);
        if (coordinate && cases.some(item => item.status === "FAIL")) break;
      }
      return cases;
    };
    const controls = await run(false, ["T04", "T04 removed"]);
    const cases = await run(true, bufferTraceOrder);
    return { appCommit, baseHead: "335ab4d6ef412db229d3fac788f7f975c091e325", browser: version.product,
      bundleSha256: createHash("sha256").update(script).digest("hex"), repair: "prototype paint re-entry guard only; app source tree equals c67139b8", off, controls, cases };
  });
  await mkdir(join(folder, "split-reconcile"), { recursive: true });
  await writeFile(join(folder, "split-reconcile/evidence.json"), publicBEvidence(evidence) + "\n");
} finally { await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
