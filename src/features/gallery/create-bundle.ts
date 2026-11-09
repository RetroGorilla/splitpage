import { rowSlots } from "../../core/document/gallery.ts";
import { bundleFolderName } from "../../../shared/video-path.ts";
import type { CreateBundlePlan, DesktopBundleCopy, DesktopBundleMove } from "../../application/media/desktop-video.ts";
import type { VideoBundlePorts } from "./ports.ts";

type CreatedFile = CreateBundlePlan["files"][number];
type CreateAnswer = DesktopBundleCopy | DesktopBundleMove;

export function startCreateBundle(ports: VideoBundlePorts, ui: {
  readonly active: () => boolean;
  readonly blocked: () => boolean;
  readonly size: (bytes: number) => string;
  readonly warning: (bytes: number) => string | null;
  readonly relink: (path: string, name: string) => void;
  readonly enqueue: (file: CreatedFile, move: boolean, done: (result: CreateAnswer) => void) => void;
}) {
  const page = ports.window.document;
  const el = (id: string): HTMLElement | null => page.getElementById(id);
  let sequence = 0;
  let dismissed = false;
  let arriving = false;
  let written = ports.place.writtenOut();
  let pendingFirst = false;
  let ask: { plan: CreateBundlePlan; ctx: ReturnType<VideoBundlePorts["ownership"]["capture"]>; focus: Element | null } | null = null;

  function paths(): string[] {
    return ports.document.read((doc) => [...new Set((doc?.rows ?? []).flatMap((row) => rowSlots(row).flatMap((slot) =>
      slot.links.flatMap((link) => !link.href && link.location?.kind === "path" ? [link.location.path] : []))))]);
  }

  function set(id: string, value: string | null): void {
    const node = el(id);
    if (node) { node.textContent = value; node.hidden = value === null; }
  }

  function close(): void {
    sequence++;
    if (!ask) return;
    const focus = ask.focus as HTMLElement | null;
    ask = null;
    const modal = el("bundle-modal");
    if (modal) modal.hidden = true;
    if (focus?.isConnected) focus.focus({ preventScroll: true });
  }

  async function inspect(show: boolean, automatic = false): Promise<void> {
    if (!ui.active() || ui.blocked()) return;
    const script = ports.script();
    if (!script) return;
    const mine = ++sequence;
    const ctx = ports.ownership.capture();
    const plan = await ports.create.planCreate(paths()).catch(() => null);
    if (!plan || !ui.active() || mine !== sequence || ui.blocked() || !ports.ownership.stillOwns(ctx)) return;
    plan.bundled.forEach((file) => ui.relink(file.path, file.name));
    const bar = el("bundle-outside-bar");
    if (bar) bar.hidden = dismissed || !plan.files.length;
    set("bundle-outside-text", plan.files.length + (plan.files.length === 1 ? " file is" : " files are") + " outside this script's folder.");
    if (!show || (automatic && !plan.files.length)) return;
    ask = { plan, ctx, focus: page.activeElement };
    const bytes = plan.files.reduce((sum, file) => sum + file.size, 0);
    const move = plan.files.length > 0 && plan.files.every((file) => file.move);
    set("bundle-title", "Create bundle?");
    set("bundle-detail", "This script links " + plan.files.length + (plan.files.length === 1 ? " file" : " files") + " outside “" +
      bundleFolderName(script) + "” (" + ui.size(bytes) + "). Copy or move them into that folder, next to the script, so they open wherever the script goes.");
    set("bundle-create-missing", plan.missing ? plan.missing + " more can't be found, so they stay as they are." : null);
    set("bundle-create-move", move ? null : "Move is only offered for files you added since Splitpage started. To move these, copy them, then delete the originals yourself.");
    set("bundle-create-warning", ui.warning(bytes));
    const list = el("bundle-create-paths");
    if (list) {
      list.replaceChildren(...plan.files.map((file) => { const item = page.createElement("li"); item.textContent = file.path; return item; }));
      list.hidden = false;
    }
    set("bundle-decline", "Leave them where they are");
    set("bundle-move", move ? "Move" : null);
    set("bundle-accept", "Copy (" + ui.size(bytes) + ")");
    const copy = el("bundle-accept") as HTMLButtonElement | null;
    if (copy) copy.disabled = !plan.files.length;
    const modal = el("bundle-modal");
    if (modal) modal.hidden = false;
    (plan.files.length ? copy : el("bundle-decline"))?.focus({ preventScroll: true });
  }

  function answer(choice: "copy" | "move" | "leave"): boolean {
    const was = ask;
    if (!was) return false;
    close();
    if (choice === "leave" || !ports.ownership.stillOwns(was.ctx) ||
      (choice === "move" && !was.plan.files.every((file) => file.move))) return true;
    const folder = bundleFolderName(ports.script() || "");
    let remaining = was.plan.files.length, copied = 0, moved = 0, failed = 0;
    was.plan.files.forEach((file) => ui.enqueue(file, choice === "move", (result) => {
      if (!ports.ownership.stillOwns(was.ctx)) return;
      if (result.ok) {
        if ("outcome" in result && result.outcome === "moved") moved++;
        else if (!("outcome" in result)) copied++;
      } else if (result.code !== "CANCELLED" && result.code !== "DROPPED") failed++;
      if (--remaining) return;
      if (copied) ports.notices.show("Copied " + copied + (copied === 1 ? " file" : " files") + " to “" + folder + "”.", "ok");
      if (moved) ports.notices.show("Moved " + moved + (moved === 1 ? " file" : " files") + " to “" + folder + "”.", "ok");
      if (failed) ports.notices.show(failed + (failed === 1 ? " file couldn't be copied, so it links" : " files couldn't be copied, so they link") + " to where " + (failed === 1 ? "it is." : "they are."), "error");
      void inspect(false);
    }));
    return true;
  }

  function replaced(): void {
    close();
    dismissed = false;
    arriving = true;
    pendingFirst = false;
    const bar = el("bundle-outside-bar");
    if (bar) bar.hidden = true;
    void Promise.resolve().then(() => {
      if (!ui.active()) return;
      arriving = false;
      const script = ports.script();
      written = !!script && ports.place.writtenOut();
      if (script) return inspect(false);
    });
  }

  const offDocument = ports.document.onReplaced(replaced);
  function ready(): void {
    if (!pendingFirst || ui.blocked()) return;
    pendingFirst = false;
    void inspect(true, true);
  }
  const offPlace = ports.place.onChange((change) => {
    if (arriving) return;
    const now = ports.place.writtenOut();
    const first = change === "writtenOut" && !written && now;
    written = now;
    if (first) { pendingFirst = true; void Promise.resolve().then(ready); }
  });
  replaced();

  return {
    open: () => inspect(true),
    ready,
    answer,
    close,
    dismiss: () => { dismissed = true; const bar = el("bundle-outside-bar"); if (bar) bar.hidden = true; },
    dispose: () => { close(); offDocument(); offPlace(); const bar = el("bundle-outside-bar"); if (bar) bar.hidden = true; }
  };
}
