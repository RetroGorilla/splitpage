import { SliceProtocol } from "../slice/protocol.ts";

export interface LocalBrowserPage {
  targetId: string;
  protocol: SliceProtocol;
  dispose: () => Promise<void>;
}

export const localFixtureOrigin = "https://local-replica.test";

export async function localBrowserPage(control: SliceProtocol, script: string, origin = localFixtureOrigin): Promise<LocalBrowserPage> {
  return localBrowserDocument(control, `<!doctype html><title>Local replica experiment</title><body><script>${script.replaceAll("</script", "<\\/script")}</script>`, origin,
    "new Promise((resolve,reject) => { const ready=() => window.localExperiment ? resolve(true) : reject(new Error('Missing local fixture')); if(document.readyState === 'complete') ready(); else addEventListener('load',ready,{once:true}); })");
}

export async function localBrowserDocument(control: SliceProtocol, html: string, origin: string, ready: string): Promise<LocalBrowserPage> {
  const created = await control.call("Target.createTarget", { url: "about:blank", newWindow: true });
  const targetId = String(created.targetId);
  const endpoint = new URL(control.socket.url);
  const response = await fetch(`http://${endpoint.host}/json/list`);
  const targets = await response.json() as { id: string; webSocketDebuggerUrl: string }[];
  const target = targets.find(target => target.id === targetId);
  if (!target) throw new Error(`Missing browser target ${targetId}`);
  const protocol = await SliceProtocol.connect(target.webSocketDebuggerUrl);
  const failures: Error[] = [];
  const listener = (event: MessageEvent): void => {
    const message = JSON.parse(String(event.data)) as { method?: string; params?: { requestId: string } };
    if (message.method !== "Fetch.requestPaused" || !message.params) return;
    const body = Buffer.from(html).toString("base64");
    void protocol.call("Fetch.fulfillRequest", { requestId: message.params.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/html" }], body }).catch(error => { failures.push(error as Error); });
  };
  protocol.socket.addEventListener("message", listener);
  await protocol.call("Fetch.enable", { patterns: [{ urlPattern: `${origin}/*` }] });
  await protocol.call("Page.enable");
  await protocol.call("Page.navigate", { url: `${origin}/fixture` });
  await protocol.evaluate(ready);
  if (failures.length) throw failures[0];
  return {
    targetId, protocol,
    dispose: async () => {
      protocol.socket.removeEventListener("message", listener);
      await control.call("Target.closeTarget", { targetId });
      protocol.socket.close();
    }
  };
}

export async function crashLocalRenderer(page: LocalBrowserPage): Promise<void> {
  const crashed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { page.protocol.socket.removeEventListener("message", listener); reject(new Error("Renderer did not crash")); }, 10000);
    const listener = (event: MessageEvent): void => {
      const message = JSON.parse(String(event.data)) as { method?: string };
      if (message.method === "Inspector.targetCrashed") {
        clearTimeout(timer);
        page.protocol.socket.removeEventListener("message", listener);
        resolve();
      }
    };
    page.protocol.socket.addEventListener("message", listener);
  });
  await page.protocol.call("Inspector.enable");
  void page.protocol.call("Page.crash").catch(() => undefined);
  await crashed;
}

export async function reloadLocalPage(page: LocalBrowserPage): Promise<void> {
  const loaded = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { page.protocol.socket.removeEventListener("message", listener); reject(new Error("Reload did not finish")); }, 10000);
    const listener = (event: MessageEvent): void => {
      const message = JSON.parse(String(event.data)) as { method?: string };
      if (message.method === "Page.loadEventFired") {
        clearTimeout(timer);
        page.protocol.socket.removeEventListener("message", listener);
        resolve();
      }
    };
    page.protocol.socket.addEventListener("message", listener);
  });
  await page.protocol.call("Page.reload");
  await loaded;
}
