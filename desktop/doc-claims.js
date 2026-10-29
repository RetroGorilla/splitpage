"use strict";

const crypto = require("node:crypto");

function createDocClaims({ policy, homeKeyOf, contentsFor, askToReassign }) {
  const { DOC_ID_RE, chooseDuplicateLoser, docIdFromSha256Hex, duplicateReplacementInput } = policy;
  const claims = new Map();
  let seq = 0;
  const cleanupRegistered = new WeakSet();

  function replacementDocId(fromId, homeKey) {
    const digest = crypto.createHash("sha256")
      .update(duplicateReplacementInput(fromId, homeKey), "utf8")
      .digest("hex");
    return docIdFromSha256Hex(digest);
  }

  function checkDuplicate(senderId) {
    const mine = claims.get(senderId);
    if (!mine) return;
    for (const [otherId, theirs] of claims) {
      if (otherId === senderId) continue;
      const loser = chooseDuplicateLoser(mine, theirs);
      if (!loser) continue;
      const winner = loser === mine ? theirs : mine;
      const loserId = loser === mine ? senderId : otherId;
      const toId = replacementDocId(loser.docId, loser.homeKey);
      if (loser.pendingToId === toId) continue;
      const wc = contentsFor(loserId);
      if (!wc) continue;
      loser.pendingToId = toId;
      try {
        askToReassign(wc, { fromId: loser.docId, toId, otherTitle: winner.title });
      } catch { }
    }
  }

  function record(sender, tab) {
    const webContentsId = sender.id;
    const docId = typeof tab.docId === "string" && DOC_ID_RE.test(tab.docId) ? tab.docId : null;
    const homeKey = docId ? homeKeyOf(tab) : null;
    if (!docId || !homeKey) {
      claims.delete(webContentsId);
      return;
    }
    const previous = claims.get(webContentsId);
    if (previous && previous.docId === docId && previous.homeKey === homeKey) {
      previous.title = tab.title;
      return;
    }
    if (!cleanupRegistered.has(sender)) {
      cleanupRegistered.add(sender);
      sender.once("destroyed", () => { claims.delete(webContentsId); });
    }
    claims.set(webContentsId, {
      docId,
      homeKey,
      seq: ++seq,
      title: tab.title,
      pendingToId: null
    });
    checkDuplicate(webContentsId);
  }

  return { record };
}

module.exports = { createDocClaims };
