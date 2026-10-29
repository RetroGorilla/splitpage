import { brollView as brollViewOwner, useBrollViewStorage } from "../../../application/preferences/broll-view.ts";
import type { BrollView } from "../../../application/preferences/broll-view.ts";
import type { CommentFilter, PreferenceChange, PreferenceChanges, Preferences } from "../../../application/preferences/preferences.ts";
import type { ViewFlags } from "../../../application/preferences/view-flags.ts";
import { PREF_EVENT, preferences, viewFlags, getEditorName } from "../preferences-owner.ts";

export const historyPreferences: Pick<Preferences, "clock"> & { readonly editorName: () => string } = {
  clock: () => preferences().clock(), editorName: getEditorName
};

export const chromePreferences: Pick<Preferences, "commentAuthor" | "myColor" | "nameOf" | "setCommentAuthor" | "setMyColor"> = {
  commentAuthor: () => preferences().commentAuthor(), myColor: () => preferences().myColor(),
  nameOf: (key) => preferences().nameOf(key), setCommentAuthor: (name) => { preferences().setCommentAuthor(name); },
  setMyColor: (colour) => { preferences().setMyColor(colour); }
};

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

export const screenFlags: () => Pick<ViewFlags, "tourOpen" | "writerOpen" | "brollPageOpen"> = viewFlags;

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

export const appDataPreferences: Pick<Preferences, "appDataExport" | "appDataImport" | "commentsSort"> = {
  appDataExport: (extra) => preferences().appDataExport(extra),
  appDataImport: (incoming, extra) => preferences().appDataImport(incoming, extra),
  commentsSort: () => preferences().commentsSort()
};

export const attributionPreferences: Pick<Preferences, "commentAuthor" | "myColor"> = {
  commentAuthor: () => preferences().commentAuthor(),
  myColor: () => preferences().myColor()
};

export const saveStatusPreferences: Pick<Preferences, "clock" | "nameOf"> = {
  clock: () => preferences().clock(),
  nameOf: (key) => preferences().nameOf(key)
};

export const updatePreferences: Pick<Preferences, "desktopNoticeDismissed" | "dismissDesktopNotice"> = {
  desktopNoticeDismissed: () => preferences().desktopNoticeDismissed(),
  dismissDesktopNotice: () => preferences().dismissDesktopNotice()
};

export const prompterPreferences: Pick<Preferences, "prompterFlag" | "setPrompterFlag" | "skipOnboardingForPrompter"> = {
  prompterFlag: (name) => preferences().prompterFlag(name),
  setPrompterFlag: (name, value) => preferences().setPrompterFlag(name, value),
  skipOnboardingForPrompter: () => preferences().skipOnboardingForPrompter()
};

export const prompterView: Pick<ViewFlags, "hideShot"> = { hideShot: () => viewFlags().hideShot() };

export const tagView: () => Pick<ViewFlags, "writerOpen"> = viewFlags;
export const renderPreferences: () => Pick<Preferences, "clock"> = preferences;

export const writerPreferences: () => Pick<Preferences, "writerSize" | "setWriterSize"> = preferences;
export const writerView: () => Pick<ViewFlags, "writerOpen" | "setWriterOpen" | "findOpen"> = viewFlags;
