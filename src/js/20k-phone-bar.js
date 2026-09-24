/* ================= the phone's bottom bar (#169, B-Phone) =================

   At phone width the header keeps File, the title, the clock and Present,
   and the modes and panels move to a bar along the bottom of the screen,
   under the thumb (app.css, the responsive block; #phone-bar in page.html).

   It is a second face for the header's own buttons, not a second set of
   controls: a tab clicks its header button, so every open, close, toggle
   and "Still loading…" / review-mode check stays in the one handler it
   already had (21-events.js), and the command menu and the desktop's
   native menu, which click those same buttons, agree with it for free.
   What the tabs show is read back the same way, by watching the elements
   that already say it — each panel's own `hidden`, and the header's count
   badges — so the modules that own those never need to know the bar
   exists.

   Script is the script itself: lit while no panel covers it, and tapping it
   closes the one that does, through that panel's own close button. */

/* Every side panel and its close button: Script closes whichever is open,
   Version history included, which has no tab of its own (it opens from
   File). */
var PANEL_CLOSERS = [
  ["production-panel", "production-close"],
  ["gear-panel", "gear-close"],
  ["broll-panel", "broll-close"],
  ["comments-panel", "comments-panel-close"],
  ["history-panel", "history-close"]
];

/* What a tab's count is counting, for its spoken name — the b-roll badge
   counts what is still to shoot, not every shot (updateBrollBadge,
   08c-broll.js). */
var COUNT_WORDS = {
  "production-badge": ["item", "items"],
  "gear-badge": ["item", "items"],
  "broll-badge": ["to shoot", "to shoot"],
  "comments-badge": ["open", "open"]
};

function isShown(id) {
  var el = document.getElementById(id);
  return !!el && !el.hidden;
}

function syncTab(tab, anyPanelOpen) {
  var panelId = tab.getAttribute("data-panel");
  var current = panelId ? isShown(panelId) : tab.getAttribute("data-for") === "script" && !anyPanelOpen;
  if (current) tab.setAttribute("aria-current", "page");
  else tab.removeAttribute("aria-current");

  var badgeId = tab.getAttribute("data-badge");
  var countEl = tab.querySelector(".phone-tab-count");
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
  bar.querySelectorAll(".phone-tab").forEach(function (tab) { syncTab(tab, anyPanelOpen); });
}

function closeOpenPanels() {
  PANEL_CLOSERS.forEach(function (pair) {
    if (!isShown(pair[0])) return;
    var close = document.getElementById(pair[1]);
    if (close) close.click();
  });
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  var bar = document.getElementById("phone-bar");
  if (!bar) return;

  bar.addEventListener("click", function (e) {
    var tab = e.target.closest ? e.target.closest(".phone-tab") : null;
    if (!tab) return;
    var target = tab.getAttribute("data-for");
    if (target === "script") { closeOpenPanels(); return; }
    var btn = document.getElementById(target);
    if (btn) btn.click();
  });

  /* One observer for everything the tabs mirror: a panel opening or
     closing flips its `hidden`, and a badge changes its `hidden` or its
     text. The records arrive in one batch per task, so a render that
     touches all four badges costs one sync; the sync writes only to the
     bar, which is not watched. */
  if (typeof MutationObserver === "function") {
    var observer = new MutationObserver(syncPhoneBar);
    PANEL_CLOSERS.forEach(function (pair) {
      var panel = document.getElementById(pair[0]);
      if (panel) observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
    });
    bar.querySelectorAll(".phone-tab[data-badge]").forEach(function (tab) {
      var badge = document.getElementById(tab.getAttribute("data-badge"));
      if (badge) observer.observe(badge, { attributes: true, attributeFilter: ["hidden"], childList: true, characterData: true, subtree: true });
    });
  }
  syncPhoneBar();
}
