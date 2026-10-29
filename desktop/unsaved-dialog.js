"use strict";

function unsavedTitles(list, draftsList) {
  let listing = null;
  return list.map((tab) => {
    if (tab.title) return tab.title;
    if (!listing) listing = draftsList();
    const found = listing.find((d) => d.tabId === tab.id);
    return (found && found.title) || "Untitled";
  });
}

function unsavedDialogFor(count, verb, titles) {
  if (count === 1) {
    return {
      options: {
        type: "warning",
        buttons: ["Leave without saving", "Stay"],
        defaultId: 1,
        cancelId: 1,
        title: "Splitpage",
        message: "You have unsaved changes",
        detail: verb === "Close tab"
          ? "If you close this tab now, your changes will be lost."
          : "If you leave now, your changes will be lost."
      },
      decisions: ["discard", "cancel"]
    };
  }

  const leaveLabel = verb === "Quit" ? "Quit without saving" : "Close without saving";
  return {
    options: {
      type: "warning",
      buttons: ["Review", leaveLabel, "Cancel"],
      defaultId: 0,
      cancelId: 2,
      title: "Splitpage",
      message: `You have unsaved changes in ${count} documents`,
      detail: titles.map((t) => "• " + t).join("\n") + "\n\nIf you continue, these changes will be lost."
    },
    decisions: ["review", "discard", "cancel"]
  };
}

function decisionFor(dialogSpec, choice) {
  return dialogSpec.decisions[choice] || "cancel";
}

module.exports = { unsavedTitles, unsavedDialogFor, decisionFor };
