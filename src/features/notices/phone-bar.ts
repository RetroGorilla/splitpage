import { createViewLifetime } from "../common/view-lifetime.ts";

const PANEL_CLOSERS: [string, string][] = [
  ["production-panel", "production-close"],
  ["gear-panel", "gear-close"],
  ["broll-panel", "broll-close"],
  ["comments-panel", "comments-panel-close"],
  ["history-panel", "history-close"]
];

const COUNT_WORDS: Record<string, [string, string]> = {
  "production-badge": ["item", "items"],
  "gear-badge": ["item", "items"],
  "broll-badge": ["to shoot", "to shoot"],
  "comments-badge": ["open", "open"]
};

export function mountPhoneBar({ window }: { window: Window }) {
  const document = window.document;
  const life = createViewLifetime(window);
  const bar = document.getElementById("phone-bar");
  if (!bar) return { dispose: life.dispose };

  function isShown(id: string) {
    const el = document.getElementById(id);
    return !!el && !el.hidden;
  }

  function syncTab(tab: HTMLElement, anyPanelOpen: boolean) {
    const panelId = tab.getAttribute("data-panel");
    const current = panelId ? isShown(panelId) : tab.getAttribute("data-for") === "script" && !anyPanelOpen;
    if (current) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");

    const badgeId = tab.getAttribute("data-badge");
    const countEl = tab.querySelector<HTMLElement>(".phone-tab-count");
    if (!badgeId || !countEl) return;
    const badge = document.getElementById(badgeId);
    const n = badge && !badge.hidden ? badge.textContent : "";
    if (countEl.textContent !== n) countEl.textContent = n;
    countEl.hidden = !n;
    const label = tab.querySelector(".phone-tab-label");
    const words = COUNT_WORDS[badgeId] || ["", ""];
    if (n) tab.setAttribute("aria-label", (label ? label.textContent : "") + ", " + n + " " + words[n === "1" ? 0 : 1]);
    else tab.removeAttribute("aria-label");
  }

  function syncPhoneBar() {
    const bar = document.getElementById("phone-bar");
    if (!bar) return;
    const anyPanelOpen = PANEL_CLOSERS.some(function (pair) { return isShown(pair[0]); });
    bar.querySelectorAll<HTMLElement>(".phone-tab").forEach(function (tab) { syncTab(tab, anyPanelOpen); });
  }

  function closeOpenPanels() {
    PANEL_CLOSERS.forEach(function (pair) {
      if (!isShown(pair[0])) return;
      const close = document.getElementById(pair[1]);
      if (close) close.click();
    });
  }

  function onClick(e: Event) {
    const tab = e.target instanceof Element ? e.target.closest(".phone-tab") : null;
    if (!tab) return;
    const target = tab.getAttribute("data-for");
    if (target === "script") { closeOpenPanels(); return; }
    const btn = target ? document.getElementById(target) : null;
    if (btn) btn.click();
  }
  life.listen(bar, "click", onClick);

  if (typeof MutationObserver === "function") {
    const observer = new MutationObserver(function () { if (life.active()) syncPhoneBar(); });
    life.release(function () { observer.disconnect(); });
    PANEL_CLOSERS.forEach(function (pair) {
      const panel = document.getElementById(pair[0]);
      if (panel) observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
    });
    bar.querySelectorAll(".phone-tab[data-badge]").forEach(function (tab) {
      const badgeId = tab.getAttribute("data-badge");
      const badge = badgeId ? document.getElementById(badgeId) : null;
      if (badge) observer.observe(badge, { attributes: true, attributeFilter: ["hidden"], childList: true, characterData: true, subtree: true });
    });
  }
  syncPhoneBar();
  return { dispose: life.dispose };
}
