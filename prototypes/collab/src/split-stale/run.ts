import { build } from "esbuild";
import { readFile, writeFile, mkdir, mkdtemp, symlink, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { withSliceBrowser } from "../slice/protocol.ts";
import { bufferOracles } from "../../test/buffer-oracles.ts";
import type { BufferTrace } from "../../test/buffer-oracles.ts";
import { serializeSplitRecord } from "../split-reconcile/records.ts";

const folder = fileURLToPath(new URL("../../", import.meta.url));
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const appCommit = "224b60c580dd03d2541f4edd58a9324b07ff389c";
const built = await build({ absWorkingDir: repo, entryPoints: [join(folder, "src/split-stale/page-probe.ts")], bundle: true, write: false, platform: "browser", format: "iife", target: "es2023" });
const script = built.outputFiles?.[0]?.text;
if (!script) throw new Error("Split stale binding bundle missing");
const temporary = await mkdtemp(join(tmpdir(), "split-stale-app-"));
try {
  const archive = join(temporary, "app.tar"); const source = join(temporary, "source"); await mkdir(source);
  await writeFile(archive, execFileSync("git", ["archive", "--format=tar", appCommit], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }));
  execFileSync("tar", ["-xf", archive, "-C", source], { windowsHide: true });
  await symlink(join(repo, "node_modules"), join(source, "node_modules"), "junction");
  execFileSync(process.execPath, [join(source, "build.mjs"), "--test"], { cwd: source, windowsHide: true });
  let html = (await readFile(join(source, "index.html"), "utf8")).replace(/<link[^>]*href="https:\/\/fonts[^>]*>/g, "");
  html = html.replace(/(<script id="state-data" type="application\/json">)([\s\S]*?)(<\/script>)/, (_all, start: string, data: string, end: string) => start + JSON.stringify({ ...JSON.parse(data) as Record<string, unknown>, docId: "d" + randomUUID().replaceAll("-", "") }) + end);
  const evidence = await withSliceBrowser(async (protocol, version, browserDirectory) => {
    const path = join(browserDirectory, "app.html"); await writeFile(path, html);
    await protocol.call("Page.enable");
    await protocol.call("Page.addScriptToEvaluateOnNewDocument", { source: "window.__splitpageNoNewTab=true;window.__splitpageNoOnboarding=true" });
    const navigate = async (binding: boolean): Promise<void> => {
      await protocol.call("Page.navigate", { url: pathToFileURL(path).href + (binding ? "?app-binding=1" : "") });
      await protocol.evaluate("new Promise((resolve,reject)=>{const end=Date.now()+10000;const check=()=>{if(window.__writerFlowTest&&window.__renderTest)resolve(true);else if(Date.now()>end)reject(new Error('App did not start'));else setTimeout(check,20)};check()})");
    };
    await navigate(false);
    const off = await protocol.evaluate("({rows:document.querySelectorAll('#rows .row').length,writer:__writerFlowTest.experiment,split:__splitBindingTest})");
    const run = async (preserve: boolean, traces: readonly BufferTrace[]) => {
      const cases: { trace: BufferTrace; order: string; status: "PASS" | "FAIL"; failure: string | null; stages: unknown[] }[] = [];
      for (const trace of traces) {
        for (const order of bufferOracles[trace].orders) {
          const stages: unknown[] = []; let failure: string | null = null;
          const snap = async (phase: string): Promise<void> => { stages.push(await protocol.evaluate(`({phase:${JSON.stringify(phase)},binding:appBinding.snapshot(),probe:staleProbe.snapshot()})`)); };
          try {
            await navigate(true); await protocol.evaluate(script);
            await protocol.evaluate(`appBinding.preserveStalePaint(${preserve});appBinding.reset(${JSON.stringify(trace)},'M1',true);appBinding.select(${bufferOracles[trace].from},${bufferOracles[trace].to});appBinding.clear();staleProbe.clear()`);
            await snap("painted");
            if (trace === "T02") { await protocol.evaluate(`appBinding.remote(${JSON.stringify(order)})`); await snap("remote-before-input"); }
            if (trace === "T03") { for (let i = 0; i < 4; i++) await protocol.key("Backspace"); }
            else await protocol.insert(trace === "T02" ? "c" : trace === "T02 boundary" ? "Z" : "a");
            await snap("after-input");
            if (trace !== "T02") { await protocol.evaluate(`appBinding.remote(${JSON.stringify(order)})`); await snap("after-remote"); }
            const errors = await protocol.evaluate<string[]>("appBinding.snapshot().errors");
            if (errors.length) throw new Error(errors.join("; "));
            await protocol.evaluate(`appBinding.finish(${JSON.stringify(order)})`); await snap("forward");
            await protocol.key("z", 2); await protocol.evaluate(`appBinding.checkUndo(${JSON.stringify(order)})`); await snap("undo");
            const after = await protocol.evaluate<string[]>("appBinding.snapshot().errors");
            if (after.length) throw new Error(after.join("; "));
          } catch (error) { failure = String(error); try { await snap("failure"); } catch {} }
          cases.push({ trace, order, status: failure ? "FAIL" : "PASS", failure, stages });
        }
        process.stdout.write(`preserve=${preserve} ${trace}: ${cases.filter(item => item.trace === trace && item.status === "PASS").length}/${cases.filter(item => item.trace === trace).length}\n`);
        if (preserve && cases.some(item => item.status === "FAIL")) break;
      }
      return cases;
    };
    const controls = await run(false, ["T02"]);
    const cases = await run(true, ["T02", "T02 boundary", "T03", "T03 replace"]);
    return { appCommit, baseHead: "f4730c6c8e9581443ef654da869db67acab8f9db", candidate: "B", mechanism: "M1", browser: version.product,
      bundleSha256: createHash("sha256").update(script).digest("hex"), off, controls, cases };
  });
  await mkdir(join(folder, "split-stale"), { recursive: true });
  await writeFile(join(folder, "split-stale/evidence.json"), serializeSplitRecord(evidence));
} finally { await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
