import { test } from "node:test";
import assert from "node:assert/strict";
import { WRITER_SIZE_MAX, WRITER_SIZE_MIN, createPreferences } from "../../../src/application/preferences/preferences.ts";
import type { AppDataPref, PreferenceChange } from "../../../src/application/preferences/preferences.ts";
import type { KeyValueStorage } from "../../../src/application/recovery/conflict-stash.ts";

function memoryStorage(): KeyValueStorage & { readonly items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items: items,
    getItem: function (key: string): string | null { return items.has(key) ? items.get(key) as string : null; },
    setItem: function (key: string, value: string): void { items.set(key, value); },
    removeItem: function (key: string): void { items.delete(key); }
  };
}

function setup() {
  const storage = memoryStorage();
  const announced: PreferenceChange[] = [];
  const prefs = createPreferences({ storage: () => storage, announce: (change) => { announced.push(change); } });
  return { storage, announced, prefs };
}

test("the stored keys keep the 3.x names, and each key maps back to its preference", () => {
  const { prefs } = setup();
  assert.equal(prefs.nameOf("splitpage-autosave"), "autosave");
  assert.equal(prefs.nameOf("splitpage-comment-author"), "commentAuthor");
  assert.equal(prefs.nameOf("splitpage-hide-shot"), "hideShot");
  assert.equal(prefs.nameOf("splitpage-onboarding"), "onboarding");
  assert.equal(prefs.nameOf("splitpage-tagging-help-dismissed"), "taggingHelp");
  assert.equal(prefs.nameOf("splitpage-tour-done"), "tourDone");
  assert.equal(prefs.nameOf("splitpage-writer-size"), "writerSize");
  assert.equal(prefs.nameOf("splitpage-theme"), null);
});

test("autosave is on until it is switched off, and switching announces the change", () => {
  const { prefs, storage, announced } = setup();
  assert.equal(prefs.autosave(), true);
  prefs.setAutosave(false);
  assert.equal(storage.items.get("splitpage-autosave"), "0");
  assert.equal(prefs.autosave(), false);
  prefs.setAutosave(true);
  assert.equal(storage.items.get("splitpage-autosave"), "1");
  assert.deepEqual(announced, [
    { key: "splitpage-autosave", value: "0" },
    { key: "splitpage-autosave", value: "1" }
  ]);
});

test("the comment author reads as empty when none is stored; setting announces and remembering stays silent", () => {
  const { prefs, storage, announced } = setup();
  assert.equal(prefs.commentAuthor(), "");
  prefs.rememberCommentAuthor("Ann");
  assert.equal(prefs.commentAuthor(), "Ann");
  assert.deepEqual(announced, []);
  prefs.setCommentAuthor("Bo");
  assert.equal(storage.items.get("splitpage-comment-author"), "Bo");
  assert.deepEqual(announced, [{ key: "splitpage-comment-author", value: "Bo" }]);
});

test("hide-shot is off until set and announces each change", () => {
  const { prefs, announced } = setup();
  assert.equal(prefs.hideShot(), false);
  prefs.setHideShot(true);
  assert.equal(prefs.hideShot(), true);
  prefs.setHideShot(false);
  assert.equal(prefs.hideShot(), false);
  assert.deepEqual(announced.map((a) => a.value), ["1", "0"]);
});

test("the tagging help is shown with 0 and dismissed with 1 without announcing, and announcing it again passes the stored value on", () => {
  const { prefs, storage, announced } = setup();
  prefs.announceTaggingHelp();
  assert.deepEqual(announced, [{ key: "splitpage-tagging-help-dismissed", value: null }]);
  prefs.taggingHelpShown();
  assert.equal(storage.items.get("splitpage-tagging-help-dismissed"), "0");
  prefs.taggingHelpDismissed();
  assert.equal(storage.items.get("splitpage-tagging-help-dismissed"), "1");
  assert.equal(announced.length, 1);
  prefs.announceTaggingHelp();
  assert.deepEqual(announced[1], { key: "splitpage-tagging-help-dismissed", value: "1" });
});

test("the tour is marked done silently and resetting it removes the key and announces", () => {
  const { prefs, storage, announced } = setup();
  prefs.tourFinished();
  assert.equal(storage.items.get("splitpage-tour-done"), "1");
  assert.deepEqual(announced, []);
  prefs.resetTour();
  assert.equal(storage.items.has("splitpage-tour-done"), false);
  assert.deepEqual(announced, [{ key: "splitpage-tour-done", value: null }]);
});

test("the onboarding record is stored as JSON, reads back only as an object, and the prompter's skip never overwrites one", () => {
  const { prefs, storage } = setup();
  assert.equal(prefs.onboarding(), null);
  prefs.skipOnboardingForPrompter();
  assert.deepEqual(prefs.onboarding(), { v: 1, done: true, skipped: true, at: "prompter-launch" });
  prefs.recordOnboarding(false, "2026-10-22T00:00:00.000Z");
  assert.deepEqual(prefs.onboarding(), { v: 1, done: true, skipped: false, at: "2026-10-22T00:00:00.000Z" });
  prefs.skipOnboardingForPrompter();
  assert.equal(prefs.onboarding()?.["skipped"], false);
  storage.items.set("splitpage-onboarding", "42");
  assert.equal(prefs.onboarding(), null);
  storage.items.set("splitpage-onboarding", "{broken");
  assert.equal(prefs.onboarding(), null);
});

test("the writer size reads as none when absent or not a number, is clamped to the range, and setting announces", () => {
  const { prefs, storage, announced } = setup();
  assert.equal(WRITER_SIZE_MIN, 16);
  assert.equal(WRITER_SIZE_MAX, 34);
  assert.equal(prefs.writerSize(), null);
  storage.items.set("splitpage-writer-size", "abc");
  assert.equal(prefs.writerSize(), null);
  storage.items.set("splitpage-writer-size", "5");
  assert.equal(prefs.writerSize(), 16);
  storage.items.set("splitpage-writer-size", "99");
  assert.equal(prefs.writerSize(), 34);
  prefs.setWriterSize(22);
  assert.equal(prefs.writerSize(), 22);
  assert.deepEqual(announced, [{ key: "splitpage-writer-size", value: "22" }]);
});

test("storage that is missing or throws reads as defaults and a write that fails still announces", () => {
  const announced: PreferenceChange[] = [];
  const fail = function (): never { throw new Error("storage is off"); };
  const broken: KeyValueStorage = { getItem: fail, setItem: fail, removeItem: fail };
  for (const storage of [() => broken, () => null]) {
    const prefs = createPreferences({ storage: storage, announce: (change) => { announced.push(change); } });
    assert.equal(prefs.autosave(), true);
    assert.equal(prefs.commentAuthor(), "");
    assert.equal(prefs.writerSize(), null);
    assert.equal(prefs.onboarding(), null);
    prefs.setAutosave(false);
    prefs.taggingHelpDismissed();
    prefs.skipOnboardingForPrompter();
  }
  assert.equal(announced.length, 2);
});

test("a listener that throws does not stop the write", () => {
  const storage = memoryStorage();
  const prefs = createPreferences({ storage: () => storage, announce: () => { throw new Error("listener"); } });
  prefs.setAutosave(false);
  assert.equal(storage.items.get("splitpage-autosave"), "0");
});

const EXTRA: readonly AppDataPref[] = [{ name: "theme", key: "splitpage-theme", valid: (v) => v === "dark" }];

test("exporting the app data lists every owned preference by name, with the onboarding record parsed and absent values as none", () => {
  const { prefs, storage } = setup();
  storage.items.set("splitpage-theme", "dark");
  storage.items.set("splitpage-writer-size", "20");
  prefs.recordOnboarding(true, "t");
  assert.deepEqual(prefs.appDataExport(EXTRA), {
    onboarding: { v: 1, done: true, skipped: true, at: "t" },
    tourDone: null,
    commentAuthor: null,
    writerSize: "20",
    taggingHelpDismissed: null,
    autosave: null,
    theme: "dark"
  });
});

test("importing app data writes only valid values for keys that are not set yet, silently, and names what it wrote", () => {
  const { prefs, storage, announced } = setup();
  storage.items.set("splitpage-autosave", "0");
  const written = prefs.appDataImport({
    tourDone: "1",
    commentAuthor: "   ",
    writerSize: "40",
    taggingHelpDismissed: "1",
    autosave: "1",
    theme: "dark",
    unknown: "x"
  }, EXTRA);
  assert.deepEqual(written, ["tourDone", "taggingHelpDismissed", "theme"]);
  assert.equal(storage.items.get("splitpage-autosave"), "0", "a value already set stays");
  assert.equal(storage.items.has("splitpage-comment-author"), false, "a blank name is refused");
  assert.equal(storage.items.has("splitpage-writer-size"), false, "a size out of range is refused");
  assert.deepEqual(announced, []);
});

test("importing app data ignores a value that is not text and input that is not an object", () => {
  const { prefs, storage } = setup();
  assert.deepEqual(prefs.appDataImport(null, []), []);
  assert.deepEqual(prefs.appDataImport([1], []), []);
  assert.deepEqual(prefs.appDataImport({ tourDone: 1 }, []), []);
  assert.equal(storage.items.size, 0);
});

test("importing the onboarding record fills a missing one, keeps the local values over incoming ones, and caps what it takes", () => {
  const { prefs, storage } = setup();
  assert.deepEqual(prefs.appDataImport({ onboarding: { done: true, skipped: false, at: "x".repeat(300), junk: [1], ["__proto__"]: 1 } }, []), ["onboarding"]);
  const first = prefs.onboarding() as Record<string, unknown>;
  assert.equal(first["done"], true);
  assert.equal((first["at"] as string).length, 200);
  assert.equal("junk" in first, false);
  storage.items.set("splitpage-onboarding", JSON.stringify({ done: false, v: 1 }));
  assert.deepEqual(prefs.appDataImport({ onboarding: { done: true, skipped: true } }, []), ["onboarding"], "a key the local record lacks is added");
  assert.deepEqual(prefs.onboarding(), { skipped: true, done: false, v: 1 });
  assert.deepEqual(prefs.appDataImport({ onboarding: { done: true } }, []), [], "nothing new to add");
  storage.items.set("splitpage-onboarding", "[1]");
  assert.deepEqual(prefs.appDataImport({ onboarding: { done: true } }, []), [], "a local record that is not an object is left alone");
  assert.equal(storage.items.get("splitpage-onboarding"), "[1]");
});
