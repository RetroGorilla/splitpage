import "../../src/test/_dom.mjs";
import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInThisContext } from "node:vm";
import { build, type Plugin } from "esbuild";
import { REPO } from "../../tools/source-scan.mjs";
import { COMPOSITION_ROOT } from "./load-manifests.ts";
import { showStartupFailure } from "../../src/bootstrap/startup/failure-screen.ts";

interface Probe {
  readonly calls: string[];
  readonly throwAt: string | null;
  readonly error: Error;
}

const PANEL = "#startup-failure";
const REAL = "./startup/failure-screen.ts";
const holder = globalThis as unknown as { __bootProbe?: Probe };

function importedNames(source: string): Map<string, string[]> {
  const byModule = new Map<string, string[]>();
  for (const [, list = "", spec = ""] of source.matchAll(/^import \{([^}]+)\} from "([^"]+)";$/gm)) {
    const names = list.split(",").map((part) => part.trim()).filter((part) => part && !part.startsWith("type ")).map((part) => part.split(/\s+as\s+/)[0] ?? part);
    byModule.set(spec, names);
  }
  return byModule;
}

function stubSource(names: readonly string[]): string {
  const lines = [
    "function stub(name) {",
    "  return function () {",
    "    const probe = globalThis.__bootProbe;",
    "    probe.calls.push(name);",
    "    if (probe.throwAt === name) throw probe.error;",
    "    return {};",
    "  };",
    "}"
  ];
  for (const name of names) lines.push(`export const ${name} = stub(${JSON.stringify(name)});`);
  return lines.join("\n");
}

let bundled: Promise<string> | null = null;

function bundle(): Promise<string> {
  bundled ??= (async () => {
    const root = join(REPO, COMPOSITION_ROOT);
    const names = importedNames(readFileSync(root, "utf8"));
    assert.ok(names.has(REAL), "the composition root imports the failure screen");
    const stubs: Plugin = {
      name: "stub-composition-root-imports",
      setup(b) {
        b.onResolve({ filter: /.*/ }, (args) => (args.importer === root && args.path !== REAL ? { path: args.path, namespace: "boot-stub" } : undefined));
        b.onLoad({ filter: /.*/, namespace: "boot-stub" }, (args) => ({ contents: stubSource(names.get(args.path) ?? []), loader: "js" }));
      }
    };
    const result = await build({ entryPoints: [root], bundle: true, format: "iife", write: false, logLevel: "silent", plugins: [stubs] });
    return result.outputFiles[0]?.text ?? "";
  })();
  return bundled;
}

async function boot(throwAt: string | null, error = new TypeError("boom")): Promise<{ calls: string[]; logged: unknown[] }> {
  const probe: Probe = { calls: [], throwAt, error };
  holder.__bootProbe = probe;
  const logged = mock.method(console, "error", () => {});
  try {
    runInThisContext(await bundle());
  } finally {
    logged.mock.restore();
    delete holder.__bootProbe;
  }
  return { calls: probe.calls, logged: logged.mock.calls.map((call): unknown => call.arguments[0]) };
}

function panel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(PANEL);
}

function setVersion(content: string | null): void {
  document.head.querySelector('meta[name="splitpage-version"]')?.remove();
  if (content === null) return;
  const meta = document.createElement("meta");
  meta.name = "splitpage-version";
  meta.content = content;
  document.head.append(meta);
}

afterEach(() => {
  panel()?.remove();
  setVersion(null);
});

test("wiring that throws shows the panel, logs the error, and no mount runs", async () => {
  const error = new TypeError("wiring broke");
  const { calls, logged } = await boot("wireLegacyApp", error);
  assert.deepEqual(calls, ["wireLegacyApp"]);
  assert.deepEqual(logged, [error]);
  const shown = panel();
  assert.ok(shown, "the panel is in the page");
  assert.equal(shown.parentElement, document.body);
  assert.equal(shown.getAttribute("role"), "alert");
  assert.equal(shown.querySelector("h1")?.textContent, "Splitpage couldn't start");
  assert.equal(shown.querySelector("p")?.textContent, "Your document data on disk has not been touched.");
  assert.equal(shown.querySelector("pre > code")?.textContent, "TypeError: wiring broke");
  assert.deepEqual([...shown.querySelectorAll("button")].map((b) => b.textContent), ["Copy details", "Reload"]);
  assert.equal(shown.style.position, "fixed", "styled inline, so it shows without the app's CSS");
});

test("a mount that throws, early or late, shows the panel and stops the sequence there", async () => {
  for (const at of ["mountScreenStateOwner", "mountSettingsFeature", "startAppWhenReady"]) {
    const error = new RangeError(at + " broke");
    const { calls, logged } = await boot(at, error);
    assert.equal(calls.at(-1), at, at);
    assert.equal(calls.filter((c) => c === at).length, 1, at);
    if (at !== "startAppWhenReady") assert.ok(!calls.includes("startAppWhenReady"), at);
    assert.deepEqual(logged, [error], at);
    assert.equal(panel()?.querySelector("pre > code")?.textContent, "RangeError: " + at + " broke", at);
    panel()?.remove();
  }
});

test("the success path runs every call, logs nothing and leaves no panel", async () => {
  const { calls, logged } = await boot(null);
  assert.equal(calls[0], "wireLegacyApp");
  assert.equal(calls.at(-1), "startAppWhenReady");
  assert.equal(calls.length, new Set(calls).size, "every call runs once");
  assert.ok(calls.includes("mountSettingsFeature"));
  assert.deepEqual(logged, []);
  assert.equal(panel(), null);
});

test("Copy details copies the message, the stack and the app version", async () => {
  setVersion("4.1.0");
  const copied: string[] = [];
  Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: (text: string) => { copied.push(text); return Promise.resolve(); } } });
  try {
    const error = new Error("no owner");
    showStartupFailure(error);
    const copy = panel()?.querySelectorAll("button")[0];
    copy?.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(copied.length, 1);
    const [text = ""] = copied;
    assert.ok(text.startsWith("Error: no owner\n"), text);
    assert.ok(text.includes(String(error.stack)), "the stack is included");
    assert.ok(text.endsWith("Splitpage version: 4.1.0"), text);
    assert.equal(copy?.textContent, "Copied");
  } finally {
    Reflect.deleteProperty(window.navigator, "clipboard");
  }
});

test("when the clipboard refuses, the details are shown and selected instead; an unbuilt version placeholder reads as unknown", async () => {
  setVersion("{{VERSION}}");
  Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("denied")) } });
  try {
    showStartupFailure("plain text failure");
    const copy = panel()?.querySelectorAll("button")[0];
    copy?.click();
    await new Promise((resolve) => setImmediate(resolve));
    const code = panel()?.querySelector("pre > code");
    assert.equal(code?.textContent, "Error: plain text failure\n\nSplitpage version: unknown");
    assert.equal(document.getSelection()?.toString(), code?.textContent);
    assert.equal(copy?.textContent, "Selected: copy it with the keyboard");
  } finally {
    Reflect.deleteProperty(window.navigator, "clipboard");
  }
});

test("a second failure keeps the first panel", () => {
  showStartupFailure(new Error("first"));
  showStartupFailure(new Error("second"));
  assert.equal(document.querySelectorAll(PANEL).length, 1);
  assert.equal(panel()?.querySelector("pre > code")?.textContent, "Error: first");
});
