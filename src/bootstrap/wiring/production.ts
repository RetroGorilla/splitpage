import { mountBrollPanelFeature, productionFootage } from "./broll.ts";
import { setBeatFilmed } from "./beat-status.ts";
import { actions as portActions } from "./ports/actions.ts";
import { startTagPanels as mountPanelState } from "../../features/tags/panels.ts";
import type { TagPanelMount, TagPanelPorts } from "../../features/tags/ports.ts";
import { tagPanelActions as panelDefinitions } from "../../features/tags/actions.ts";
import * as tagPanelCommands from "../../application/tag-panel-commands.ts";
import { installTagPanelCommands } from "../../application/tag-panel-commands.ts";
import { documentReader as portDocument, documentLifetime as portLifetime } from "./ports/document.ts";
import { edits as portEdits, focus as portFocus, productionSelection as portSelection, undoControl as portUndo } from "./ports/editing.ts";
import { text as portText } from "./ports/text.ts";
import { production as portProduction, deletion as portDeletion, tagPanelState as portView } from "./ports/production.ts";
import { panelControl as portPanels, sidePanels } from "./ports/panels.ts";
import { personColors as portPersonColors } from "./ports/person-colors.ts";
import { shotHiding as portShotHiding } from "./ports/shot-hiding.ts";
import { notices as portNotices } from "./ports/effects.ts";
import { ids as portIds } from "./ports/identity.ts";
import { screen as portScreen } from "./ports/screen.ts";
import { bulkDeleteArmed, clearProductionSelection, disarmBulkDelete, productionSelection, selectedKeys } from "./production-editing-owners.ts";
import type { TagsPorts } from "../../features/tags/mount.ts";
import { owned } from "../../features/routing/owned.ts";
import { runFromButton } from "./ports/actions.ts";
import { mountTagEntityContainer, mountTags } from "../../features/tags/mount.ts";
import { captureOperation, stillOwns } from "./transition-owners.ts";
import { cssAttr } from "../../features/common/dom.ts";
import {
  acceptTagGhost,
  acceptUntaggedMention,
  applyTag,
  closeTagComposer,
  hideTagGhost,
  hideUntaggedPrompt,
  renderTagCategories
} from "../../features/tags/production-tags.ts";
import { tagKey } from "../../core/document/tags.ts";
import { currentPlainTags } from "./plain-tags.ts";
import {
  IS_TOUCH,
  addPersonForTag,
  clickProductionOutline,
  changeProductionOutline,
  revealProductionItem,
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
} from "../../features/tags/panels.ts";
import { queueAutoSave } from "./save-owners.ts";
import { bulkTagRows } from "./production-index.ts";
import { localFileMenuControls } from "./local-files.ts";
import { saves as portSaves } from "./ports/saving.ts";
import { onRootClick, routeRootClick, routeRootMouseDown } from "./editor.ts";

const tags = owned<ReturnType<typeof mountTags>>();

const panelState = owned<TagPanelMount>();

export function mountTagPanelsFeature(): TagPanelMount {
  return panelState.replace(() => {
    const ports: TagPanelPorts = {
      focus: portFocus, footage: productionFootage,
      beats: { setFilmed: setBeatFilmed, reveal: (id) => { portActions.invoke("reveal-row", "button", id); } },
      view: portView, document: portDocument, lifetime: portLifetime, edits: portEdits, text: portText,
      production: portProduction, deletion: portDeletion, selection: portSelection,
      panels: portPanels, personColors: portPersonColors, shotHiding: portShotHiding,
      notices: portNotices, undo: portUndo, ids: portIds, bulkTag: bulkTagRows
    };
    return mountPanelState(ports);
  }, (owner) => [
    () => installTagPanelCommands(owner),
    () => installTagEntityContainerFactory((id, rootClick) => mountTagEntityContainer({
      window: window,
      id: id,
      ports: {
        rootClick: rootClick,
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
      clickProductionOutline,
      changeProductionOutline,
      revealProductionItem,
      acceptTagGhost: acceptTagGhost,
      acceptUntaggedMention: acceptUntaggedMention,
      applyTag: applyTag,
      armBulkDelete: function () { productionSelection().arm(renderProduction); },
      clearProductionSelection: clearProductionSelection,
      closeTagComposer: function () { if (!currentPlainTags()?.cancelCategory()) closeTagComposer(); },
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
      queueAutoSave: queueAutoSave,
      selectedKeys: selectedKeys,
      plainTagOpen: function () { return currentPlainTags()?.isOpen() ?? false; },
      addPersonForTag: addPersonForTag,
      saveTagRename: saveTagRename,
      tagAllMentions: tagAllMentions,
      renderTagCategories: function (cat) { if (!currentPlainTags()?.chooseCategory(cat)) renderTagCategories(cat); },
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
      addingPerson: function () { return portView.tagAddingPersonKey(); },
      expanded: function () { return portView.tagExpandedKey(); },
      productionGroup: function () { return portView.productionGroupBy(); },
      setAddingPerson: function (value) { portView.setTagAddingPerson(value); },
      setRenaming: function (value) { portView.setTagRenaming(value); },
      setExpanded: function (value) { portView.setTagExpanded(value); },
      setProductionGroup: function (value) { portView.setProductionGroupBy(value as string); },
      setGearGroup: function (value) { portView.setGearGroupBy(value as string); },
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
