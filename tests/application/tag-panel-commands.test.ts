import test from "node:test";
import assert from "node:assert/strict";
import {
  addPersonForTag,
  installTagPanelCommands,
  renderProduction,
  saveTagRename,
  setTagNotes,
  setTagOwner
} from "../../src/application/tag-panel-commands.ts";
import type { TagPanelCommands } from "../../src/application/tag-panel-commands.ts";

function recording(log: string[], name = ""): TagPanelCommands {
  return {
    renderProduction: () => { log.push(name + "render"); },
    saveTagRename: (key, value) => { log.push(name + "rename:" + key + ":" + value); },
    addPersonForTag: (key, value) => { log.push(name + "person:" + key + ":" + value); },
    setTagOwner: (key, personId) => { log.push(name + "owner:" + key + ":" + personId); },
    setTagNotes: (key, text) => { log.push(name + "notes:" + key + ":" + text); }
  };
}

test("every command throws while nothing is installed", () => {
  assert.throws(() => renderProduction(), /not installed yet/);
  assert.throws(() => saveTagRename("k", "name"), /not installed yet/);
  assert.throws(() => addPersonForTag("k", "name"), /not installed yet/);
  assert.throws(() => setTagOwner("k", "p"), /not installed yet/);
  assert.throws(() => setTagNotes("k", "t"), /not installed yet/);
});

test("each command reaches the installed command with its arguments", () => {
  const log: string[] = [];
  const stop = installTagPanelCommands(recording(log));
  try {
    renderProduction();
    saveTagRename("prop:mug", "cup");
    addPersonForTag("prop:mug", "Alice");
    setTagOwner("prop:mug", "p1");
    setTagNotes("prop:mug", "chipped");
    assert.deepEqual(log, ["render", "rename:prop:mug:cup", "person:prop:mug:Alice", "owner:prop:mug:p1", "notes:prop:mug:chipped"]);
  } finally {
    stop();
  }
});

test("stopping the install makes the commands throw again", () => {
  const stop = installTagPanelCommands(recording([]));
  stop();
  assert.throws(() => renderProduction(), /not installed yet/);
});

test("installing again replaces the commands, and the old stop leaves the new ones in place", () => {
  const log: string[] = [];
  const stopFirst = installTagPanelCommands(recording(log, "first:"));
  const stopSecond = installTagPanelCommands(recording(log, "second:"));
  try {
    renderProduction();
    stopFirst();
    renderProduction();
    assert.deepEqual(log, ["second:render", "second:render"]);
  } finally {
    stopSecond();
  }
  assert.throws(() => renderProduction(), /not installed yet/);
});

test("a command that throws passes its error through", () => {
  const stop = installTagPanelCommands({ ...recording([]), renderProduction: () => { throw new Error("boom"); } });
  try {
    assert.throws(() => renderProduction(), /boom/);
  } finally {
    stop();
  }
});
