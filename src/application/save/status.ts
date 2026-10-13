export type AutoSaveTarget = "server" | "file" | null;

export interface SaveStatusInput {
  readonly busy: boolean;
  readonly dirty: boolean;
  readonly halted: string;
  readonly autoSaveOn: boolean;
  readonly target: AutoSaveTarget;
  readonly where: string;
  readonly homeKind: string;
  readonly onServer: boolean;
  readonly signedOut: boolean;
  readonly linkOff: boolean;
}

export interface SaveStatusLine {
  readonly text: string;
  readonly cls: "warn" | "busy" | "ok" | "pending";
  readonly title: string;
  readonly where?: string;
}

export interface SaveButtonView {
  readonly label: string;
  readonly dirty: boolean;
  readonly disabled: boolean;
}

export interface SaveStatus {
  readonly line: SaveStatusLine | null;
  readonly button: SaveButtonView;
}

export const SAVE_LABEL = "Save";
export const SAVE_DIRTY_LABEL = "Save •";
export const SAVING_LABEL = "Saving…";

export function saveButtonView(input: Pick<SaveStatusInput, "busy" | "dirty">): SaveButtonView {
  if (input.busy) return Object.freeze({ label: SAVING_LABEL, dirty: false, disabled: true });
  return Object.freeze({ label: input.dirty ? SAVE_DIRTY_LABEL : SAVE_LABEL, dirty: input.dirty, disabled: false });
}

function line(input: SaveStatusInput): SaveStatusLine | null {
  const where = input.where;
  if (input.onServer && input.signedOut) {
    return { text: "Not saving", cls: "warn", title: "Your sign-in to the server has lapsed — reload the page to sign in again." };
  }
  if (input.onServer && input.linkOff) {
    return { text: "Not saving", cls: "warn", title: "The owner turned off the link you opened this with — File ▸ Save a copy… keeps what's on screen." };
  }
  if (input.busy) {
    return { text: "Saving…", cls: "busy", title: where ? "Writing your changes to " + where + "." : "Writing your changes." };
  }
  if (input.halted) return { text: "Not saving", cls: "warn", title: input.halted };
  if (!input.dirty) {
    if (!input.target && input.homeKind !== "file" && !where) return null;
    return { text: "Saved", cls: "ok", title: "", where: where };
  }
  if (input.target && input.autoSaveOn) {
    return { text: "Unsaved changes", cls: "pending", title: "Autosave will write these to " + where + " a moment after you stop typing." };
  }
  return {
    text: "Unsaved changes",
    cls: "pending",
    title: input.target
      ? "Autosave is off — press Save to write these to " + where + "."
      : "Press Save to choose where this script is kept."
  };
}

export function saveStatus(input: SaveStatusInput): SaveStatus {
  const view = line(input);
  return Object.freeze({ line: view ? Object.freeze(view) : null, button: saveButtonView(input) });
}
