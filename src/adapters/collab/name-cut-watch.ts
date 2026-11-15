import * as Y from "yjs";
import type { SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState } from "./state.ts";
import { collabProjectedTextTarget } from "./text-target.ts";
import { readSharedOwnHiddenUnits } from "./paint-base.ts";

export function createSharedNameCutWatch(handle: SharedDocumentHandle, names: () => readonly SharedTextAddress[], since: number,
  count?: (address: SharedTextAddress) => void) {
  const { roots } = collabState(handle);
  const texts = new Map<Y.Text, Set<SharedTextAddress>>(), pending = new Set<SharedTextAddress>();
  let structural = true;
  const changed: Parameters<typeof roots.segments.observeDeep>[0] = events => {
    for (const event of events) {
      if (event.target instanceof Y.Text) {
        for (const address of texts.get(event.target) ?? []) pending.add(address);
      } else if (event instanceof Y.YMapEvent && (event.path.length === 0 || event.keysChanged.has("head") || event.keysChanged.has("text"))) structural = true;
    }
  };
  const headings = (): void => { structural = true; };
  const meta: Parameters<typeof roots.meta.observeDeep>[0] = events => {
    for (const event of events) {
      if (event.target instanceof Y.Text) for (const address of texts.get(event.target) ?? []) pending.add(address);
      else if (event.target === roots.meta && event instanceof Y.YMapEvent && event.keysChanged.has("title")) structural = true;
    }
  };
  roots.segments.observeDeep(changed); roots.headings.observeDeep(headings); roots.meta.observeDeep(meta);
  return {
    check() {
      if (structural) {
        structural = false; texts.clear(); pending.clear();
        for (const address of names()) {
          pending.add(address);
          for (const part of collabProjectedTextTarget(handle, address)?.parts ?? []) {
            let owners = texts.get(part.text);
            if (!owners) { owners = new Set(); texts.set(part.text, owners); }
            owners.add(address);
          }
        }
      }
      const changed = [...pending]; pending.clear();
      return changed.map(address => {
        count?.(address);
        return { address, units: readSharedOwnHiddenUnits(handle, address, since) };
      });
    },
    dispose() {
      roots.segments.unobserveDeep(changed); roots.headings.unobserveDeep(headings); roots.meta.unobserveDeep(meta);
      texts.clear(); pending.clear();
    }
  };
}
