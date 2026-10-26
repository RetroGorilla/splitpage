let PAGE_SHELL: string;

export function capturePageShell(): void {
  PAGE_SHELL = "<!doctype html>" + document.documentElement.outerHTML;
}

export function defaultState() {
  try {
    return JSON.parse((document.getElementById("state-data") as HTMLElement).textContent as string);
  } catch (e) {
    return { title: "Untitled Script", rows: [] };
  }
}

export function buildPublishHtml(stateJson: unknown) {
  const CLOSE_SCRIPT = "<" + "/script>";
  const openTag = '<script id="state-data" type="application/json">';
  const start = PAGE_SHELL.indexOf(openTag);
  if (start === -1) throw new Error("state-data anchor missing from the page shell");
  const openEnd = start + openTag.length;
  const close = PAGE_SHELL.indexOf(CLOSE_SCRIPT, openEnd);
  if (close === -1) throw new Error("state-data closing tag missing from the page shell");
  const safeJson = String(stateJson).replace(/<\//g, "<\\/");
  return PAGE_SHELL.slice(0, openEnd) + "\n" + safeJson + "\n" + PAGE_SHELL.slice(close);
}

