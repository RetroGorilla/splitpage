import test from "node:test";
import assert from "node:assert/strict";
import { applyTagIcons, applyTheme, mountAppearance } from "../../../src/features/settings/appearance.ts";
import { jsdomWindow } from "../editing/jsdom.mjs";

function page() {
  const window = jsdomWindow() as unknown as Window & typeof globalThis;
  const themes: string[] = [];
  Object.assign(window, { splitpageDesktop: { setTheme: (mode: string) => { themes.push(mode); } } });
  const stored = { theme: "system", tagIcons: false };
  const ports = {
    theme: () => stored.theme,
    tagIcons: () => stored.tagIcons,
    nameOf: (key: string) => key === "splitpage-theme" ? "theme" : key === "splitpage-tag-icons" ? "tagIcons" : null
  };
  const root = window.document.documentElement;
  const storage = (key: string | null): void => {
    const event = new window.Event("storage");
    Object.defineProperty(event, "key", { value: key });
    window.dispatchEvent(event);
  };
  return { window, themes, stored, ports, root, storage };
}

test("the theme is set on the page and passed to the desktop app; system removes the attribute", () => {
  const { window, themes, root } = page();
  applyTheme(window, "dark");
  assert.equal(root.getAttribute("data-theme"), "dark");
  applyTheme(window, "system");
  assert.equal(root.hasAttribute("data-theme"), false);
  assert.deepEqual(themes, ["dark", "system"]);
});

test("a desktop bridge that throws or has no setTheme does not stop the theme", () => {
  const { window, root } = page();
  Object.assign(window, { splitpageDesktop: { setTheme: () => { throw new Error("gone"); } } });
  applyTheme(window, "light");
  assert.equal(root.getAttribute("data-theme"), "light");
  Object.assign(window, { splitpageDesktop: {} });
  applyTheme(window, "dark");
  assert.equal(root.getAttribute("data-theme"), "dark");
});

test("tag icons are an empty data-tag-icons attribute on the page", () => {
  const { window, root } = page();
  applyTagIcons(window, true);
  assert.equal(root.getAttribute("data-tag-icons"), "");
  applyTagIcons(window, false);
  assert.equal(root.hasAttribute("data-tag-icons"), false);
});

test("mounting applies both, and a change in another tab reapplies only the one it names, until disposed", () => {
  const { window, themes, stored, ports, root, storage } = page();
  stored.theme = "light";
  stored.tagIcons = true;
  const view = mountAppearance({ window, ports });
  assert.equal(root.getAttribute("data-theme"), "light");
  assert.equal(root.getAttribute("data-tag-icons"), "");
  assert.deepEqual(themes, ["light"]);
  stored.tagIcons = false;
  storage("splitpage-tag-icons");
  assert.equal(root.hasAttribute("data-tag-icons"), false);
  assert.deepEqual(themes, ["light"]);
  stored.theme = "dark";
  storage("splitpage-clock");
  storage(null);
  assert.equal(root.getAttribute("data-theme"), "light");
  storage("splitpage-theme");
  assert.equal(root.getAttribute("data-theme"), "dark");
  assert.deepEqual(themes, ["light", "dark"]);
  view.dispose();
  stored.theme = "system";
  storage("splitpage-theme");
  assert.equal(root.getAttribute("data-theme"), "dark");
  assert.deepEqual(themes, ["light", "dark"]);
});
