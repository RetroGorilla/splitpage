import { createViewLifetime } from "../common/view-lifetime.ts";

export type CommentEvent = Event & {
  readonly target: HTMLElement & { value: string; files?: FileList };
  readonly isComposing: boolean;
  readonly inputType: string;
  readonly data: string | null;
  readonly dataTransfer: DataTransfer | null;
  readonly clientX: number;
  readonly clientY: number;
};

export interface CommentsPorts {
  readonly rootClick: (event: MouseEvent) => void;
  readonly rootMouseDown: (event: MouseEvent) => void;
  readonly rootInput: (event: InputEvent) => void;
  readonly rootFocusOut: (event: FocusEvent) => void;
  readonly rootPaste: (event: ClipboardEvent) => void;
  readonly rootKeydown: (event: KeyboardEvent) => void;
  readonly authorFields: string;
  readonly limitAuthor: (field: HTMLElement) => void;
  readonly isDraft: (box: HTMLElement) => boolean;
  readonly draftUndo: (box: HTMLElement) => void;
  readonly draftRedo: (box: HTMLElement) => void;
  readonly typeMarks: (box: HTMLElement, data: string) => boolean;
  readonly beforeInput: (box: HTMLElement, event: CommentEvent) => void;
  readonly focusDraft: (box: HTMLElement) => void;
  readonly composeDraft: (box: HTMLElement, composing: boolean) => void;
  readonly pasteDraft: (box: HTMLElement, html: string, text: string) => void;
  readonly toggleResolve: (id: string | null) => void;
  readonly filter: (value: string | null) => void;
  readonly toggleReply: (id: string | null) => void;
  readonly postReply: (id: string | null) => void;
  readonly deleteComment: (button: Element, id: string | null) => void;
  readonly restoreConflict: (id: string | null) => void;
  readonly menu: (id: string | null) => void;
  readonly jump: (id: string | null) => void;
  readonly openPanel: () => void;
  readonly closePanel: () => void;
  readonly assigneeFilter: (value: string) => void;
  readonly assignee: (id: string | null, value: string) => void;
  readonly sortMode: () => string;
  readonly captureReplies: () => void;
  readonly sort: (value: string) => void;
  readonly closeComposer: (cancelled: boolean) => void;
  readonly post: () => void;
  readonly captureComposer: () => () => HTMLElement | null;
  readonly compressImage: (file: File, maxDim: number, quality: number) => Promise<string>;
  readonly appendImage: (box: HTMLElement, dataUrl: string) => void;
  readonly imageError: () => void;
  readonly reset: () => void;
}

export interface CommentsMount {
  readonly mountRoots: () => void;
  readonly mountControls: () => void;
  readonly click: (event: MouseEvent) => boolean;
  readonly jumpClick: (event: MouseEvent) => boolean;
  readonly dispose: () => void;
}

export function mountComments(mount: { window: Window; ports: CommentsPorts }): CommentsMount {
  const win = mount.window;
  const doc = win.document;
  const ports = mount.ports;
  const life = createViewLifetime<CommentEvent>(win, (target) =>
    target === doc || doc.getElementById((target as HTMLElement).id) === target);
  const { listen } = life;
  let rootsMounted = false;
  let controlsMounted = false;
  let dragSource: HTMLElement | null = null;
  function draftBox(event: CommentEvent): HTMLElement | null {
    return event.target?.closest?.<HTMLElement>(".cell-editable") || null;
  }
  function beforeInput(event: CommentEvent): void {
    const box = draftBox(event);
    if (!box || !ports.isDraft(box)) return;
    if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
      event.preventDefault();
      if (event.inputType === "historyRedo") ports.draftRedo(box); else ports.draftUndo(box);
      return;
    }
    if (event.inputType === "insertText" && !event.isComposing && event.data && ports.typeMarks(box, event.data)) {
      event.preventDefault();
      return;
    }
    ports.beforeInput(box, event);
  }
  function composition(event: CommentEvent): void {
    const box = draftBox(event);
    if (box) ports.composeDraft(box, event.type === "compositionstart");
  }
  function drop(event: CommentEvent): void {
    const box = draftBox(event);
    if (!box || !ports.isDraft(box) || dragSource === box) return;
    const dt = event.dataTransfer;
    const html = dt ? dt.getData("text/html") : "";
    const text = dt ? dt.getData("text/plain") : "";
    if (!html && !text) return;
    event.preventDefault();
    box.focus();
    try {
      const caretDoc = doc as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
      const range = caretDoc.caretRangeFromPoint?.(event.clientX, event.clientY);
      if (range && box.contains(range.startContainer)) {
        const selection = win.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    } catch {}
    ports.pasteDraft(box, html, text);
  }
  listen(doc, "input", (event) => {
    if (event.isComposing) return;
    if (event.target?.matches?.(ports.authorFields)) ports.limitAuthor(event.target);
  });
  listen(doc, "compositionend", (event) => {
    if (event.target?.matches?.(ports.authorFields)) ports.limitAuthor(event.target);
  });
  return {
    mountRoots(): void {
      if (!life.active() || rootsMounted) return;
      rootsMounted = true;
      for (const root of [doc.getElementById("comment-modal"), doc.getElementById("comments-panel")]) {
        listen(root, "click", (event) => ports.rootClick(event as unknown as MouseEvent));
        listen(root, "mousedown", (event) => ports.rootMouseDown(event as unknown as MouseEvent));
        listen(root, "input", (event) => ports.rootInput(event as unknown as InputEvent));
        listen(root, "focusout", (event) => ports.rootFocusOut(event as unknown as FocusEvent));
        listen(root, "paste", (event) => ports.rootPaste(event as unknown as ClipboardEvent));
        listen(root, "keydown", (event) => ports.rootKeydown(event as unknown as KeyboardEvent));
        listen(root, "focusin", (event) => { const box = draftBox(event); if (box) ports.focusDraft(box); });
        listen(root, "beforeinput", beforeInput);
        listen(root, "compositionstart", composition);
        listen(root, "compositionend", composition);
        listen(root, "dragstart", (event) => { const box = draftBox(event); dragSource = box && ports.isDraft(box) ? box : null; });
        listen(root, "dragend", () => { dragSource = null; });
        listen(root, "drop", drop);
      }
      listen(doc.getElementById("btn-comments"), "click", ports.openPanel);
      listen(doc.getElementById("comments-panel-close"), "click", ports.closePanel);
    },
    mountControls(): void {
      if (!life.active() || controlsMounted) return;
      controlsMounted = true;
      listen(doc.getElementById("comments-panel"), "change", (event) => {
        if (event.target.id === "comments-assignee-filter") { ports.assigneeFilter(event.target.value); return; }
        if (event.target.classList.contains("comment-assignee-select")) ports.assignee(event.target.getAttribute("data-id"), event.target.value);
      });
      const select = doc.getElementById("comments-sort") as HTMLSelectElement | null;
      if (select) select.value = ports.sortMode();
      listen(select, "change", (event) => { ports.captureReplies(); ports.sort(event.target.value); });
      listen(doc.getElementById("comment-close"), "click", () => { ports.closeComposer(true); });
      listen(doc.getElementById("comment-cancel"), "click", () => { ports.closeComposer(true); });
      listen(doc.getElementById("comment-post"), "click", ports.post);
      listen(doc.getElementById("comment-modal"), "click", (event) => {
        if (event.target.id === "comment-modal") ports.closeComposer(true);
      });
      listen(doc.getElementById("comment-image-input"), "change", (event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        const resolveComposer = ports.captureComposer();
        const input = event.target;
        function live(): HTMLElement | null {
          return life.active() && doc.getElementById("comment-image-input") === input ? resolveComposer() : null;
        }
        ports.compressImage(file, 700, 0.72).then((dataUrl) => {
          const composer = live();
          if (composer) ports.appendImage(composer, dataUrl);
        }).catch(() => { if (live()) ports.imageError(); });
      });
    },
    click(event): boolean {
      if (!life.active()) return false;
      const target = event.target as HTMLElement;
      const resolve = target.closest('[data-action="toggle-resolve"]');
      if (resolve) { ports.toggleResolve(resolve.getAttribute("data-id")); return true; }
      const filter = target.closest("#comments-filter-seg [data-filter]");
      if (filter) { ports.filter(filter.getAttribute("data-filter")); return true; }
      const reply = target.closest('[data-action="toggle-reply"]');
      if (reply) { ports.toggleReply(reply.getAttribute("data-id")); return true; }
      const cancel = target.closest('[data-action="reply-cancel"]');
      if (cancel) { ports.toggleReply(cancel.getAttribute("data-id")); return true; }
      const post = target.closest('[data-action="reply-post"]');
      if (post) { ports.postReply(post.getAttribute("data-id")); return true; }
      const remove = target.closest('[data-action="delete-comment"]');
      if (remove) { ports.deleteComment(remove, remove.getAttribute("data-id")); return true; }
      const restore = target.closest('[data-action="restore-conflict"]');
      if (restore) { ports.restoreConflict(restore.getAttribute("data-id")); return true; }
      const menu = target.closest('[data-action="comment-menu"]');
      if (menu) { ports.menu(menu.getAttribute("data-id")); return true; }
      return !!target.closest(".comment-menu");
    },
    jumpClick(event): boolean {
      if (!life.active()) return false;
      const target = event.target as HTMLElement;
      const card = target.closest(".comment-card.is-jumpable");
      if (card && !target.closest(".reply-composer") && !target.closest("a") && win.getSelection()?.isCollapsed) {
        ports.jump(card.getAttribute("data-id"));
        return true;
      }
      return false;
    },
    dispose(): void {
      if (!life.active()) return;
      life.dispose();
      dragSource = null;
      ports.reset();
    }
  };
}
