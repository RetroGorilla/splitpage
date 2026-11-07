"use strict";

import type { DesktopTabStripBridge, DesktopWireShellState } from "../../shared/desktop-contract.d.ts";

(function () {
  const bridge = window.splitpageTabStrip;
  if (!bridge) {
    return;
  }

  const stripEl = document.getElementById("tabstrip");

  const tabsEl = document.createElement("div");
  tabsEl.className = "tabstrip__tabs";
  (stripEl as HTMLElement).appendChild(tabsEl);

  const newTabBtn = document.createElement("button");
  newTabBtn.type = "button";
  newTabBtn.className = "tabstrip__new";
  newTabBtn.setAttribute("aria-label", "New tab");
  newTabBtn.textContent = "+";
  newTabBtn.addEventListener("click", function () {
    bridge.newTab();
  });
  (stripEl as HTMLElement).appendChild(newTabBtn);

  let draggedTabId: string | null = null;

  function windowId() {
    return (bridge as DesktopTabStripBridge).windowId;
  }

  function render(state: DesktopWireShellState | null) {
    tabsEl.textContent = "";
    const tabs = (state && state.tabs) || [];
    for (let i = 0; i < tabs.length; i++) {
      tabsEl.appendChild(buildTabEl(state as DesktopWireShellState, tabs[i] as DesktopWireShellState["tabs"][number]));
    }
  }

  function buildTabEl(state: DesktopWireShellState, tab: DesktopWireShellState["tabs"][number]) {
    const el = document.createElement("div");
    el.className = "tab" + (tab.tabId === state.activeTabId ? " tab--active" : "");
    el.setAttribute("role", "tab");
    el.setAttribute("aria-selected", tab.tabId === state.activeTabId ? "true" : "false");
    if (tab.crashed) el.className += " tab--crashed";
    el.title = tab.crashed
      ? (tab.fullPathForTooltip || tab.title) + " — this tab stopped responding and was not reloaded"
      : (tab.fullPathForTooltip || tab.title) as string;
    el.dataset.tabId = tab.tabId;
    el.draggable = true;

    const titleEl = document.createElement("span");
    titleEl.className = "tab__title";
    titleEl.textContent = tab.title;
    el.appendChild(titleEl);

    if (tab.crashed) {
      const broken = document.createElement("span");
      broken.className = "tab__broken";
      broken.textContent = "!";
      broken.setAttribute("aria-label", "stopped responding");
      el.appendChild(broken);
    } else if (tab.dirty) {
      const dot = document.createElement("span");
      dot.className = "tab__dot";
      dot.setAttribute("aria-hidden", "true");
      el.appendChild(dot);
    }

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "tab__close";
    closeBtn.setAttribute("aria-label", "Close " + tab.title);
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      (bridge as DesktopTabStripBridge).closeTab(tab.tabId);
    });
    el.appendChild(closeBtn);

    el.addEventListener("click", function () {
      (bridge as DesktopTabStripBridge).activateTab(tab.tabId);
    });

    el.addEventListener("mousedown", function (e) {
      if (e.button === 1) e.preventDefault();
    });
    el.addEventListener("auxclick", function (e) {
      if (e.button === 1) (bridge as DesktopTabStripBridge).closeTab(tab.tabId);
    });

    el.addEventListener("dragstart", function (e) {
      draggedTabId = tab.tabId;
      (e.dataTransfer as DataTransfer).effectAllowed = "move";
      (e.dataTransfer as DataTransfer).setData(
        "application/x-splitpage-tab",
        JSON.stringify({ tabId: tab.tabId, sourceWindowId: windowId() })
      );
    });

    el.addEventListener("dragend", function (e) {
      const draggedId = draggedTabId;
      draggedTabId = null;
      clearDropMarkers();
      if (!draggedId) return;
      if ((e.dataTransfer as DataTransfer).dropEffect !== "none") return;
      const outside =
        e.clientX < 0 ||
        e.clientY < 0 ||
        e.clientX > window.innerWidth ||
        e.clientY > window.innerHeight;
      if (outside) {
        (bridge as DesktopTabStripBridge).tearOffToNewWindow(draggedId, e.screenX, e.screenY);
      }
    });

    el.addEventListener("dragover", function (e) {
      e.preventDefault();
      (e.dataTransfer as DataTransfer).dropEffect = "move";
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

  function markDropSide(el: HTMLElement, clientX: number) {
    const rect = el.getBoundingClientRect();
    const before = clientX < rect.left + rect.width / 2;
    el.classList.toggle("tab--drop-before", before);
    el.classList.toggle("tab--drop-after", !before);
  }

  function clearDropMarkers() {
    const marked = tabsEl.querySelectorAll(".tab--drop-before, .tab--drop-after");
    for (let i = 0; i < marked.length; i++) {
      (marked[i] as Element).classList.remove("tab--drop-before", "tab--drop-after");
    }
  }

  function dropIndexForTarget(el: HTMLElement, clientX: number) {
    const pills = Array.prototype.slice.call(tabsEl.children) as Element[];
    const index = pills.indexOf(el);
    const rect = el.getBoundingClientRect();
    const before = clientX < rect.left + rect.width / 2;
    return before ? index : index + 1;
  }

  function handleDrop(e: DragEvent, dropIndex: number) {
    clearDropMarkers();
    const raw = (e.dataTransfer as DataTransfer).getData("application/x-splitpage-tab");
    if (!raw) return;
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      return;
    }
    const tabId = payload ? (payload as Record<string, unknown>).tabId : null;
    if (typeof tabId !== "string" || !tabId) return;
    if ((payload as Record<string, unknown>).sourceWindowId === windowId()) {
      (bridge as DesktopTabStripBridge).reorderTab(tabId, dropIndex);
    } else {
      (bridge as DesktopTabStripBridge).moveTabHere(tabId, dropIndex);
    }
  }

  function dropIndexForPoint(clientX: number) {
    const pills = tabsEl.children;
    for (let i = 0; i < pills.length; i++) {
      const rect = (pills[i] as Element).getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return i;
    }
    return pills.length;
  }

  tabsEl.addEventListener("dragover", function (e) {
    e.preventDefault();
    (e.dataTransfer as DataTransfer).dropEffect = "move";
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
    const overlay = navigator.windowControlsOverlay;
    if (!overlay || !overlay.getTitlebarAreaRect) return;
    const rect = overlay.getTitlebarAreaRect();
    if (!rect || !rect.width) return;
    const inset = Math.max(0, window.innerWidth - (rect.x + rect.width));
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

interface TabstripPageOverlay extends Pick<EventTarget, "addEventListener"> {
  getTitlebarAreaRect?: () => DOMRect | null;
}

declare global {
  interface Window { splitpageTabStrip?: DesktopTabStripBridge; }
  interface Navigator { windowControlsOverlay?: TabstripPageOverlay; }
}
