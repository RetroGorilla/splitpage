import { bulkDeleteArmed, clearProductionSelection, disarmBulkDelete, productionSelection, selectedKeys } from "../../legacy/production-editing-bridge.ts";
import type { FindPorts } from "../../features/find/mount.ts";
import type { TagsPorts } from "../../features/tags/mount.ts";
import { owned } from "../../features/routing/owned.ts";
import { runFromButton } from "../../legacy/app-actions.ts";
import { sidePanels } from "../../legacy/panels-bridge.ts";
import { mountFind } from "../../features/find/mount.ts";
import { mountTags } from "../../features/tags/mount.ts";
import { captureOperation, stillOwns } from "../../legacy/transition-bridge.ts";
import { cssAttr } from "../../js/04-richtext.js";
import {
  acceptTagGhost,
  acceptUntaggedMention,
  applyTag,
  closeTagComposer,
  hideTagGhost,
  hideUntaggedPrompt,
  renderTagCategories,
  tagKey
} from "../../js/07-production-tags.js";
import { closePlainTag, plainTagOpen, refreshPlainTag } from "../../js/07b-plain-tags.js";
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
} from "../../js/08-production-panels.js";
import {
  bulkTagOpen,
  closeBulkTag,
  closeFindBar,
  findQueryChanged,
  leaveFindAtMatch,
  pickBulkTagCat,
  replaceAll,
  replaceCurrent,
  runBulkTag,
  stepFind,
  toggleBulkTag
} from "../../js/09-find-replace.js";
import { queueAutoSave } from "../../legacy/save-bridge.ts";
import { exportAs, runExport } from "../../js/18-local-files.js";
import { wireTagEntityContainer } from "../../js/20-teleprompter.js";
import { onRootClick, routeRootClick, routeRootMouseDown } from "./editor.ts";
import { productionGroupBy, setGearGroupBy, setProductionGroupBy, setTagAddingPerson, setTagExpanded, setTagRenaming, tagAddingPersonKey, tagExpandedKey } from "../../application/tag-panel-state.ts";
import { findMatchesCase, setFindMatchCase } from "../../application/find-options.ts";
import { reviewBlocked, reviewMode } from "../../legacy/location-bridge.ts";

const find = owned<ReturnType<typeof mountFind>>();

export function mountFindFeature(): ReturnType<typeof mountFind> {
  return find.replace(function () {
    const ports: FindPorts = {
      closeFindBar: closeFindBar,
      stepFind: stepFind,
      replaceCurrent: replaceCurrent,
      replaceAll: replaceAll,
      toggleBulkTag: toggleBulkTag,
      runBulkTag: runBulkTag,
      closeBulkTag: closeBulkTag,
      pickBulkTagCat: pickBulkTagCat,
      findQueryChanged: findQueryChanged,
      leaveFindAtMatch: leaveFindAtMatch,
      bulkTagOpen: bulkTagOpen,
      getFindMatchCase: function () { return findMatchesCase(); },
      setFindMatchCase: function (value) { setFindMatchCase(value); }
    };
    return mountFind({ window: window, ports: ports });
  });
}

export const stopFindFeature = find.stop;

const tags = owned<ReturnType<typeof mountTags>>();

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
      closePlainTag: closePlainTag,
      refreshPlainTag: refreshPlainTag,
      reviewBlocked: reviewBlocked,
      queueAutoSave: queueAutoSave,
      selectedKeys: selectedKeys,
      plainTagOpen: plainTagOpen,
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
      exportAs: exportAs,
      runExport: runExport,
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
      installEntity: function (id) { return wireTagEntityContainer(id, onRootClick); }
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
