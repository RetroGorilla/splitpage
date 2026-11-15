import { escapeHtml } from "../../core/document/text-policy.ts";

export type TypedWrite = "saved" | "kept" | "waits" | "gone";

export function heldWrite(run: { readonly held: boolean; readonly announced?: true }): TypedWrite {
  return !run.held ? "saved" : run.announced ? "waits" : "kept";
}

export function isHeld(wrote: TypedWrite | null): boolean {
  return wrote === "kept" || wrote === "waits";
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
  readonly revise: (box: string, record: string, text: string) => void;
  readonly retry: () => void;
  readonly held: () => readonly TypedDraft[];
  readonly orphans: () => readonly TypedDraft[];
  readonly dismiss: (box: string, record: string) => void;
  readonly clear: () => void;
}

interface HeldDraft extends TypedDraft {
  readonly save: TypedSave;
  readonly waits?: boolean;
}

const keyOf = (box: string, record: string): string => JSON.stringify([box, record]);

export function createTypedDrafts(boxes: readonly string[], gone: (draft: TypedDraft) => void): TypedDrafts {
  const held = new Map<string, HeldDraft>(), orphaned = new Map<string, TypedDraft>();
  let retrying = false;
  function settle(draft: HeldDraft, outcome: TypedWrite): TypedWrite {
    const key = keyOf(draft.box, draft.record);
    if (isHeld(outcome)) { held.set(key, { ...draft, waits: outcome === "waits" }); return outcome; }
    held.delete(key);
    if (outcome === "saved") return outcome;
    const { save: _save, waits: _waits, ...text } = draft;
    const told = orphaned.has(key);
    orphaned.set(key, text);
    if (!told) gone(text);
    return outcome;
  }
  return {
    submit: (box, record, text, save, quiet = false) => {
      if (!boxes.includes(box)) throw new Error("typed drafts: undeclared box " + box);
      held.delete(keyOf(box, record));
      const outer = retrying;
      retrying = true;
      try { return settle({ box, record, text, save }, save(text, quiet)); }
      finally { retrying = outer; }
    },
    draft: (box, record) => held.get(keyOf(box, record))?.text ?? null,
    drop: (box, record) => { held.delete(keyOf(box, record)); },
    revise: (box, record, text) => {
      const key = keyOf(box, record), draft = held.get(key);
      if (draft) held.set(key, { ...draft, text });
    },
    retry: () => {
      if (retrying) return;
      retrying = true;
      try {
        for (const draft of [...held.values()]) {
          if (!draft.waits && held.get(keyOf(draft.box, draft.record)) === draft) settle(draft, draft.save(draft.text, true));
        }
      }
      finally { retrying = false; }
    },
    held: () => [...held.values()].map(({ save: _save, waits: _waits, ...text }) => text),
    orphans: () => [...orphaned.values()],
    dismiss: (box, record) => { orphaned.delete(keyOf(box, record)); },
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
