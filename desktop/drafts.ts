"use strict";

import type * as NodeFs from "node:fs";
import type * as NodePath from "node:path";
import type * as NodeCrypto from "node:crypto";
import type {
  DesktopDraftReadHeader, DesktopDraftWriteHeader, DesktopWireDraftWrite,
  DesktopWireDraftDiscard, DesktopWireTakenDraft, DesktopWireDraftSuccess
} from "../shared/desktop-contract.d.ts";

type DraftWriteInput = Omit<DesktopDraftWriteHeader,
  "format" | "formatVersion" | "tabId" | "writtenAt" | "state" | "base" | "appVersion" | "seq">;
type DraftBaseRef = NonNullable<DesktopDraftWriteHeader["base"]>;
type DraftTabRecord = {
  floor: number; epoch: number; lastBase: DraftBaseRef | null; lastHeader: DesktopDraftReadHeader | null;
  held: boolean; holdGen: number; lastSeq: number | null;
};
type DraftReadFailure = {
  bad?: true; unsupported?: true; missing?: true; unreadable?: true;
  header?: undefined; ok?: undefined; stateJson?: undefined;
};
type DraftHeaderRead = DraftReadFailure | {
  header: DesktopDraftReadHeader; bad?: undefined; unsupported?: undefined; missing?: undefined;
  unreadable?: undefined; ok?: undefined; stateJson?: undefined;
};
type DraftGenerationRead = DraftReadFailure | {
  ok: true; header: DesktopDraftReadHeader; stateJson: string;
  bad?: undefined; unsupported?: undefined; missing?: undefined; unreadable?: undefined;
};
type DraftStoreOptions = {
  dir: string; fs: typeof NodeFs; fsp: typeof NodeFs.promises;
  path: typeof NodePath; crypto: typeof NodeCrypto; appVersion?: string;
  testHooks?: {
    failNext?: { code?: string; count?: number };
    maxBodyBytes?: number; writeDelayMs?: number; killBeforeRenameAt?: number; onKill?: () => void;
  } | null;
};

const TAB_ID_RE = /^[0-9a-f]{32}$/;
const BASE_FILE_RE = /^base-[0-9a-f]{12}\.json$/;
const CORRUPT_ENTRY_RE = /^([0-9a-f]{32})-(\d+)(?:-\d+)?$/;

const DRAFT_FORMAT = "splitpage-draft";
const BASE_FORMAT = "splitpage-draft-base";
const FORMAT_VERSION = 1;
const SESSION_FORMAT_VERSION = 1;

const MAX_BODY_BYTES = 256 * 1024 * 1024;

const CORRUPT_KEEP_NEWEST = 10;
const CORRUPT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const HEADER_READ_LIMIT = 4 * 1024 * 1024;

const WRITE_ERROR_CODES = new Set<unknown>(["ENOSPC", "EACCES", "EPERM", "EBUSY", "EIO"]);
const SESSION_STATES = new Set(["running", "clean-exit", "session-end"]);

const RENAME_RETRY_CODES = new Set<string | undefined>(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 20;

function sleepSync(ms: number) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
  }
}

function renameSyncRetry(fs: typeof NodeFs, from: string, to: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= RENAME_ATTEMPTS || !err || !RENAME_RETRY_CODES.has((err as NodeJS.ErrnoException).code)) throw err;
      sleepSync(RENAME_RETRY_MS);
    }
  }
}

function sha256Hex(crypto: typeof NodeCrypto, data: NodeCrypto.BinaryLike) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function durableWriteSync(fs: typeof NodeFs, path: typeof NodePath, crypto: typeof NodeCrypto, file: string, text: unknown) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.tmp-${crypto.randomBytes(6).toString("hex")}-${path.basename(file)}`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, "wx");
    const buf = Buffer.isBuffer(text) ? text : Buffer.from(String(text), "utf8");
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    renameSyncRetry(fs, tmp, file);
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) { }
    }
    try { fs.unlinkSync(tmp); } catch (_) { }
    throw err;
  }
}

function writeFileDurableSync(file: string, text: unknown) {
  durableWriteSync(require("fs") as typeof NodeFs, require("path") as typeof NodePath, require("crypto") as typeof NodeCrypto, file, text);
}

function createDraftStore(opts?: DraftStoreOptions | null) {
  const o = opts || ({} as DraftStoreOptions);
  const { dir, fs, fsp, path, crypto } = o;
  if (typeof dir !== "string" || !dir) throw new TypeError("createDraftStore: dir is required");
  if (!fs || !fsp || !path || !crypto) throw new TypeError("createDraftStore: fs, fsp, path and crypto are required");
  const appVersion = typeof o.appVersion === "string" ? o.appVersion : "";
  const hooks = o.testHooks && typeof o.testHooks === "object" ? o.testHooks : null;

  const sessionFile = path.join(dir, "session.json");
  const corruptDir = path.join(dir, "corrupt");

  const tabs = new Map<string, DraftTabRecord>();
  const queues = new Map<string, Promise<void>>();
  let tombstones = new Set<string>();
  let previousSession = "none";
  let session = {
    formatVersion: SESSION_FORMAT_VERSION,
    state: "running",
    pid: process.pid,
    startedAt: Date.now(),
    appVersion,
    discardedTabIds: [] as string[],
  };
  const stats = { writes: 0, failures: 0 };
  let writesReachedRename = 0;
  let failNextCode: string | null = null;
  let failNextRemaining = 0;
  if (hooks && hooks.failNext && typeof hooks.failNext.code === "string") {
    failNextCode = hooks.failNext.code;
    failNextRemaining = Number.isInteger(hooks.failNext.count) && (hooks.failNext.count as number) > 0 ? hooks.failNext.count as number : 1;
  }

  function tabRec(tabId: string) {
    let rec = tabs.get(tabId);
    if (!rec) {
      rec = { floor: -Infinity, epoch: 0, lastBase: null, lastHeader: null, held: false, holdGen: 0, lastSeq: null };
      tabs.set(tabId, rec);
    }
    return rec;
  }

  function validTabId(tabId: unknown): tabId is string {
    return typeof tabId === "string" && TAB_ID_RE.test(tabId);
  }

  function tabDir(tabId: string) {
    return path.join(dir, tabId);
  }

  function enqueue<T>(tabId: string, task: () => T | Promise<T>): Promise<T> {
    const prev = queues.get(tabId) || Promise.resolve();
    const run = prev.then(task);
    const tail = run.then(noop, noop);
    queues.set(tabId, tail);
    tail.then(() => {
      if (queues.get(tabId) === tail) queues.delete(tabId);
    });
    return run;
  }

  function noop() {}

  function delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  function persistSession() {
    fs.mkdirSync(dir, { recursive: true });
    durableWriteSync(fs, path, crypto, sessionFile, JSON.stringify(session));
  }

  function readSessionSync() {
    try {
      const parsed = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
      return isPlainObject(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function readdirSafe(folder: string) {
    try {
      return fs.readdirSync(folder);
    } catch (_) {
      return [];
    }
  }

  function isDirSafe(p: string) {
    try {
      return fs.statSync(p).isDirectory();
    } catch (_) {
      return false;
    }
  }

  function unlinkQuiet(p: string) {
    try { fs.unlinkSync(p); } catch (_) { }
  }

  function rmQuiet(p: string) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      return true;
    } catch (_) {
      return false;
    }
  }

  function removeTabFolder(tabId: string) {
    const folder = tabDir(tabId);
    if (!fs.existsSync(folder)) return true;
    const trash = path.join(dir, `.trash-${tabId}-${crypto.randomBytes(6).toString("hex")}`);
    try {
      renameSyncRetry(fs, folder, trash);
    } catch (_) {
      rmQuiet(folder);
      return !fs.existsSync(folder);
    }
    rmQuiet(trash);
    return true;
  }

  function classifyDraftHeader(h: unknown, tabId: string): DraftHeaderRead {
    if (!isPlainObject(h) || h.format !== DRAFT_FORMAT || typeof h.formatVersion !== "number") return { bad: true };
    if (h.formatVersion > FORMAT_VERSION) return { unsupported: true };
    if (h.formatVersion !== FORMAT_VERSION) return { bad: true };
    if (h.tabId !== tabId) return { bad: true };
    const s = h.state;
    if (!isPlainObject(s) || !Number.isInteger(s.bytes) || (s.bytes as number) < 0 || typeof s.sha256 !== "string") return { bad: true };
    if (h.base !== null && h.base !== undefined) {
      const b = h.base;
      if (!isPlainObject(b) || typeof b.file !== "string" || !BASE_FILE_RE.test(b.file) ||
          !Number.isInteger(b.bytes) || (b.bytes as number) < 0 || typeof b.sha256 !== "string") return { bad: true };
    }
    return { header: h as DesktopDraftReadHeader };
  }

  function readHeaderSync(file: string, tabId: string): DraftHeaderRead {
    let fd;
    try {
      fd = fs.openSync(file, "r");
    } catch (err) {
      return err && (err as NodeJS.ErrnoException).code === "ENOENT" ? { missing: true } : { bad: true, unreadable: true };
    }
    try {
      const chunks = [];
      const chunk = Buffer.alloc(64 * 1024);
      let pos = 0;
      for (;;) {
        const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
        if (n <= 0) return { bad: true };
        const piece = chunk.subarray(0, n);
        const nl = piece.indexOf(0x0a);
        if (nl >= 0) {
          chunks.push(Buffer.from(piece.subarray(0, nl)));
          break;
        }
        chunks.push(Buffer.from(piece));
        pos += n;
        if (pos > HEADER_READ_LIMIT) return { bad: true };
      }
      let header;
      try {
        header = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch (_) {
        return { bad: true };
      }
      return classifyDraftHeader(header, tabId);
    } catch (_) {
      return { bad: true, unreadable: true };
    } finally {
      try { fs.closeSync(fd); } catch (_) { }
    }
  }

  async function readGeneration(tabId: string, name: string): Promise<DraftGenerationRead> {
    let buf;
    try {
      buf = await fsp.readFile(path.join(tabDir(tabId), name));
    } catch (err) {
      return err && (err as NodeJS.ErrnoException).code === "ENOENT" ? { missing: true } : { bad: true, unreadable: true };
    }
    const nl = buf.indexOf(0x0a);
    if (nl < 0) return { bad: true };
    let header;
    try {
      header = JSON.parse(buf.subarray(0, nl).toString("utf8"));
    } catch (_) {
      return { bad: true };
    }
    const c = classifyDraftHeader(header, tabId);
    if (!c.header) return c;
    const body = buf.subarray(nl + 1);
    if (body.length !== (header as DesktopDraftReadHeader).state.bytes || sha256Hex(crypto, body) !== (header as DesktopDraftReadHeader).state.sha256) return { bad: true };
    return { ok: true, header: header as DesktopDraftReadHeader, stateJson: body.toString("utf8") };
  }

  async function readBase(tabId: string, ref: DesktopDraftReadHeader["base"]): Promise<Pick<DesktopWireDraftSuccess, "baseJson" | "baseProblem">> {
    if (!ref) return { baseJson: null, baseProblem: null };
    let buf;
    try {
      buf = await fsp.readFile(path.join(tabDir(tabId), ref.file));
    } catch (err) {
      return { baseJson: null, baseProblem: err && (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "corrupt" };
    }
    const nl = buf.indexOf(0x0a);
    if (nl < 0) return { baseJson: null, baseProblem: "corrupt" };
    let meta;
    try {
      meta = JSON.parse(buf.subarray(0, nl).toString("utf8"));
    } catch (_) {
      return { baseJson: null, baseProblem: "corrupt" };
    }
    const body = buf.subarray(nl + 1);
    if (!isPlainObject(meta) || meta.format !== BASE_FORMAT || meta.formatVersion !== FORMAT_VERSION ||
        meta.bytes !== ref.bytes || meta.sha256 !== ref.sha256 ||
        body.length !== ref.bytes || sha256Hex(crypto, body) !== ref.sha256) {
      return { baseJson: null, baseProblem: "corrupt" };
    }
    return { baseJson: body.toString("utf8"), baseProblem: null };
  }

  function quarantine(tabId: string) {
    try {
      fs.mkdirSync(corruptDir, { recursive: true });
      const ts = Date.now();
      let dest = path.join(corruptDir, `${tabId}-${ts}`);
      for (let i = 1; fs.existsSync(dest); i++) dest = path.join(corruptDir, `${tabId}-${ts}-${i}`);
      renameSyncRetry(fs, tabDir(tabId), dest);
      return true;
    } catch (_) {
      return false;
    }
  }

  function forgetDiskState(rec: DraftTabRecord) {
    rec.lastBase = null;
    rec.lastHeader = null;
  }

  function tooLarge(str: string) {
    const cap = hooks && Number.isFinite(hooks.maxBodyBytes) ? hooks.maxBodyBytes as number : MAX_BODY_BYTES;
    if (str.length > cap) return true;
    return Buffer.byteLength(str, "utf8") > cap;
  }

  function errorCode(err: unknown) {
    const code = err && (err as NodeJS.ErrnoException).code;
    return WRITE_ERROR_CODES.has(code) ? code as string : "EIO";
  }

  function consumeInjectedFailure() {
    if (!failNextCode || failNextRemaining <= 0) return null;
    failNextRemaining--;
    return failNextCode;
  }

  async function writeFileDurable(file: string, buffers: Buffer[], injectCode: string | null) {
    const fh = await fsp.open(file, "wx");
    let closed = false;
    try {
      if (injectCode) throw Object.assign(new Error(`injected ${injectCode}`), { code: injectCode });
      for (const b of buffers) {
        let off = 0;
        while (off < b.length) {
          const { bytesWritten } = await fh.write(b, off, b.length - off, null);
          off += bytesWritten;
        }
      }
      await fh.sync();
      closed = true;
      await fh.close();
    } catch (err) {
      if (!closed) await fh.close().catch(noop);
      throw err;
    }
  }

  function previousBaseRefs(folder: string, tabId: string, headerThatBecamePrevious: DesktopDraftReadHeader | null, currentExisted: boolean) {
    if (currentExisted && headerThatBecamePrevious) {
      return headerThatBecamePrevious.base ? [headerThatBecamePrevious.base.file] : [];
    }
    const prev = readHeaderSync(path.join(folder, "previous.draft"), tabId);
    if (prev.missing) return [];
    if (!prev.header) return null;
    return prev.header.base ? [prev.header.base.file] : [];
  }

  function pruneBases(folder: string, keepFiles: string[]) {
    const keep = new Set(keepFiles);
    for (const name of readdirSafe(folder)) {
      if (BASE_FILE_RE.test(name) && !keep.has(name)) unlinkQuiet(path.join(folder, name));
    }
  }

  async function doWrite(tabId: string, rec: DraftTabRecord, epoch: number, holdAtCall: number | null, header: DraftWriteInput, stateJson: string, baseJson: string | null, seq: number): Promise<DesktopWireDraftWrite> {
    const fail = (code: string): Extract<DesktopWireDraftWrite, { ok: false }> => {
      rec.lastBase = null;
      if (code !== "NEED_BASE" && code !== "STALE_SEQ" && code !== "DISCARDED" && code !== "HELD") stats.failures++;
      return { ok: false, code };
    };

    if (tombstones.has(tabId)) return fail("DISCARDED");
    if (!isPlainObject(header) || typeof stateJson !== "string" ||
        (baseJson !== null && typeof baseJson !== "string") ||
        typeof seq !== "number" || !Number.isFinite(seq)) return fail("BAD_PAYLOAD");
    if (tooLarge(stateJson) || (baseJson !== null && tooLarge(baseJson))) return fail("TOO_LARGE");
    if (rec.epoch !== epoch || !(seq > rec.floor)) return fail("STALE_SEQ");

    const folder = tabDir(tabId);
    const currentPath = path.join(folder, "current.draft");
    const previousPath = path.join(folder, "previous.draft");

    if (holdAtCall !== null && rec.held && rec.holdGen === holdAtCall) {
      if (fs.existsSync(currentPath) || fs.existsSync(previousPath)) return fail("HELD");
      rec.held = false;
    }

    if (!rec.lastHeader) {
      const cur = readHeaderSync(currentPath, tabId);
      if (cur.unsupported || readHeaderSync(previousPath, tabId).unsupported) return fail("EPERM");
    }

    let baseRef;
    let baseBuf = null;
    if (baseJson === null) {
      if (!rec.lastBase || !fs.existsSync(path.join(folder, rec.lastBase.file))) return fail("NEED_BASE");
      baseRef = rec.lastBase;
    } else {
      baseBuf = Buffer.from(baseJson, "utf8");
      const sha = sha256Hex(crypto, baseBuf);
      baseRef = { file: `base-${sha.slice(0, 12)}.json`, bytes: baseBuf.length, sha256: sha };
    }

    const stateBuf = Buffer.from(stateJson, "utf8");
    const finalHeader: DesktopDraftWriteHeader = Object.assign(
      { format: DRAFT_FORMAT, formatVersion: FORMAT_VERSION, tabId },
      header,
      {
        format: DRAFT_FORMAT as typeof DRAFT_FORMAT,
        formatVersion: FORMAT_VERSION as typeof FORMAT_VERSION,
        tabId,
        writtenAt: Date.now(),
        appVersion,
        seq,
        state: { bytes: stateBuf.length, sha256: sha256Hex(crypto, stateBuf) },
        base: { file: baseRef.file, bytes: baseRef.bytes, sha256: baseRef.sha256 },
      }
    );
    let headerLine;
    try {
      headerLine = JSON.stringify(finalHeader);
    } catch (_) {
      return fail("BAD_PAYLOAD");
    }

    const rand = crypto.randomBytes(6).toString("hex");
    const stateTmp = path.join(dir, `.tmp-${tabId}-state-${rand}`);
    const baseTmp = baseBuf ? path.join(dir, `.tmp-${tabId}-base-${rand}`) : null;
    const pendingTmps: string[] = [];
    const cleanupTmps = () => {
      for (const t of pendingTmps.splice(0)) unlinkQuiet(t);
    };

    try {
      fs.mkdirSync(dir, { recursive: true });
      pendingTmps.push(stateTmp);
      await writeFileDurable(stateTmp, [Buffer.from(headerLine + "\n", "utf8"), stateBuf], consumeInjectedFailure());
      if (baseTmp) {
        pendingTmps.push(baseTmp);
        const meta = { format: BASE_FORMAT, formatVersion: FORMAT_VERSION, bytes: baseRef.bytes, sha256: baseRef.sha256 };
        await writeFileDurable(baseTmp, [Buffer.from(JSON.stringify(meta) + "\n", "utf8"), baseBuf as Buffer], null);
      }
      if (hooks && Number.isFinite(hooks.writeDelayMs) && (hooks.writeDelayMs as number) > 0) await delay(hooks.writeDelayMs as number);

      writesReachedRename++;
      if (hooks && Number.isInteger(hooks.killBeforeRenameAt) && hooks.killBeforeRenameAt === writesReachedRename) {
        pendingTmps.length = 0;
        try { if (typeof hooks.onKill === "function") hooks.onKill(); } catch (_) { }
        return fail("EIO");
      }

      if (tombstones.has(tabId)) {
        cleanupTmps();
        return fail("DISCARDED");
      }
      if (rec.epoch !== epoch || !(seq > rec.floor)) {
        cleanupTmps();
        return fail("STALE_SEQ");
      }

      fs.mkdirSync(folder, { recursive: true });
      if (baseTmp) {
        renameSyncRetry(fs, baseTmp, path.join(folder, baseRef.file));
        pendingTmps.splice(pendingTmps.indexOf(baseTmp), 1);
      }
      const currentExisted = fs.existsSync(currentPath);
      const headerThatBecamePrevious = currentExisted ? rec.lastHeader : null;
      forgetDiskState(rec);
      if (currentExisted) renameSyncRetry(fs, currentPath, previousPath);
      renameSyncRetry(fs, stateTmp, currentPath);
      pendingTmps.length = 0;

      rec.floor = seq;
      rec.lastSeq = seq;
      rec.lastBase = baseRef;
      rec.lastHeader = finalHeader;
      stats.writes++;

      const prevRefs = previousBaseRefs(folder, tabId, headerThatBecamePrevious, currentExisted);
      if (prevRefs) pruneBases(folder, [baseRef.file].concat(prevRefs));

      return { ok: true, seq, bytes: stateBuf.length };
    } catch (err) {
      cleanupTmps();
      forgetDiskState(rec);
      return fail(errorCode(err));
    }
  }

  function write(tabId: string, header: DraftWriteInput, stateJson: string, baseJson: string | null | undefined, seq: number): Promise<DesktopWireDraftWrite> {
    if (!validTabId(tabId)) return Promise.resolve({ ok: false, code: "NO_TAB" });
    const rec = tabRec(tabId);
    const epoch = rec.epoch;
    const holdAtCall = rec.held ? rec.holdGen : null;
    const base = baseJson === undefined ? null : baseJson;
    return enqueue(tabId, () => doWrite(tabId, rec, epoch, holdAtCall, header, stateJson, base, seq));
  }

  function discardClean(tabId: string | undefined, seq: number): Promise<DesktopWireDraftDiscard> {
    if (!validTabId(tabId)) return Promise.resolve({ ok: false, code: "NO_TAB" });
    const rec = tabRec(tabId);
    const epoch = rec.epoch;
    return enqueue(tabId, async () => {
      if (typeof seq !== "number" || Number.isNaN(seq)) return { ok: false, code: "BAD_PAYLOAD" };
      if (rec.held) return { ok: false, code: "HELD" };
      if (rec.epoch !== epoch || seq < rec.floor) return { ok: false, code: "STALE_SEQ" };
      rec.floor = seq;
      forgetDiskState(rec);
      const removed = removeTabFolder(tabId);
      return removed ? { ok: true } : { ok: false, code: "EBUSY" };
    });
  }

  function discardForUserDecision(tabIds: string | undefined | readonly (string | undefined)[], reason: unknown) {
    const ids = (Array.isArray(tabIds) ? tabIds : [tabIds]).filter(validTabId);
    for (const id of ids) {
      tombstones.add(id);
      const rec = tabRec(id);
      rec.held = false;
      forgetDiskState(rec);
    }
    session.discardedTabIds = Array.from(tombstones);
    let persisted = true;
    try {
      persistSession();
    } catch (_) {
      persisted = false;
    }
    const failed = [];
    for (const id of ids) {
      if (!removeTabFolder(id)) failed.push(id);
    }
    return { ok: failed.length === 0, persisted, failed, reason: typeof reason === "string" ? reason : null };
  }

  function take(tabId: string): Promise<DesktopWireTakenDraft | null> {
    if (!validTabId(tabId)) return Promise.resolve(null);
    return enqueue(tabId, async () => {
      if (tombstones.has(tabId)) return null;
      const cur = await readGeneration(tabId, "current.draft");
      if (cur.unsupported) return { unsupported: true };
      let chosen = cur.ok ? cur : null;
      let usedPrevGeneration = false;
      if (!chosen) {
        const prev = await readGeneration(tabId, "previous.draft");
        if (prev.unsupported) return { unsupported: true };
        if (prev.ok) {
          chosen = prev;
          usedPrevGeneration = true;
        } else {
          if (cur.missing && prev.missing) return null;
          if (!cur.unreadable && !prev.unreadable && !tombstones.has(tabId)) {
            forgetDiskState(tabRec(tabId));
            quarantine(tabId);
          }
          return { corrupt: true };
        }
      }
      const base = await readBase(tabId, chosen.header.base);
      const writtenAt = chosen.header.writtenAt;
      return {
        header: chosen.header,
        stateJson: chosen.stateJson,
        baseJson: base.baseJson,
        baseProblem: base.baseProblem,
        ageMs: Number.isFinite(writtenAt) ? Math.max(0, Date.now() - (writtenAt as number)) : null,
        previousSession,
        usedPrevGeneration,
      };
    });
  }

  function hasDraft(tabId: string) {
    if (!validTabId(tabId) || tombstones.has(tabId)) return false;
    const folder = tabDir(tabId);
    return fs.existsSync(path.join(folder, "current.draft")) || fs.existsSync(path.join(folder, "previous.draft"));
  }

  function listingFor(tabId: string) {
    const folder = tabDir(tabId);
    const cur = readHeaderSync(path.join(folder, "current.draft"), tabId);
    let chosen = null;
    let generation = null;
    let status;
    if (cur.unsupported) {
      status = "unsupported";
    } else if (cur.header) {
      chosen = cur.header;
      generation = "current";
      status = "ok";
    } else {
      const prev = readHeaderSync(path.join(folder, "previous.draft"), tabId);
      if (prev.unsupported) {
        status = "unsupported";
      } else if (prev.header) {
        chosen = prev.header;
        generation = "previous";
        status = "ok";
      } else if (cur.missing && prev.missing) {
        return null;
      } else {
        status = "corrupt";
      }
    }
    const h: Partial<DesktopDraftReadHeader> = chosen || {};
    const origin = isPlainObject(h.origin) ? h.origin : null;
    return {
      tabId,
      status,
      generation,
      header: chosen,
      title: typeof h.title === "string" ? h.title : "",
      writtenAt: Number.isFinite(h.writtenAt) ? h.writtenAt as number : null,
      seq: Number.isFinite(h.seq) ? h.seq as number : null,
      docId: typeof h.docId === "string" ? h.docId : null,
      originKind: origin && typeof origin.kind === "string" ? origin.kind : null,
      filePath: origin && typeof origin.filePath === "string" ? origin.filePath : null,
      placement: isPlainObject(h.placement) ? h.placement : null,
    };
  }

  function list() {
    const out = [];
    for (const name of readdirSafe(dir)) {
      if (!TAB_ID_RE.test(name) || tombstones.has(name) || !isDirSafe(path.join(dir, name))) continue;
      const listing = listingFor(name);
      if (listing) out.push(listing);
    }
    out.sort((a, b) => (b.writtenAt || 0) - (a.writtenAt || 0));
    return out;
  }

  function sweepTabFolder(tabId: string) {
    const folder = tabDir(tabId);
    for (const name of readdirSafe(folder)) {
      if (name.startsWith(".tmp-")) rmQuiet(path.join(folder, name));
    }
    const cur = readHeaderSync(path.join(folder, "current.draft"), tabId);
    const prev = readHeaderSync(path.join(folder, "previous.draft"), tabId);
    if (cur.unsupported || prev.unsupported || cur.bad || prev.bad) return;
    const keep = [];
    if (cur.header && cur.header.base) keep.push(cur.header.base.file);
    if (prev.header && prev.header.base) keep.push(prev.header.base.file);
    pruneBases(folder, keep);
    if (cur.missing && prev.missing) {
      try { fs.rmdirSync(folder); } catch (_) { }
    }
  }

  function pruneCorrupt() {
    const now = Date.now();
    const entries = readdirSafe(corruptDir)
      .map((name) => {
        const m = CORRUPT_ENTRY_RE.exec(name);
        return m ? { name, ts: Number(m[2]) } : null;
      })
      .filter<{ name: string; ts: number }>(Boolean as unknown as (value: { name: string; ts: number } | null) => value is { name: string; ts: number })
      .sort((a, b) => b.ts - a.ts);
    for (const e of entries.slice(CORRUPT_KEEP_NEWEST)) {
      if (now - e.ts > CORRUPT_MAX_AGE_MS) rmQuiet(path.join(corruptDir, e.name));
    }
  }

  function init() {
    fs.mkdirSync(dir, { recursive: true });
    const prior = readSessionSync();
    previousSession = prior && SESSION_STATES.has(prior.state as string) ? prior.state as string : "none";
    const priorTombstones = prior && Array.isArray(prior.discardedTabIds) ? prior.discardedTabIds.filter(validTabId) : [];

    const entries = readdirSafe(dir);
    for (const name of entries) {
      if (name.startsWith(".tmp-") || name.startsWith(".trash-")) rmQuiet(path.join(dir, name));
    }

    const remaining = [];
    for (const id of new Set(priorTombstones)) {
      if (!removeTabFolder(id)) remaining.push(id);
    }
    tombstones = new Set(remaining);

    for (const name of entries) {
      if (TAB_ID_RE.test(name) && !tombstones.has(name) && isDirSafe(path.join(dir, name))) sweepTabFolder(name);
    }
    pruneCorrupt();

    tabs.clear();
    session = {
      formatVersion: SESSION_FORMAT_VERSION,
      state: "running",
      pid: process.pid,
      startedAt: Date.now(),
      appVersion,
      discardedTabIds: Array.from(tombstones),
    };
    let sessionWritten = true;
    try {
      persistSession();
    } catch (_) {
      sessionWritten = false;
    }
    return { previousSession, drafts: list(), sessionWritten };
  }

  function markSession(state: string) {
    session.state = state;
    session.discardedTabIds = Array.from(tombstones);
    try {
      persistSession();
      return true;
    } catch (_) {
      return false;
    }
  }

  return {
    init,
    write,
    discardClean,
    discardForUserDecision,
    take,
    hasDraft,
    list,
    hold(tabId: string) {
      if (!validTabId(tabId)) return;
      const rec = tabRec(tabId);
      if (!rec.held) {
        rec.held = true;
        rec.holdGen++;
      }
    },
    release(tabId: string) {
      if (validTabId(tabId)) tabRec(tabId).held = false;
    },
    isHeld(tabId: string) {
      return validTabId(tabId) && tabs.has(tabId) && (tabs.get(tabId) as DraftTabRecord).held;
    },
    resetSeq(tabId: string) {
      if (!validTabId(tabId)) return;
      const rec = tabRec(tabId);
      rec.epoch++;
      rec.floor = -Infinity;
      rec.lastBase = null;
    },
    markCleanExit() {
      return markSession("clean-exit");
    },
    markSessionEnd() {
      return markSession("session-end");
    },
    status(tabId: string) {
      const rec = validTabId(tabId) ? tabs.get(tabId) : null;
      return {
        tabId: validTabId(tabId) ? tabId : null,
        hasDraft: hasDraft(tabId),
        held: !!(rec && rec.held),
        lastSeq: rec ? rec.lastSeq : null,
        tombstoned: validTabId(tabId) && tombstones.has(tabId),
        previousSession,
        writes: stats.writes,
        failures: stats.failures,
      };
    },
  };
}

function restoreDoneAction(outcome: unknown) {
  if (outcome === "failed") return "open";
  if (outcome === "kept") return "drop";
  return "release";
}

export type { createDraftStore, restoreDoneAction, writeFileDurableSync, TAB_ID_RE, MAX_BODY_BYTES };

module.exports = { createDraftStore, restoreDoneAction, writeFileDurableSync, TAB_ID_RE, MAX_BODY_BYTES };
