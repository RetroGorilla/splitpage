import { after } from "node:test";

export function trackGlobalListeners() {
  const globalListeners = new Map();
  const listenerProto = window.EventTarget.prototype, realAdd = listenerProto.addEventListener, realRemove = listenerProto.removeEventListener;
  const listenerSlot = (target, type, options) => (target === window ? "window " : "document ") + type
    + ((typeof options === "boolean" ? options : Boolean(options?.capture)) ? "/C" : "/B");
  listenerProto.addEventListener = function (type, listener, options) {
    const signal = options?.signal;
    if ((this === window || this === document) && listener && !signal?.aborted) {
      const slot = listenerSlot(this, type, options);
      if (!globalListeners.has(slot)) globalListeners.set(slot, new Set());
      const listeners = globalListeners.get(slot);
      if (!listeners.has(listener)) {
        listeners.add(listener);
        signal?.addEventListener("abort", () => listeners.delete(listener), { once: true });
      }
    }
    return realAdd.call(this, type, listener, options);
  };
  listenerProto.removeEventListener = function (type, listener, options) {
    if (this === window || this === document) globalListeners.get(listenerSlot(this, type, options))?.delete(listener);
    return realRemove.call(this, type, listener, options);
  };
  const listenerCounts = () => Object.fromEntries([...globalListeners].map(([slot, set]) => [slot, set.size]).filter(([, size]) => size > 0).sort());
  after(() => {
    listenerProto.addEventListener = realAdd;
    listenerProto.removeEventListener = realRemove;
  });
  return listenerCounts;
}
