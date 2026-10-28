import { mountBrollPanelFeature } from "./broll.ts";
import { startTagPanels as mountPanelState } from "../../features/tags/panels.js";
import type { TagPanelMount, TagPanelPorts } from "../../features/tags/ports.ts";
import { tagPanelActions as panelDefinitions } from "../../features/tags/actions.ts";
import * as tagPanelCommands from "../../application/tag-panel-commands.ts";
import { installTagPanelCommands } from "../../application/tag-panel-commands.ts";
import { documentReader as portDocument } from "./ports/document.ts";
import { edits as portEdits, productionSelection as portSelection, undoControl as portUndo } from "./ports/editing.ts";
import { text as portText } from "./ports/text.ts";
import { production as portProduction, deletion as portDeletion, tagPanelState as portView } from "./ports/production.ts";
import { panelControl as portPanels } from "./ports/panels.ts";
import { presence as portPresence } from "./ports/presence.ts";
import { shotHiding as portShotHiding } from "./ports/shot-hiding.ts";
import { notices as portNotices } from "./ports/effects.ts";
import { review as portReview } from "./ports/location.ts";
import { ids as portIds } from "./ports/identity.ts";
import { screen as portScreen } from "./ports/screen.ts";
import { bulkDeleteArmed, clearProductionSelection, disarmBulkDelete, productionSelection, selectedKeys } from "../../legacy/production-editing-bridge.ts";
import type { TagsPorts } from "../../features/tags/mount.ts";
import { owned } from "../../features/routing/owned.ts";
import { runFromButton } from "../../legacy/app-actions.ts";
import { sidePanels } from "../../legacy/panels-bridge.ts";
import { mountTagEntityContainer, mountTags } from "../../features/tags/mount.ts";
import { captureOperation, stillOwns } from "../../legacy/transition-bridge.ts";
import { cssAttr } from "../../features/common/dom.ts";
import {
  acceptTagGhost,
  acceptUntaggedMention,
  applyTag,
  closeTagComposer,
  hideTagGhost,
  hideUntaggedPrompt,
  renderTagCategories
} from "../../features/tags/production-tags.js";
import { tagKey } from "../../core/document/tags.ts";
import { currentPlainTags } from "./plain-tags.ts";
import {
  IS_TOUCH,
  addPersonForTag,
  applyGearQuickAdd,
  armDeleteTag,
  armPersonDelete,
  armRemoveTag,
  bulkAddPerson,
  bulkDeleteSelected,
  bulkSetOwner,
  bulkSetStatus,
  handleSelectionClick,
  jumpToTag,
  openProductionPanel,
  renderGearList,
  renderProduction,
  saveTagRename,
  setTagStatus,
  tagAllMentions,
  toggleCardSelection,
  setTagOwner,
  setTagNotes
} from "../../features/tags/panels.js";
import { queueAutoSave } from "../../legacy/save-bridge.ts";
import { localFileMenuControls } from "./local-files.ts";
import { saves as portSaves } from "./ports/saving.ts";
import { onRootClick, routeRootClick, routeRootMouseDown } from "./editor.ts";
import { productionGroupBy, setGearGroupBy, setProductionGroupBy, setTagAddingPerson, setTagExpanded, setTagRenaming, tagAddingPersonKey, tagExpandedKey } from "../../application/tag-panel-state.ts";
import { reviewBlocked, reviewMode } from "../../legacy/location-bridge.ts";

const tags = owned<ReturnType<typeof mountTags>>();

const panelState = owned<TagPanelMount>();

export function mountTagPanelsFeature(): TagPanelMount {
  return panelState.replace(() => {
    const ports: TagPanelPorts = {
      view: portView, document: portDocument, edits: portEdits, text: portText,
      production: portProduction, deletion: portDeletion, selection: portSelection,
      panels: portPanels, presence: portPresence, shotHiding: portShotHiding,
      notices: portNotices, review: portReview, undo: portUndo, ids: portIds
    };
    return mountPanelState(ports);
  }, (owner) => [
    () => installTagPanelCommands(owner),
    () => installTagEntityContainerFactory((id, rootClick) => mountTagEntityContainer({
      window: window,
      id: id,
      ports: {
        rootClick: rootClick,
        reviewMode: portReview.reviewing,
        reviewBlocked: portReview.refuseInReview,
        renderProduction: tagPanelCommands.renderProduction,
        saveTagRename: (key) => tagPanelCommands.saveTagRename(key as string),
        addPersonForTag: (key) => tagPanelCommands.addPersonForTag(key as string),
        setRenaming: portView.setTagRenaming,
        setAddingPerson: portView.setTagAddingPerson,
        setTagOwner: (key, value) => tagPanelCommands.setTagOwner(key as string, value),
        setTagNotes: (key, value) => tagPanelCommands.setTagNotes(key as string, value),
        queueAutoSave: portSaves.dueNow
      }
    }))
  ]);
}

export const stopTagPanelsFeature = panelState.stop;

export function tagPanelActions() {
  return panelDefinitions(panelState.owner, portScreen, portPanels);
}

export function mountTagsFeature(): ReturnType<typeof mountTags> {
  return tags.replace(function () {
    const ports: TagsPorts = {
      acceptTagGhost: acceptTagGhost,
      acceptUntaggedMention: acceptUntaggedMention,
      applyTag: applyTag,
      armBulkDelete: function () { productionSelection().arm(renderProduction); },
      clearProductionSelection: clearProductionSelection,
      closeTagComposer: closeTagComposer,
      disarmBulkDelete: disarmBulkDelete,
      hideTagGhost: hideTagGhost,
      hideUntaggedPrompt: hideUntaggedPrompt,
      renderProduction: renderProduction,
      bulkDeleteSelected: bulkDeleteSelected,
      bulkAddPerson: bulkAddPerson,
      closeGearPanel: () => { sidePanels().close("gear-panel"); },
      closeProductionPanel: () => { sidePanels().close("production-panel"); },
      openProductionPanel: openProductionPanel,
      renderGearList: renderGearList,
      applyGearQuickAdd: applyGearQuickAdd,
      closePlainTag: function () { currentPlainTags()?.close(); },
      refreshPlainTag: function () { currentPlainTags()?.refresh(); },
      reviewBlocked: reviewBlocked,
      queueAutoSave: queueAutoSave,
      selectedKeys: selectedKeys,
      plainTagOpen: function () { return currentPlainTags()?.isOpen() ?? false; },
      reviewMode: reviewMode,
      addPersonForTag: addPersonForTag,
      saveTagRename: saveTagRename,
      tagAllMentions: tagAllMentions,
      renderTagCategories: renderTagCategories,
      armPersonDelete: armPersonDelete,
      armRemoveTag: armRemoveTag,
      armDeleteTag: armDeleteTag,
      setTagStatus: setTagStatus,
      bulkSetOwner: bulkSetOwner,
      bulkSetStatus: bulkSetStatus,
      handleSelectionClick: handleSelectionClick,
      jumpToTag: jumpToTag,
      toggleCardSelection: toggleCardSelection,
      tagKey: function (cat: string | null, name: string | null) { return tagKey(cat as string, name as string); },
      cssAttr: cssAttr,
      exportAs: (...args: Parameters<ReturnType<typeof localFileMenuControls>["exportAs"]>) => localFileMenuControls().exportAs(...args),
      runExport: (...args: Parameters<ReturnType<typeof localFileMenuControls>["runExport"]>) => localFileMenuControls().runExport(...args),
      rootClick: onRootClick,
      runFromButton: runFromButton,
      setTagOwner: setTagOwner,
      setTagNotes: setTagNotes,
      bulkDeleteArmed: bulkDeleteArmed,
      isTouch: function () { return IS_TOUCH as boolean; },
      addingPerson: function () { return tagAddingPersonKey(); },
      expanded: function () { return tagExpandedKey(); },
      productionGroup: function () { return productionGroupBy(); },
      setAddingPerson: function (value) { setTagAddingPerson(value); },
      setRenaming: function (value) { setTagRenaming(value); },
      setExpanded: function (value) { setTagExpanded(value); },
      setProductionGroup: function (value) { setProductionGroupBy(value as string); },
      setGearGroup: function (value) { setGearGroupBy(value as string); },
      capture: function () { const context = captureOperation(); return function () { return stillOwns(context); }; },
      installEntity: function (id) { return createTagEntityContainer(id, onRootClick); }
    };
    return mountTags({ window: window, ports: ports });
  }, function (owner) {
    return [
      function () { return routeRootClick("tags-jump", function (e) { return owner.jumpClick(e); }); },
      function () { return routeRootClick("tags", function (e) { return owner.click(e); }); },
      function () { return routeRootMouseDown("tags-anchor", function (e) { owner.anchorMouseDown(e); return false; }); }
    ];
  });
}

export const stopTagsFeature = tags.stop;

export function mountBrollEventsFeature(): ReturnType<typeof mountBrollPanelFeature> {
  return mountBrollPanelFeature({ exportAs: (...args: Parameters<ReturnType<typeof localFileMenuControls>["exportAs"]>) => localFileMenuControls().exportAs(...args) });
}

type TagEntityContainerFactory = (id: string, rootClick: (event: MouseEvent) => void) => () => void;

let factory: TagEntityContainerFactory | null = null;

function installTagEntityContainerFactory(next: TagEntityContainerFactory): () => void {
  factory = next;
  return () => { if (factory === next) factory = null; };
}

export function createTagEntityContainer(id: string, rootClick: (event: MouseEvent) => void): () => void {
  if (!factory) throw new Error("The tag entity container factory is not installed yet");
  return factory(id, rootClick);
}
