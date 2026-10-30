# Why the CI configuration looks the way it does

Workflow and configuration files carry no comments
([plan](../IMPLEMENTATION-PLAN.md) section 2; `npm run check:comments` enforces
it). A setting whose reason is not visible in the file itself is explained
here, under the file and the step that holds it. [testing.md](testing.md#ci)
lists what each job runs.

## `.github/workflows/ci.yml`

The change classifier reports `code`, `app` and `desktop` separately.
`desktop` is `app` plus any non-prose change under `desktop/test/`, so an edit
to the smoke itself runs the smoke; it decides whether `desktop-smoke` runs.
For non-prose
changes requiring a fresh run, static checks and both test shards remain
required. Only known test-only
paths, the classifier itself, issue templates, Dependabot configuration and
selected non-browser workflows can skip the app build, browser suites and
built-app upload in `checks`. Runtime source, server code, dependencies,
browser tooling, `ci.yml`, `nightly.yml` and unknown paths retain full app
coverage. Unknown or empty diffs also run everything. Renames are expanded
into removed and added paths so moving runtime code into a test folder cannot
hide the runtime change. Test shards retain their own build and stamp check.

Chromium is stored outside the checkout in
`$RUNNER_TOOL_CACHE/splitpage-playwright/$PLAYWRIGHT_VERSION`. Self-hosted
runners reuse that version across checkout cleanup; a version bump selects
a new directory. GitHub-hosted runners still install system dependencies.
Where present, nightly and native Windows workflows use the same versioned
cache layout. No new schedule or runner routing is introduced.

| Where | Why |
| --- | --- |
| `checks` job, `SPLITPAGE_CHROME_ARGS: --no-sandbox --disable-dev-shm-usage` | Ubuntu 24.04's AppArmor blocks the user namespaces Chromium's sandbox needs. Without these flags the browser dies before it opens a DevTools (CDP) port, and every browser step fails. |
| `changes`, `checks`, `tests` and `gate` jobs, `runs-on: ${{ contains(github.event.pull_request.labels.*.name, 'ci-github') && 'ubuntu-latest' \|\| vars.CI_RUNNER \|\| 'ubuntu-latest' }}` | The label `ci-github` on a pull request sends only that pull request's runs to GitHub's runners, so one queued run can skip the queue without moving every other run (see [Testing](testing.md#ci)). The label's string literal makes the comment gate's runner reading `unknown`, so a comment in these jobs' scripts that reads differently as bash and as PowerShell needs a `shell:` on its step. The repository variable `CI_RUNNER` (`splitpage-local`) sends these jobs to the self-hosted runners with that label: `splitpage-unraid-1` and `splitpage-unraid-2` on the unRAID server, `splitpage-wsl` and `splitpage-wsl-2` in WSL Ubuntu on the maintainer's PC. Delete the variable and they go back to GitHub's runners. While no runner with that label is online, jobs wait in the queue for up to a day, the `gate` check with them. `desktop-smoke` stays on GitHub's runners: it needs `sudo apt-get`. `CI_RUNNER` must name a Linux runner: the comment gate reads a `runs-on` expression by its string literals, here `'ubuntu-latest'`, and so scans these jobs' scripts as bash. The runner needs git, a workspace on the Linux filesystem (not under `/mnt/`) and Chromium's libraries. Playwright's versioned Chromium cache lives under `RUNNER_TOOL_CACHE`, outside checkout cleanup. Pull requests from forks must never reach it: delete `CI_RUNNER` before the repository goes public. |
| Tab strip width check | Removed by the maintainer's decision (2026-10-14). It guarded PR #17's bug (editing one tab's title resized every other tab) and cost about 55 s per run; see `ci-audit.md` in the project files. `desktop/tabstrip/` still ships. |
| Node 24 | CI has no separate Node 24 job: `checks` and both test shards read `.nvmrc`, which pins Node 24.22.0 since the end-of-M5 upgrade. Node 22 stays inside `package.json`'s `engines` for the portable install, which uses the user's own Node, but CI no longer runs it. |
| `checks` job, step `Browser suites for save, typing, undo and export` | Real-app coverage of the four paths a pull request most often breaks, on the same two lanes and port block as the step before it. Save: `19-save-conflict`, `28-autosave`, `185-autosave-every-edit`, `261-import-save-back-late-edit`, `270-save-open-every-surface`, `283-save-status-by-destination`, `285-save-buttons-one-state`. Typing: `06-writer`, `81-draft-edit`, `282-editor-operations`, `289-script-cell-ime`. Undo: `73-undo`, `84-undo-caret`, `267-writer-undo`. Export: `03-exports`, `41-export-polish`, `259-xlsx-export`, `284-exports-from-a-fixture`, `98-export-dialog`. Each passed twice locally on Windows before it was listed. The known flaky suites (186, 247, 266, 173, 30, 134) are not in it and no suite in it is retried; a suite that turns flaky leaves the list, it is not retried or relaxed. The step adds about 75 s to `checks` (2 min 8 s against about 55 s without it, first hosted run of the pull request that added it); the budget is 6 min. Its logs go to the `suite-logs` artifact in `suites-flows` when it fails. |
| `tests` matrix and `checks` | Two jobs run `npm run test:all -- --shard 1/2` and `2/2` independently of `checks`, which retains lint, types, dependency/comment checks, the build, the browser suites 01, 52 and the save, typing, undo and export set above, and the single app-artifact upload. With both Unraid runners online, the scheduler runs the shards on separate available runner slots; the short `checks` job also shares the two slots. Each shard builds its own app and checks the worker stamp before testing. No build artifact is passed between checkouts. Sorted files in each discovered group are distributed by alternating index, so every file runs in exactly one shard, with no maintained filename list. `fail-fast: false` lets the other shard finish after a failure. |
| `desktop-smoke` job, `if: needs.changes.outputs.desktop == 'true' && needs.changes.outputs.tested != 'true'` | The Electron dev-target smoke (`desktop/test/smoke.mjs --only-target dev`, about 600 checks launching real Electron processes under Xvfb) runs on every pull request and every push to `main` or `4.1-development` whose change touches app or desktop code, unless the same tree already passed. It stays on `ubuntu-latest` whatever the `ci-github` label says: it needs `sudo apt-get` for Xvfb, which the self-hosted runners cannot do. It runs in parallel with `checks` and `tests`, so a run lasts as long as the smoke does: 5 min 30 s in the first hosted run (the smoke step 4 min 46 s). The 90-minute timeout is unchanged. |
| `gate`, `needs: [changes, checks, tests, desktop-smoke]` | The required `gate` succeeds for code only when classification, `checks`, the aggregate result of both test shards and, when `changes` reports `desktop=true`, `desktop-smoke` succeed. Failed, cancelled or skipped shards cannot pass a code change, and a smoke that was skipped when it was due, or that ran when it was not, fails the gate. For prose-only changes, or a tree another run already passed, `checks`, `tests` and `desktop-smoke` must all be skipped. A code change with `desktop=false` (test-only paths) needs `desktop-smoke` skipped. `tools/test-ci-shards.mjs` checks the workflow's matrix/dependencies and executes the actual gate script against success, failure, cancellation and skip combinations. |
| `on.push` and `concurrency` | Every merge to `4.1-development` runs CI again on the merged commit, the only run that tests the merged result when the base moved after the pull request's last run (unless the `changes` job finds the same tree already passed, below). A push run classifies only the files its own push changed (`github.event.before` to the new commit), so a docs-only merge skips `checks`. `cancel-in-progress` on `ci-${{ github.ref }}` cancels a push run when the next merge lands before it finishes. If that next merge is docs-only, the cancelled merge's code is never tested after merging; rerun the cancelled run by hand. |
| `changes` job, step `Find a passed run of this exact tree`; `gate` job, `ci-passed-tree-<tree>` upload | A pull request's run tests GitHub's trial merge of its branch into the base as the base was when the run started. When nothing else merged since, the merge commit has exactly that tree (the same files), so the push run after the merge would repeat the same checks. Each run whose `checks` and both `tests` shards succeed, and whose `desktop-smoke` succeeded or was not due, uploads a small artifact named `ci-passed-tree-<git tree SHA>`. It asks for 30 days but lives only as long as the repository's artifact retention allows (3 days in October 2026); once it expires, the push run runs everything. On a push to `4.1-development`, `tools/ci-tested-tree.mjs --lookup` lists artifacts by that name for the pushed commit's tree and accepts one only from another run of `ci.yml` that concluded `success` and ran on this repository's own branches, not a fork's. A match sets `tested=true`: `checks`, `tests` and `desktop-smoke` skip and `gate` passes on `changes` alone. No match, or any API error, runs everything as before. The job needs `actions: read` to list artifacts. Pushes to `main` never skip the tree check, but a test-only `main` push skips the app build, the `splitpage-app` upload and, unless it changes a non-prose file under `desktop/test/` (the smoke's own files, which run `desktop-smoke` and its own app build), `desktop-smoke` too; a skipped `4.1-development` push has no `splitpage-app` of its own, and the pull request's last run holds the same build. `tools/test-ci-tested-tree.mjs` covers which runs count; `tools/test-ci-shards.mjs` runs the gate script against every `tested` value. |
| `checks` job, step `Install Chromium`, `--with-deps` only when `runner.environment == 'github-hosted'` | `--with-deps` runs `sudo apt-get`, which a self-hosted runner can't do without a password. Chromium's system libraries are installed once on that machine instead (`npx playwright@<PLAYWRIGHT_VERSION> install-deps chromium`, as root). |
| `checks` job, step `Install Chromium` | The runner's `/usr/bin/chromium` is a snap that never opens a debugging port. The step installs Playwright's Chromium (pinned by `PLAYWRIGHT_VERSION`) under `PLAYWRIGHT_BROWSERS_PATH`, finds its `chrome` binary and hands it to the driver as `SPLITPAGE_CHROME`. |
| `checks` job, step `Pick this runner's port block` | Two runners on one machine would start their suite servers on the same ports. The step takes the number at the end of `RUNNER_NAME` (1 when there is none, as in `splitpage-wsl`) and maps it to a block of 100 ports, `(n + 9) % 10 * 100`, passed to `tools/run-suites.mjs` as `--port-base`. Numbers 1 to 10 get blocks 0 to 900; numbers ten apart (1 and 11) share one. Runners that share a machine must get different blocks; `splitpage-unraid-1` and `splitpage-wsl` share block 0 but run on different machines. |
| `desktop-smoke` job, step `Install desktop dependencies` | Runs `npm ci` without an architecture override. Architecture selection is confined to the subsequent Electron binary fetch; desktop/.npmrc has been removed. |
| `desktop-smoke` job, step `Fetch the dev Electron binary` | Runs `npm run fetch-electron`. `desktop/electron-arch.mjs` selects the machine architecture, detecting native Windows ARM64 even under x64 Node emulation, then sets `npm_config_arch` for Electron's installer. Explicit `npm_config_arch` or `ELECTRON_ARCH` wins, in that order; unknown values fail. Electron 44 has no postinstall. |
| `desktop-smoke` job, step `Desktop smoke (dev target)` | Xvfb is started by hand because `xvfb-run` intermittently returns its own cleanup failure as the exit status. The `grep` on Xvfb's stderr drops xkbcomp's harmless unknown-keysym warnings, about 1,700 lines a run. |

## `.github/workflows/release.yml`

The workflow builds what docs/RELEASING.md §3 publishes, from a `v*` tag, on a
GitHub-hosted Windows runner: `node tools/package.mjs` (which builds `index.html`
itself before zipping), then `npm run dist:win` in `desktop/`, then
`SHA256SUMS.txt`. docs/RELEASING.md §3 has the release procedure. A run started by
hand (Actions ▸ Release ▸ Run workflow) builds from any branch and never
drafts a release; the `draft` job runs only for a tag.

| Where | Why |
| --- | --- |
| `build` job, `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` | The installers are unsigned (#81). Without this electron-builder looks for a signing certificate in the runner's store. |
| `build` job, step `Read VERSION and check the tag` | `VERSION` is the single source of truth (`desktop/stage.mjs` checks `desktop/package.json` against it). A tag naming another version would publish files whose names and update checks disagree with it. |
| `build` job, step `Desktop installers (dist:win, with verify-dist)` | `dist:win` runs `stage.mjs`, electron-builder for x64 and arm64, then `verify-dist.mjs`: the architecture checks and the payload extraction that caught 2.0.1's empty ARM64 installer. A mismatch fails the job there. |
| `build` job, step `Collect the release files and their checksums` | Only the per-arch installers are published, not the combined one (docs/RELEASING.md §3). The `sha256sum` output format is the one `desktop/main.js` reads to check a downloaded update. |
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
