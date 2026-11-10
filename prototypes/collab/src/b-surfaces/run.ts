import { build } from "esbuild";
import { readFile, writeFile, mkdir, mkdtemp, symlink, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir, cpus, platform, release, totalmem } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { withSliceBrowser } from "../slice/protocol.ts";
import type { SliceProtocol } from "../slice/protocol.ts";
import { bufferOracles, bufferTraceOrder } from "../../test/buffer-oracles.ts";
import type { BufferTrace } from "../../test/buffer-oracles.ts";
import { bufferMechanisms } from "../editing-buffer.ts";
import { bindingFollowupCases } from "../app-binding-2/cases.ts";
import type { BindingFollowupResult, BindingFollowupStage } from "../app-binding-2/run.ts";
import type { AppBindingSnapshot } from "../app-binding/run.ts";
import type { SliceSnapshot } from "../slice/run.ts";
import { publicBEvidence } from "./public.ts";

export type BMatrixSnapshot = (AppBindingSnapshot | SliceSnapshot) & { candidate: "B"; segments: string[] };
export interface BMatrixCase {
  trace: BufferTrace; mechanism: string; order: string; status: "PASS" | "FAIL"; difference: string | null;
  stages: BMatrixSnapshot[];
}
export interface BSurfaceEvidence {
  surface: string; candidate: "B"; appCommit: string | null; bundleSha256: string;
  environment: { cpu: string; os: string; node: string; memoryGiB: number; browser: string };
  off: unknown; traces: BMatrixCase[]; followup: BindingFollowupResult[];
}

const folder = fileURLToPath(new URL("../../", import.meta.url));
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const surface = process.argv[2] ?? "writer";
if (!["writer", "slice", "split"].includes(surface)) throw new Error("Choose writer, slice or split");
const appCommit = surface === "split" ? "a9483468e01db63568b25bbe194eacf6f2d36246" : "935e618949a2e964198847daa2115d35e1da58ef";
const entry = surface === "slice" ? "slice-page.ts" : surface === "split" ? "split-page.ts" : "followup-page.ts";
const bundle = await build({ absWorkingDir: repo, entryPoints: [join(folder, "src/b-surfaces", entry)], bundle: true, write: false, platform: "browser", format: "iife", target: "es2023" });
const script = bundle.outputFiles?.[0]?.text;
if (!script) throw new Error("Missing B binding bundle");

async function matrix(protocol: SliceProtocol, api: string): Promise<BMatrixCase[]> {
  const traces: BMatrixCase[] = [];
  for (const trace of bufferTraceOrder) {
    for (const mechanism of surface === "split" ? ["M1"] : bufferMechanisms) for (const order of bufferOracles[trace].orders) {
      const stages: BMatrixSnapshot[] = []; let difference: string | null = null;
      const snap = (): Promise<BMatrixSnapshot> => protocol.evaluate(`${api}.snapshot()`);
      try {
        await protocol.evaluate(`${api}.reset(${JSON.stringify(trace)},${JSON.stringify(mechanism)},true)`);
        if (api === "appBinding") await protocol.evaluate(`appBinding.select(${bufferOracles[trace].from},${bufferOracles[trace].to})`);
        else {
          await protocol.key("Home", 2);
          for (let i = 0; i < bufferOracles[trace].from; i++) await protocol.key("ArrowRight");
          for (let i = bufferOracles[trace].from; i < bufferOracles[trace].to; i++) await protocol.key("ArrowRight", 8);
        }
        await protocol.evaluate(`${api}.clear()`); stages.push(await snap());
        if (trace === "T02") await protocol.evaluate(`${api}.remote(${JSON.stringify(order)})`);
        if (trace === "T04" || trace === "T04 removed") await protocol.compose("x");
        else if (trace === "T01 composition") await protocol.compose("β");
        else if (trace === "T01") await protocol.key("Backspace");
        else if (trace === "T03") { for (let i = 0; i < 4; i++) await protocol.key("Backspace"); }
        else await protocol.insert(trace === "T02" ? "c" : trace === "T02 boundary" ? "Z" : "a");
        stages.push(await snap());
        if (trace !== "T02") await protocol.evaluate(`${api}.remote(${JSON.stringify(order)})`);
        stages.push(await snap());
        if (trace === "T04" || trace === "T04 removed") { await protocol.compose("xy"); await protocol.insert("xy"); }
        else if (trace === "T01 composition") await protocol.insert("β");
        stages.push(await snap());
        if (stages.at(-1)?.errors.length) throw new Error(stages.at(-1)?.errors.join("; "));
        await protocol.evaluate(`${api}.finish(${JSON.stringify(order)})`); stages.push(await snap());
        await protocol.key("z", 2);
        await protocol.evaluate(`${api}.checkUndo(${JSON.stringify(order)})`); stages.push(await snap());
        if (stages.at(-1)?.errors.length) throw new Error(stages.at(-1)?.errors.join("; "));
      } catch (error) { difference = error instanceof Error ? error.message : String(error); try { stages.push(await snap()); } catch {} }
      traces.push({ trace, mechanism, order, status: difference ? "FAIL" : "PASS", difference, stages });
    }
    process.stdout.write(`${surface} B ${trace}: ${traces.filter(item => item.trace === trace && item.status === "PASS").length}/${traces.filter(item => item.trace === trace).length}\n`);
  }
  return traces;
}

async function followup(protocol: SliceProtocol): Promise<BindingFollowupResult[]> {
  await protocol.evaluate("appBindingFollowup.reset('reentry-paste','M1');{const field=document.createElement('textarea');field.id='b-clipboard';document.querySelector('#writer').append(field);field.focus()}");
  await protocol.insert("Q"); await protocol.key("a", 2); await protocol.key("c", 2);
  const results: BindingFollowupResult[] = [];
  for (const name of bindingFollowupCases) {
    const orders = name.startsWith("reentry-") ? ["D3"] : name === "removed" ? ["D3", "late-C"] : ["D3", "dup", "late-C"];
    for (const mechanism of bufferMechanisms) for (const order of orders) for (const mode of name.startsWith("reentry-") ? ["baseline", "retained", "paint-gate"] : ["baseline"]) {
      const retained = mode !== "baseline"; const paintGate = mode === "paint-gate";
      const stages: BindingFollowupStage[] = []; const failures: string[] = [];
      let literal: string | null = null; let literalUndo: string | null = null; let undo: BindingFollowupStage | null = null;
      const snap = (): Promise<BindingFollowupStage> => protocol.evaluate("appBindingFollowup.snapshot()");
      try {
        await protocol.evaluate(`appBindingFollowup.reset(${JSON.stringify(name)},${JSON.stringify(mechanism)},${JSON.stringify(order)},${retained},${paintGate})`);
        stages.push(await snap());
        if (name.startsWith("reentry-")) {
          if (name === "reentry-paste") await protocol.key("v", 2); else await protocol.insert("Q");
        } else {
          await protocol.compose("x"); stages.push(await snap());
          await protocol.evaluate("appBindingFollowup.remote()"); stages.push(await snap());
          await protocol.compose("xy"); await protocol.insert("xy");
        }
        stages.push(await snap());
        const result = await protocol.evaluate<{ failures: string[]; literal: string | null }>("appBindingFollowup.finish()");
        failures.push(...result.failures); literal = result.literal; stages.push(await snap());
        if (name === "removed" && !failures.length) { await protocol.key("z", 2); await protocol.evaluate("appBindingFollowup.removedUndo()"); literalUndo = "PASS"; undo = await snap(); }
      } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); try { stages.push(await snap()); } catch {} }
      results.push({ name, mechanism, order: order as BindingFollowupResult["order"], retained, paintGate, status: failures.length ? "FAIL" : "PASS", failures, literal, literalUndo, undo, stages });
    }
    process.stdout.write(`B ${name}: ${results.filter(item => item.name === name && item.status === "PASS").length}/${results.filter(item => item.name === name).length}\n`);
  }
  return results;
}

const buildDirectory = await mkdtemp(join(tmpdir(), "b-surface-app-"));
try {
  let template: string;
  if (surface === "slice") template = (await readFile(join(folder, "slice.html"), "utf8")).replace("SLICE_BUNDLE", () => script.replaceAll("</script", "<\\/script"));
  else {
    const archive = join(buildDirectory, "app.tar"); const source = join(buildDirectory, "source");
    await mkdir(source);
    await writeFile(archive, execFileSync("git", ["archive", "--format=tar", appCommit], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }));
    execFileSync("tar", ["-xf", archive, "-C", source], { windowsHide: true });
    await symlink(join(repo, "node_modules"), join(source, "node_modules"), "junction");
    execFileSync(process.execPath, [join(source, "build.mjs"), "--test"], { cwd: source, windowsHide: true });
    template = (await readFile(join(source, "index.html"), "utf8")).replace(/<link[^>]*href="https:\/\/fonts[^>]*>/g, "");
    template = template.replace(/(<script id="state-data" type="application\/json">)([\s\S]*?)(<\/script>)/, (_all, start: string, data: string, end: string) => start + JSON.stringify({ ...JSON.parse(data) as Record<string, unknown>, docId: "d" + randomUUID().replaceAll("-", "") }) + end);
  }
  const evidence = await withSliceBrowser(async (protocol, version, temporary): Promise<BSurfaceEvidence> => {
    const page = join(temporary, "surface.html"); await writeFile(page, template);
    await protocol.call("Page.enable");
    await protocol.call("Page.addScriptToEvaluateOnNewDocument", { source: "window.__splitpageNoNewTab=true;window.__splitpageNoOnboarding=true" });
    const navigate = async (binding: boolean): Promise<void> => {
      await protocol.call("Page.navigate", { url: pathToFileURL(page).href + (binding ? "?app-binding=1" : "") });
      await protocol.evaluate(surface === "slice" ? "new Promise(resolve=>{if(window.slice)resolve(true);else window.addEventListener('load',()=>resolve(true),{once:true})})" : "new Promise((resolve,reject)=>{const deadline=Date.now()+10000;const check=()=>{if(window.__writerFlowTest&&document.querySelector('#rows .row'))resolve(true);else if(Date.now()>deadline)reject(new Error('App did not start'));else setTimeout(check,20)};check()})");
    };
    let off: unknown = null;
    if (surface !== "slice") { await navigate(false); off = await protocol.evaluate("({rows:document.querySelectorAll('#rows .row').length,experiment:__writerFlowTest.experiment})"); }
    await navigate(true);
    if (surface !== "slice") await protocol.evaluate(script);
    const traces = await matrix(protocol, surface === "slice" ? "slice" : "appBinding");
    const results = surface === "writer" && !traces.some(item => item.mechanism === "M1" && item.status === "FAIL") ? await followup(protocol) : [];
    return { surface, candidate: "B", appCommit: surface === "slice" ? null : appCommit, bundleSha256: createHash("sha256").update(script).digest("hex"), environment: { cpu: cpus()[0]?.model.trim() ?? "unknown", os: `${platform()} ${release()}`, node: process.version, memoryGiB: Math.round(totalmem() / 1024 ** 3), browser: String(version.product) }, off, traces, followup: results };
  });
  await mkdir(join(folder, "b-surfaces"), { recursive: true });
  await writeFile(join(folder, "b-surfaces", `${surface}.json`), publicBEvidence(evidence) + "\n");
  process.stdout.write(`${surface}: ${evidence.traces.length} matrix cases, ${evidence.followup.length} follow-up cases retained\n`);
} finally { await rm(buildDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
