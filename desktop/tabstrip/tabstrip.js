/* Splitpage desktop — title-bar tab strip renderer.
 *
 * Plain browser JS (var/function, no modules) per HOUSE-RULES; this file is
 * not part of the src/js build.mjs concatenation and is loaded on its own,
 * only from splitpage://tabstrip. Its sole API surface is
 * window.splitpageTabStrip (TABSTRIP-BRIDGE, desktop/tabstrip-preload.js).
 * This page holds no document data beyond the ShellState it renders and
 * makes no fetches of its own.
 */

"use strict";

(function () {
  var bridge = window.splitpageTabStrip;
  if (!bridge) {
    /* Loaded somewhere other than splitpage://tabstrip — e.g. opened
       directly for a visual check outside Electron. Nothing to wire up;
       the preload only defines the bridge on the trusted origin. */
    return;
  }

  var stripEl = document.getElementById("tabstrip");

  var tabsEl = document.createElement("div");
  tabsEl.className = "tabstrip__tabs";
  stripEl.appendChild(tabsEl);

  var newTabBtn = document.createElement("button");
  newTabBtn.type = "button";
  newTabBtn.className = "tabstrip__new";
  newTabBtn.setAttribute("aria-label", "New tab");
  newTabBtn.textContent = "+";
  newTabBtn.addEventListener("click", function () {
    bridge.newTab();
  });
  stripEl.appendChild(newTabBtn);

  var SERVER_ICON_SVG =
    '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<rect x="1.5" y="2.5" width="13" height="4" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"></rect>' +
    '<rect x="1.5" y="9.5" width="13" height="4" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"></rect>' +
    '<circle cx="4" cy="4.5" r="0.75" fill="currentColor"></circle>' +
    '<circle cx="4" cy="11.5" r="0.75" fill="currentColor"></circle>' +
    "</svg>";

  var draggedTabId = null;

  function windowId() {
    return bridge.windowId;
  }

  function render(state) {
    tabsEl.textContent = "";
    var tabs = (state && state.tabs) || [];
    for (var i = 0; i < tabs.length; i++) {
      tabsEl.appendChild(buildTabEl(state, tabs[i]));
    }
  }

  function buildTabEl(state, tab) {
    var el = document.createElement("div");
    el.className = "tab" + (tab.tabId === state.activeTabId ? " tab--active" : "");
    el.setAttribute("role", "tab");
    el.setAttribute("aria-selected", tab.tabId === state.activeTabId ? "true" : "false");
    /* A tab whose renderer died and was not reloaded has no page behind it.
       Main already treats it as never-unsaved (it closes with no prompt), so
       the strip must not keep showing it as an ordinary tab with unsaved
       work — it says what actually happened instead. */
    if (tab.crashed) el.className += " tab--crashed";
    el.title = tab.crashed
      ? (tab.fullPathForTooltip || tab.title) + " — this tab stopped responding and was not reloaded"
      : (tab.fullPathForTooltip || tab.title);
    el.dataset.tabId = tab.tabId;
    el.draggable = true;

    if (tab.isServerDoc) {
      var icon = document.createElement("span");
      icon.className = "tab__icon";
      icon.innerHTML = SERVER_ICON_SVG;
      el.appendChild(icon);
    }

    var titleEl = document.createElement("span");
    titleEl.className = "tab__title";
    titleEl.textContent = tab.title;
    el.appendChild(titleEl);

    /* main never reports dirty AND crashed together (shellStateForWindow
       suppresses the dirty flag for a crashed tab), so these are two
       different marks, not one overriding the other. */
    if (tab.crashed) {
      var broken = document.createElement("span");
      broken.className = "tab__broken";
      broken.textContent = "!";
      broken.setAttribute("aria-label", "stopped responding");
      el.appendChild(broken);
    } else if (tab.dirty) {
      var dot = document.createElement("span");
      dot.className = "tab__dot";
      dot.setAttribute("aria-hidden", "true");
      el.appendChild(dot);
    }

    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "tab__close";
    closeBtn.setAttribute("aria-label", "Close " + tab.title);
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      bridge.closeTab(tab.tabId);
    });
    el.appendChild(closeBtn);

    el.addEventListener("click", function () {
      bridge.activateTab(tab.tabId);
    });

    /* Middle click closes, same path as Ctrl+W. mousedown's preventDefault
       stops Chromium's autoscroll cursor from appearing on the press;
       auxclick (fired on release) is what actually closes the tab. */
    el.addEventListener("mousedown", function (e) {
      if (e.button === 1) e.preventDefault();
    });
    el.addEventListener("auxclick", function (e) {
      if (e.button === 1) bridge.closeTab(tab.tabId);
    });

    el.addEventListener("dragstart", function (e) {
      draggedTabId = tab.tabId;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(
        "application/x-splitpage-tab",
        JSON.stringify({ tabId: tab.tabId, sourceWindowId: windowId() })
      );
    });

    el.addEventListener("dragend", function (e) {
      var draggedId = draggedTabId;
      draggedTabId = null;
      clearDropMarkers();
      if (!draggedId) return;
      if (e.dataTransfer.dropEffect !== "none") return;
      /* The strip IS the whole window (36px tall, full width), so "outside
         the strip bounds" is the same as "outside this window's
         viewport" — dropped over the document view below, another
         window, or open desktop. */
      var outside =
        e.clientX < 0 ||
        e.clientY < 0 ||
        e.clientX > window.innerWidth ||
        e.clientY > window.innerHeight;
      if (outside) {
        bridge.tearOffToNewWindow(draggedId, e.screenX, e.screenY);
      }
    });

    el.addEventListener("dragover", function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      markDropSide(el, e.clientX);
    });

    el.addEventListener("dragleave", function () {
      el.classList.remove("tab--drop-before", "tab--drop-after");
    });

    el.addEventListener("drop", function (e) {
      e.preventDefault();
      handleDrop(e, dropIndexForTarget(el, e.clientX));
    });

    return el;
  }

  function markDropSide(el, clientX) {
    var rect = el.getBoundingClientRect();
    var before = clientX < rect.left + rect.width / 2;
    el.classList.toggle("tab--drop-before", before);
    el.classList.toggle("tab--drop-after", !before);
  }

  function clearDropMarkers() {
    var marked = tabsEl.querySelectorAll(".tab--drop-before, .tab--drop-after");
    for (var i = 0; i < marked.length; i++) {
      marked[i].classList.remove("tab--drop-before", "tab--drop-after");
    }
  }

  /* The index, in the CURRENT (pre-drop) tab order, that the dragged tab
     should land at — used for both an in-strip reorder and a drop arriving
     from another window's strip. */
  function dropIndexForTarget(el, clientX) {
    var pills = Array.prototype.slice.call(tabsEl.children);
    var index = pills.indexOf(el);
    var rect = el.getBoundingClientRect();
    var before = clientX < rect.left + rect.width / 2;
    return before ? index : index + 1;
  }

  function handleDrop(e, dropIndex) {
    clearDropMarkers();
    var raw = e.dataTransfer.getData("application/x-splitpage-tab");
    if (!raw) return;
    var payload;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      return;
    }
    if (!payload || !payload.tabId) return;
    if (payload.sourceWindowId === windowId()) {
      bridge.reorderTab(payload.tabId, dropIndex);
    } else {
      bridge.moveTabHere(payload.tabId, dropIndex);
    }
  }

  /* A drop on the row itself rather than on a pill: past the last tab, or in
     the small gap between two tabs (the row is no-drag now, so it receives
     drops there). The index comes from the pointer's position, so a drop in a
     gap lands in that gap: the first pill whose midpoint is right of the
     pointer, or the end. Always sending it to the end moved a tab dropped
     between the first two all the way to the right. */
  function dropIndexForPoint(clientX) {
    var pills = tabsEl.children;
    for (var i = 0; i < pills.length; i++) {
      var rect = pills[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return i;
    }
    return pills.length;
  }

  tabsEl.addEventListener("dragover", function (e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  });
  tabsEl.addEventListener("drop", function (e) {
    if (e.target === tabsEl) {
      e.preventDefault();
      handleDrop(e, dropIndexForPoint(e.clientX));
    }
  });

  bridge.onShellStateChanged(render);
  Promise.resolve(bridge.getShellState()).then(render);

  /* --- Windows caption-button inset (TABSTRIP-BRIDGE "Layout") ----------
   *
   * navigator.windowControlsOverlay.getTitlebarAreaRect() reports the part
   * of the title bar NOT covered by the OS's own min/max/close buttons.
   * Its right edge tells us how much padding the strip needs so a tab is
   * never drawn under those buttons. geometrychange fires when the window
   * is resized, maximized/restored, or moved between monitors with
   * different scale factors. Falls back to a fixed 150px on win32 when the
   * overlay API itself is unavailable; see --titlebar-inset in
   * tabstrip.css for the same default.
   */
  function applyTitlebarInset() {
    var overlay = navigator.windowControlsOverlay;
    if (!overlay || !overlay.getTitlebarAreaRect) return;
    /* Fullscreen hides the OS caption buttons: the overlay reports
       visible:false and an all-zero rect. Returning early there left the
       windowed inset (150px on Windows) reserved on a strip that now has
       nothing to avoid, and — because the stale value is only corrected by
       the NEXT geometrychange — the strip came back from fullscreen still
       padded for a window of the wrong width, with the tabs squeezed. No
       buttons means no inset. */
    if (overlay.visible === false) {
      document.documentElement.style.setProperty("--titlebar-inset", "0px");
      return;
    }
    var rect = overlay.getTitlebarAreaRect();
    if (!rect || !rect.width) return;
    var inset = Math.max(0, window.innerWidth - (rect.x + rect.width));
    document.documentElement.style.setProperty("--titlebar-inset", inset + "px");
  }

  /* The inset is a difference between two numbers that do not land in the
     same frame: geometrychange can arrive while window.innerWidth still
     reports the size the window is leaving (the fullscreen width, on the
     way back to a window), which measures an inset hundreds of pixels too
     wide. Settling for a frame past the last event — resize included,
     since a fullscreen exit is also a resize — measures both from the same
     layout. */
  var insetFrame = 0;
  function scheduleTitlebarInset() {
    if (insetFrame) cancelAnimationFrame(insetFrame);
    insetFrame = requestAnimationFrame(function () {
      insetFrame = requestAnimationFrame(function () {
        insetFrame = 0;
        applyTitlebarInset();
      });
    });
  }

  if (navigator.windowControlsOverlay) {
    navigator.windowControlsOverlay.addEventListener("geometrychange", scheduleTitlebarInset);
    window.addEventListener("resize", scheduleTitlebarInset);
    applyTitlebarInset();
  } else if (bridge.platform === "win32") {
    document.documentElement.style.setProperty("--titlebar-inset", "150px");
  } else {
    document.documentElement.style.setProperty("--titlebar-inset", "0px");
  }
})();
