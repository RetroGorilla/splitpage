import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { REPO, WORKFLOW, artifactPaths, stage, main } from "./artifact-files.mjs";

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log("  ok   " + name); return; }
  failures.push(name + (detail ? " — " + detail : ""));
  console.log("  FAIL " + name + (detail ? " — " + detail : ""));
}

function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function thrown(fn) {
  try { fn(); return ""; } catch (error) { return error.message; }
}

const upload = (paths, name = "splitpage-app") => [
  "      - name: Upload the built app",
  "        uses: actions/upload-artifact@v4",
  "        with:",
  `          name: ${name}`,
  "          path: |",
  ...paths.map((p) => `            ${p}`)
].join("\n");
const workflow = (...steps) => ["jobs:", "  checks:", "    runs-on: ubuntu-latest", "    steps:", "      - run: node build.mjs", ...steps, ""].join("\n");

console.log("\nthe repository's own lists:\n");

const real = artifactPaths(readFileSync(join(REPO, WORKFLOW), "utf8"));
check("ci.yml's splitpage-app upload is found", real.includes("index.html") && real.includes("Dockerfile.prebuilt") && real.includes("server"), JSON.stringify(real));

{
  const copies = readFileSync(join(REPO, "Dockerfile.prebuilt"), "utf8").split("\n")
    .filter((line) => /^COPY\s/i.test(line))
    .flatMap((line) => line.trim().split(/\s+/).slice(1).filter((t) => !t.startsWith("--")).slice(0, -1))
    .map((p) => p.replace(/\/+$/, ""));
  check("Dockerfile.prebuilt copies something", copies.length > 0);
  eq("everything Dockerfile.prebuilt copies is in the artifact", copies.filter((p) => !real.includes(p)), []);
}

console.log("\nartifactPaths():\n");

eq("paths are read from the named upload, trailing slashes dropped", artifactPaths(workflow(upload(["index.html", "server/"]))), ["index.html", "server"]);
check("a workflow with no such upload is an error", thrown(() => artifactPaths(workflow(upload(["a"], "other")))).includes("0 actions/upload-artifact steps named splitpage-app"));
check("two such uploads are an error", thrown(() => artifactPaths(workflow(upload(["a"]), upload(["b"])))).includes("2 actions/upload-artifact steps"));
check("an upload with no paths is an error", thrown(() => artifactPaths(workflow(upload([])))).includes("lists no paths"));
for (const bad of ["*.svg", "!server/x", "../outside", "/etc/passwd"]) {
  check(`${bad} is refused rather than staged wrongly`, thrown(() => artifactPaths(workflow(upload(["index.html", bad])))).includes(bad));
}

console.log("\nstage() and the command line:\n");

const work = mkdtempSync(join(tmpdir(), "splitpage-artifact-files-"));

function repoWith(files) {
  const repo = mkdtempSync(join(work, "repo-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  return repo;
}

{
  const repo = repoWith({ "index.html": "<p>app</p>", "server/server.js": "x", "server/package.json": "{}", "src/secret.js": "no" });
  const into = join(work, "staged");
  stage(["index.html", "server"], into, repo);
  eq("files and folders are copied under their own paths", [existsSync(join(into, "index.html")), existsSync(join(into, "server/server.js")), existsSync(join(into, "server/package.json"))], [true, true, true]);
  eq("nothing else is copied", existsSync(join(into, "src")), false);
  check("a missing path is an error that names it", thrown(() => stage(["index.html", "sw.js"], join(work, "other"), repo)).includes("sw.js"));
}

{
  const repo = repoWith({ [WORKFLOW]: workflow(upload(["index.html", "VERSION"])), "index.html": "x", VERSION: "1.0.0\n" });
  const run = (args) => {
    const out = [];
    const err = [];
    const code = main(args, { repo, print: (l) => out.push(l), printError: (l) => err.push(l) });
    return { code, out, err: err.join("\n") };
  };
  eq("with no arguments it prints the list", run([]), { code: 0, out: ["index.html", "VERSION"], err: "" });
  const into = join(work, "cli");
  const staged = run(["--stage", into]);
  eq("--stage copies the list and says so", [staged.code, existsSync(join(into, "VERSION")), staged.out[0].startsWith("artifact-files: staged 2 paths")], [0, true, true]);
  eq("--stage without a folder is a usage error", run(["--stage"]).code, 2);
  eq("an unknown flag is a usage error", run(["--all"]).code, 2);
  writeFileSync(join(repo, WORKFLOW), workflow(upload(["index.html", "sw.js"])));
  const missing = run(["--stage", join(work, "cli2")]);
  eq("a file the build has not written fails the staging", [missing.code, missing.err.includes("sw.js")], [1, true]);
}

rmSync(work, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
