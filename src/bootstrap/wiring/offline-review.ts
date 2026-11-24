import { createOfflineReview } from "../../features/collaboration/offline-review.ts";
import { cssAttr } from "../../features/common/dom.ts";
import { collaborationState } from "./collaboration-owner.ts";
import { actions } from "./ports/actions.ts";
import { collaboration } from "./ports/collaboration.ts";
import { documentReader } from "./ports/document.ts";
import { nativeOfflineReview } from "./shared-session.ts";
import { writerControls } from "./writer.ts";

export function mountOfflineReviewFeature(window: Window): { readonly dispose: () => void } {
  const dismiss = () => { collaborationState().dismissOfflineClashes(); };
  const review = createOfflineReview(window, {
    collaboration: { ...collaboration, dismissOfflineClashes: dismiss },
    document: documentReader,
    readBeat: id => nativeOfflineReview()?.readBeat(id) ?? null,
    revealBeat: id => {
      actions.invoke("reveal-row", "button", id);
      const writer = writerControls()?.writerFlowControl();
      if (writer) writer.caret(id, 0);
      else window.document.querySelector('#rows .row[data-id="' + cssAttr(id) + '"]')?.scrollIntoView({ block: "center" });
    },
    putBack: entry => collaborationState().restoreOfflineClash(entry, beat => nativeOfflineReview()?.putBack(beat) ?? false)
  });
  const stopReplacement = documentReader.onReplaced(dismiss);
  return { dispose: () => { stopReplacement(); review.dispose(); } };
}
