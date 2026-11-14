import type { SharedCommentPorts } from "../../../application/commands/comments.ts";
import type { SharedDocumentHandle } from "../../../adapters/collab/types.ts";

export function sharedCommentPorts(source: { readonly handle: () => SharedDocumentHandle | null; readonly author: SharedCommentPorts["author"]; readonly cells: SharedCommentPorts["cells"] }): () => SharedCommentPorts | null {
  return () => source.handle() ? { author: source.author, cells: source.cells } : null;
}
