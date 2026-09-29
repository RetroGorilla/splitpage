"use strict";

(function () {
  var bridge = window.splitpageTabStrip;
  if (!bridge) {
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

  function applyTitlebarInset() {
    var overlay = navigator.windowControlsOverlay;
    if (!overlay || !overlay.getTitlebarAreaRect) return;
    var rect = overlay.getTitlebarAreaRect();
    if (!rect || !rect.width) return;
    var inset = Math.max(0, window.innerWidth - (rect.x + rect.width));
    document.documentElement.style.setProperty("--titlebar-inset", inset + "px");
  }

  if (navigator.windowControlsOverlay) {
    navigator.windowControlsOverlay.addEventListener("geometrychange", applyTitlebarInset);
    applyTitlebarInset();
  } else if (bridge.platform === "win32") {
    document.documentElement.style.setProperty("--titlebar-inset", "150px");
  } else {
    document.documentElement.style.setProperty("--titlebar-inset", "0px");
  }
})();
