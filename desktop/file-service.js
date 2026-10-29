"use strict";

const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");

const OPENABLE_EXTENSIONS = [".splitpage", ".md", ".html", ".htm", ".docx", ".txt", ".csv"];

function filesToOpenFrom(list, baseDir) {
  const out = [];
  for (const item of list) {
    if (item.startsWith("-")) continue;
    const ext = path.extname(item).toLowerCase();
    if (!OPENABLE_EXTENSIONS.includes(ext)) continue;
    try {
      const abs = path.resolve(baseDir, item);
      if (fs.statSync(abs).isFile()) out.push(abs);
    } catch { }
  }
  return out;
}

function pathKey(absPath, platform = process.platform) {
  const resolved = path.resolve(absPath);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function createFileRegistry() {
  const paths = new Map();
  return {
    register(absPath) {
      const id = crypto.randomBytes(16).toString("hex");
      paths.set(id, absPath);
      return id;
    },
    pathOf(id) {
      return paths.get(id);
    }
  };
}

async function readFileEntry(id, absPath) {
  const stat = await fsp.stat(absPath);
  const buf = await fsp.readFile(absPath);
  return {
    id,
    name: path.basename(absPath),
    lastModified: Math.floor(stat.mtimeMs),
    size: stat.size,
    bytes: new Uint8Array(buf)
  };
}

function toBuffer(data) {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw new Error("writeFile: unsupported data type");
}

async function atomicWrite(absPath, buffer) {
  const dir = path.dirname(absPath);
  const tmp = path.join(dir, `.${path.basename(absPath)}.tmp-${crypto.randomBytes(6).toString("hex")}`);
  await fsp.writeFile(tmp, buffer);
  try {
    await fsp.rename(tmp, absPath);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

module.exports = {
  filesToOpenFrom,
  pathKey,
  createFileRegistry,
  readFileEntry,
  toBuffer,
  atomicWrite
};
