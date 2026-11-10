import type { splitReconcileContext } from "../split-reconcile/page.ts";

type StaleObservedContext = Pick<ReturnType<typeof splitReconcileContext>, "session" | "bridge" | "value" | "selected" | "host" | "model">;

export function startStaleProbe(context: StaleObservedContext): void {
  const states: { site: string; state: ReturnType<typeof snapshot>; input?: unknown }[] = [];
  const realm = window as unknown as { __splitCall?: (site: string) => void; staleProbe: unknown };
  const nodeIds = new WeakMap<Node, number>(); let serial = 1;
  function snapshot() {
    const buffer = context.session().alice;
    const selectedNode = window.getSelection()?.anchorNode;
    const element = selectedNode?.parentElement?.closest(".wr-beat, .cell-editable");
    if (element && !nodeIds.has(element)) nodeIds.set(element, serial++);
    return { dom: context.value(), selection: context.selected(), selectedElement: element ? nodeIds.get(element) : null,
      paintHeld: buffer.paintHeld, dirty: buffer.dirty, composing: buffer.composing, nativeBaseChanged: buffer.nativeBaseChanged(),
      painted: buffer.painted ? { id: buffer.painted.id, value: buffer.painted.value, names: [...buffer.painted.names], identities: buffer.painted.identities.map(identity => ({ ...identity })), version: buffer.painted.version } : null,
      model: context.model() };
  }
  const project = context.bridge.project;
  context.bridge.project = rows => {
    realm.__splitCall?.("binding.project:before");
    project(rows);
    realm.__splitCall?.("binding.project:after");
  };
  const repaint = context.bridge.repaint;
  context.bridge.repaint = () => {
    realm.__splitCall?.("binding.requestRepaint");
    states.push({ site: "binding.requestRepaint", state: snapshot() });
    repaint();
  };
  window.addEventListener("beforeinput", event => {
    const input = event as InputEvent;
    if (!(event.target instanceof Element) || !context.host.contains(event.target)) return;
    realm.__splitCall?.("native.begin");
    states.push({ site: "native.begin", state: snapshot(), input: { trusted: event.isTrusted, type: input.inputType, data: input.data, defaultPrevented: event.defaultPrevented } });
  }, true);
  realm.staleProbe = { mark: (site: string) => { states.push({ site, state: snapshot() }); }, clear: () => { states.length = 0; }, snapshot: () => ({ state: snapshot(), states: structuredClone(states) }) };
}
