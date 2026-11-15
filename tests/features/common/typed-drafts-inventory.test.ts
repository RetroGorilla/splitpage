import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import "../../../src/test/_dom.mjs";

const HELPER = "typed draft";
const FEATURES = ["broll", "comments", "gallery", "tags"] as const;
type Feature = typeof FEATURES[number];

const PAGE_ROOTS: Record<string, Feature> = {
  "broll-panel": "broll", "broll-page": "broll",
  "comments-panel": "comments", "comment-modal": "comments",
  "gallery-modal": "gallery", "annotate-modal": "gallery",
  "production-panel": "tags", "gear-panel": "tags", "tag-modal": "tags"
};

const INVENTORY: Record<Feature, Record<string, string>> = {
  broll: {
    "broll-notes-input": HELPER, "broll-ref-input": HELPER, "broll-loc-input": HELPER, "broll-rename-input": HELPER,
    "broll-prop-input": HELPER, "broll-person-input": HELPER, "broll-bulk-input": HELPER, "broll-add-input": HELPER
  },
  comments: {
    "comment-body-editable": HELPER,
    "editableCellHtml": HELPER,
    "comment-name": "writes nothing: the name is read when a comment posts and kept as a local preference",
    "reply-name-input": "writes nothing: the name is read when a reply posts, and a redraw restores it from the reply draft",
    "link-input": "writes nothing: it inserts a link into the comment draft, which saves only through Post",
    "video-input": "writes nothing: it inserts a video card into the comment draft, which saves only through Post"
  },
  gallery: {
    "createElement:textarea": "writes nothing: its text becomes a mark on the drawing, and a held Done keeps the editor open"
  },
  tags: {
    "tag-notes-input": HELPER, "tag-person-input": HELPER, "tag-rename-input": HELPER, "bulk-person-input": HELPER,
    "gear-quickadd-input": HELPER,
    "tag-name": "writes nothing in a shared session: Apply refuses before reading it and the composer stays open"
  }
};

const HELPER_BOX: Record<string, string> = { editableCellHtml: "reply-composer" };
const NOT_TEXT = new Set(["checkbox", "radio", "file", "hidden", "range", "color", "button", "submit", "reset", "image"]);

function sources(feature: Feature): { name: string; text: string }[] {
  const dir = "src/features/" + feature + "/";
  return readdirSync(dir).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map(name => ({ name, text: readFileSync(dir + name, "utf8") }));
}

function attribute(attrs: string, name: string): string | null {
  const found = new RegExp("\\s" + name + '="([^"]*)"').exec(attrs);
  return found ? found[1] as string : null;
}

function sourceBoxes(text: string): string[] {
  const boxes: string[] = [];
  for (const found of text.matchAll(/<(input|textarea)\b((?:\s+[\w-]+(?:="[^"']*")?)*)/g)) {
    const attrs = found[2] ?? "", type = attribute(attrs, "type");
    if (found[1] === "input" && type !== null && NOT_TEXT.has(type)) continue;
    const id = attribute(attrs, "id"), cls = attribute(attrs, "class")?.split(/\s+/)[0] ?? null;
    boxes.push(id && /^[\w-]+$/.test(id) ? id : cls ?? "unnamed " + found[1]);
  }
  for (const found of text.matchAll(/<\w+\b[^<>]*\scontenteditable="(?:true|)"[^<>]*/g)) {
    boxes.push(attribute(found[0], "id") ?? attribute(found[0], "class")?.split(/\s+/)[0] ?? "unnamed contenteditable");
  }
  if (/\beditableCellHtml\(/.test(text)) boxes.push("editableCellHtml");
  for (const found of text.matchAll(/createElement\("(input|textarea)"\)/g)) boxes.push("createElement:" + found[1]);
  return boxes;
}

function pageBoxes(): Map<Feature, string[]> {
  const page = new DOMParser().parseFromString(readFileSync("src/page.html", "utf8"), "text/html"), out = new Map<Feature, string[]>();
  for (const [root, feature] of Object.entries(PAGE_ROOTS)) {
    const host = page.getElementById(root);
    assert.ok(host, "the page has #" + root);
    for (const el of host.querySelectorAll<HTMLElement>("input, textarea, [contenteditable]")) {
      if (el.tagName === "INPUT" && NOT_TEXT.has((el.getAttribute("type") ?? "text").toLowerCase())) continue;
      if (el.hasAttribute("contenteditable") && !["", "true"].includes(el.getAttribute("contenteditable") as string)) continue;
      out.set(feature, [...out.get(feature) ?? [], el.id || el.getAttribute("data-role") || el.classList[0] || "unnamed " + el.tagName]);
    }
  }
  return out;
}

function declaredBoxes(text: string): Set<string> {
  const declared = new Set<string>();
  for (const call of text.matchAll(/createTypedDrafts\((\w+)/g)) {
    const list = new RegExp("const " + call[1] + "\\s*=\\s*\\[([^\\]]*)\\]").exec(text);
    for (const name of list?.[1]?.matchAll(/"([\w-]+)"/g) ?? []) declared.add(name[1] as string);
  }
  return declared;
}

function submittedBoxes(text: string): Set<string> {
  const submitted = new Set<string>();
  for (const call of text.matchAll(/\.submit\(\s*"([\w-]+)"/g)) submitted.add(call[1] as string);
  for (const call of text.matchAll(/\.submit\(\s*(\w+)\[/g)) {
    const map = new RegExp("const " + call[1] + "\\b[^=]*=\\s*\\{([^}]*)\\}").exec(text);
    for (const name of map?.[1]?.matchAll(/"([\w-]+)"/g) ?? []) submitted.add(name[1] as string);
  }
  return submitted;
}

test("every text box in the b-roll, comments, gallery and tags features saves through the typed-draft helper or says why it writes nothing", () => {
  const page = pageBoxes();
  for (const feature of FEATURES) {
    const files = sources(feature), all = files.map(file => file.text).join("\n");
    const found = new Set([...files.flatMap(file => sourceBoxes(file.text)), ...page.get(feature) ?? []]);
    const listed = INVENTORY[feature];
    assert.deepEqual([...found].filter(box => !(box in listed)).sort(), [], feature + ": every text box is listed");
    assert.deepEqual(Object.keys(listed).filter(box => !found.has(box)).sort(), [], feature + ": every listed box still exists");
    const declared = declaredBoxes(all), submitted = submittedBoxes(all);
    for (const [box, reason] of Object.entries(listed)) {
      if (reason !== HELPER) { assert.match(reason, /^writes nothing/, feature + " " + box + " names its reason"); continue; }
      const name = HELPER_BOX[box] ?? box;
      assert.ok(declared.has(name), feature + ": " + name + " is declared to the typed-draft helper");
      assert.ok(submitted.has(name), feature + ": " + name + " submits through the typed-draft helper");
    }
  }
});
