import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { withSliceBrowser } from "../slice/protocol.ts";
import { perfFixtures } from "./fixtures.ts";
import { beforeMeasurement, cpuBusy, perfMachine } from "./conditions.ts";

const input = perfFixtures().find(input => input.name === "large");
if (!input) throw new Error("Missing large browser fixture");
const beforeLaunch = await beforeMeasurement();
if (beforeLaunch.freeMemoryBytes < 3 * 1024 ** 3 || beforeLaunch.cpuBefore > 35 || beforeLaunch.forbiddenProcesses.length) throw new Error("Browser measurement starting conditions invalid");
const bundle = await build({ stdin: { contents: 'import {fromDocument} from "./src/proj/document.ts"; import {measureEdits} from "./src/perf/measure.ts"; window.measurePerf = (document,candidate) => { const r=fromDocument(document,candidate); try { return measureEdits(r); } finally { r.destroy(); } };', resolveDir: fileURLToPath(new URL("../../", import.meta.url)) }, bundle: true, platform: "browser", format: "iife", target: "es2023", write: false });
const script = bundle.outputFiles?.[0]?.text;
if (!script) throw new Error("Missing browser performance bundle");
const evidence = await withSliceBrowser(async (protocol, version, directory) => {
  const page = join(directory, "perf.html");
  await writeFile(page, `<!doctype html><title>Projection CPU measurement</title><script>${script.replaceAll("</script", "<\\/script")}</script>`);
  await protocol.call("Page.enable");
  await protocol.call("Page.navigate", { url: pathToFileURL(page).href });
  await protocol.evaluate("new Promise(resolve => {if(window.measurePerf)resolve(true);else window.addEventListener('load',()=>resolve(true),{once:true});})");
  await protocol.evaluate(`window.perfInput=${JSON.stringify(input.document)}`);
  const runs = [];
  for (let round = 0; round < 5; round++) for (const candidate of round % 2 ? ["B", "A"] : ["A", "B"]) {
    const condition = await beforeMeasurement(true);
    if (condition.freeMemoryBytes < 3 * 1024 ** 3 || condition.cpuBefore > 35 || condition.forbiddenProcesses.length) throw new Error("Invalid browser run conditions");
    const edits = await protocol.evaluate(`measurePerf(perfInput,${JSON.stringify(candidate)})`);
    const cpuAfter = await cpuBusy();
    if (cpuAfter > 35) throw new Error("Browser CPU after run exceeds 35%; rerun the complete set");
    runs.push({ round, candidate, condition, cpuAfter, edits });
  }
  return { machine: perfMachine(), version, beforeLaunch, fixture: { ...input, document: undefined }, warmup: 3, samples: 11, runs };
});
await writeFile(new URL("browser-results.json", import.meta.url), JSON.stringify(evidence, null, 2) + "\n");
process.stdout.write("Five paired Edge runs complete; browser closed.\n");
