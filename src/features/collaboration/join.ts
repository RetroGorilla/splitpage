import { cleanAuthorName } from "../../core/document/people.ts";
import { PERSON_COLORS, PERSON_COLOR_NAMES } from "../../core/document/person-colors.ts";
import { JOIN_SCRIPT_COMMAND } from "./actions.ts";
import { mountCollaborationDialog } from "./dialog.ts";
import type { JoinDialogPorts, JoinPreview, JoinRequest } from "./ports.ts";

const RETRY_LINK_CHECK = new Set(["relay-unreachable", "script-too-large-for-connection", "opening-pending"]);

const MESSAGES: Readonly<Record<string, string>> = {
  "bad-link": "This invitation link is invalid. Check the whole link or ask for a new one.",
  "invitation-revoked": "This invitation link has been reset or revoked. Ask the owner for a new link.",
  "access-removed": "This invitation link has been reset or revoked. Ask the owner for a new link.",
  "script-deleted": "This shared script was deleted.",
  "script-unknown": "This shared script is no longer available.",
  "permission-denied": "This invitation link is invalid. Check the whole link or ask for a new one.",
  "unsupported-version": "This shared script needs a newer version of Splitpage.",
  "relay-unreachable": "Could not reach the relay. Check your connection and try again.",
  "script-too-large-for-connection": "This script is too large to load over this connection.",
  "pictures-stalled": "The picture download stopped. Check your connection and try again.",
  "pictures-unavailable": "Could not download the pictures. Check your connection and available storage.",
  "opening-pending": "The script changed while opening the invitation. Try again.",
  locked: "This shared script is already open in another tab."
};

export function mountJoinDialog(ports: JoinDialogPorts, request?: Extract<JoinRequest, { kind: "browser" }>) {
  const dialog = mountCollaborationDialog("join-script-modal", `
    <form class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="join-script-title">
      <div class="modal-header"><h2 id="join-script-title">${JOIN_SCRIPT_COMMAND.label}</h2></div>
      <label id="join-script-link-label" class="modal-hint" hidden>Invitation link
        <input id="join-script-link" type="text" autocomplete="off" spellcheck="false">
      </label>
      <div id="join-script-summary" hidden><h3></h3><p class="modal-hint"></p></div>
      <div id="join-script-identity" hidden>
        <label class="modal-hint">Your name <input type="text" id="join-script-name" autocomplete="off"></label>
        <fieldset class="swatch-group"><legend>Your colour</legend><div class="swatch-row">
          ${PERSON_COLORS.map((colour, index) => `<label class="swatch" style="--swatch:${colour}" title="${PERSON_COLOR_NAMES[index]}">
            <input type="radio" name="join-colour" value="${colour}" aria-label="${PERSON_COLOR_NAMES[index]}"><span class="swatch-dot" aria-hidden="true"></span>
          </label>`).join("")}
        </div></fieldset>
      </div>
      <p class="modal-hint" role="status" id="join-script-status"></p>
      <div class="modal-footer">
        <button type="button" class="btn" data-dialog-cancel>Cancel</button>
        <div class="modal-footer-actions"><button type="submit" class="btn btn-accent"></button></div>
      </div>
    </form>`);
  const { part, signal, dispose } = dialog;
  const form = part("form") as HTMLFormElement, status = part("[role=status]");
  const cancel = part("[data-dialog-cancel]") as HTMLButtonElement;
  const submit = part("[type=submit]") as HTMLButtonElement;
  const name = part("#join-script-name") as HTMLInputElement;
  const identity = part("#join-script-identity"), summary = part("#join-script-summary");
  const link = part("#join-script-link") as HTMLInputElement, linkLabel = part("#join-script-link-label");
  let preview: JoinPreview | undefined;
  let busy = false;

  const setBusy = (value: boolean) => {
    busy = value;
    submit.disabled = value;
    link.disabled = value;
  };
  const fail = (reason: string) => {
    status.textContent = MESSAGES[reason] ?? "Could not join the shared script. Try again.";
    ports.settled();
  };

  async function check(invite: JoinRequest) {
    setBusy(true);
    link.value = "";
    linkLabel.hidden = true;
    status.textContent = "Loading script…";
    cancel.focus();
    const result = await ports.check(invite, signal);
    if (signal.aborted) return;
    setBusy(false);
    if (result.kind === "failed") {
      fail(result.reason);
      if (request) {
        const retryable = RETRY_LINK_CHECK.has(result.reason);
        submit.hidden = !retryable;
        if (retryable) submit.textContent = "Try again";
        (retryable ? submit : cancel).focus();
      } else {
        linkLabel.hidden = false;
        link.focus();
      }
      return;
    }
    preview = result;
    status.textContent = "";
    summary.hidden = false;
    part("#join-script-summary h3").textContent = result.title;
    const { beats, pictures } = result;
    part("#join-script-summary p").textContent = beats + (beats === 1 ? " beat" : " beats") + " · " +
      pictures + (pictures === 1 ? " picture" : " pictures");
    identity.hidden = ports.editor() !== "Anonymous";
    const colour = ports.identity.myColor() || PERSON_COLORS[0];
    for (const radio of Array.from(form.querySelectorAll<HTMLInputElement>("input[name=join-colour]"))) radio.checked = radio.value === colour;
    submit.hidden = false;
    submit.textContent = "Join script";
    (identity.hidden ? submit : name).focus();
  }

  async function join(ready: JoinPreview) {
    if (!identity.hidden) {
      const chosen = cleanAuthorName(name.value);
      if (!chosen) {
        status.textContent = "Enter your name to join.";
        name.focus();
        return;
      }
      const colour = form.querySelector<HTMLInputElement>("input[name=join-colour]:checked")?.value;
      ports.identity.setCommentAuthor(chosen);
      if (typeof colour === "string") ports.identity.setMyColor(colour);
      identity.hidden = true;
    }
    setBusy(true);
    status.textContent = "Opening shared script…";
    cancel.focus();
    const reason = await ready.join(signal, pending => {
      if (!signal.aborted) status.textContent = pending ? "Downloading pictures… " + pending + " remaining" : "Opening shared script…";
    });
    if (signal.aborted) return;
    if (!reason) {
      ports.settled();
      dispose();
      return;
    }
    setBusy(false);
    fail(reason);
    submit.focus();
  }

  cancel.onclick = () => { dispose(); ports.settled(); };
  form.onsubmit = event => {
    event.preventDefault();
    if (busy) return;
    if (preview) void join(preview);
    else void check(request ?? { kind: "paste", link: link.value });
  };
  if (request) {
    submit.hidden = true;
    void check(request);
  } else {
    submit.textContent = "Check link";
    linkLabel.hidden = false;
    link.focus();
  }
  return { signal, dispose };
}
