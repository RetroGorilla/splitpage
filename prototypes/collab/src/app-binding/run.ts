import { build } from "esbuild";
import { readFile, writeFile, mkdir, mkdtemp, symlink, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { withSliceBrowser } from "../slice/protocol.ts";
import type { SliceProtocol } from "../slice/protocol.ts";
import { bufferOracles, bufferTraceOrder } from "../../test/buffer-oracles.ts";
import { bufferMechanisms } from "../editing-buffer.ts";
import type { CollabIdentity, CollabModel } from "../model.ts";
import { serializeAppBindingEvidence, writeAppBindingHistories } from "./report.ts";

export interface AppBindingSnapshot {
  events: Record<string, unknown>[]; errors: string[]; commits: string[]; html: string; text: string;
  rawText: string; selection: [number, number] | null; app: unknown; history: string[]; dirty: boolean;
  composing: boolean; heldBytes: number; models: Record<string, CollabModel>; bindings: Record<string, CollabIdentity>;
}
export interface AppBindingEvidence {
  appCommit: string; harnessSha256: string; instanceDocId: string; version: Record<string, unknown>;
  off: unknown; inputs: { name: string; snapshot: AppBindingSnapshot }[];
  traces: { trace: string; mechanism: string; order: string; status: "PASS" | "FAIL"; difference: string | null; forward: AppBindingSnapshot | null; snapshot: AppBindingSnapshot }[];
  probes: { name: string; stages: AppBindingSnapshot[]; result?: unknown }[];
}

const directory = fileURLToPath(new URL("../../", import.meta.url));
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
async function snap(protocol: SliceProtocol): Promise<AppBindingSnapshot> { return protocol.evaluate("appBinding.snapshot()"); }

async function run(): Promise<AppBindingEvidence> {
  const { appCommit } = JSON.parse(await readFile(join(directory, "app-binding/manifest.json"), "utf8")) as { appCommit: string };
  if (!/^[a-f0-9]{40}$/.test(appCommit)) throw new Error("Invalid pinned app commit");
  const bundle = await build({ absWorkingDir: repo, entryPoints: [join(directory, "src/app-binding/page.ts")], bundle: true, write: false, platform: "browser", format: "iife", target: "es2023" });
  const script = bundle.outputFiles?.[0]?.text;
  if (!script) throw new Error("Missing app binding bundle");
  const archiveDirectory = await mkdtemp(join(tmpdir(), "app-binding-build-"));
  try {
  const archive = join(archiveDirectory, "app.tar");
  const source = join(archiveDirectory, "source");
  await mkdir(source);
  await writeFile(archive, execFileSync("git", ["archive", "--format=tar", appCommit], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }));
  execFileSync("tar", ["-xf", archive, "-C", source], { windowsHide: true });
  await symlink(join(repo, "node_modules"), join(source, "node_modules"), "junction");
  execFileSync(process.execPath, [join(source, "build.mjs"), "--test"], { cwd: source, windowsHide: true });
  const html = (await readFile(join(source, "index.html"), "utf8")).replace(/<link[^>]*href="https:\/\/fonts[^>]*>/g, "");
  return await withSliceBrowser(async (protocol, version, temporary) => {
    const app = join(temporary, "app.html");
    await writeFile(app, html);
    const instanceDocId = "d" + randomUUID().replaceAll("-", "");
    const state = html.match(/(<script id="state-data" type="application\/json">)([\s\S]*?)(<\/script>)/);
    if (!state?.[2]) throw new Error("No real app embedded document");
    const seeded = html.replace(state[0], `${state[1]}${JSON.stringify({ ...JSON.parse(state[2]) as Record<string, unknown>, docId: instanceDocId })}${state[3]}`);
    const boundApp = join(temporary, "bound-app.html");
    await writeFile(boundApp, seeded);
    await protocol.call("Page.enable");
    await protocol.call("Page.addScriptToEvaluateOnNewDocument", { source: "window.__splitpageNoNewTab=true; window.__splitpageNoOnboarding=true;" });
    const navigate = async (binding: boolean): Promise<void> => {
      const loaded = protocol.call("Page.navigate", { url: pathToFileURL(binding ? boundApp : app).href + (binding ? "?app-binding=1" : "") });
      await loaded;
      await protocol.evaluate("new Promise((resolve,reject)=>{const deadline=Date.now()+10000; const check=()=>{if(window.__writerFlowTest && document.querySelector('#rows .row')) resolve(true);else if(Date.now()>deadline) reject(new Error('App did not start'));else setTimeout(check,20)};check()})");
    };
    await navigate(false);
    const off = await protocol.evaluate("({rows:document.querySelectorAll('#rows .row').length,experiment:__writerFlowTest.experiment,errors:document.querySelector('#startup-failure')?.textContent ?? null})");
    await navigate(true);
    await protocol.evaluate(script);
    await protocol.evaluate("{const field=document.createElement('textarea');field.id='binding-clipboard';document.querySelector('#writer').append(field)}");
    const evidence: AppBindingEvidence = { appCommit, harnessSha256: createHash("sha256").update(script).digest("hex"), instanceDocId, version, off, inputs: [], traces: [], probes: [] };
    const observe = async (name: string, from: number, to: number, action: () => Promise<void>): Promise<void> => {
      await protocol.evaluate("appBinding.reset('observe')");
      await protocol.evaluate(`appBinding.select(${from},${to});appBinding.clear()`);
      await action();
      evidence.inputs.push({ name, snapshot: await snap(protocol) });
    };
    await observe("typing", 7, 7, () => protocol.insert("a"));
    await observe("Backspace", 7, 7, () => protocol.key("Backspace"));
    await observe("Delete", 4, 4, () => protocol.key("Delete"));
    await observe("typing over selection", 4, 7, () => protocol.insert("a"));
    await protocol.evaluate("document.querySelector('#binding-clipboard').focus()");
    await protocol.insert("Q"); await protocol.key("a", 2); await protocol.key("c", 2);
    await observe("paste", 4, 7, () => protocol.key("v", 2));
    await observe("cut", 4, 7, () => protocol.key("x", 2));
    await observe("Enter", 4, 4, () => protocol.key("Enter"));
    await observe("composition", 4, 4, async () => { await protocol.compose("x"); await protocol.compose("xy"); await protocol.insert("xy"); });
    await observe("native undo shortcut", 7, 7, async () => { await protocol.insert("a"); await protocol.evaluate("appBinding.clear()"); await protocol.key("z", 2); });
    const mechanisms = process.env.APP_BINDING_MECHANISM ? [process.env.APP_BINDING_MECHANISM] : bufferMechanisms;
    const traces = process.env.APP_BINDING_TRACE ? bufferTraceOrder.filter(trace => trace === process.env.APP_BINDING_TRACE) : bufferTraceOrder;
    for (const trace of traces) {
      for (const mechanism of mechanisms) {
        for (const order of bufferOracles[trace].orders) {
          let difference: string | null = null; let forward: AppBindingSnapshot | null = null;
          try {
            await protocol.evaluate(`appBinding.reset(${JSON.stringify(trace)},${JSON.stringify(mechanism)},true);appBinding.select(${bufferOracles[trace].from},${bufferOracles[trace].to});appBinding.clear()`);
            if (trace === "T02") await protocol.evaluate(`appBinding.remote(${JSON.stringify(order)})`);
            if (trace === "T04" || trace === "T04 removed") await protocol.compose("x");
            else if (trace === "T01 composition") await protocol.compose("β");
            else if (trace === "T01") await protocol.key("Backspace");
            else if (trace === "T03") { for (let count = 0; count < 4; count++) await protocol.key("Backspace"); }
            else await protocol.insert(trace === "T02" ? "c" : trace === "T02 boundary" ? "Z" : "a");
            if (trace !== "T02") await protocol.evaluate(`appBinding.remote(${JSON.stringify(order)})`);
            if (trace === "T04" || trace === "T04 removed") { await protocol.compose("xy"); await protocol.insert("xy"); }
            else if (trace === "T01 composition") await protocol.insert("β");
            const before = await snap(protocol);
            if (before.errors.length) throw new Error(before.errors.join("; "));
            await protocol.evaluate(`appBinding.finish(${JSON.stringify(order)})`);
            forward = await snap(protocol);
            await protocol.key("z", 2);
            await protocol.evaluate(`appBinding.checkUndo(${JSON.stringify(order)})`);
            const after = await snap(protocol);
            if (after.errors.length) throw new Error(after.errors.join("; "));
          } catch (error) { difference = error instanceof Error ? error.message : String(error); }
          evidence.traces.push({ trace, mechanism, order, status: difference ? "FAIL" : "PASS", difference, forward, snapshot: await snap(protocol) });
        }
      }
      process.stdout.write(`${trace}: ${evidence.traces.filter(result => result.trace === trace && result.status === "PASS").length}/${evidence.traces.filter(result => result.trace === trace).length}\n`);
    }
    for (const mechanism of mechanisms) {
      await protocol.evaluate(`appBinding.reset('T03 replace',${JSON.stringify(mechanism)},false);appBinding.select(4,7);appBinding.clear()`);
      await protocol.insert("a");
      const synchronous = [await snap(protocol)];
      await protocol.evaluate("appBinding.remote('D3');appBinding.finish('D3')");
      synchronous.push(await snap(protocol));
      await protocol.key("z", 2);
      await protocol.evaluate("appBinding.checkUndo('D3')");
      synchronous.push(await snap(protocol));
      evidence.probes.push({ name: `synchronous input ${mechanism}`, stages: synchronous });

      await protocol.evaluate(`appBinding.reset('T04',${JSON.stringify(mechanism)},false);appBinding.select(2);appBinding.clear()`);
      await protocol.compose("x");
      const composition = [await snap(protocol)];
      await protocol.evaluate("appBinding.remote('D3');appBinding.repaint()");
      composition.push(await snap(protocol));
      await protocol.compose("xy"); await protocol.insert("xy");
      await protocol.evaluate("appBinding.finish('D3')");
      composition.push(await snap(protocol));
      evidence.probes.push({ name: `composition repaint deferral ${mechanism}`, stages: composition });

      await protocol.evaluate(`appBinding.reset('T03 replace',${JSON.stringify(mechanism)},false);appBinding.select(4,7);appBinding.clear()`);
      await protocol.insert("a");
      await protocol.evaluate("appBinding.remote('D3');appBinding.finish('D3');appBinding.holdUndo()");
      const held = [await snap(protocol)];
      await protocol.key("z", 2);
      held.push(await snap(protocol));
      evidence.probes.push({ name: `standalone undo hold bypass ${mechanism}`, stages: held });

      await protocol.evaluate(`appBinding.reset('T04',${JSON.stringify(mechanism)},false);appBinding.select(2);appBinding.clear()`);
      await protocol.compose("x");
      const blur = [await snap(protocol)];
      await protocol.evaluate("appBinding.remote('D3');appBinding.blur()");
      blur.push(await snap(protocol));
      evidence.probes.push({ name: `writer host blur during composition ${mechanism}`, stages: blur });
      await protocol.insert("x");
    }
    await protocol.evaluate("appBinding.reset('T03 replace','M2',false);appBinding.select(4,7);appBinding.clear();appBinding.bypassSync()");
    await protocol.insert("a");
    evidence.probes.push({ name: "sync hook removed", stages: [await snap(protocol)] });
    await protocol.evaluate("appBinding.reset('T04');appBinding.unbind();appBinding.select(2);appBinding.clear()");
    await protocol.compose("x");
    const unbound = [await snap(protocol)];
    await protocol.evaluate("appBinding.rawRemote()");
    unbound.push(await snap(protocol));
    await protocol.compose("xy"); await protocol.insert("xy");
    unbound.push(await snap(protocol));
    evidence.probes.push({ name: "unbound whole-beat reconciliation overwrites remote", stages: unbound });
    await protocol.evaluate("appBinding.reset('T04','M2',false);appBinding.clear()");
    const beforeIsolation = await snap(protocol);
    const isolation = await protocol.evaluate("appBinding.isolation()");
    evidence.probes.push({ name: "SLICE isolated session writers", stages: [beforeIsolation, await snap(protocol)], result: isolation });
    const markBefore = await snap(protocol);
    const controls = await protocol.evaluate("({mark:appBinding.markProbe(),hold:appBinding.heldUndoProbe()})");
    evidence.probes.push({ name: "undo owner instrumentation controls", stages: [markBefore, await snap(protocol)], result: controls });
    await protocol.evaluate("appBinding.reset('T02 boundary','M2',false);appBinding.select(0);appBinding.clear();window.bindingNode=document.querySelector('.wr-beat[data-id=R2]');window.bindingText=bindingNode.firstChild");
    const otherBefore = await snap(protocol);
    await protocol.evaluate("appBinding.remote('D3')");
    const otherResult = await protocol.evaluate("({sameBeat:bindingNode===document.querySelector('.wr-beat[data-id=R2]'),sameText:bindingText===bindingNode.firstChild,focused:document.activeElement.id})");
    evidence.probes.push({ name: "remote other beat preserves focused DOM", stages: [otherBefore, await snap(protocol)], result: otherResult });
    return evidence;
  });
  } finally { await rm(archiveDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}

const evidence = await run();
await mkdir(join(directory, "app-binding"), { recursive: true });
await writeFile(join(directory, "app-binding/evidence.json"), serializeAppBindingEvidence(evidence));
writeAppBindingHistories(evidence);
process.stdout.write(`${evidence.traces.filter(result => result.status === "PASS").length}/${evidence.traces.length} real-app cases\n`);
if (evidence.traces.some(result => result.status === "FAIL")) process.exitCode = 1;
