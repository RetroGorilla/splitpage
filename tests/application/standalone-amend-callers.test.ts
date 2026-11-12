import { test } from "node:test";
import assert from "node:assert/strict";
import type { CommonDocumentSession, StandaloneDocumentSession } from "../../src/application/session/document-session.ts";
import type { Undo } from "../../src/application/editing/undo/undo.ts";
import type { FileSavingPorts } from "../../src/application/save/file-saving-ports.ts";
import type { GalleryVideoPorts, VideoBundlePorts } from "../../src/features/gallery/ports.ts";
import type { SessionUndoPorts, liveSession, standaloneSession } from "../../src/bootstrap/wiring/session-owner.ts";
import type { Wiring } from "../../src/bootstrap/wiring.ts";
import { identifierMentions, liveSessionMembers, memberMentions, sourceModuleCount, standaloneTypeMentions } from "./session-caller-scan.ts";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

interface AmendContracts {
  readonly liveSessionIsCommon: Same<ReturnType<typeof liveSession>, CommonDocumentSession>;
  readonly wiringHandsOutCommon: Same<Wiring["session"], CommonDocumentSession>;
  readonly commonHasNoAmend: Same<Extract<keyof CommonDocumentSession, "amend">, never>;
  readonly standaloneDoor: Same<ReturnType<typeof standaloneSession>, StandaloneDocumentSession>;
  readonly undoRoute: Same<Parameters<SessionUndoPorts["route"]>[2], StandaloneDocumentSession["amend"]>;
  readonly galleryFold: Same<GalleryVideoPorts["undo"]["fold"], Undo["foldIntoEdit"]>;
  readonly bundleFold: Same<VideoBundlePorts["undo"]["fold"], Undo["foldIntoEdit"]>;
  readonly saveRelink: Same<FileSavingPorts["history"]["amendRows"], Undo["amendRows"]>;
}

const NAMED: AmendContracts = {
  liveSessionIsCommon: true,
  wiringHandsOutCommon: true,
  commonHasNoAmend: true,
  standaloneDoor: true,
  undoRoute: true,
  galleryFold: true,
  bundleFold: true,
  saveRelink: true
};

const COMMON_MEMBERS = ["cancelRefresh", "dispose", "epoch", "generation", "read", "refresh", "run", "subscribe"];

const AMEND_CARRIERS = [
  "running().current",
  "mine.current",
  "replays",
  "history"
];

const AMEND = {
  "application/editing/undo/undo.ts": 3,
  "bootstrap/wiring/session-owner.ts": 3,
  "bootstrap/wiring/writer.ts": 1
};

const AMEND_TYPES = {
  "bootstrap/wiring/session-owner.ts": 1
};

const STANDALONE_DOOR = {
  "bootstrap/wiring/session-owner.ts": 1,
  "bootstrap/wiring/writer.ts": 2
};

const FOLD_INTO_EDIT = {
  "bootstrap/wiring/gallery.ts": 2
};

const FOLD_PORT = {
  "features/gallery/video-bundles.ts": 1,
  "features/gallery/video.ts": 1
};

const AMEND_ROWS = {
  "application/save/save-completion.ts": 1,
  "bootstrap/wiring/file-saving.ts": 1
};

test("the amend scan reads the app's modules", () => {
  assert.ok(sourceModuleCount() > 500);
});

test("the live session is typed as the common session, and the wiring asks it only for members both kinds of session have", () => {
  assert.deepEqual(Object.keys(NAMED).sort(), ["bundleFold", "commonHasNoAmend", "galleryFold", "liveSessionIsCommon", "saveRelink", "standaloneDoor", "undoRoute", "wiringHandsOutCommon"]);
  for (const [file, members] of Object.entries(liveSessionMembers())) {
    for (const member of members) assert.ok(COMMON_MEMBERS.includes(member), file + " asks the live session for " + member);
  }
});

test("the session's amend is reached from the audited modules, and the standalone session is named where it is", () => {
  assert.deepEqual(memberMentions("amend", AMEND_CARRIERS), AMEND);
  assert.deepEqual(standaloneTypeMentions("amend"), AMEND_TYPES);
  assert.deepEqual(identifierMentions("standaloneSession"), STANDALONE_DOOR);
});

test("the gallery fold and the save-time row relink reach amend only through the undo owner", () => {
  assert.deepEqual(memberMentions("foldIntoEdit", ["undoOwner()"]), FOLD_INTO_EDIT);
  assert.deepEqual(memberMentions("fold", ["ports.undo"]), FOLD_PORT);
  assert.deepEqual(memberMentions("amendRows", ["undoOwner()", "ports.history"]), AMEND_ROWS);
});
