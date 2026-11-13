import assert from "node:assert/strict";
import { bufferedWriter } from "./buffer-support.ts";
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
  function typeHeading(from: number, to: number, insert: string, type = "insertText", during?: () => void, reportInput = true): boolean {
    const target = { anchor: headingPos("H1", from), head: headingPos("H1", to) };
    page.surface.place(target);
    const range = page.surface.domRange(target); assert.ok(range);
    const event = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: type, data: insert });
    const nativeTarget = range.cloneRange();
    Object.defineProperty(event, "getTargetRanges", { value: () => [nativeTarget] });
    if (!page.root.dispatchEvent(event)) return false;
    during?.();
    const heading = element(), value = heading.textContent ?? "";
    heading.textContent = value.slice(0, from) + insert + value.slice(to);
    const node = heading.firstChild ?? heading.appendChild(document.createTextNode(""));
    window.getSelection()?.setBaseAndExtent(node, from + insert.length, node, from + insert.length);
    if (reportInput) page.root.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: type, data: insert }));
    return true;
  }
  return {
    ...page, element, typeHeading,
    name: () => page.a.session.read(doc => sceneNames(doc as FlowDoc | null)[0]),
    startHeading: (from: number, to = from) => {
      page.surface.place({ anchor: headingPos("H1", from), head: headingPos("H1", to) });
      page.root.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    }
  };
}
