import { test } from "node:test";
import assert from "node:assert/strict";
import { mountTags, mountTagEntityContainer } from "../../../src/features/tags/mount.ts";
import type { TagsPorts, TagsRoutes } from "../../../src/features/tags/mount.ts";
import { jsdomWindow } from "../editing/jsdom.mjs";

type Realm = Window & typeof globalThis;
const targets: Record<string, readonly string[]> = {
  "production-list": ["pointerdown", "pointermove", "pointerup", "pointercancel", "click/C", "contextmenu"],
  "tag-ghost": ["pointerdown"], "tag-open-hint": ["pointerdown"],
  window: ["scroll/C", "resize", "scroll/C", "resize", "scroll/C", "resize", "keydown"],
  "tag-suggest": ["mousedown", "click"], "btn-production": ["click"], "production-close": ["click"],
  "production-panel": ["click", "keydown", "change", "input", "focusout", "keydown", "change"],
  "btn-gear": ["click"], "gear-close": ["click"],
  "gear-panel": ["click", "keydown", "change", "input", "focusout"],
  "gear-modes": ["click"], "gear-quickadd-save": ["click"],
  "tag-modal": ["click", "click"], "tag-close": ["click"], "tag-cancel": ["click"],
  "tag-apply": ["click"], "tag-name": ["keydown"]
};

function harness() {
  const win = jsdomWindow() as unknown as Realm;
  const doc = win.document;
  doc.body.innerHTML = Object.keys(targets).filter((id) => id !== "window").map((id) => '<div id="' + id + '"></div>').join("");
  const el = (id: string): HTMLElement => doc.getElementById(id) as HTMLElement;
  el("tag-modal").hidden = true;
  el("production-panel").append(el("production-list"));
  el("production-list").innerHTML = '<div class="tag-entity" data-key="prop:Hat"><button class="tag-entity-row"></button></div>';
  const anchor = doc.createElement("span");
  anchor.className = "tag-anchor";
  anchor.dataset.tagCat = "prop";
  anchor.dataset.tagName = "Hat";
  doc.body.append(anchor);
  const calls: string[] = [];
  const log = (name: string) => (...args: unknown[]): void => { const values = args.filter((v) => !(v instanceof win.Event)); calls.push(name + (values.length ? ":" + values.map(String).join(",") : "")); };
  const state = { epoch: 0, review: false, selected: [] as string[], touch: false, armed: false, adding: null as string | null, expanded: null as string | null, group: "cat" };
  const pending = new Map<number, { ms: number; fn: () => void }>();
  const held: (() => void)[] = [];
  const cleared: number[] = [];
  let next = 0;
  win.setTimeout = ((fn: () => void, ms: number): number => { const id = ++next; pending.set(id, { ms, fn }); held.push(fn); return id; }) as typeof win.setTimeout;
  win.clearTimeout = ((id?: number): void => { if (id !== undefined) { cleared.push(id); pending.delete(id); } }) as typeof win.clearTimeout;
  const tick = (): void => { const jobs = [...pending.values()]; pending.clear(); jobs.forEach(({ fn }) => fn()); };
  let routes: TagsRoutes;
  const ports: TagsPorts = {
    rootClick: (e) => { calls.push("root"); if (!state.review) { routes.jumpClick(e); routes.click(e); } },
    reviewMode: () => state.review, reviewBlocked: log("refuse"), renderProduction: log("render"),
    saveTagRename: log("rename-save"), addPersonForTag: log("person-save"),
    setRenaming: log("renaming"), setAddingPerson: (v) => { state.adding = v; log("adding")(v); },
    setTagOwner: log("owner"), setTagNotes: log("notes"), queueAutoSave: log("autosave"),
    acceptTagGhost: log("ghost"), acceptUntaggedMention: log("suggest"), applyTag: log("apply"),
    armBulkDelete: log("arm-bulk"), clearProductionSelection: log("clear"), closeTagComposer: log("close-composer"),
    disarmBulkDelete: log("disarm-bulk"), hideTagGhost: log("hide-ghost"), hideUntaggedPrompt: log("hide-suggest"),
    bulkDeleteSelected: log("delete-bulk"), bulkAddPerson: log("bulk-person"), closeGearPanel: log("close-gear"),
    closeProductionPanel: log("close-production"), openProductionPanel: log("open-production"),
    renderGearList: log("gear-render"), applyGearQuickAdd: log("quickadd"), closePlainTag: log("close-plain"),
    refreshPlainTag: log("refresh-plain"), tagAllMentions: log("mentions"), renderTagCategories: log("category"),
    armPersonDelete: () => { calls.push("delete-person"); }, armRemoveTag: () => { calls.push("remove-tag"); },
    armDeleteTag: () => { calls.push("delete-tag"); }, selectedKeys: () => state.selected,
    plainTagOpen: () => true, bulkDeleteArmed: () => state.armed, isTouch: () => state.touch,
    addingPerson: () => state.adding, expanded: () => state.expanded, productionGroup: () => state.group,
    setExpanded: (v) => { state.expanded = v; log("expanded")(v); },
    setProductionGroup: (v) => { state.group = v || ""; log("group")(v); }, setGearGroup: log("gear-group"),
    setTagStatus: log("status"), bulkSetOwner: log("bulk-owner"), bulkSetStatus: log("bulk-status"),
    handleSelectionClick: () => { calls.push("modifier"); return true; }, jumpToTag: log("jump"),
    toggleCardSelection: log("select"), tagKey: (cat, name) => cat + ":" + name, cssAttr: (v) => v || "",
    exportAs: log("export"), runExport: log("run-export"), runFromButton: log("action"),
    capture: () => { const epoch = state.epoch; return () => state.epoch === epoch; },
    installEntity: (id) => mountTagEntityContainer({ window: win, id, ports })
  };
  const mount = (): TagsRoutes => { routes = mountTags({ window: win, ports }); return routes; };
  function fire(target: EventTarget, type: string, init: Record<string, unknown> = {}): Event {
    const e = new win.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
    for (const [key, value] of Object.entries(init)) Object.defineProperty(e, key, { value });
    target.dispatchEvent(e);
    return e;
  }
  const click = (attrs: string, init: Record<string, unknown> = {}): void => {
    const holder = doc.createElement("div");
    holder.innerHTML = '<button ' + attrs + ' data-key="prop:Hat" data-row="r1" data-status="ready" data-person="p1"></button>';
    const button = holder.firstElementChild as HTMLElement;
    el("production-panel").append(button);
    fire(button, "click", init);
    button.remove();
  };
  const card = (): HTMLElement => el("production-list").querySelector(".tag-entity") as HTMLElement;
  card().scrollIntoView = () => { calls.push("scroll-card"); };
  return { win, doc, el, anchor, card, calls, state, pending, held, cleared, tick, ports, mount, fire, click };
}

test("tags: all 41 listeners behind the 54 ledger rows are removed and remounted once, with phase and multiplicity", () => {
  const h = harness();
  const records = Object.entries(targets).map(([id, expected]) => {
    const target: EventTarget = id === "window" ? h.win : h.el(id);
    const added: string[] = [];
    const active: { fn: EventListenerOrEventListenerObject | null; key: string }[] = [];
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    const key = (type: string, opts?: boolean | EventListenerOptions): string => type + ((typeof opts === "boolean" ? opts : opts?.capture) ? "/C" : "");
    target.addEventListener = (type, fn, opts) => { added.push(key(type, opts)); active.push({ fn, key: key(type, opts) }); add(type, fn, opts); };
    target.removeEventListener = (type, fn, opts) => { const index = active.findIndex((entry) => entry.fn === fn && entry.key === key(type, opts)); assert.ok(index >= 0, id); active.splice(index, 1); remove(type, fn, opts); };
    return { id, expected, added, active };
  });
  let owner = h.mount();
  assert.equal(records.reduce((n, r) => n + r.added.length, 0), 41);
  for (const r of records) assert.deepEqual(r.added, r.expected, r.id);
  owner.dispose();
  owner.dispose();
  for (const r of records) assert.equal(r.active.length, 0, r.id);
  owner = h.mount();
  for (const r of records) {
    assert.deepEqual(r.added, [...r.expected, ...r.expected], r.id);
    assert.equal(r.active.length, r.expected.length, r.id);
  }
  h.fire(h.el("tag-apply"), "click");
  assert.equal(h.calls.filter((c) => c === "apply").length, 1);
  owner.dispose();
  h.win.close();
});

const branches: readonly [string, string][] = [
  ["jump-tag", "jump:r1,prop:Hat"], ["bulk-clear", "clear"], ["bulk-delete", "arm-bulk"],
  ["bulk-person-new", "adding:__bulk__"], ["bulk-person-save", "bulk-person"], ["bulk-person-cancel", "adding:null"],
  ["tag-status-cycle", "status:prop:Hat,null"], ["tag-status-set", "status:prop:Hat,ready"],
  ["tag-expand", "expanded:prop:Hat"], ["tag-person-new", "adding:prop:Hat"], ["tag-person-save", "person-save:prop:Hat"],
  ["tag-person-cancel", "adding:null"], ["person-delete", "delete-person"], ["export-breakdown", "export:breakdown"],
  ["export-packing-gear", "run-export:export-packing-gear"], ["tag-rename", "renaming:prop:Hat"],
  ["tag-rename-save", "rename-save:prop:Hat"], ["tag-rename-cancel", "renaming:null"],
  ["tag-all-mentions", "mentions:prop:Hat"], ["tag-remove", "remove-tag"], ["tag-delete", "delete-tag"]
];

test("tags: all 25 B rows retain one route after dispose and remount", () => {
  const h = harness();
  h.mount().dispose();
  const owner = h.mount();
  for (const [action, expected] of branches) {
    h.calls.length = 0;
    h.click('data-action="' + action + '"');
    assert.equal(h.calls.filter((c) => c === expected).length, 1, action);
  }
  h.calls.length = 0;
  h.fire(h.card(), "click", { ctrlKey: true });
  assert.equal(h.calls.filter((c) => c === "modifier").length, 1);
  h.state.touch = true;
  h.state.selected = ["prop:Hat"];
  h.calls.length = 0;
  h.fire(h.card().firstElementChild as Element, "click");
  assert.equal(h.calls.filter((c) => c === "select:prop:Hat").length, 1);
  h.el("production-panel").insertAdjacentHTML("beforeend", '<div id="production-modes"><button data-group="scene"></button></div>');
  h.calls.length = 0;
  h.fire(h.el("production-modes").firstElementChild as Element, "click");
  assert.deepEqual(h.calls, ["root", "group:scene", "clear", "render"]);
  h.el("tag-modal").innerHTML = '<div id="tag-cats"><button class="tag-cat-btn" data-tag-cat="cast"></button></div>';
  h.calls.length = 0;
  h.fire(h.el("tag-cats").firstElementChild as Element, "click");
  assert.deepEqual(h.calls, ["root", "category:cast"]);
  owner.dispose();
  h.calls.length = 0;
  h.click('data-action="tag-delete"');
  assert.deepEqual(h.calls, []);
  h.win.close();
});

for (const work of ["card", "touch"] as const) {
  for (const scenario of ["dispose and reopen", "same-ID replacement", "stale completion after remount", "normal completion"] as const) {
    test("tags: " + work + " timer, " + scenario, () => {
      const h = harness();
      const owner = h.mount();
      if (work === "card") {
        h.el("production-panel").addEventListener("mousedown", (e) => owner.anchorMouseDown(e as MouseEvent));
        h.el("production-panel").append(h.anchor);
        h.fire(h.anchor, "mousedown");
      } else h.fire(h.card(), "pointerdown", { pointerType: "touch", clientX: 1, clientY: 2 });
      assert.equal(h.pending.size, 1);
      assert.equal([...h.pending.values()][0]?.ms, work === "card" ? 30 : 450);
      let replacement: TagsRoutes | undefined;
      if (scenario === "dispose and reopen" || scenario === "stale completion after remount") {
        owner.dispose();
        assert.equal(h.pending.size, 0);
        assert.equal(h.cleared.length, 1);
        replacement = h.mount();
      }
      if (scenario === "same-ID replacement") h.state.epoch++;
      h.calls.length = 0;
      h.tick();
      if (scenario === "stale completion after remount") h.held.forEach((fn) => fn());
      assert.deepEqual(h.calls, scenario === "normal completion" ? [work === "card" ? "scroll-card" : "select:prop:Hat"] : []);
      assert.equal(h.card().classList.contains("flash"), work === "card" && scenario === "normal completion");
      owner.dispose();
      replacement?.dispose();
      h.win.close();
    });
  }
}

test("tags: delegation precedes backdrop, review Enter refuses, input Escape excludes selection clearing, captured scroll refreshes", () => {
  const h = harness();
  const owner = h.mount();
  h.fire(h.el("tag-modal"), "click");
  assert.deepEqual(h.calls, ["root", "close-composer"]);
  h.calls.length = 0;
  h.el("production-panel").insertAdjacentHTML("beforeend", '<input class="tag-rename-input" data-key="prop:Hat"><input id="bulk-person-input">');
  h.state.review = true;
  h.fire(h.el("production-panel").querySelector("input") as Element, "keydown", { key: "Enter" });
  assert.deepEqual(h.calls, ["refuse", "render"]);
  h.calls.length = 0;
  h.fire(h.el("bulk-person-input"), "keydown", { key: "Enter" });
  assert.deepEqual(h.calls, ["refuse", "render"]);
  h.state.review = false;
  h.state.selected = ["prop:Hat"];
  h.calls.length = 0;
  h.fire(h.el("production-panel").querySelector("input") as Element, "keydown", { key: "Escape" });
  assert.deepEqual(h.calls, ["renaming:null", "render"]);
  h.calls.length = 0;
  h.el("production-list").dispatchEvent(new h.win.Event("scroll"));
  assert.deepEqual(h.calls, ["hide-ghost", "hide-suggest", "refresh-plain"]);
  owner.dispose();
  h.win.close();
});

for (const work of ["card", "touch"] as const) {
  test("tags: held " + work + " work cannot reach a replaced panel with the same ID", () => {
    const h = harness();
    const owner = h.mount();
    if (work === "card") {
      h.anchor.addEventListener("mousedown", (e) => owner.anchorMouseDown(e as MouseEvent));
      h.fire(h.anchor, "mousedown");
    } else h.fire(h.card(), "pointerdown", { pointerType: "touch" });
    const panel = h.el("production-panel");
    panel.replaceWith(panel.cloneNode(true));
    h.card().scrollIntoView = () => { h.calls.push("replacement-scroll"); };
    h.calls.length = 0;
    h.tick();
    assert.deepEqual(h.calls, []);
    assert.equal(h.card().classList.contains("flash"), false);
    owner.dispose();
    h.win.close();
  });
}

test("tags: disposal removes every listener newest first and silences retained callbacks", () => {
  const h = harness();
  const added: { target: EventTarget; type: string; fn: EventListenerOrEventListenerObject | null; options: boolean | AddEventListenerOptions | undefined }[] = [];
  const removed: typeof added = [];
  for (const target of Object.keys(targets).map((id) => id === "window" ? h.win : h.el(id))) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = (type: string, fn: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void => {
      added.push({ target, type, fn, options });
      add(type, fn, options);
    };
    target.removeEventListener = (type: string, fn: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void => {
      removed.push({ target, type, fn, options });
      remove(type, fn, options);
    };
  }
  const owner = h.mount();
  try {
    assert.equal(added.length, 41);
    assert.deepEqual(added.filter((entry) => entry.options === true).map((entry) => [entry.target, entry.type]), [[h.el("production-list"), "click"], [h.win, "scroll"], [h.win, "scroll"], [h.win, "scroll"]]);
    owner.dispose();
    owner.dispose();
    assert.equal(removed.length, 41);
    assert.deepEqual(removed, [...added].reverse());
    h.calls.length = 0;
    for (const entry of added) {
      assert.equal(typeof entry.fn, "function");
      (entry.fn as EventListener)(new h.win.Event(entry.type));
    }
    assert.deepEqual(h.calls, []);
  } finally { owner.dispose(); h.win.close(); }
});

test("tags: detached entity targets remain live until their lifetime is disposed", () => {
  const h = harness();
  const owner = h.mount();
  const target = h.el("production-panel");
  target.replaceWith(target.cloneNode(true));
  try {
    h.fire(target, "click");
    assert.deepEqual(h.calls, ["root"]);
    owner.dispose();
    h.calls.length = 0;
    h.fire(target, "click");
    assert.deepEqual(h.calls, []);
  } finally { owner.dispose(); h.win.close(); }
});
