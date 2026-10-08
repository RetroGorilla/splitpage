import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { documentServerHost } = require(path.join(here, "..", "bind-host.js"));
const { createPrompterShare } = require(path.join(here, "..", "prompter-share.js"));

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("a normal run listens on loopback only unless it is hosting", () => {
  assert.equal(documentServerHost({ hosting: false, testMode: false }), "127.0.0.1");
  assert.equal(documentServerHost({}), "127.0.0.1");
  assert.equal(documentServerHost(), "127.0.0.1");
});

test("a normal run that is hosting listens on every interface", () => {
  assert.equal(documentServerHost({ hosting: true, testMode: false }), "0.0.0.0");
  assert.equal(documentServerHost({ hosting: true }), "0.0.0.0");
});

test("a test run listens on loopback only, even when hosting", () => {
  assert.equal(documentServerHost({ hosting: true, testMode: true }), "127.0.0.1");
  assert.equal(documentServerHost({ hosting: false, testMode: true }), "127.0.0.1");
});

test("main.js picks the document server host through documentServerHost, with no address of its own", () => {
  const main = fs.readFileSync(path.join(here, "..", "main.js"), "utf8");
  assert.match(main, /documentServerHost\(\{ hosting: HOSTING, testMode: TEST_MODE \}\)/);
  assert.equal(main.includes('"0.0.0.0"'), false);
});

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list || []) if (addr.family === "IPv4" && !addr.internal) out.push(addr.address);
  }
  return out;
}

function connects(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.setTimeout(2000, () => { socket.destroy(); resolve(false); });
  });
}

test("the teleprompter share listens on loopback only", async () => {
  const share = createPrompterShare({ staticAllowlist: {}, preferredPort: 0 });
  try {
    const url = new URL(await share.publish("tab1", "script.md", "x"));
    const port = Number(url.port);
    assert.equal(await connects("127.0.0.1", port), true);
    for (const addr of lanAddresses()) assert.equal(await connects(addr, port), false, addr + " must not reach the share");
  } finally { share.closeAll(); }
});

let failed = 0;
for (const c of cases) {
  try { await c.fn(); console.log("ok   " + c.name); } catch (e) { failed++; console.log("FAIL " + c.name + "\n     " + (e && e.stack || e)); }
}
if (failed) { console.log(failed + " FAILED"); process.exit(1); }
console.log("ALL PASS (" + cases.length + ")");
