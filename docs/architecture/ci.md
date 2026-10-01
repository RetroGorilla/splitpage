# Why the CI and container configuration looks the way it does

Workflow and configuration files carry no comments
([plan](../IMPLEMENTATION-PLAN.md) section 2; `npm run check:comments` enforces
it). A setting whose reason is not visible in the file itself is explained
here, under the file and the step that holds it. [testing.md](testing.md#ci)
lists what each job runs.

## `.github/workflows/ci.yml`

| Where | Why |
| --- | --- |
| `checks` job, `SPLITPAGE_CHROME_ARGS: --no-sandbox --disable-dev-shm-usage` | Ubuntu 24.04's AppArmor blocks the user namespaces Chromium's sandbox needs. Without these flags the browser dies before it opens a DevTools (CDP) port, and every browser step fails. |
| `changes`, `checks`, `node-24` and `gate` jobs, `runs-on: ${{ vars.CI_RUNNER \|\| 'ubuntu-latest' }}` | The repository variable `CI_RUNNER` sends these jobs to a self-hosted runner: the maintainer's PC, in WSL Ubuntu, with the label `splitpage-local`. Delete the variable and they go back to GitHub's runners. While no runner with that label is online, jobs wait in the queue for up to a day, the `gate` check with them. `desktop-smoke` and `docker.yml` stay on GitHub's runners: they need `sudo apt-get` and Docker. `CI_RUNNER` must name a Linux runner: the comment gate reads a `runs-on` expression by its string literals, here `'ubuntu-latest'`, and so scans these jobs' scripts as bash. The runner needs git, a workspace on the Linux filesystem (not under `/mnt/`) and Chromium's libraries. Each run downloads Playwright's Chromium again, because checkout cleans the workspace. Pull requests from forks must never reach it: delete `CI_RUNNER` before the repository goes public. |
| `checks` job, step `Install Chromium`, `--with-deps` only when `runner.environment == 'github-hosted'` | `--with-deps` runs `sudo apt-get`, which a self-hosted runner can't do without a password. Chromium's system libraries are installed once on that machine instead (`npx playwright@<PLAYWRIGHT_VERSION> install-deps chromium`, as root). |
| `checks` job, step `Install Chromium` | The runner's `/usr/bin/chromium` is a snap that never opens a debugging port. The step installs Playwright's Chromium (pinned by `PLAYWRIGHT_VERSION`) under `PLAYWRIGHT_BROWSERS_PATH`, finds its `chrome` binary and hands it to the driver as `SPLITPAGE_CHROME`. |
| `checks` job, step `Browser suite 265 (…persistence)` | The fast gate's persistence suite. `265-browser-drafts.txt` keeps a server document's unsaved edits in IndexedDB while saves fail (through a fetch emulator), finds them again after reloads, merges them and drops the draft once a save lands. It is its own step so its runtime shows in the job log; its logs land in `suites/persistence/`, inside the folder the failure upload takes. |
| `desktop-smoke` job, step `Install desktop dependencies`, `npm_config_arch` | `desktop/.npmrc` pins `arch=arm64` for the maintainer's Windows-on-ARM machine. An `npm_config_*` environment variable outranks `.npmrc`, so the runner's own architecture wins. Plan section 8 replaces the unconditional pin. |
| `desktop-smoke` job, step `Fetch the dev Electron binary` | Runs `node node_modules/electron/install.js` directly, not through npm: npm would turn `desktop/.npmrc`'s `arch=arm64` into `npm_config_arch` and fetch a binary the x64 runner cannot execute. |
| `desktop-smoke` job, step `Desktop smoke (dev target)` | Xvfb is started by hand because `xvfb-run` intermittently returns its own cleanup failure as the exit status. The `grep` on Xvfb's stderr drops xkbcomp's harmless unknown-keysym warnings, about 1,700 lines a run. |

## `.github/workflows/docker.yml`

`image` builds the root `Dockerfile` with the legacy builder (as `deploy.sh`
does on unRAID) and starts it with the settings `deploy.sh` insists on.
`prebuilt` builds the app, copies into an empty folder only the files
`ci.yml` uploads as the `splitpage-app` artifact, and builds and starts
`Dockerfile.prebuilt` from that folder, so the recipe DEPLOY.md §8 gives for
running without a checkout is exercised on the artifact's inputs. The job
holds no file list of its own: `node tools/artifact-files.mjs --stage <dir>`
reads the paths from `ci.yml`'s `Upload the built app` step and copies
exactly those, failing on a missing file or on a glob it cannot reproduce.
`tools/test-artifact-files.mjs` also checks that everything
`Dockerfile.prebuilt` copies is in that list. A change to `ci.yml` or to
the script runs this workflow.

## `.github/workflows/release.yml`

The workflow builds what DEPLOY.md §7 publishes, from a `v*` tag, on a
GitHub-hosted Windows runner: `node package.mjs` (which builds `index.html`
itself before zipping), then `npm run dist:win` in `desktop/`, then
`SHA256SUMS.txt`. DEPLOY.md §7 has the release procedure. A run started by
hand (Actions ▸ Release ▸ Run workflow) builds from any branch and never
drafts a release; the `draft` job runs only for a tag.

| Where | Why |
| --- | --- |
| `build` job, `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` | The installers are unsigned (#81). Without this electron-builder looks for a signing certificate in the runner's store. |
| `build` job, step `Read VERSION and check the tag` | `VERSION` is the single source of truth (`desktop/stage.mjs` checks `desktop/package.json` against it). A tag naming another version would publish files whose names and update checks disagree with it. |
| `build` job, step `Desktop installers (dist:win, with verify-dist)` | `dist:win` runs `stage.mjs`, electron-builder for x64 and arm64, then `verify-dist.mjs`: the architecture checks and the payload extraction that caught 2.0.1's empty ARM64 installer. A mismatch fails the job there. |
| `build` job, step `Collect the release files and their checksums` | Only the per-arch installers are published, not the combined one (DEPLOY.md §7). The `sha256sum` output format is the one `desktop/main.js` reads to check a downloaded update. |
| `draft` job, `SPLITPAGE_RELEASES_TOKEN` | A fine-grained personal access token with Contents read and write on `RetroGorilla/splitpage-releases` and nothing else. This repository's own `GITHUB_TOKEN` cannot write to another repository. Without the secret the job leaves the files on the run as an artifact and says so. |

## Desktop packaging (`desktop/electron-builder.yml`)

The configuration that `dist:win` hands to electron-builder is explained,
setting by setting, in [desktop-build.md](desktop-build.md): what goes into the
asar and what is staged beside it, why both architectures are pinned, and why
the NSIS payload is a ZIP with differential packaging off.

## `.github/dependabot.yml`

Dependency updates arrive as pull requests, so they run through the same CI
as any other change. They are weekly and grouped, so a week's updates are
one pull request per area rather than a stream.

| Entry | Why |
| --- | --- |
| npm, `/desktop` | The Electron shell and its installer builder. Major Electron releases change Chromium and the security defaults, so they are read, not merged on green. |
| docker, `/` | The server image's base, `node:22-alpine` in both Dockerfiles. |

## `Dockerfile` and `Dockerfile.prebuilt`

`Dockerfile` builds the app and the document server into one small image in
two stages; `Dockerfile.prebuilt` is its second stage alone, over the built
files in the `splitpage-app` artifact.

| Where | Why |
| --- | --- |
| `USER node` | The server runs as the image's built-in non-root user. When the container cannot write to an unRAID share, pass `--user` with the share's uid and gid rather than running as root (DEPLOY.md §5; `deploy.sh` and CI use `99:100`). |
| `COPY … ./public/` | The files the browser downloads live in their own directory, so `STATIC_DIR` can never expose the server source or the data volume. |
| `COPY server/ ./server/` | `server.js` is CommonJS and `server/package.json` says so; a `"type": "module"` anywhere above it would otherwise stop it running, so the folder is copied whole. |
| `RUN mkdir -p /data && chown node:node /data` | The path exists even when no volume is mounted, so a quick `docker run` with no `-v` still works for a smoke test. |
| `HEALTHCHECK … CMD node -e …` | A plain request to `/api/health` made with `node` itself, so the image needs no `curl` or `wget`. |

## `docker-compose.yml`

The compose file is the unRAID setup for `docker compose` (DEPLOY.md §8).

| Where | Why |
| --- | --- |
| `ports: "8791:8791"` | Bound to the LAN so the Cloudflare tunnel (and you) can reach it. The tunnel connects outbound, so the port never needs forwarding. |
| `volumes: ./data:/data` | Every document lives there as one `.json` file. Back it up by copying the folder; there is no database and no index to rebuild. |
| `user: "99:100"` | An unRAID share is usually owned by `nobody:users` (`99:100`). If the container logs `EACCES` on startup, this is the line to change (DEPLOY.md §5). |
