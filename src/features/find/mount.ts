export interface FindPorts {
  readonly closeFindBar: () => void;
  readonly stepFind: (direction: number) => void;
  readonly replaceCurrent: () => void;
  readonly replaceAll: () => void;
  readonly toggleBulkTag: () => void;
  readonly runBulkTag: () => void;
  readonly closeBulkTag: () => void;
  readonly pickBulkTagCat: (category: string | null) => void;
  readonly findQueryChanged: () => void;
  readonly leaveFindAtMatch: () => void;
  readonly bulkTagOpen: () => boolean;
  readonly getFindMatchCase: () => boolean;
  readonly setFindMatchCase: (value: boolean) => void;
}

type FindEvent = KeyboardEvent & { readonly target: HTMLElement; readonly currentTarget: HTMLElement };

export function mountFind(mount: { window: Window; ports: FindPorts }): { dispose: () => void } {
  const doc = mount.window.document;
  const ports = mount.ports;
  const releases: (() => void)[] = [];
  function listen(id: string, type: string, fn: (event: FindEvent) => void): void {
    const target = doc.getElementById(id);
    if (!target) return;
    const handler = fn as EventListener;
    target.addEventListener(type, handler, false);
    releases.push(() => target.removeEventListener(type, handler, false));
  }
  listen("find-close", "click", ports.closeFindBar);
  listen("find-next", "click", function () { ports.stepFind(1); });
  listen("find-prev", "click", function () { ports.stepFind(-1); });
  listen("find-replace", "click", ports.replaceCurrent);
  listen("find-replace-all", "click", ports.replaceAll);
  listen("find-tag", "click", ports.toggleBulkTag);
  listen("find-tag-go", "click", ports.runBulkTag);
  listen("find-tag-cancel", "click", function () {
    ports.closeBulkTag();
    doc.getElementById("find-tag")?.focus();
  });
  listen("find-tag-cats", "click", function (e) {
    const btn = e.target.closest(".tag-cat-btn");
    if (btn) ports.pickBulkTagCat(btn.getAttribute("data-tag-cat"));
  });
  listen("find-case", "click", function (e) {
    ports.setFindMatchCase(!ports.getFindMatchCase());
    e.currentTarget.classList.toggle("is-active", ports.getFindMatchCase());
    e.currentTarget.setAttribute("aria-pressed", ports.getFindMatchCase() ? "true" : "false");
    ports.findQueryChanged();
  });
  listen("find-input", "input", ports.findQueryChanged);
  listen("findbar", "keydown", function (e) {
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      if (ports.bulkTagOpen()) { ports.closeBulkTag(); doc.getElementById("find-tag")?.focus(); return; }
      ports.leaveFindAtMatch();
      return;
    }
    if (e.key !== "Enter") return;
    if (e.target.tagName === "BUTTON") return;
    e.preventDefault();
    if (e.target.id === "replace-input") { ports.replaceCurrent(); return; }
    ports.stepFind(e.shiftKey ? -1 : 1);
  });
  return { dispose: () => { releases.splice(0).reverse().forEach((release) => release()); } };
}
