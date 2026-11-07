import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFakeDesktopBackend } from "../../../src/adapters/desktop/fake-desktop.ts";
import type { DesktopRouteRequest } from "../../../src/adapters/desktop/desktop-port.ts";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

test("a save dialog hands out an id without creating the file, as the real dialog does", async () => {
  const fake = makeFakeDesktopBackend();
  const picked = await fake.saveFileDialog({ suggestedName: "new.splitpage" });
  assert.ok(picked);
  assert.equal(picked.name, "new.splitpage");
  await assert.rejects(fake.readFile(picked.id), /ENOENT/);
  assert.equal(await fake.statFile(picked.id), null);
  const written = await fake.writeFile(picked.id, new TextEncoder().encode("body"));
  assert.equal(written.size, 4);
  assert.equal(text((await fake.readFile(picked.id)).bytes), "body");
  assert.equal((await fake.statFile(picked.id))?.size, 4);
});

test("writing a string stores its UTF-8 bytes, and any other kind of data is refused", async () => {
  const fake = makeFakeDesktopBackend();
  const id = fake._addFile("a.txt", "old");
  await fake.writeFile(id, "héllo" as unknown as Uint8Array);
  assert.equal(fake._text(id), "héllo");
  await assert.rejects(fake.writeFile(id, 42 as unknown as Uint8Array), /unsupported data type/);
  await assert.rejects(fake.writeFile(id, null as unknown as Uint8Array), /unsupported data type/);
  assert.equal(fake._text(id), "héllo");
});

test("reading, writing, statting and routing an unknown file id are refused", async () => {
  const fake = makeFakeDesktopBackend();
  await assert.rejects(fake.readFile("nope"), /ENOENT: unknown file id/);
  await assert.rejects(fake.writeFile("nope", new Uint8Array(1)), /ENOENT: unknown file id/);
  await assert.rejects(fake.statFile("nope"), /ENOENT: unknown file id/);
  await assert.rejects(fake.routeOpen({ kind: "file", fileId: "nope" }), /ENOENT: unknown file id/);
});

test("routing a file the fake holds answers this tab, and any other kind of request is refused", async () => {
  const fake = makeFakeDesktopBackend();
  const id = fake._addFile("a.splitpage", "{}");
  assert.deepEqual(await fake.routeOpen({ kind: "file", fileId: id }), { where: "this-tab" });
  await assert.rejects(fake.routeOpen({ kind: "other" } as unknown as DesktopRouteRequest), /route-open: unknown kind/);
  await assert.rejects(fake.routeOpen(null as unknown as DesktopRouteRequest), /route-open: unknown kind/);
});
