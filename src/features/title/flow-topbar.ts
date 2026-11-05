import { writerFlowEnabled } from "../common/writer-flow-enabled.ts";
import { cellLinkPopoverHtml, writerToolbarButtonsHtml } from "../common/editable-cell.ts";

export function mountFlowTopbar(window: Window): { refresh: () => void; dispose: () => void } {
  const document = window.document;
  const body = document.body;
  const writer = document.getElementById("writer");
  const row = document.querySelector<HTMLElement>(".topbar-row");
  const mode = document.getElementById("btn-write");
  const title = document.getElementById("writer-title");
  const mainTitle = document.getElementById("doc-title");
  const close = document.getElementById("wr-close");
  if (!writer || !row || !mode || !title || !mainTitle || !close) return { refresh: () => {}, dispose: () => {} };
  const modeHome = document.createTextNode("");
  const titleHome = document.createTextNode("");
  mode.before(modeHome);
  title.before(titleHome);
  const closeHome = document.createTextNode("");
  close.before(closeHome);
  const bar = document.querySelector<HTMLElement>(".writer-bar");
  const oldButtons = Array.from(bar?.querySelectorAll(".wr-fmt") ?? []).filter(button =>
    ["bold", "italic", "underline", "highlight", "direction", "comment"].includes(button.getAttribute("data-cmd") ?? ""));
  const exportButton = document.getElementById("wr-export");
  const exportHome = document.createTextNode("");
  exportButton?.before(exportHome);
  const stats = document.querySelector(".writer-stats");
  const statsHome = document.createTextNode("");
  stats?.before(statsHome);
  let tools: HTMLElement | null = null;
  let active = true;

  function measure(): void {
    if (!active) return;
    body.style.setProperty("--writer-topbar-bottom", row?.getBoundingClientRect().bottom + "px");
  }

  function sync(): void {
    if (!active) return;
    const enabled = writerFlowEnabled(window);
    const open = enabled && writer?.hidden === false;
    body.classList.toggle("writer-flow-bar", enabled);
    body.classList.toggle("writer-flow-open", open);
    if (enabled) {
      if (!tools && bar) {
        tools = document.createElement("div");
        tools.className = "writer-format";
        tools.setAttribute("role", "toolbar");
        tools.setAttribute("aria-label", "Text formatting");
        tools.innerHTML = writerToolbarButtonsHtml();
        tools.querySelectorAll("button").forEach(button => button.classList.add("wr-fmt"));
        oldButtons.forEach(button => button.remove());
        bar.prepend(tools);
        tools.insertAdjacentHTML("beforeend", cellLinkPopoverHtml());
        if (stats) bar.append(stats);
        if (exportButton) {
          exportButton.classList.add("mi");
          exportButton.setAttribute("role", "menuitem");
          exportButton.setAttribute("data-file-action", "export-narration-docx");
          document.querySelector('[data-menu-group="export"]')?.append(exportButton);
        }
      }
      if (mode && mainTitle && mode.parentElement !== mainTitle.parentElement) mainTitle.before(mode);
      if (close && mainTitle && close.parentElement !== mainTitle.parentElement) mode?.after(close);
      if (close) close.textContent = "Split view";
      if (title && mainTitle && title.parentElement !== mainTitle.parentElement) mainTitle.before(title);
    } else {
      if (mode) modeHome.after(mode);
      if (title) titleHome.after(title);
    }
    measure();
  }

  sync();
  return { refresh: sync, dispose: () => {
    if (!active) return;
    active = false;
    modeHome.after(mode);
    titleHome.after(title);
    closeHome.after(close);
    close.textContent = "Close";
    tools?.remove();
    if (bar) oldButtons.reverse().forEach(button => bar.prepend(button));
    if (exportButton) {
      exportHome.after(exportButton);
      exportButton.classList.remove("mi");
      exportButton.removeAttribute("role");
      exportButton.removeAttribute("data-file-action");
    }
    if (stats) statsHome.after(stats);
    exportHome.remove();
    statsHome.remove();
    modeHome.remove();
    titleHome.remove();
    closeHome.remove();
    body.classList.remove("writer-flow-bar", "writer-flow-open");
    body.style.removeProperty("--writer-topbar-bottom");
  } };
}
