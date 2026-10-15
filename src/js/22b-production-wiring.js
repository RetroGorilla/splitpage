import { owned } from "../features/routing/owned.ts";
import { runFromButton } from "../legacy/app-actions.ts";
import { mountFind } from "../features/find/mount.ts";
import { mountTags } from "../features/tags/mount.ts";
import { S } from "./_state.js";
import { captureOperation, stillOwns } from "../legacy/transition-bridge.ts";
import { cssAttr } from "./04-richtext.js";
import {
  acceptTagGhost,
  acceptUntaggedMention,
  applyTag,
  armBulkDelete,
  bulkDeleteArmed,
  clearProductionSelection,
  closeTagComposer,
  disarmBulkDelete,
  hideTagGhost,
  hideUntaggedPrompt,
  renderTagCategories,
  selectedKeys,
  tagKey
} from "./07-production-tags.js";
import { closePlainTag, plainTagOpen, refreshPlainTag } from "./07b-plain-tags.js";
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
  closeGearPanel,
  closeProductionPanel,
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
} from "./08-production-panels.js";
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
} from "./09-find-replace.js";
import { reviewBlocked, reviewMode } from "./13-hosted.js";
import { queueAutoSave } from "./14-export.js";
import { exportAs, runExport } from "./18-local-files.js";
import { wireTagEntityContainer } from "./20-teleprompter.js";
import { onRootClick, routeRootClick, routeRootMouseDown } from "./22a-editor-wiring.js";

var find = owned();

export function mountFindFeature() {
  return find.replace(function () {
    return mountFind({
    window: window,
    ports: {
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
      getFindMatchCase: function () { return S.findMatchCase; },
      setFindMatchCase: function (value) { S.findMatchCase = value; }
    }
    });
  });
}

export var stopFindFeature = find.stop;

var tags = owned();

export function mountTagsFeature() {
  return tags.replace(function () {
    return mountTags({
    window: window,
    ports: {
      acceptTagGhost: acceptTagGhost,
      acceptUntaggedMention: acceptUntaggedMention,
      applyTag: applyTag,
      armBulkDelete: armBulkDelete,
      clearProductionSelection: clearProductionSelection,
      closeTagComposer: closeTagComposer,
      disarmBulkDelete: disarmBulkDelete,
      hideTagGhost: hideTagGhost,
      hideUntaggedPrompt: hideUntaggedPrompt,
      renderProduction: renderProduction,
      bulkDeleteSelected: bulkDeleteSelected,
      bulkAddPerson: bulkAddPerson,
      closeGearPanel: closeGearPanel,
      closeProductionPanel: closeProductionPanel,
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
      tagKey: tagKey,
      cssAttr: cssAttr,
      exportAs: exportAs,
      runExport: runExport,
      rootClick: onRootClick,
      runFromButton: runFromButton,
      setTagOwner: setTagOwner,
      setTagNotes: setTagNotes,
      bulkDeleteArmed: function () { return bulkDeleteArmed; },
      isTouch: function () { return IS_TOUCH; },
      addingPerson: function () { return S.tagAddingPersonFor; },
      expanded: function () { return S.tagExpanded; },
      productionGroup: function () { return S.productionGroupBy; },
      setAddingPerson: function (value) { S.tagAddingPersonFor = value; },
      setRenaming: function (value) { S.tagRenaming = value; },
      setExpanded: function (value) { S.tagExpanded = value; },
      setProductionGroup: function (value) { S.productionGroupBy = value; },
      setGearGroup: function (value) { S.gearGroupBy = value; },
      capture: function () { var context = captureOperation(); return function () { return stillOwns(context); }; },
      installEntity: function (id) { return wireTagEntityContainer(id, onRootClick); }
    }
    });
  }, function (owner) {
    return [
      routeRootClick("tags-jump", function (e) { return owner.jumpClick(e); }),
      routeRootClick("tags", function (e) { return owner.click(e); }),
      routeRootMouseDown("tags-anchor", function (e) { owner.anchorMouseDown(e); return false; })
    ];
  });
}

export var stopTagsFeature = tags.stop;
