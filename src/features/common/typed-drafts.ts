import { escapeHtml } from "../../core/document/text-policy.ts";

export type TypedWrite = "saved" | "kept" | "gone";

export function heldWrite(run: { readonly held: boolean }): TypedWrite {
  return run.held ? "kept" : "saved";
}

export function isHeld(wrote: TypedWrite | null): boolean {
  return wrote === "kept";
}

export type TypedSave = (text: string, quiet: boolean) => TypedWrite;

export interface TypedDraft {
  readonly box: string;
  readonly record: string;
  readonly text: string;
}

export interface TypedDrafts {
  readonly submit: (box: string, record: string, text: string, save: TypedSave, quiet?: boolean) => TypedWrite;
  readonly draft: (box: string, record: string) => string | null;
  readonly drop: (box: string, record: string) => void;
  readonly revise: (box: string, record: string, text: string, drawn: string) => void;
  readonly hidden: (rendered: (draft: TypedDraft) => boolean, exists: (draft: TypedDraft) => boolean) => readonly TypedDraft[];
  readonly held: () => readonly TypedDraft[];
  readonly orphans: () => readonly TypedDraft[];
  readonly dismiss: (box: string, record: string) => void;
  readonly clear: () => void;
}

const keyOf = (box: string, record: string): string => JSON.stringify([box, record]);

const plain = (draft: TypedDraft): TypedDraft => ({ box: draft.box, record: draft.record, text: draft.text });

export function createTypedDrafts(boxes: readonly string[], gone: (draft: TypedDraft) => void): TypedDrafts {
  const held = new Map<string, TypedDraft>(), orphaned = new Map<string, TypedDraft>();
  const submitting = new Set<string>();
  function settle(draft: TypedDraft, outcome: TypedWrite): TypedWrite {
    const key = keyOf(draft.box, draft.record);
    if (isHeld(outcome)) { held.set(key, draft); return outcome; }
    held.delete(key);
    if (outcome === "saved") { orphaned.delete(key); return outcome; }
    const text = plain(draft);
    const told = orphaned.has(key);
    orphaned.set(key, text);
    if (!told) gone(text);
    return outcome;
  }
  return {
    submit: (box, record, text, save, quiet = false) => {
      if (!boxes.includes(box)) throw new Error("typed drafts: undeclared box " + box);
      const key = keyOf(box, record);
      held.delete(key);
      submitting.add(key);
      try { return settle({ box, record, text }, save(text, quiet)); }
      finally { submitting.delete(key); }
    },
    draft: (box, record) => held.get(keyOf(box, record))?.text ?? null,
    drop: (box, record) => { held.delete(keyOf(box, record)); orphaned.delete(keyOf(box, record)); },
    revise: (box, record, text, drawn) => {
      const key = keyOf(box, record);
      if (submitting.has(key)) return;
      if (text === drawn) held.delete(key);
      else held.set(key, { box, record, text });
    },
    hidden: (rendered, exists) => {
      for (const draft of [...held.values()]) if (!exists(draft)) settle(draft, "gone");
      return [...orphaned.values(), ...[...held.values()].filter(draft => !rendered(draft))];
    },
    held: () => [...held.values()].map(plain),
    orphans: () => [...orphaned.values()],
    dismiss: (box, record) => { held.delete(keyOf(box, record)); orphaned.delete(keyOf(box, record)); },
    clear: () => { held.clear(); orphaned.clear(); }
  };
}

export function typedOrphansHtml(orphans: readonly TypedDraft[], label: (draft: TypedDraft) => string): string {
  if (!orphans.length) return "";
  return '<div class="typed-unsaved" role="group" aria-label="Text that was not saved">' + orphans.map(draft =>
    '<div class="typed-unsaved-item"><span class="typed-unsaved-label">' + escapeHtml(label(draft)) + '</span>' +
      '<textarea class="typed-unsaved-text" readonly rows="2" aria-label="' + escapeHtml(label(draft)) + '">\n' + escapeHtml(draft.text) + '</textarea>' +
      '<button type="button" class="typed-unsaved-dismiss btn-outline is-small" data-action="typed-unsaved-dismiss" data-box="' +
        escapeHtml(draft.box) + '" data-record="' + escapeHtml(draft.record) + '">Dismiss</button></div>').join("") + '</div>';
}
