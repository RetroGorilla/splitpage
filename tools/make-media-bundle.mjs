import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput = "D:\\vibecoding\\Splitpage\\scratch\\media-bundle";

export function planMedia(photos, videos, beats = 150) {
  const items = [];
  for (const [kind, count] of [["photo", photos], ["video", videos]]) {
    for (let i = 0; i < count; i++) {
      const ext = kind === "video" ? "mp4" : i % 2 ? "png" : "jpg";
      items.push({ kind, index: i, beat: ((i * 37 + Math.floor(i / 5) * 11 + (kind === "video" ? 7 : 0)) % Math.ceil(beats * 0.8)), name: `${kind}-${String(i + 1).padStart(4, "0")}.${ext}` });
    }
  }
  return items;
}

function parseArgs(args) {
  let output = null, photos = 300, videos = 60;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--small") { photos = 6; videos = 2; }
    else if (arg === "--photos" || arg === "--videos") {
      const value = args[++i];
      if (!/^\d+$/.test(value || "") || Number(value) > 9000) throw new Error(`${arg} needs a whole number from 0 to 9000`);
      if (arg === "--photos") photos = Number(value); else videos = Number(value);
    } else if (arg.startsWith("-") || output) throw new Error("Usage: node tools/make-media-bundle.mjs [output-folder] [--small] [--photos N] [--videos N]");
    else output = arg;
  }
  return { output: path.resolve(output || defaultOutput), photos, videos };
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${error.trim()}`)));
  });
}

async function main() {
  const { output, photos, videos } = parseArgs(process.argv.slice(2));
  const actualOutput = path.join(await realpath(path.dirname(output)), path.basename(output));
  const relative = path.relative(await realpath(repo), actualOutput);
  if (!relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Choose an output folder outside the repository.");
  if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0) throw new Error("ffmpeg is required on PATH; install it before generating a bundle.");
  const plan = planMedia(photos, videos);
  const counts = Array.from({ length: 150 }, () => 0);
  for (const item of plan) counts[item.beat]++;
  if (counts.some((count) => count > 61)) throw new Error("These counts put more than 61 items on a beat; choose smaller counts.");
  await mkdir(output, { recursive: false });
  const folder = path.join(output, "Media speed test files");
  await mkdir(folder);
  const seed = JSON.parse(await readFile(path.join(repo, "src/starters/long-demo.json"), "utf8"));
  const rows = Array.from({ length: 150 }, (_, i) => {
    const source = seed.rows[i % seed.rows.length];
    return { id: `r${i + 1}`, status: "todo", visualText: source.visualText.replace(/<[^>]*>/g, " "), audioText: source.audioText.replace(/<[^>]*>/g, " "), updatedAt: "", updatedBy: null };
  });
  const entries = Array.from({ length: rows.length }, () => []);
  let next = 0;
  async function worker() {
    while (next < plan.length) {
      const item = plan[next++];
      const dest = path.join(folder, item.name);
      const size = item.kind === "photo" ? ["1920x1080", "2560x1440", "3840x2160"][item.index % 3] : ["1280x720", "1920x1080"][item.index % 2];
      const duration = 5 + item.index % 16;
      const source = `testsrc2=size=${size}:rate=${item.kind === "video" ? 12 : 1}`;
      const args = ["-f", "lavfi", "-i", source, "-vf", `hue=h=${item.index * 13 % 360}`, "-threads", "2"];
      if (item.kind === "video") args.push("-t", String(duration), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p", "-movflags", "+faststart");
      else args.push("-frames:v", "1", "-update", "1");
      await runFfmpeg([...args, dest]);
      const bytes = await readFile(dest);
      if (item.kind === "photo") entries[item.beat].push({ order: item.name, visualImage: `data:image/${item.name.endsWith(".png") ? "png" : "jpeg"};base64,${bytes.toString("base64")}`, name: item.name });
      else entries[item.beat].push({ order: item.name, links: [{ name: item.name, size: bytes.length, duration, location: { kind: "bundled", name: item.name }, poster: true }] });
      process.stdout.write(`Generated ${item.name}\n`);
    }
  }
  await Promise.all(Array.from({ length: 3 }, worker));
  for (let i = 0; i < rows.length; i++) {
    const slots = entries[i].sort((a, b) => a.order.localeCompare(b.order)).map((entry) => {
      const slot = { ...entry };
      delete slot.order;
      return slot;
    });
    const first = slots.shift();
    if (first) {
      if (first.visualImage) { rows[i].visualImage = first.visualImage; rows[i].imageName = first.name; }
      if (first.links) rows[i].imageLinks = first.links;
      if (slots.length) rows[i].moreImages = slots;
    }
  }
  const sections = Array.from({ length: 30 }, (_, i) => ({ id: `scene${i + 1}`, name: `Scene ${i + 1}`, firstSceneId: `r${i * 5 + 1}` }));
  const script = path.join(output, "Media speed test.splitpage");
  await writeFile(script, JSON.stringify({ schema: 2, title: "Media speed test", rows, sections, comments: [], people: [], productionTags: [], brollShots: [], wordsPerMinute: 150, rev: 0 }, null, 2));
  const sizes = await Promise.all(plan.map((item) => stat(path.join(folder, item.name))));
  const total = sizes.reduce((sum, file) => sum + file.size, (await stat(script)).size);
  console.log(`Bundle: ${script}\n30 scenes, 150 beats, ${photos} photos, ${videos} videos\nTotal size: ${total} bytes (${(total / 1024 ** 3).toFixed(2)} GiB)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
