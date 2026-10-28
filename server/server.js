"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const PORT = Number(process.env.PORT || 8791);
const HOST = process.env.HOST || "0.0.0.0";
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, "..", "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
}

async function handleStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch (e) {
    res.writeHead(400).end();
    return;
  }
  if (rel === "/") rel = "/index.html";

  const full = path.resolve(path.join(STATIC_DIR, rel));
  const root = path.resolve(STATIC_DIR);
  if (full !== root && !full.startsWith(root + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  const segments = path.relative(root, full).split(path.sep);
  if (segments.some((seg) => seg.charAt(0) === ".") || segments[0].toLowerCase() === "data") {
    notFound(res);
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(full);
  } catch (err) {
    notFound(res);
    return;
  }
  if (!stat.isFile()) {
    notFound(res);
    return;
  }

  const ext = path.extname(full).toLowerCase();
  const cache = (ext === ".html" || rel === "/sw.js")
    ? "no-cache"
    : "public, max-age=3600";
  const headers = {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": cache
  };
  if (ext === ".html") headers["Content-Security-Policy"] = "frame-ancestors 'self'";
  res.writeHead(200, headers);
  if (req.method === "HEAD") { res.end(); return; }
  const stream = fs.createReadStream(full);
  stream.on("error", (err) => {
    console.error("[splitpage] static read error for " + full + ": " + (err && err.message));
    res.destroy();
  });
  stream.pipe(res);
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch (e) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Connection": "close" });
    res.end("Bad request");
    return;
  }

  Promise.resolve(handleStatic(req, res, url)).catch((err) => {
    if (res.headersSent) { res.destroy(); return; }
    console.error("[splitpage]", req.method, url.pathname, err && err.stack ? err.stack : err);
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("Server error");
  });
});

server.on("error", (err) => {
  console.error("[splitpage] could not start on " + HOST + ":" + PORT + " — " +
    (err && err.message ? err.message : err));
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log("[splitpage] listening on " + HOST + ":" + PORT);
  console.log("[splitpage] static files from " + STATIC_DIR);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
