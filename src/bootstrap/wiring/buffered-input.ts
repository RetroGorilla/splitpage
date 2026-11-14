import { createBufferedField } from "../../application/editing/buffered-field.ts";
import type { BufferedFieldPorts } from "../../application/editing/buffered-field.ts";
import { createPaintedBeats } from "../../application/editing/painted-beats.ts";
import type { PaintedTextSource } from "../../application/editing/ports.ts";
import { onBeforePaint, onPainted, render } from "../../features/rows/render.ts";
import type { BufferedInputPorts } from "../../features/common/buffered-input.ts";
import { paintGuard } from "./editor-owners.ts";

export function sharedBufferedInputPorts(shared: { readonly paintedText: PaintedTextSource; readonly bufferedText: BufferedFieldPorts }): BufferedInputPorts {
  return {
    field: surface => createBufferedField(shared.bufferedText, surface),
    painted: createPaintedBeats(shared.paintedText),
    report: shared.bufferedText.report,
    shown: edit => paintGuard().whileShown(edit),
    repaint: render,
    onPainted,
    beforePaint: onBeforePaint
  };
}
