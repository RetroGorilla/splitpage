import { mountRowsRenderFeature } from "../bootstrap/wiring/render.ts";
import { startEditor } from "../bootstrap/wiring/editor-owners.ts";
import { currentDocument } from "../bootstrap/wiring/session-owner.ts";

startEditor({ current: currentDocument, assign() { throw new Error("The render fixture cannot assign a document"); } });
mountRowsRenderFeature();
