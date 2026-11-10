import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export class SliceProtocol {
  private serial = 0;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  readonly socket: WebSocket;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", event => {
      const response = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
      if (!response.id) return;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.error) pending.reject(new Error(response.error.message));
      else pending.resolve(response.result ?? {});
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Protocol closed")); }
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<SliceProtocol> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Protocol connection failed")), { once: true });
    });
    return new SliceProtocol(socket);
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Protocol timeout: ${method}`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return (response.result as { value: T }).value;
  }

  async key(key: string, modifiers = 0): Promise<void> {
    const codes: Record<string, number> = { Backspace: 8, Delete: 46, Enter: 13, Home: 36, End: 35, ArrowLeft: 37, ArrowRight: 39, a: 65, c: 67, v: 86, x: 88, z: 90 };
    const windowsVirtualKeyCode = codes[key] ?? key.toUpperCase().charCodeAt(0);
    const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
    await this.call("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode, modifiers, ...(key === "Enter" ? { text: "\r" } : {}) });
    await this.call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode, modifiers });
  }

  async insert(text: string): Promise<void> { await this.call("Input.insertText", { text }); }
  async compose(text: string): Promise<void> { await this.call("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length }); }
}

export async function withSliceBrowser<T>(run: (protocol: SliceProtocol, version: Record<string, unknown>, directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "browser-slice-"));
  const programFiles = process.env["ProgramFiles(x86)"] ?? `${process.env.SystemDrive ?? "C:"}\\Program Files (x86)`;
  const executable = process.env.SLICE_EDGE ?? join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe");
  const child = spawn(executable, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${join(directory, "profile")}`, "--no-first-run", "--no-default-browser-check", "--disable-features=Translate,msEdgeSplitScreen,msImplicitSignin", "--disable-sync", "--disable-background-networking", "about:blank"], { windowsHide: true, stdio: "ignore" });
  let spawnError: Error | null = null;
  child.on("error", error => { spawnError = error; });
  let protocol: SliceProtocol | null = null;
  try {
    let port = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError) throw spawnError;
      try { port = (await readFile(join(directory, "profile", "DevToolsActivePort"), "utf8")).split("\n")[0] ?? ""; } catch {}
      if (port) break;
      await delay(100);
    }
    if (!port) throw new Error("Edge debugging port did not open");
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await response.json() as { type: string; webSocketDebuggerUrl: string }[];
    const target = targets.find(target => target.type === "page");
    if (!target) throw new Error("No Edge page target");
    protocol = await SliceProtocol.connect(target.webSocketDebuggerUrl);
    return await run(protocol, await protocol.call("Browser.getVersion"), directory);
  } finally {
    if (protocol) {
      try { await protocol.call("Browser.close"); } catch {}
      protocol.socket.close();
    }
    if (child.exitCode === null && child.pid) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          if (process.platform === "win32") {
            const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
            killer.once("exit", () => resolve());
          } else { child.kill("SIGKILL"); resolve(); }
        }, 2000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
