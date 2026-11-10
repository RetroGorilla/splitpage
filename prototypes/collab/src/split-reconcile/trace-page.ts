interface ReconcileTraceEntry {
  site: string; depth: number; stack: string; detail?: unknown;
}

const traceLog: ReconcileTraceEntry[] = [];
let domDepth = 0;
const traceRealm = window as unknown as {
  __splitCall: (site: string) => void;
  splitTrace: { clear: () => void; snapshot: () => ReconcileTraceEntry[] };
};
Error.stackTraceLimit = 60;
function log(site: string, detail?: unknown): void {
  traceLog.push({ site, depth: domDepth, stack: new Error(site).stack ?? "", ...(detail === undefined ? {} : { detail }) });
}
traceRealm.__splitCall = site => { log(site); };
const addListener = EventTarget.prototype.addEventListener;
const removeListener = EventTarget.prototype.removeEventListener;
const listeners = new WeakMap<EventListener, EventListener>();
EventTarget.prototype.addEventListener = function (type, listener, options) {
  if (type !== "focusout" || typeof listener !== "function" || !(this instanceof Element) || this.id !== "rows") return addListener.call(this, type, listener, options);
  const wrapped: EventListener = function (this: EventTarget, event) {
    log("focusout-handler:enter", { phase: event.eventPhase, source: listener.toString() });
    try { listener.call(this, event); } finally { log("focusout-handler:exit"); }
  };
  listeners.set(listener, wrapped);
  return addListener.call(this, type, wrapped, options);
};
EventTarget.prototype.removeEventListener = function (type, listener, options) {
  return removeListener.call(this, type, typeof listener === "function" ? listeners.get(listener) ?? listener : listener, options);
};
const nodeIds = new WeakMap<Node, number>();
let nextNode = 1;
const nodeLabel = (node: Node): string => {
  if (!nodeIds.has(node)) nodeIds.set(node, nextNode++);
  const label = node instanceof Element ? `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}.${node.className}[${node.getAttribute("data-id") ?? ""}]` : node.nodeName;
  return `${label}@${nodeIds.get(node)}`;
};
const replace = Node.prototype.replaceChild;
const remove = Node.prototype.removeChild;
Node.prototype.replaceChild = function <T extends Node>(fresh: Node, old: T): T {
  const watched = this instanceof Element && (this.id === "rows" || !!this.closest("#rows"));
  if (!watched) return replace.call(this, fresh, old) as T;
  log("replaceChild:enter", { parent: nodeLabel(this), old: nodeLabel(old), fresh: nodeLabel(fresh) });
  domDepth++;
  try { return replace.call(this, fresh, old) as T; }
  catch (error) { log("replaceChild:throw", String(error)); throw error; }
  finally { domDepth--; log("replaceChild:exit"); }
};
Node.prototype.removeChild = function <T extends Node>(old: T): T {
  const watched = this instanceof Element && (this.id === "rows" || !!this.closest("#rows"));
  if (!watched) return remove.call(this, old) as T;
  log("removeChild:enter", { parent: nodeLabel(this), old: nodeLabel(old) });
  domDepth++;
  try { return remove.call(this, old) as T; }
  catch (error) { log("removeChild:throw", String(error)); throw error; }
  finally { domDepth--; log("removeChild:exit"); }
};
window.addEventListener("focusout", event => {
  if (event.target instanceof Element && event.target.closest("#rows")) log("focusout:capture", { target: nodeLabel(event.target) });
}, true);
window.addEventListener("focusout", event => {
  if (event.target instanceof Element && event.target.closest("#rows")) log("focusout:window-bubble");
});
traceRealm.splitTrace = { clear: () => { traceLog.length = 0; }, snapshot: () => structuredClone(traceLog) };
