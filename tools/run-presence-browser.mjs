import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { Server } from "@hocuspocus/server";
import { openNativeSession } from "../src/adapters/collab/native/session.ts";
import { cells } from "../tests/adapters/collab/native/helpers.ts";
import { structureScript } from "../tests/adapters/collab/native/structure-harness.ts";
import { PROBE } from "./perf-record.mjs";
import { REPO } from "./source-scan.mjs";

const driver = ".claude/skills/run-splitpage-app/driver.mjs";
const testFile = ".claude/skills/run-splitpage-app/presence.txt";
const at = "2026-11-24T00:00:00.000Z";
const session = openNativeSession({
  kind: "document",
  document: structureScript({ r1: "First beat", r2: "Second beat" }, { r1: "First visual", r2: "Second visual" }),
  conversion: { cells, creation: "seed", at, by: "Editor" }
}, { actor: "Editor", sanitize: value => String(value ?? "") });
const seed = session.encodeState();
session.close();

const server = new Server({
  address: "127.0.0.1", port: 0, quiet: true, stopOnSignals: false,
  async onAuthenticate({ token }) {
    if (token !== "presence-test") throw new Error("Invalid presence test token");
  }
});
await server.listen();

const setup = [
  "open",
  "wait window.__sharedTest && document.querySelector('#rows .row')",
  "expect !document.querySelector('#shared-pill')",
  "eval localStorage.setItem('splitpage-comment-author','First Editor');window.frame=document.createElement('iframe');frame.src='/?presence-peer=1';frame.style.cssText='position:fixed;right:0;bottom:0;width:640px;height:480px;z-index:100';document.body.append(frame);true",
  "wait frame.contentWindow.__sharedTest && frame.contentDocument.querySelector('#rows .row')",
  "eval window.P=frame.contentWindow;window.enter=(win,deployment)=>win.__sharedTest.enterRetained({deployment,script:'presence',relayUrl:" +
    JSON.stringify(`ws://127.0.0.1:${server.address.port}`) +
    ",invitation:{token:'presence-test',state:Uint8Array.from(" + JSON.stringify(Array.from(seed)) + ")}});enter(window,'local').then(result=>result.ok)",
  "wait document.querySelector('[data-connection]')?.textContent === 'Connected'",
  "eval localStorage.setItem('splitpage-comment-author','Peer Editor');enter(P,'peer').then(result=>result.ok)",
  "wait P.document.querySelector('[data-connection]')?.textContent === 'Connected'",
  "eval window.Q=(win,id,field)=>win.document.querySelector('#rows .cell-editable[data-id=\"'+id+'\"][data-field=\"'+field+'\"]');true",
];

function benchmark() {
  const typed = "presenceoverarealrelaypresenceoverarealrelay";
  const keys = [...typed].flatMap(letter => ["press " + letter, "sleep 65"]);
  const lines = [
    "eval " + PROBE.replace(/\n\s*/g, " "),
    "eval Q(P,'r2','visualText').focus();true",
    "caret #rows .audio-cell .cell-editable[data-id=r1]",
    "key End",
    "eval window.__perf.reset()",
    ...keys,
    "wait Q(P,'r1','audioText').textContent.includes('" + typed + "')",
    "eval window.__perf.take('shared Split typing')",
    "click #btn-write",
    "wait window.__writerFlowTest.on()",
    "eval window.w=document.querySelector('#writer-doc');w.focus();const beat=w.querySelector('.wr-beat[data-id=r2]');getSelection().collapse(beat,beat.childNodes.length);true",
    "eval window.__perf.reset()",
    ...keys,
    "wait Q(P,'r2','audioText').textContent.includes('" + typed + "')",
    "eval window.__perf.take('shared Writer typing')",
    "eval document.querySelector('#wr-close').click();true",
    "eval P.__sharedTest.leave().then(result=>result.ok)",
    "eval __sharedTest.leave().then(result=>result.ok)"
  ];
  return lines;
}

const ignored = join(REPO, "node_modules", ".presence-check");
mkdirSync(ignored, { recursive: true });
const work = mkdtempSync(join(ignored, "run-"));
try {
  const suite = join(work, "presence.txt");
  const checks = process.argv.includes("--perf") ? benchmark() : [readFileSync(join(REPO, testFile), "utf8")];
  writeFileSync(suite, [...setup, ...checks].join("\n") + "\n");
  const base = Number(process.env.PERF_PORT_BASE ?? "17090");
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    driver, "--script", suite, "--port", String(base), "--cdp-port", String(base + 1000), "--shot-dir", work
  ], { cwd: REPO, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
} catch (error) {
  console.error(error.stdout ?? "", error.stderr ?? "", error.message);
  process.exitCode = 1;
} finally {
  await server.destroy();
  rmSync(work, { recursive: true, force: true });
}
