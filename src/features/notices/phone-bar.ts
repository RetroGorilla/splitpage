import { createViewLifetime } from "../common/view-lifetime.ts";

var PANEL_CLOSERS: [string, string][] = [
  ["production-panel", "production-close"],
  ["gear-panel", "gear-close"],
  ["broll-panel", "broll-close"],
  ["comments-panel", "comments-panel-close"],
  ["history-panel", "history-close"]
];

var COUNT_WORDS: Record<string, [string, string]> = {
  "production-badge": ["item", "items"],
  "gear-badge": ["item", "items"],
  "broll-badge": ["to shoot", "to shoot"],
  "comments-badge": ["open", "open"]
};

export function mountPhoneBar({ window }: { window: Window }) {
  var document = window.document;
  var life = createViewLifetime(window);
  var bar = document.getElementById("phone-bar");
  if (!bar) return { dispose: life.dispose };

  function isShown(id: string) {
    var el = document.getElementById(id);
    return !!el && !el.hidden;
  }

  function syncTab(tab: HTMLElement, anyPanelOpen: boolean) {
    var panelId = tab.getAttribute("data-panel");
    var current = panelId ? isShown(panelId) : tab.getAttribute("data-for") === "script" && !anyPanelOpen;
    if (current) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");

    var badgeId = tab.getAttribute("data-badge");
    var countEl = tab.querySelector<HTMLElement>(".phone-tab-count");
    if (!badgeId || !countEl) return;
    var badge = document.getElementById(badgeId);
    var n = badge && !badge.hidden ? badge.textContent : "";
    if (countEl.textContent !== n) countEl.textContent = n;
    countEl.hidden = !n;
    var label = tab.querySelector(".phone-tab-label");
    var words = COUNT_WORDS[badgeId] || ["", ""];
    if (n) tab.setAttribute("aria-label", (label ? label.textContent : "") + ", " + n + " " + words[n === "1" ? 0 : 1]);
    else tab.removeAttribute("aria-label");
  }

  function syncPhoneBar() {
    var bar = document.getElementById("phone-bar");
    if (!bar) return;
    var anyPanelOpen = PANEL_CLOSERS.some(function (pair) { return isShown(pair[0]); });
    bar.querySelectorAll<HTMLElement>(".phone-tab").forEach(function (tab) { syncTab(tab, anyPanelOpen); });
  }

  function closeOpenPanels() {
    PANEL_CLOSERS.forEach(function (pair) {
      if (!isShown(pair[0])) return;
      var close = document.getElementById(pair[1]);
      if (close) close.click();
    });
  }

  function onClick(e: Event) {
    var tab = e.target instanceof Element ? e.target.closest(".phone-tab") : null;
    if (!tab) return;
    var target = tab.getAttribute("data-for");
    if (target === "script") { closeOpenPanels(); return; }
    var btn = target ? document.getElementById(target) : null;
    if (btn) btn.click();
  }
  life.listen(bar, "click", onClick);

  if (typeof MutationObserver === "function") {
    var observer = new MutationObserver(function () { if (life.active()) syncPhoneBar(); });
    life.release(function () { observer.disconnect(); });
    PANEL_CLOSERS.forEach(function (pair) {
      var panel = document.getElementById(pair[0]);
      if (panel) observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
    });
    bar.querySelectorAll(".phone-tab[data-badge]").forEach(function (tab) {
      var badgeId = tab.getAttribute("data-badge");
      var badge = badgeId ? document.getElementById(badgeId) : null;
      if (badge) observer.observe(badge, { attributes: true, attributeFilter: ["hidden"], childList: true, characterData: true, subtree: true });
    });
  }
  syncPhoneBar();
  return { dispose: life.dispose };
}
