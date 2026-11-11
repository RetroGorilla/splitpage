import { test } from "node:test";
import assert from "node:assert/strict";
import type { CommonDocumentSession, DocumentView } from "../../src/application/session/document-session.ts";
import type { DocumentReader } from "../../src/application/session/document-reader.ts";
import type { DocumentNumbering } from "../../src/core/document/numbering.ts";
import type { CapturePorts } from "../../src/application/save/capture.ts";
import type { ExportKitPorts } from "../../src/application/save/export-kit.ts";
import type { RemoveTagPorts } from "../../src/application/commands/production-actions.ts";
import type { SelectionPorts } from "../../src/application/editing/selection.ts";
import type { OperationPorts } from "../../src/application/session/operation.ts";
import type { HistoryOwnerPorts } from "../../src/application/recovery/history-ports.ts";
import type { DraftsPorts } from "../../src/application/recovery/drafts-ports.ts";
import type { SessionMergeOwnerPorts } from "../../src/application/session/session-merge-ports.ts";
import type { LocalFilesOwnerPorts } from "../../src/application/transitions/local-files-ports.ts";
import type { ProjectFilesPorts } from "../../src/application/save/project-files.ts";
import type { BrollRecordsPorts, BrollPanelPorts } from "../../src/features/broll/ports.ts";
import type { CellClipboardPorts, BeatSelectPorts } from "../../src/features/clipboard/ports.ts";
import type { CommentStatePorts } from "../../src/features/comments/ports.ts";
import type { DesktopPorts } from "../../src/features/desktop/ports.ts";
import type { CompositionPorts } from "../../src/features/editing/composition.ts";
import type { SceneBoundaryPorts } from "../../src/features/editing/scene-boundary.ts";
import type { FileMenuExportPorts, FileMenuDropdownPorts } from "../../src/features/file-menu/ports.ts";
import type { LocalFileMenuPorts } from "../../src/features/file-menu/local-files-ports.ts";
import type { FindPorts } from "../../src/features/find/ports.ts";
import type { GalleryPorts, GalleryOverlayPorts, VideoBundlePorts, GalleryVideoPorts } from "../../src/features/gallery/ports.ts";
import type { VideoFilePorts } from "../../src/features/gallery/video-files-ports.ts";
import type { HelpPorts } from "../../src/features/help/ports.ts";
import type { HistoryPanelPorts } from "../../src/features/history/ports.ts";
import type { ImportDialogPorts } from "../../src/features/imports/ports.ts";
import type { MergeReviewPorts } from "../../src/features/merge/ports.ts";
import type { NewTabPorts } from "../../src/features/newtab/ports.ts";
import type { PrompterFeaturePorts } from "../../src/features/prompter/ports.ts";
import type { ReadTimePorts, BeatPorts, BeatMediaPorts } from "../../src/features/rows/ports.ts";
import type { RowsRenderPorts } from "../../src/features/rows/render-ports.ts";
import type { createBeatStatus } from "../../src/features/rows/beat-status.ts";
import type { SceneControlsPorts } from "../../src/features/rows/scene-controls.ts";
import type { RundownPorts, TargetPorts } from "../../src/features/rundown/ports.ts";
import type { animateRundownClick } from "../../src/features/rundown/click-scroll.ts";
import type { PlainTagPorts, WhoListPorts, TagPanelPorts, ProductionTagPorts } from "../../src/features/tags/ports.ts";
import type { DocumentChromePorts } from "../../src/features/title/ports.ts";
import type { WriterFeaturePorts, FlowWriterPorts } from "../../src/features/writer/ports.ts";
import type { SurfacePorts } from "../../src/features/writer/flow-surface.ts";

type SessionReadContract = Pick<CommonDocumentSession, "epoch" | "generation" | "read"> & {
  readonly current: () => DocumentView | null;
  readonly onChange: CommonDocumentSession["subscribe"];
  readonly numbering: () => DocumentNumbering;
  readonly onReplaced: (listener: () => void) => () => void;
  readonly onRefresh: (listener: (jobs: ReadonlySet<string>) => void) => () => void;
};

function caller<Actual extends Partial<SessionReadContract>>() {
  return <const Keys extends readonly (keyof Actual)[]>(...keys: Keys &
    (Exclude<keyof Actual, Keys[number]> extends never ? unknown : never) &
    (Pick<SessionReadContract, Extract<keyof Actual, keyof SessionReadContract>> extends
      Pick<Actual, Extract<keyof Actual, keyof SessionReadContract>> ? unknown : never)) => keys;
}

const READ_ONLY_CALLERS = {
  "application/session/document-reader.ts:DocumentReader": caller<DocumentReader>()("current", "read", "onChange", "numbering", "onReplaced", "onRefresh"),
  "application/save/capture.ts:CapturePorts": caller<CapturePorts>()("read", "readModels", "clock"),
  "application/save/export-kit.ts:ExportKitPorts": caller<ExportKitPorts>()("read", "preferences", "clock", "ids", "services", "entry", "assets", "following"),
  "application/commands/production-actions.ts:RemoveTagPorts": caller<RemoveTagPorts>()("read", "mentions", "run", "rewrites", "stamps"),
  "application/editing/selection.ts:SelectionPorts": caller<SelectionPorts>()("epoch", "order", "keys"),
  "application/session/operation.ts:OperationPorts.session": caller<OperationPorts["session"]>()("epoch", "generation"),
  "application/recovery/history-ports.ts:HistoryOwnerPorts.document": caller<HistoryOwnerPorts["document"]>()("current"),
  "application/recovery/drafts-ports.ts:DraftsPorts.document": caller<DraftsPorts["document"]>()("current"),
  "application/session/session-merge-ports.ts:SessionMergeOwnerPorts.document": caller<SessionMergeOwnerPorts["document"]>()("current"),
  "application/transitions/local-files-ports.ts:LocalFilesOwnerPorts.document": caller<LocalFilesOwnerPorts["document"]>()("current"),
  "application/save/project-files.ts:ProjectFilesPorts.document": caller<ProjectFilesPorts["document"]>()("current"),
  "features/broll/ports.ts:BrollRecordsPorts.document": caller<BrollRecordsPorts["document"]>()("current", "read", "numbering"),
  "features/broll/ports.ts:BrollPanelPorts.document": caller<BrollPanelPorts["document"]>()("current", "read", "numbering"),
  "features/clipboard/ports.ts:CellClipboardPorts.document": caller<CellClipboardPorts["document"]>()("read"),
  "features/clipboard/ports.ts:BeatSelectPorts.document": caller<BeatSelectPorts["document"]>()("current"),
  "features/clipboard/ports.ts:BeatSelectPorts.lifetime": caller<BeatSelectPorts["lifetime"]>()("epoch"),
  "features/comments/ports.ts:CommentStatePorts.document": caller<CommentStatePorts["document"]>()("current", "read", "numbering"),
  "features/desktop/ports.ts:DesktopPorts.document": caller<DesktopPorts["document"]>()("current"),
  "features/editing/composition.ts:CompositionPorts": caller<CompositionPorts<unknown>>()("epoch", "cellOf", "mark", "dropEmptySince"),
  "features/editing/scene-boundary.ts:SceneBoundaryPorts.document": caller<SceneBoundaryPorts["document"]>()("current"),
  "features/file-menu/ports.ts:FileMenuExportPorts.document": caller<FileMenuExportPorts["document"]>()("current"),
  "features/file-menu/ports.ts:FileMenuDropdownPorts.document": caller<FileMenuDropdownPorts["document"]>()("current"),
  "features/file-menu/local-files-ports.ts:LocalFileMenuPorts.document": caller<LocalFileMenuPorts["document"]>()("current"),
  "features/find/ports.ts:FindPorts.document": caller<FindPorts["document"]>()("current", "read", "onChange"),
  "features/gallery/ports.ts:GalleryPorts.document": caller<GalleryPorts["document"]>()("current", "read", "numbering"),
  "features/gallery/ports.ts:GalleryOverlayPorts.document": caller<GalleryOverlayPorts["document"]>()("current", "read", "numbering"),
  "features/gallery/ports.ts:VideoBundlePorts.document": caller<VideoBundlePorts["document"]>()("read", "onReplaced"),
  "features/gallery/ports.ts:GalleryVideoPorts.document": caller<GalleryVideoPorts["document"]>()("current", "read", "numbering"),
  "features/gallery/video-files-ports.ts:VideoFilePorts.document": caller<VideoFilePorts["document"]>()("current", "read", "onReplaced"),
  "features/help/ports.ts:HelpPorts.document": caller<HelpPorts["document"]>()("current"),
  "features/history/ports.ts:HistoryPanelPorts.document": caller<HistoryPanelPorts["document"]>()("current"),
  "features/imports/ports.ts:ImportDialogPorts.document": caller<ImportDialogPorts["document"]>()("read"),
  "features/merge/ports.ts:MergeReviewPorts.document": caller<MergeReviewPorts["document"]>()("current"),
  "features/newtab/ports.ts:NewTabPorts.document": caller<NewTabPorts["document"]>()("current"),
  "features/prompter/ports.ts:PrompterFeaturePorts.document": caller<PrompterFeaturePorts["document"]>()("current", "numbering"),
  "features/rows/ports.ts:ReadTimePorts.document": caller<ReadTimePorts["document"]>()("current", "read", "numbering"),
  "features/rows/ports.ts:BeatPorts.document": caller<BeatPorts["document"]>()("current", "read"),
  "features/rows/ports.ts:BeatMediaPorts.document": caller<BeatMediaPorts["document"]>()("read", "numbering"),
  "features/rows/render-ports.ts:RowsRenderPorts.document": caller<RowsRenderPorts["document"]>()("current", "read", "numbering"),
  "features/rows/beat-status.ts:createBeatStatus.document": caller<Parameters<typeof createBeatStatus>[0]["document"]>()("current", "read"),
  "features/rows/scene-controls.ts:SceneControlsPorts.document": caller<SceneControlsPorts["document"]>()("current", "numbering"),
  "features/rundown/ports.ts:RundownPorts.document": caller<RundownPorts["document"]>()("current", "read", "numbering"),
  "features/rundown/ports.ts:TargetPorts.document": caller<TargetPorts["document"]>()("current"),
  "features/rundown/click-scroll.ts:animateRundownClick.document": caller<Parameters<typeof animateRundownClick>[2]>()("current"),
  "features/tags/ports.ts:PlainTagPorts.document": caller<PlainTagPorts["document"]>()("current"),
  "features/tags/ports.ts:WhoListPorts.document": caller<WhoListPorts["document"]>()("current"),
  "features/tags/ports.ts:TagPanelPorts.document": caller<TagPanelPorts["document"]>()("current", "read", "numbering"),
  "features/tags/ports.ts:TagPanelPorts.lifetime": caller<TagPanelPorts["lifetime"]>()("epoch"),
  "features/tags/ports.ts:ProductionTagPorts.document": caller<ProductionTagPorts["document"]>()("current", "read", "numbering"),
  "features/title/ports.ts:DocumentChromePorts.document": caller<DocumentChromePorts["document"]>()("current"),
  "features/writer/ports.ts:WriterFeaturePorts.document": caller<WriterFeaturePorts["document"]>()("current", "read", "numbering"),
  "features/writer/ports.ts:FlowWriterPorts.lifetime": caller<FlowWriterPorts["lifetime"]>()("epoch"),
  "features/writer/flow-surface.ts:SurfacePorts.lifetime": caller<SurfacePorts["lifetime"]>()("epoch")
};

test("read-only session callers keep exactly their audited common read members", () => {
  assert.equal(Object.keys(READ_ONLY_CALLERS).length, 53);
  for (const [name, keys] of Object.entries(READ_ONLY_CALLERS)) {
    assert.equal(new Set(keys).size, keys.length, name);
  }
});
