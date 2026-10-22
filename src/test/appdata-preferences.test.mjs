import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { preferences } from "../legacy/preferences-bridge.ts";
import { commentSortMode } from "../application/comment-sort.ts";

await bootApp();
after(closeApp);

const EXPORTED_PREFS = '{"onboarding":null,"tourDone":null,"commentAuthor":null,"writerSize":null,"taggingHelpDismissed":null,"autosave":null,"commentsSort":"recent","theme":null,"clock":null,"personColor":null,"defaultWpm":null,"hideShot":null,"prompterMirror":null,"prompterFlip":null,"prompterSceneMode":null,"rundownMin":null,"videoThumbs":null,"tagIcons":null,"scriptScale":null}';
const PARSED_PREFS = '{"onboarding":null,"tourDone":null,"commentAuthor":null,"commentsSort":"recent","writerSize":null,"taggingHelpDismissed":null,"autosave":null,"theme":null,"clock":null,"personColor":null,"defaultWpm":null,"hideShot":null,"prompterMirror":null,"prompterFlip":null,"prompterSceneMode":null,"rundownMin":null,"videoThumbs":null,"tagIcons":null,"scriptScale":null}';

test("app data: comments sort round trip keeps the exported and parsed preference bytes", async () => {
  localStorage.clear();
  preferences().setCommentsSort("recent");
  preferences().setCommentFilter({ mode: "resolved", assignee: "Ada" });
  const exported = await window.__appDataTest.build();
  assert.equal(JSON.stringify(exported.prefs), EXPORTED_PREFS);
  const text = JSON.stringify(exported);
  assert.equal(JSON.stringify(window.__appDataTest.parse(text).prefs), PARSED_PREFS);
  localStorage.clear();
  await window.__appDataTest.importText(text);
  assert.equal(preferences().commentsSort(), "recent");
  assert.equal(commentSortMode(), "recent");
  assert.deepEqual(preferences().commentFilter(), { mode: "open", assignee: "" });
  assert.equal(JSON.stringify((await window.__appDataTest.build()).prefs), EXPORTED_PREFS);
});

test("app data: comments sort validation and preservation of a local value stay unchanged", async () => {
  for (const value of ["position", "recent", "unknown", "Recent", "", 1, null]) {
    localStorage.removeItem("splitpage-comments-sort");
    const text = JSON.stringify({
      format: "splitpage-app-data", version: 1, history: { docs: [], older: [] }, prefs: { commentsSort: value }
    });
    await window.__appDataTest.importText(text);
    assert.equal(localStorage.getItem("splitpage-comments-sort"), value === "position" || value === "recent" ? value : null);
  }
  preferences().setCommentsSort("position");
  await window.__appDataTest.importText(JSON.stringify({
    format: "splitpage-app-data", version: 1, history: { docs: [], older: [] }, prefs: { commentsSort: "recent" }
  }));
  assert.equal(preferences().commentsSort(), "position");
});
