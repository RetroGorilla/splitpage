import { build } from "esbuild";
import { readFile, writeFile, mkdir, mkdtemp, symlink, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpus, hostname, tmpdir, platform, release } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { withSliceBrowser } from "../slice/protocol.ts";
import { bindingFollowupCases } from "./cases.ts";
import type { BindingFollowupCase } from "./cases.ts";
import { bufferMechanisms } from "../editing-buffer.ts";
import type { BindingFollowupFacts, BindingFollowupObservation } from "./checker.ts";
import type { DeliveryOrder } from "../delivery.ts";
import { writeBindingFollowupArtifacts } from "./report.ts";

export interface BindingFollowupStage extends BindingFollowupObservation {
  facts: BindingFollowupFacts;
  timings: { phase: string; ms: number }[];
  reentry: Record<string, unknown>[];
  peak: { bytes: number; messages: number; transportMessages: number };
  history: string[];
  events: Record<string, unknown>[];
  app: unknown;
  heldBytes: number;
  heldMessages: number;
  native: string;
  commits: string[];
  queuePending: number;
  rawLocalMarks: { name: string; marks: Record<string, unknown> }[];
}

export interface BindingFollowupResult {
  name: BindingFollowupCase;
  mechanism: string;
  order: DeliveryOrder;
  retained: boolean;
  paintGate: boolean;
  status: "PASS" | "FAIL";
  failures: string[];
  literal: string | null;
  literalUndo: string | null;
  stages: BindingFollowupStage[];
}

export interface BindingFollowupEvidence {
  appCommit: string;
  bundleSha256: string;
  machine: { host: string; cpu: string; platform: string; release: string; node: string };
  version: Record<string, unknown>;
  off: unknown;
  results: BindingFollowupResult[];
}

const folder = fileURLToPath(new URL("../../", import.meta.url));
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const { appCommit } = JSON.parse(await readFile(join(folder, "app-binding-2/manifest.json"), "utf8")) as { appCommit: string };
if (!/^[a-f0-9]{40}$/.test(appCommit)) throw new Error("Invalid pinned app commit");
const output = await build({ absWorkingDir: repo, entryPoints: [join(folder, "src/app-binding-2/page.ts")], bundle: true, write: false, platform: "browser", format: "iife", target: "es2023" });
const script = output.outputFiles?.[0]?.text;
if (!script) throw new Error("Missing follow-up bundle");
const archiveDirectory = await mkdtemp(join(tmpdir(), "binding-followup-build-"));
try {
  const archive = join(archiveDirectory, "app.tar"); const source = join(archiveDirectory, "source");
  await mkdir(source);
  await writeFile(archive, execFileSync("git", ["archive", "--format=tar", appCommit], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }));
  execFileSync("tar", ["-xf", archive, "-C", source], { windowsHide: true });
  await symlink(join(repo, "node_modules"), join(source, "node_modules"), "junction");
  execFileSync(process.execPath, [join(source, "build.mjs"), "--test"], { cwd: source, windowsHide: true });
  const html = (await readFile(join(source, "index.html"), "utf8")).replace(/<link[^>]*href="https:\/\/fonts[^>]*>/g, "");
  const evidence = await withSliceBrowser(async (protocol, version, temporary): Promise<BindingFollowupEvidence> => {
    const app = join(temporary, "followup.html");
    const state = html.match(/(<script id="state-data" type="application\/json">)([\s\S]*?)(<\/script>)/);
    if (!state?.[2]) throw new Error("No embedded app document");
    await writeFile(app, html.replace(state[0], `${state[1]}${JSON.stringify({ ...JSON.parse(state[2]) as Record<string, unknown>, docId: "d" + randomUUID().replaceAll("-", "") })}${state[3]}`));
    await protocol.call("Page.enable");
    await protocol.call("Page.addScriptToEvaluateOnNewDocument", { source: "window.__splitpageNoNewTab=true;window.__splitpageNoOnboarding=true" });
    const navigate = async (binding: boolean): Promise<void> => {
      await protocol.call("Page.navigate", { url: pathToFileURL(app).href + (binding ? "?app-binding=1" : "") });
      await protocol.evaluate("new Promise((resolve,reject)=>{const deadline=Date.now()+10000;const check=()=>{if(window.__writerFlowTest&&document.querySelector('#rows .row'))resolve(true);else if(Date.now()>deadline)reject(new Error('App did not start'));else setTimeout(check,20)};check()})");
    };
    await navigate(false);
    const off = await protocol.evaluate("({rows:document.querySelectorAll('#rows .row').length,experiment:__writerFlowTest.experiment})");
    await navigate(true);
    await protocol.evaluate(script);
    await protocol.evaluate("appBindingFollowup.reset('reentry-paste','M1');{const field=document.createElement('textarea');field.id='binding-followup-clipboard';document.querySelector('#writer').append(field);field.focus()}");
    await protocol.insert("Q"); await protocol.key("a", 2); await protocol.key("c", 2);
    const results: BindingFollowupResult[] = [];
    const names = process.env.APP_BINDING_FOLLOWUP_CASE ? bindingFollowupCases.filter(name => name === process.env.APP_BINDING_FOLLOWUP_CASE) : bindingFollowupCases;
    const mechanisms = process.env.APP_BINDING_MECHANISM ? bufferMechanisms.filter(mechanism => mechanism === process.env.APP_BINDING_MECHANISM) : bufferMechanisms;
    for (const name of names) {
      const orders: DeliveryOrder[] = name.startsWith("reentry-") ? ["D3"] : name === "removed" ? ["D3", "late-C"] : ["D3", "dup", "late-C"];
      for (const mechanism of mechanisms) for (const order of orders) for (const mode of name.startsWith("reentry-") ? ["baseline", "retained", "paint-gate"] : ["baseline"]) {
        const retained = mode !== "baseline"; const paintGate = mode === "paint-gate";
        const stages: BindingFollowupStage[] = [];
        const failures: string[] = [];
        let literal: string | null = null; let literalUndo: string | null = null;
        const snap = (): Promise<BindingFollowupStage> => protocol.evaluate("appBindingFollowup.snapshot()");
        try {
          await protocol.evaluate(`appBindingFollowup.reset(${JSON.stringify(name)},${JSON.stringify(mechanism)},${JSON.stringify(order)},${retained},${paintGate})`);
          stages.push(await snap());
          if (name.startsWith("reentry-")) {
            if (name === "reentry-paste") await protocol.key("v", 2);
            else await protocol.insert("Q");
          } else {
            await protocol.compose("x"); stages.push(await snap());
            await protocol.evaluate("appBindingFollowup.remote()"); stages.push(await snap());
            await protocol.compose("xy"); await protocol.insert("xy");
          }
          stages.push(await snap());
          const result = await protocol.evaluate<{ failures: string[]; literal: string | null }>("appBindingFollowup.finish()");
          failures.push(...result.failures); literal = result.literal;
          stages.push(await snap());
          if (name === "removed" && failures.length === 0) {
            await protocol.key("z", 2);
            await protocol.evaluate("appBindingFollowup.removedUndo()"); literalUndo = "PASS";
          }
        } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); try { stages.push(await snap()); } catch {} }
        results.push({ name, mechanism, order, retained, paintGate, status: failures.length ? "FAIL" : "PASS", failures, literal, literalUndo, stages });
      }
      process.stdout.write(`${name}: ${results.filter(result => result.name === name && result.status === "PASS").length}/${results.filter(result => result.name === name).length}\n`);
    }
    return { appCommit, bundleSha256: createHash("sha256").update(script).digest("hex"), machine: { host: hostname(), cpu: cpus()[0]?.model ?? "unknown", platform: platform(), release: release(), node: process.version }, version, off, results };
  });
  writeBindingFollowupArtifacts(evidence);
  process.stdout.write(`${evidence.results.length} follow-up cases recorded; ${evidence.results.filter(result => result.status === "FAIL").length} invariant/binding failures retained\n`);
} finally { await rm(archiveDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
