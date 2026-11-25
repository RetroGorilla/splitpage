import type { FileCopyBannerPorts } from "./ports.ts";

export function mountFileCopyBanner(ports: FileCopyBannerPorts): () => void {
  const before = document.getElementById("merge-banner");
  if (!before) return () => {};
  const banner = document.createElement("div");
  banner.id = "file-copy-banner";
  banner.className = "notice notice-save-error";
  const body = document.createElement("div");
  body.className = "notice-body";
  body.setAttribute("role", "status");
  const actions = document.createElement("div");
  actions.className = "notice-actions";
  banner.append(body, actions);
  before.before(banner);
  let busy = false;

  function action(label: string, run: () => Promise<void>) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn";
    button.textContent = label;
    button.onclick = async () => {
      busy = true;
      sync();
      let failed = false;
      try { await run(); }
      catch { failed = true; }
      finally {
        busy = false;
        sync();
        if (failed && !banner.hidden) body.textContent = "Could not change the file copy. Try again.";
      }
    };
    actions.append(button);
    return button;
  }

  const retry = action("Try again", ports.retry);
  const overwrite = action("Overwrite the file", ports.overwrite);
  const save = action("Save as a new copy…", ports.saveAs);
  const stop = action("Stop keeping a copy", ports.stop);

  function sync() {
    const { file, problem } = ports.read();
    banner.hidden = !file || !problem;
    if (banner.hidden) return;
    body.textContent = problem === "changed" ? `“${file?.name}” changed outside Splitpage.`
      : `Could not update “${file?.name}” — check that the file is available and try again.`;
    retry.hidden = problem === "changed";
    overwrite.hidden = problem !== "changed";
    for (const button of [retry, overwrite, save, stop]) button.disabled = busy;
  }

  const unsubscribe = ports.subscribe(sync);
  sync();
  return () => { unsubscribe(); banner.remove(); };
}
