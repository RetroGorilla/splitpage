import { BROLL_PANEL_GROUPS, FILTERS, PAGE_GROUPS, oneOf } from "../../core/production/broll-view.ts";

export interface BrollViewState {
  readonly filter: string;
  readonly group: string;
  readonly pageGroup: string;
}

export interface BrollView {
  readonly load: () => void;
  readonly current: () => BrollViewState;
  readonly setFilter: (value: unknown) => void;
  readonly setGroup: (value: unknown) => void;
  readonly setPageGroup: (value: unknown) => void;
  readonly printView: (overrides?: unknown) => { filter: string; group: string };
}

export interface BrollViewStorage {
  readonly read: () => string | null;
  readonly write: (value: string) => void;
}

export function createBrollView(storage: BrollViewStorage): BrollView {
  let state: BrollViewState = { filter: "all", group: "scene", pageGroup: "location" };
  function save(): void {
    try { storage.write(JSON.stringify(state)); } catch { }
  }
  return {
    load: () => {
      try {
        const saved: unknown = JSON.parse(storage.read() || "null");
        if (saved && typeof saved === "object") {
          state = {
            filter: oneOf(FILTERS, "filter" in saved ? saved.filter : undefined, state.filter),
            group: oneOf(BROLL_PANEL_GROUPS, "group" in saved ? saved.group : undefined, state.group),
            pageGroup: oneOf(PAGE_GROUPS, "pageGroup" in saved ? saved.pageGroup : undefined, state.pageGroup)
          };
        }
      } catch { }
    },
    current: () => ({ ...state }),
    setFilter: (value) => { state = { ...state, filter: oneOf(FILTERS, value, "all") }; save(); },
    setGroup: (value) => { state = { ...state, group: oneOf(BROLL_PANEL_GROUPS, value, "scene") }; save(); },
    setPageGroup: (value) => { state = { ...state, pageGroup: oneOf(PAGE_GROUPS, value, "location") }; save(); },
    printView: (overrides) => {
      const as = overrides && typeof overrides === "object" ? overrides : {};
      const filter = "filter" in as ? as.filter : undefined;
      const group = "group" in as ? as.group : undefined;
      return {
        filter: filter ? oneOf(FILTERS, filter, "all") : state.filter,
        group: group ? oneOf(PAGE_GROUPS, group, "scene") : state.pageGroup
      };
    }
  };
}
