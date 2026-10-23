import "../../src/test/_dom.mjs";
import "../../src/test/_preferences-started.mjs";
import "../../src/test/_location-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry } from "../../src/application/actions.ts";
import { startActions } from "../../src/bootstrap/actions.ts";
import { wireRegistries } from "../../src/test/_registries.mjs";

test("bootstrap preserves the complete action registration order when export definitions move", () => {
  const wired = wireRegistries();
  const registry = createActionRegistry();
  const stop = startActions(registry, new EventTarget());
  try {
    assert.deepEqual(registry.list().map((action) => action.id), [
      "toggle-hide-shot", "toggle-rundown-min", "history", "find",
      "save", "save-as", "open", "export", "command-menu", "close-file-menu",
      "panel-production", "panel-gear", "panel-broll", "panel-comments", "write", "present",
      "servers", "show-servers-dialog", "settings", "help", "tour", "long-demo", "setup", "about",
      "tagging-help", "export-app-data", "import-app-data",
      "save-back", "autosave", "new", "server-open", "paste", "gdoc-import", "show-gdoc-import", "drive-open",
      "collaborate", "ask-guest-name", "server-publish", "export-again", "set-target",
      "prompter-open-in-browser", "prompter-open-in-chromium",
      "script-zoom-in", "script-zoom-out", "script-zoom-reset",
      "go-to-scene", "annotate-picture", "open-picture-link", "comment-on-selection", "tag-selection", "reveal-row"
    ]);
  } finally {
    stop();
    wired.dispose();
  }
  assert.deepEqual(registry.list(), []);
});
