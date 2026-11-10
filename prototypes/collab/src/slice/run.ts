import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { bufferOracles, bufferTraceOrder } from "../../test/buffer-oracles.ts";
import { bufferMechanisms } from "../editing-buffer.ts";
import { withSliceBrowser } from "./protocol.ts";
import type { SliceProtocol } from "./protocol.ts";
import type { SliceEvent } from "./dom.ts";
import type { CollabIdentity, CollabModel } from "../model.ts";
import { serializeSliceEvidence, writeSliceArtifacts } from "./report.ts";

export interface SliceSnapshot {
  events: SliceEvent[];
  errors: string[];
  commits: string[];
  text: string;
  html: string;
  rootHtml: string;
  selection: [number, number] | null;
  history: string[];
  dirty: boolean;
  composing: boolean;
  models: Record<string, CollabModel>;
  bindings: Record<string, CollabIdentity>;
}

export interface SliceEvidence {
  version: Record<string, unknown>;
  inputs: { name: string; snapshot: SliceSnapshot }[];
  traces: { trace: string; mechanism: string; order: string; status: "PASS" | "FAIL"; difference: string | null; forward: SliceSnapshot | null; snapshot: SliceSnapshot }[];
  probes: { name: string; stages: SliceSnapshot[] }[];
}

async function select(protocol: SliceProtocol, from: number, to = from): Promise<void> {
  await protocol.key("Home", 2);
  for (let offset = 0; offset < from; offset++) await protocol.key("ArrowRight");
  for (let offset = from; offset < to; offset++) await protocol.key("ArrowRight", 8);
}

async function snapshot(protocol: SliceProtocol): Promise<SliceSnapshot> { return protocol.evaluate("slice.snapshot()"); }

export async function runSlice(): Promise<SliceEvidence> {
  const folder = fileURLToPath(new URL("../../", import.meta.url));
  const bundle = await build({ entryPoints: [join(folder, "src/slice/page.ts")], bundle: true, write: false, platform: "browser", format: "iife", target: "es2023" });
  const script = bundle.outputFiles?.[0]?.text;
  if (!script) throw new Error("Missing slice bundle");
  return withSliceBrowser(async (protocol, version, directory) => {
    const page = join(directory, "slice.html");
    const template = await readFile(join(folder, "slice.html"), "utf8");
    await writeFile(page, template.replace("SLICE_BUNDLE", () => script.replaceAll("</script", "<\\/script")));
    await protocol.call("Page.enable");
    await protocol.call("Page.navigate", { url: pathToFileURL(page).href });
    await protocol.evaluate("new Promise(resolve => { if (window.slice) resolve(true); else window.addEventListener('load', () => resolve(true), {once:true}); })");
    const evidence: SliceEvidence = { version, inputs: [], traces: [], probes: [] };
    const observe = async (name: string, from: number, to: number, action: () => Promise<void>): Promise<void> => {
      await protocol.evaluate("slice.reset('observe')");
      await select(protocol, from, to);
      await protocol.evaluate("slice.clear()");
      await action();
      evidence.inputs.push({ name, snapshot: await snapshot(protocol) });
    };
    await observe("typing one character", 7, 7, () => protocol.insert("a"));
    await observe("Backspace collapsed", 7, 7, () => protocol.key("Backspace"));
    await observe("Delete collapsed", 4, 4, () => protocol.key("Delete"));
    await observe("Backspace selection", 4, 7, () => protocol.key("Backspace"));
    await observe("typing over selection", 4, 7, () => protocol.insert("a"));
    await protocol.evaluate("document.querySelector('#clipboard').focus()");
    await protocol.key("a", 2);
    await protocol.insert("Q");
    await protocol.key("a", 2);
    await protocol.key("c", 2);
    await observe("paste over selection", 4, 7, () => protocol.key("v", 2));
    await observe("cut", 4, 7, () => protocol.key("x", 2));
    await observe("Ctrl+Backspace", 7, 7, () => protocol.key("Backspace", 2));
    await observe("Enter", 4, 4, () => protocol.key("Enter"));
    await observe("native undo Ctrl+Z", 7, 7, async () => { await protocol.insert("a"); await protocol.evaluate("slice.clear()"); await protocol.key("z", 2); });
    await observe("composition at caret", 4, 4, async () => { await protocol.compose("x"); await protocol.compose("xy"); await protocol.insert("xy"); });
    await observe("composition over selection", 4, 7, async () => { await protocol.compose("x"); await protocol.compose("xy"); await protocol.insert("xy"); });
    for (const trace of bufferTraceOrder) {
      for (const mechanism of bufferMechanisms) {
        for (const order of bufferOracles[trace].orders) {
          let difference: string | null = null;
          let forward: SliceSnapshot | null = null;
          try {
            await protocol.evaluate(`slice.reset(${JSON.stringify(trace)},${JSON.stringify(mechanism)},true)`);
            const fixture = bufferOracles[trace];
            await select(protocol, fixture.from, fixture.to);
            await protocol.evaluate("slice.clear()");
            if (trace === "T02") await protocol.evaluate(`slice.remote(${JSON.stringify(order)})`);
            if (trace === "T04" || trace === "T04 removed") await protocol.compose("x");
            else if (trace === "T01 composition") await protocol.compose("β");
            else if (trace === "T01") await protocol.key("Backspace");
            else if (trace === "T03") { for (let count = 0; count < 4; count++) await protocol.key("Backspace"); }
            else await protocol.insert(trace === "T02" ? "c" : trace === "T02 boundary" ? "Z" : "a");
            if (trace !== "T02") await protocol.evaluate(`slice.remote(${JSON.stringify(order)})`);
            if (trace === "T04" || trace === "T04 removed") { await protocol.compose("xy"); await protocol.insert("xy"); }
            else if (trace === "T01 composition") await protocol.insert("β");
            const before = await snapshot(protocol);
            if (before.errors.length) throw new Error(before.errors.join("; "));
            await protocol.evaluate(`slice.finish(${JSON.stringify(order)})`);
            forward = await snapshot(protocol);
            await protocol.key("z", 2);
            await protocol.evaluate(`slice.checkUndo(${JSON.stringify(order)})`);
            const after = await snapshot(protocol);
            if (after.errors.length) throw new Error(after.errors.join("; "));
          } catch (error) { difference = error instanceof Error ? error.message : String(error); }
          evidence.traces.push({ trace, mechanism, order, status: difference ? "FAIL" : "PASS", difference, forward, snapshot: await snapshot(protocol) });
        }
      }
      process.stdout.write(`${trace}: ${evidence.traces.filter(result => result.trace === trace && result.status === "PASS").length}/${evidence.traces.filter(result => result.trace === trace).length}\n`);
    }
    for (const mode of ["whole", "text"] as const) {
      for (const composing of [false, true]) {
        await protocol.evaluate("slice.reset('observe')");
        await select(protocol, 4);
        await protocol.evaluate("slice.clear()");
        if (composing) await protocol.compose("x");
        const stages = [await snapshot(protocol)];
        await protocol.evaluate(`slice.repaint(${JSON.stringify(mode)}, false)`);
        stages.push(await snapshot(protocol));
        if (composing) { await protocol.compose("xy"); await protocol.insert("xy"); stages.push(await snapshot(protocol)); }
        evidence.probes.push({ name: `${mode} repaint ${composing ? "during composition" : "selection"}`, stages });
      }
    }
    await protocol.evaluate("slice.reset('observe')");
    await select(protocol, 4, 7);
    const stages = [await snapshot(protocol)];
    await protocol.evaluate("slice.repaint('whole', true)");
    stages.push(await snapshot(protocol));
    evidence.probes.push({ name: "whole repaint explicit selection restoration", stages });
    await protocol.evaluate("slice.reset('T03 replace','M2',false)");
    await select(protocol, 4, 7);
    await protocol.insert("a");
    evidence.probes.push({ name: "synchronous input commit", stages: [await snapshot(protocol)] });
    await protocol.evaluate("slice.reset('T03','M2',false)");
    await select(protocol, 7);
    const cleanStages = [await snapshot(protocol)];
    await protocol.evaluate("slice.remote('D3')");
    cleanStages.push(await snapshot(protocol));
    evidence.probes.push({ name: "M2 clean remote repaint", stages: cleanStages });
    await protocol.evaluate("document.querySelector('#clipboard').focus()");
    await protocol.key("a", 2);
    await protocol.insert("Q");
    await protocol.key("a", 2);
    await protocol.key("c", 2);
    for (const [name, key, from, to, modifiers] of [
      ["Backspace", "Backspace", 7, 7, 0], ["Delete", "Delete", 4, 4, 0],
      ["selection Backspace", "Backspace", 4, 7, 0], ["Ctrl+Backspace", "Backspace", 7, 7, 2],
      ["paste", "v", 4, 7, 2], ["cut", "x", 4, 7, 2]
    ] as const) {
      await protocol.evaluate("slice.reset('T03 replace','M2',false)");
      await select(protocol, from, to);
      await protocol.evaluate("slice.clear(); slice.lag(); slice.remote('D3')");
      await protocol.key(key, modifiers);
      evidence.probes.push({ name: `stale cancellation ${name}`, stages: [await snapshot(protocol)] });
    }
    for (const mode of ["whole", "text"] as const) {
      await protocol.evaluate("slice.reset('observe')");
      await select(protocol, 4);
      await protocol.evaluate("slice.clear()");
      await protocol.compose("x");
      const stages = [await snapshot(protocol)];
      await protocol.evaluate(`slice.repaint(${JSON.stringify(mode)}, true)`);
      stages.push(await snapshot(protocol));
      await protocol.compose("xy");
      await protocol.insert("xy");
      stages.push(await snapshot(protocol));
      evidence.probes.push({ name: `${mode} repaint during composition with selection restoration`, stages });
    }
    for (const mechanism of bufferMechanisms) {
      await protocol.evaluate(`slice.reset('T03 replace',${JSON.stringify(mechanism)},false)`);
      await select(protocol, 4, 7);
      await protocol.evaluate("slice.clear()");
      await protocol.insert("the");
      evidence.probes.push({ name: `T03 replace identical text ${mechanism}`, stages: [await snapshot(protocol)] });
    }
    await protocol.evaluate("slice.reset('observe'); slice.tryCancelComposition()");
    await select(protocol, 4);
    await protocol.evaluate("slice.clear()");
    await protocol.compose("x");
    await protocol.insert("x");
    evidence.probes.push({ name: "composition beforeinput cancellation attempt", stages: [await snapshot(protocol)] });
    return evidence;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const evidence = await runSlice();
  await writeFile(new URL("../../slice-evidence.json", import.meta.url), serializeSliceEvidence(evidence));
  writeSliceArtifacts(evidence);
  process.stdout.write(`Edge ${String(evidence.version.product)}: ${evidence.traces.filter(result => result.status === "PASS").length}/${evidence.traces.length} trace cases\n`);
  if (evidence.traces.some(result => result.status === "FAIL")) process.exitCode = 1;
}
