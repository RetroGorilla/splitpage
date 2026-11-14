import assert from "node:assert/strict";
import { bufferedWriter, keyOf, pressKey, releaseKey } from "./buffer-support.ts";
import { headingPos } from "../../../src/core/flow/flow.ts";
import type { FlowDoc } from "../../../src/core/flow/flow.ts";
import type { SurfacePorts } from "../../../src/features/writer/flow-surface.ts";

export type HeadedPage = ReturnType<typeof headedWriter>;

export function sceneNames(doc: object | null): string[] {
  const sections: unknown = doc && "sections" in doc ? doc.sections : undefined;
  return Array.isArray(sections) ? sections.map((scene: { readonly name: string }) => scene.name) : [];
}

export function headedWriter(name = "Scene", command?: SurfacePorts["commit"], options: Parameters<typeof bufferedWriter>[4] = {}) {
  const page = bufferedWriter("ab", true, command, undefined, { ...options, fields: { sections: [{ id: "H1", name, firstSceneId: "R1" }] } });
  const element = () => { const found = page.root.querySelector<HTMLElement>('.wr-heading[data-scene="H1"]'); assert.ok(found); return found; };
  const press = (init: KeyboardEventInit): boolean => page.root.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  function typeHeading(from: number, to: number, insert: string, type = "insertText", during?: () => void, reportInput = true,
    modified?: KeyboardEventInit): boolean {
    const target = { anchor: headingPos("H1", from), head: headingPos("H1", to) }, key = modified?.key ?? keyOf(type, insert);
    page.surface.place(target);
    if (!(modified ? press(modified) : pressKey(page.root, key))) return false;
    const range = page.surface.domRange(target); assert.ok(range);
    const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: type, data: insert });
    const nativeTarget = range.cloneRange();
    Object.defineProperty(event, "getTargetRanges", { value: () => [nativeTarget] });
    if (!page.root.dispatchEvent(event)) { releaseKey(page.root, key); return false; }
    during?.();
    const heading = element(), value = heading.textContent ?? "";
    heading.textContent = value.slice(0, from) + insert + value.slice(to);
    const node = heading.firstChild ?? heading.appendChild(document.createTextNode(""));
    window.getSelection()?.setBaseAndExtent(node, from + insert.length, node, from + insert.length);
    if (reportInput) page.root.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: type, data: insert }));
    releaseKey(page.root, key);
    return true;
  }
  function holdHeading(key: "Backspace" | "Delete", from: number, to: number, repeats: number): number {
    const type = key === "Backspace" ? "deleteContentBackward" : "deleteContentForward";
    let count = 0, anchor = from, head = to;
    page.surface.place({ anchor: headingPos("H1", from), head: headingPos("H1", to) });
    for (let stroke = 0; stroke <= repeats; stroke++) {
      if (!press({ key, repeat: stroke > 0 })) continue;
      const value = element().textContent ?? "";
      const [start, end] = anchor !== head ? [anchor, head] : key === "Backspace" ? [Math.max(0, anchor - 1), anchor] : [anchor, Math.min(value.length, anchor + 1)];
      const range = page.surface.domRange({ anchor: headingPos("H1", start), head: headingPos("H1", end) }); assert.ok(range);
      const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: type });
      const nativeTarget = range.cloneRange();
      Object.defineProperty(event, "getTargetRanges", { value: () => [nativeTarget] });
      if (!page.root.dispatchEvent(event) || start === end) continue;
      const heading = element();
      heading.textContent = value.slice(0, start) + value.slice(end);
      const node = heading.firstChild ?? heading.appendChild(document.createTextNode(""));
      window.getSelection()?.setBaseAndExtent(node, start, node, start);
      page.root.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: type }));
      anchor = head = start; count++;
    }
    releaseKey(page.root, key);
    return count;
  }
  function selectionMoved(): void {
    document.dispatchEvent(new window.Event("selectionchange"));
  }
  function leaveTo(node: Node, offset: number): void {
    window.getSelection()?.setBaseAndExtent(node, offset, node, offset);
    selectionMoved();
  }
  return {
    ...page, element, typeHeading, holdHeading, press, selectionMoved, leaveTo,
    name: () => page.a.session.read(doc => sceneNames(doc as FlowDoc | null)[0]),
    startHeading: (from: number, to = from) => {
      page.surface.place({ anchor: headingPos("H1", from), head: headingPos("H1", to) });
      page.root.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    }
  };
}
