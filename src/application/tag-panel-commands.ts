export interface TagPanelCommands {
  readonly renderProduction: () => void;
  readonly saveTagRename: (key: string, value: string) => string | null;
  readonly addPersonForTag: (key: string, value: string) => void;
  readonly setTagOwner: (key: string, personId: string) => void;
  readonly setTagNotes: (key: string, text: string) => void;
}

let commands: TagPanelCommands | null = null;

function current(): TagPanelCommands {
  if (!commands) throw new Error("The tag panel commands are not installed yet");
  return commands;
}

export function installTagPanelCommands(next: TagPanelCommands): () => void {
  commands = next;
  return () => { if (commands === next) commands = null; };
}

export function renderProduction(): void { current().renderProduction(); }
export function saveTagRename(key: string, value: string): string | null { return current().saveTagRename(key, value); }
export function addPersonForTag(key: string, value: string): void { current().addPersonForTag(key, value); }
export function setTagOwner(key: string, personId: string): void { current().setTagOwner(key, personId); }
export function setTagNotes(key: string, text: string): void { current().setTagNotes(key, text); }
