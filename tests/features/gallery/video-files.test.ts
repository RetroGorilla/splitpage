import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import type { DesktopVideoResult } from "../../../src/application/media/desktop-video.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { videoLinkKey } from "../../../src/core/document/gallery.ts";
import { startVideoFiles as mountVideoFiles } from "../../../src/features/gallery/video-files.ts";
import type { VideoFilePorts } from "../../../src/features/gallery/video-files-ports.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeDocument, fakeNotices } from "../fakes.ts";

function setup(overrides: Partial<VideoFilePorts> = {}) {
  const doc = migrateRows({ rows: [{ id: "r1", imageLinks: [{ href: "https://example.com/clip" }, { name: "local.mp4", size: 5 }] }] }, fakeMigration().ports);
  const document = fakeDocument(doc);
  const notices = fakeNotices();
  const external: unknown[] = [];
  const ports: VideoFilePorts = {
    document: document.document,
    notices: notices.notices,
    desktop: { grant: () => null, opens: () => false, open: async () => null, openPath: async () => null },
    externalLinks: { available: () => false, open: (href) => { external.push(href); } },
    ...overrides
  };
  return { document, notices, external, doc, ports, owner: mountVideoFiles(ports) };
}

test("gallery links resolve the current row, slot and key, allow only HTTP(S), and isolate the new browser window", (t) => {
  const h = setup();
  const opened: unknown[][] = [];
  const popup = { opener: {} as unknown };
  t.mock.method(window, "open", (...args: unknown[]) => { opened.push(args); return popup as unknown as Window; });
  const link = { href: "https://example.com/clip" };
  h.owner.openGallery("missing", 0, videoLinkKey(link));
  h.owner.openGallery("r1", 99, videoLinkKey(link));
  h.owner.openGallery("r1", 0, "missing-key");
  assert.deepEqual(opened, []);
  h.owner.openGallery("r1", 0, videoLinkKey(link));
  assert.deepEqual(opened, [[link.href, "_blank", "noopener"]]);
  assert.equal(popup.opener, null);
  const row = h.doc.rows[0];
  assert.ok(row);
  const mail = { href: "mailto:test@example.com" };
  row.imageLinks = [mail];
  h.owner.openGallery("r1", 0, videoLinkKey(mail));
  assert.equal(opened.length, 1);
  h.owner.dispose();
});

test("desktop external links use the supplied capability and local files keep the original warning", () => {
  const external: unknown[] = [];
  const h = setup({ externalLinks: { available: () => true, open: (href) => { external.push(href); } } });
  h.owner.openGallery("r1", 0, videoLinkKey({ href: "https://example.com/clip" }));
  assert.deepEqual(external, ["https://example.com/clip"]);
  h.owner.openGallery("r1", 0, videoLinkKey({ name: "local.mp4", size: 5 }));
  const notice = h.notices.shown[0];
  assert.ok(notice);
  assert.match(notice.message, /video file on the computer it was added from/);
  assert.equal(notice.sticky, true);
  h.owner.dispose();
});

test("document replacement revokes URLs but keeps file grants; disposal unsubscribes and releases the owner's files", (t) => {
  const h = setup();
  const revoked: string[] = [];
  let next = 0;
  t.mock.method(URL, "createObjectURL", () => "blob:owned-" + ++next);
  t.mock.method(URL, "revokeObjectURL", (url: string) => { revoked.push(url); });
  const link = { name: "owned.mp4", size: 3 };
  h.owner.grant({ size: 3 }, link);
  assert.equal(h.owner.url(link), "blob:owned-1");
  assert.equal(h.document.listenerCount(), 1);
  h.document.replace(h.doc);
  assert.deepEqual(revoked, ["blob:owned-1"]);
  assert.equal(h.owner.has(link), true);
  assert.equal(h.owner.url(link), "blob:owned-2");
  h.owner.dispose();
  h.owner.dispose();
  assert.deepEqual(revoked, ["blob:owned-1", "blob:owned-2"]);
  assert.equal(h.document.listenerCount(), 0);
  assert.equal(h.owner.has(link), false);
  assert.equal(h.owner.url(link), null);
});

test("a disposed owner ignores pending grants and native open failures without changing its replacement", async () => {
  let finishGrant: ((value: string | null) => void) | undefined;
  let finishOpen: ((value: DesktopVideoResult | null) => void) | undefined;
  const pendingGrant = new Promise<string | null>((resolve) => { finishGrant = resolve; });
  const pendingOpen = new Promise<DesktopVideoResult | null>((resolve) => { finishOpen = resolve; });
  let granting = Promise.resolve("first-token") as Promise<string | null>;
  const h = setup({ desktop: { grant: () => granting, opens: () => true, open: () => pendingOpen, openPath: async () => null } });
  const link = { name: "pending.mp4", size: 2 };
  h.owner.grant({ size: 2 }, link);
  await Promise.resolve();
  h.owner.openFile(link);
  granting = pendingGrant;
  h.owner.grant({ size: 2 }, link);
  h.owner.dispose();
  const replacement = mountVideoFiles(h.ports);
  assert.ok(finishGrant);
  assert.ok(finishOpen);
  finishGrant("late-token");
  finishOpen({ ok: false, code: "GONE" });
  await Promise.resolve();
  assert.equal(h.notices.shown.length, 0);
  assert.equal(h.owner.has(link), false);
  assert.equal(replacement.has(link), false);
  replacement.openFile(link);
  const notice = h.notices.shown[0];
  assert.ok(notice);
  assert.match(notice.message, /drop “pending.mp4” onto this beat again/);
  replacement.dispose();
});

test("with no grant this session, a link's stored path is sent to the desktop app to check and open", async () => {
  const opened: string[] = [];
  let answer: DesktopVideoResult | null = { ok: true };
  const h = setup({ desktop: { grant: () => null, opens: () => true, open: async () => null,
    openPath: async (path) => { opened.push(path); return answer; } } });
  const located = { name: "take.mp4", size: 5, location: { kind: "path" as const, path: "C:\\Videos\\take.mp4" } };
  h.owner.openFile(located);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(opened, ["C:\\Videos\\take.mp4"]);
  assert.equal(h.notices.shown.length, 0);
  answer = { ok: false, code: "GONE" };
  h.owner.openFile(located);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.notices.shown[0]?.message, "Could not open “take.mp4” — it is no longer where it was.");
  answer = { ok: false, code: "REFUSED" };
  h.owner.openFile(located);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.notices.shown[1]?.message, "Could not open “take.mp4”.");
  h.owner.openFile({ name: "nameless.mp4", size: 5 });
  assert.match(h.notices.shown[2]?.message || "", /drop “nameless.mp4” onto this beat again/);
  assert.equal(opened.length, 3);
  h.owner.dispose();
});

test("a grant from this session opens by its token before the stored path, and the browser never sends a path", async () => {
  const tokens: string[] = [];
  const paths: string[] = [];
  const located = { name: "take.mp4", size: 5, location: { kind: "path" as const, path: "/videos/take.mp4" } };
  const h = setup({ desktop: { grant: async () => "tok", opens: () => true,
    open: async (token) => { tokens.push(token); return { ok: true }; },
    openPath: async (path) => { paths.push(path); return { ok: true }; } } });
  h.owner.grant({ size: 5 }, located);
  await new Promise((resolve) => setImmediate(resolve));
  h.owner.openFile(located);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual({ tokens, paths }, { tokens: ["tok"], paths: [] });
  h.owner.dispose();
  const browser = setup({ desktop: { grant: () => null, opens: () => false, open: async () => null,
    openPath: async (path) => { paths.push(path); return { ok: true }; } } });
  browser.owner.openFile(located);
  assert.deepEqual(paths, []);
  assert.match(browser.notices.shown[0]?.message || "", /video file on the computer it was added from/);
  browser.owner.dispose();
});
