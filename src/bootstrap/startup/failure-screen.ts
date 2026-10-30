const PANEL_ID = "startup-failure";

interface FailureText {
  readonly summary: string;
  readonly details: string;
}

function readField(error: unknown, key: "name" | "message" | "stack"): string {
  if (typeof error !== "object" || error === null || !(key in error)) return "";
  const value: unknown = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function appVersion(doc: Document): string {
  const content = doc.querySelector('meta[name="splitpage-version"]')?.getAttribute("content") ?? "";
  return /^[\w.+-]+$/.test(content) ? content : "";
}

function describeFailure(error: unknown, doc: Document): FailureText {
  const name = readField(error, "name") || "Error";
  const message = readField(error, "message") || String(error);
  const summary = name + ": " + message;
  const stack = readField(error, "stack");
  const version = appVersion(doc);
  const lines = [summary];
  if (stack && stack !== summary) lines.push("", stack);
  lines.push("", "Splitpage version: " + (version || "unknown"));
  return { summary, details: lines.join("\n") };
}

function styled<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, style: Partial<CSSStyleDeclaration>, text = ""): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  Object.assign(element.style, style);
  if (text) element.textContent = text;
  return element;
}

const BUTTON: Partial<CSSStyleDeclaration> = {
  font: "inherit",
  padding: "8px 16px",
  marginRight: "8px",
  border: "1px solid #1a1a1a",
  borderRadius: "6px",
  background: "#ffffff",
  color: "#1a1a1a",
  cursor: "pointer"
};

export function showStartupFailure(error: unknown, doc: Document = document): void {
  if (doc.getElementById(PANEL_ID)) return;
  const text = describeFailure(error, doc);
  const panel = styled(doc, "div", {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    overflow: "auto",
    boxSizing: "border-box",
    padding: "48px 24px",
    background: "#ffffff",
    color: "#1a1a1a",
    font: "16px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif"
  });
  panel.id = PANEL_ID;
  panel.setAttribute("role", "alert");
  const column = styled(doc, "div", { maxWidth: "640px", margin: "0 auto" });
  const title = styled(doc, "h1", { fontSize: "24px", margin: "0 0 12px" }, "Splitpage couldn't start");
  const note = styled(doc, "p", { margin: "0 0 16px" }, "Your document data on disk has not been touched.");
  const block = styled(doc, "pre", {
    margin: "0 0 16px",
    padding: "12px",
    border: "1px solid #c8c8c8",
    borderRadius: "6px",
    background: "#f4f4f4",
    color: "#1a1a1a",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    font: "13px/1.4 ui-monospace, Consolas, monospace"
  });
  const code = styled(doc, "code", {}, text.summary);
  block.append(code);
  const copy = styled(doc, "button", BUTTON, "Copy details");
  copy.type = "button";
  copy.addEventListener("click", () => {
    const clipboard = doc.defaultView?.navigator.clipboard;
    const copying = clipboard ? clipboard.writeText(text.details) : Promise.reject(new Error("no clipboard"));
    copying.then(() => {
      copy.textContent = "Copied";
    }, () => {
      code.textContent = text.details;
      doc.getSelection()?.selectAllChildren(code);
      copy.textContent = "Selected: copy it with the keyboard";
    });
  });
  const reload = styled(doc, "button", BUTTON, "Reload");
  reload.type = "button";
  reload.addEventListener("click", () => {
    doc.defaultView?.location.reload();
  });
  column.append(title, note, block, copy, reload);
  panel.append(column);
  (doc.body ?? doc.documentElement).append(panel);
  reload.focus();
}
