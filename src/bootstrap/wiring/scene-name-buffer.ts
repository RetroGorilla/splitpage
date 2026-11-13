import { createBufferedField } from "../../application/editing/buffered-field.ts";
import type { BufferedFieldPorts } from "../../application/editing/buffered-field.ts";
import { createPaintedBeats } from "../../application/editing/painted-beats.ts";
import type { PaintedTextSource } from "../../application/editing/ports.ts";
import { onBeforePaint, onPainted, render } from "../../features/rows/render.ts";
import type { SceneNameBufferPorts } from "../../features/rows/scene-name-buffer.ts";
import { paintGuard } from "./editor-owners.ts";

export function sharedSceneNamePorts(shared: { readonly paintedText: PaintedTextSource; readonly bufferedText: BufferedFieldPorts }): SceneNameBufferPorts {
  return {
    field: surface => createBufferedField(shared.bufferedText, surface),
    painted: createPaintedBeats(shared.paintedText),
    report: shared.bufferedText.report,
    shown: edit => paintGuard().whileShown(edit),
    repaintRows: render,
    onPainted,
    beforePaint: onBeforePaint
  };
}
