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
  const stats = document.querySelector(".writer-stats");
  const statsHome = document.createTextNode("");
  stats?.before(statsHome);
  let tools: HTMLElement | null = null;
  let active = true;

  function restoreControls(): void {
    if (mode) modeHome.after(mode);
    if (title) titleHome.after(title);
    if (close) { closeHome.after(close); close.textContent = "Close"; }
    tools?.remove();
    tools = null;
    if (stats) statsHome.after(stats);
    body.classList.remove("writer-flow-bar", "writer-flow-open");
    body.style.removeProperty("--writer-topbar-bottom");
  }

  function measure(): void {
    if (!active) return;
    body.style.setProperty("--writer-topbar-bottom", row?.getBoundingClientRect().bottom + "px");
  }

  function sync(): void {
    if (!active) return;
    const open = writer?.hidden === false;
    body.classList.add("writer-flow-bar");
    body.classList.toggle("writer-flow-open", open);
    if (!tools && bar) {
      tools = document.createElement("div");
      tools.className = "writer-format";
      tools.setAttribute("role", "toolbar");
      tools.setAttribute("aria-label", "Text formatting");
      tools.innerHTML = writerToolbarButtonsHtml();
      tools.querySelectorAll("button").forEach(button => button.classList.add("wr-fmt"));
      bar.prepend(tools);
      tools.insertAdjacentHTML("beforeend", cellLinkPopoverHtml());
      if (stats) bar.append(stats);
    }
    if (mode && mainTitle && mode.parentElement !== mainTitle.parentElement) mainTitle.before(mode);
    if (close && mainTitle && close.parentElement !== mainTitle.parentElement) mode?.after(close);
    if (close) close.textContent = "Split view";
    if (title && mainTitle && title.parentElement !== mainTitle.parentElement) mainTitle.before(title);
    measure();
  }

  sync();
  return { refresh: sync, dispose: () => {
    if (!active) return;
    active = false;
    restoreControls();
    statsHome.remove();
    modeHome.remove();
    titleHome.remove();
    closeHome.remove();
  } };
}
