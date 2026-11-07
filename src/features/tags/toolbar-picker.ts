import { TAG_CATEGORIES } from "../../core/production/looks.ts";
import { escapeHtml } from "../../core/document/text-policy.ts";
import { createViewLifetime } from "../common/view-lifetime.ts";

const SYNTAX: Readonly<Record<string, string>> = {
  prop: "[]", location: "{}", cast: "cast: ⇥", vfx: "~~", sound: "sfx: ⇥", gear: "<>"
};

export function showToolbarTagPicker(cell: HTMLElement, choose: (cat: string) => void, cancel: (restore: boolean) => void): (() => void) | null {
  const toolbar = cell.closest(".field-wrap")?.querySelector<HTMLElement>(".mini-toolbar");
  const trigger = toolbar?.querySelector<HTMLButtonElement>(".tb-tag");
  if (!toolbar || !trigger) return null;
  const doc = cell.ownerDocument;
  const win = doc.defaultView;
  if (!win) return null;
  let picker = toolbar.querySelector<HTMLElement>(".tag-toolbar-picker");
  if (!picker) {
    picker = doc.createElement("div");
    picker.className = "tag-toolbar-picker";
    picker.id = "tag-picker-" + cell.getAttribute("data-id");
    picker.setAttribute("role", "group");
    picker.setAttribute("aria-label", "Tag category");
    picker.innerHTML = '<div class="tag-toolbar-hint">Or type <code>prop: name</code> + <kbd>Tab</kbd></div>' +
      '<div class="tag-toolbar-choices">' + TAG_CATEGORIES.map(cat =>
        '<button type="button" class="tag-toolbar-choice" data-tag-cat="' + cat.id + '" style="--dot:' + cat.color +
        '" aria-label="Tag as ' + escapeHtml(cat.label) + '"><span class="tag-toolbar-label"><span class="tag-cat-dot" aria-hidden="true"></span>' +
        escapeHtml(cat.label) + '</span><code>' + escapeHtml(SYNTAX[cat.id] || "") + '</code></button>').join("") + '</div>';
    toolbar.appendChild(picker);
  }
  const panel = picker;
  const life = createViewLifetime(win, () => cell.isConnected);
  const buttons = Array.from(panel.querySelectorAll<HTMLButtonElement>(".tag-toolbar-choice"));
  trigger.setAttribute("aria-controls", panel.id);
  trigger.setAttribute("aria-expanded", "true");
  panel.inert = false;
  panel.setAttribute("aria-hidden", "false");
  toolbar.removeAttribute("data-tags-below");
  const chromeBottom = doc.querySelector(".topbar")?.getBoundingClientRect().bottom || 0;
  if (panel.getBoundingClientRect().top < Math.max(8, chromeBottom + 4)) toolbar.setAttribute("data-tags-below", "");
  panel.getBoundingClientRect();
  toolbar.setAttribute("data-tags-open", "true");
  life.listen(panel, "pointerdown", event => { event.preventDefault(); });
  life.listen(panel, "click", event => {
    const button = event.target.closest<HTMLButtonElement>(".tag-toolbar-choice");
    const cat = button?.getAttribute("data-tag-cat");
    if (cat) choose(cat);
  });
  life.listen(panel, "pointerover", event => {
    const button = event.target.closest<HTMLButtonElement>(".tag-toolbar-choice");
    const cat = button?.getAttribute("data-tag-cat");
    const hint = panel.querySelector<HTMLElement>(".tag-toolbar-hint");
    if (hint && cat) hint.innerHTML = 'Or type <code>' + (cat === "sound" ? "sfx" : cat) + ': name</code> + <kbd>Tab</kbd>';
  });
  const outside = (event: Event) => {
    if (!(event.target instanceof win.Node)) return;
    if (event.type === "focusin" && event.target === cell) return;
    if (!toolbar.contains(event.target)) cancel(false);
    else if (event.target instanceof win.Element && event.target.closest("button[data-cmd]:not(.tb-tag)")) cancel(true);
  };
  life.listen(doc, "pointerdown", outside, true);
  life.listen(doc, "click", outside, true);
  life.listen(doc, "focusin", outside);
  life.listen(win, "wheel", () => { cancel(false); }, { capture: true, passive: true });
  life.listen(win, "touchmove", () => { cancel(false); }, { capture: true, passive: true });
  life.listen(win, "resize", () => { cancel(false); });
  life.listen(doc, "keydown", event => {
    if (event.target === cell && event.key !== "Escape") { cancel(false); return; }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel(true);
      return;
    }
    const index = buttons.indexOf(doc.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 :
      event.key === "ArrowDown" ? 3 : event.key === "ArrowUp" ? -3 : 0;
    if (step && index !== -1) {
      event.preventDefault();
      buttons[(Math.max(0, index) + step + buttons.length) % buttons.length]?.focus({ preventScroll: true });
    }
  }, true);
  buttons[0]?.focus({ preventScroll: true });
  return () => {
    life.dispose();
    toolbar.setAttribute("data-tags-open", "false");
    trigger.setAttribute("aria-expanded", "false");
    panel.inert = true;
    panel.setAttribute("aria-hidden", "true");
  };
}
