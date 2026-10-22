import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const target = process.argv[2];
const repo = new URL("../../", import.meta.url);
register("./_load-order-hooks.mjs", { parentURL: import.meta.url, data: { target: pathToFileURL(join(fileURLToPath(repo), target)).href } });
const calls = [];

function callerOf(stack, spiedFile) {
  for (const line of String(stack).split("\n").slice(1)) {
    const found = /\/((?:src|tests)\/[\w./-]+\.(?:js|mjs|ts)):\d+:\d+/.exec(line);
    if (!found || found[1] === spiedFile || found[1].startsWith("src/test/_load-order-")) continue;
    return found[1];
  }
  return "(unknown)";
}

globalThis.__loadOrderCall = (file, name, stack) => {
  calls.push({ file, name, from: callerOf(stack, file) });
};

await import("./_dom.mjs");
let error = null;
try {
  await import("./_load-order-target.mjs");
} catch (failure) {
  error = String((failure && failure.stack) || failure);
}

function started(read) {
  try {
    read();
    return true;
  } catch (failure) {
    if (/not started yet/.test(String(failure && failure.message))) return false;
    return "threw: " + String(failure && failure.message);
  }
}

const session = await import("../legacy/session-bridge.ts");
const saves = await import("../legacy/save-bridge.ts");
const recovery = await import("../legacy/recovery-bridge.ts");
const transitions = await import("../legacy/transition-bridge.ts");
const editor = await import("../legacy/editor-bridge.ts");
const preferences = await import("../legacy/preferences-bridge.ts");
const effects = await import("../legacy/effects-bridge.ts");
const actions = await import("../legacy/app-actions.ts");
const exports = await import("../legacy/export-formats.ts");
const owners = {
  session: session.sessionStarted(),
  saves: saves.savesStarted(),
  recovery: recovery.recoveryStarted(),
  editor: editor.editorStarted(),
  preferences: preferences.preferencesStarted(),
  effects: effects.effectsStarted(),
  transitions: started(() => transitions.documentTransitions()),
  actions: started(() => actions.appActions.list()),
  exports: started(() => exports.exportFormats.cards())
};
process.stdout.write(JSON.stringify({ target, calls, error, owners }) + "\n");
process.exit(0);
