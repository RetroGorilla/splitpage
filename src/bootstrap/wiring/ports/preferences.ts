import { brollView as brollViewOwner, useBrollViewStorage } from "../../../application/preferences/broll-view.ts";
import type { BrollView } from "../../../application/preferences/broll-view.ts";
import type { CommentFilter, PreferenceChange, PreferenceChanges } from "../../../application/preferences/preferences.ts";
import type { ViewFlags } from "../../../application/preferences/view-flags.ts";
import { PREF_EVENT, preferences, viewFlags } from "../../../legacy/preferences-bridge.ts";

export const changes: PreferenceChanges = {
  onChange(listener, hearing) {
    const onPreference = (event: Event): void => {
      const change = (event as CustomEvent<PreferenceChange | undefined>).detail;
      if (!change) return;
      const name = preferences().nameOf(change.key);
      if (name) listener({ name, value: change.value, elsewhere: false });
    };
    const onStorage = (event: StorageEvent): void => {
      if (event.key === null) return;
      const name = preferences().nameOf(event.key);
      if (name) listener({ name, value: event.newValue, elsewhere: true });
    };
    const elsewhere = hearing?.elsewhere !== false;
    document.addEventListener(PREF_EVENT, onPreference);
    if (elsewhere) window.addEventListener("storage", onStorage);
    return () => {
      document.removeEventListener(PREF_EVENT, onPreference);
      if (elsewhere) window.removeEventListener("storage", onStorage);
    };
  }
};

export const flags: Pick<ViewFlags, "findOpen" | "setFindOpen" | "brollPageOpen" | "setBrollPageOpen"> = {
  brollPageOpen: () => viewFlags().brollPageOpen(),
  setBrollPageOpen: (open) => viewFlags().setBrollPageOpen(open),
  findOpen: () => viewFlags().findOpen(),
  setFindOpen: (open) => viewFlags().setFindOpen(open)
};

export const preferenceValues = {
  defaultWpm: () => preferences().defaultWpm(),
  clock: () => preferences().clock(),
  commentAuthor: () => preferences().commentAuthor(),
  rememberCommentAuthor: (name: string) => preferences().rememberCommentAuthor(name),
  commentsSort: () => preferences().commentsSort(),
  setCommentsSort: (mode: string) => preferences().setCommentsSort(mode),
  commentFilter: () => preferences().commentFilter(),
  setCommentFilter: (filter: CommentFilter) => preferences().setCommentFilter(filter),
  taggingHelpShown: () => preferences().taggingHelpShown(),
  taggingHelpDismissed: () => preferences().taggingHelpDismissed()
};

export const brollView: BrollView = {
  load: () => {
    useBrollViewStorage({
      read: () => localStorage.getItem("splitpage-broll-view"),
      write: (value) => { localStorage.setItem("splitpage-broll-view", value); }
    });
    brollViewOwner.load();
  },
  current: () => brollViewOwner.current(),
  setFilter: (value) => brollViewOwner.setFilter(value),
  setGroup: (value) => brollViewOwner.setGroup(value),
  setPageGroup: (value) => brollViewOwner.setPageGroup(value),
  printView: (overrides) => brollViewOwner.printView(overrides)
};
