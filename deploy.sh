#!/bin/bash
# One-command deploy for Splitpage's document server on the unRAID server.
#
#   cd /mnt/user/appdata/splitpage && ./deploy.sh
#
# What it does, in order: check the settings in .env, pull the latest code,
# keep the running version's image as "previous", build the new image (the
# server stays up meanwhile — the app is compiled inside Docker, so this box
# never needs Node), stop the server, snapshot the data folder, start the new
# container, then wait until it answers its health check and show the log.
# Safe to re-run; it stops on the first error rather than half-finishing.
#
# If the new version doesn't come up healthy, go back to the one that was
# running before — this never touches data/ or the code folder:
#
#   cd /mnt/user/appdata/splitpage && ./deploy.sh rollback
#
# DEPLOY.md is the runbook: first-time setup, backups, restoring, traps.

set -euo pipefail

# ---- settings you might need to change ----
PORT="${PORT:-8791}"          # host port; must match what the Cloudflare tunnel points at
BRANCH="${BRANCH:-main}"      # main is the line to deploy; BRANCH=other ./deploy.sh to override
CONTAINER="splitpage"
IMAGE="splitpage"
RUN_AS="99:100"               # unRAID's nobody:users — runs the server and owns data/
KEEP_BACKUPS=10
HEALTH_WAIT_SECONDS=60        # how long a new container gets to answer /api/health
# -------------------------------------------

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
warn() { printf '    \033[1;33mWARNING: %s\033[0m\n' "$1"; }
die()  { printf '\n\033[1;31mSTOPPED: %s\033[0m\n' "$1" >&2; exit 1; }

# ---- the settings check ----
#
# This server goes on the internet with no Cloudflare Access in front of it
# (DEPLOY.md says why), so the owner key in .env is the lock on the door. A
# missing or short one is a reason to stop, not to warn.

[ -f .env ] || die "No .env file in $DIR — the server needs it for its settings.
Make one from the template and give it an owner key: DEPLOY.md, First-time setup, step 3."

# What .env gives a setting, read the way docker's --env-file reads it:
# everything after the first "=", quotes and spaces included. A Windows line
# ending is dropped, as docker drops it.
env_value() {
  sed -n "s/^[[:space:]]*$1=//p" .env | tail -n 1 | tr -d '\r'
}

dupes="$(sed -n 's/^[[:space:]]*\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' .env | sort | uniq -d | tr '\n' ' ')"
[ -z "$dupes" ] || die "These are set on more than one line in .env: $dupes
Keep one line for each (nano .env), so there is no doubt which one the server uses."

# The image sets these to match the container's layout. A DATA_DIR from .env
# in particular would put your scripts INSIDE the container, where the next
# deploy deletes them.
for fixed in PORT HOST DATA_DIR STATIC_DIR; do
  if grep -q "^[[:space:]]*$fixed=" .env; then
    hint=""
    if [ "$fixed" = PORT ]; then
      hint="
To change the port the Cloudflare tunnel reaches, change PORT at the top of deploy.sh instead."
    fi
    die "$fixed is set in .env. Delete that line (nano .env): the image sets $fixed itself to match
the container, and a different value breaks it.$hint"
  fi
done

pin="$(env_value JOIN_PIN)"
[ -n "$pin" ] || die "JOIN_PIN (the owner key) is missing or empty in .env.
Without it anyone who finds https://script.bigmanonline.uk can read and change every script.
DEPLOY.md, First-time setup, step 3 has the one command that generates one."
case "$pin" in
  *[[:space:]]*|*\"*|*\'*)
    die "JOIN_PIN in .env contains a space or a quote mark. Docker keeps those as part of the key,
so the key you type would never match. Write it as JOIN_PIN=yourkey — no quotes, nothing after it." ;;
esac
[ "${#pin}" -ge 20 ] || die "JOIN_PIN in .env is only ${#pin} characters. The owner key guards the server on the internet,
so it must be at least 20 — generate a new one with the command in DEPLOY.md, First-time setup, step 3."
unset pin

# Exactly "1" — the server takes nothing else, not even "1 " with a space.
[ "$(env_value PERSIST_LINKS)" = "1" ] || die "PERSIST_LINKS=1 is missing from .env.
Without it every invite link you have sent stops working, and every device is signed out, each time the server restarts."

# The server reads this one trimmed and in any case, so this does too.
trust="$(env_value TRUST_PROXY | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')"
[ "$trust" = "cloudflare" ] || die "TRUST_PROXY=cloudflare is missing from .env.
Behind Cloudflare the server must count wrong owner-key guesses per visitor using Cloudflare's own header;
anything else lets one stranger lock everybody out, or lets a guesser dodge the limit. DEPLOY.md, Traps."

origins="$(env_value ALLOW_ORIGINS)"
case ",${origins// /}," in
  *,splitpage://app,*) ;;
  *) warn "ALLOW_ORIGINS in .env doesn't include splitpage://app, so the Splitpage desktop app can't connect to
    this server (browsers still can). To fix: ALLOW_ORIGINS=splitpage://app in .env, then docker restart $CONTAINER." ;;
esac

# The container runs as $RUN_AS, so data/ and everything in it must belong to
# that user or the server can't save (EACCES in the log). A data/ made by root
# — mkdir by hand, a restore copied in the wrong way, or docker creating a
# missing -v folder itself — is how that goes wrong, so it is checked every
# time rather than trusted.
prepare_data_dir() {
  mkdir -p data
  if [ -n "$(find data \( ! -uid "${RUN_AS%%:*}" -o ! -gid "${RUN_AS##*:}" \) -print -quit)" ]; then
    chown -R "$RUN_AS" data
    echo "    gave data/ to $RUN_AS, the user the server runs as"
  fi
}

# Start the server container from the image named in $1. The only place the
# container's settings live, so a deploy and a rollback can't drift apart.
start_container() {
  docker rm "$CONTAINER" >/dev/null 2>&1 || true
  prepare_data_dir
  docker run -d \
    --name "$CONTAINER" \
    --restart unless-stopped \
    --user "$RUN_AS" \
    -p "${PORT}:8791" \
    --env-file "$DIR/.env" \
    -v "$DIR/data:/data" \
    "$1" >/dev/null
}

# Wait until the server answers GET /api/health with a 200. Returns non-zero
# if it never does within HEALTH_WAIT_SECONDS.
wait_healthy() {
  if ! command -v curl >/dev/null 2>&1; then
    echo "    (curl isn't installed, so the health check is skipped — read the log below)"
    return 0
  fi
  local waited=0
  while [ "$waited" -lt "$HEALTH_WAIT_SECONDS" ]; do
    if curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:${PORT}/api/health"; then
      echo "    healthy after ${waited}s"
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

# Print what /api/health says (a version and some flags — nothing secret),
# and say so if it isn't keeping invite links across restarts.
show_health() {
  command -v curl >/dev/null 2>&1 || return 0
  local body
  body="$(curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || true)"
  echo "    /api/health says: $body"
  case "$body" in
    *'"linksPersist":true'*) ;;
    *) warn "the server doesn't report \"linksPersist\":true, so invite links and sign-ins won't survive a restart.
    Check PERSIST_LINKS=1 in .env, then: docker restart $CONTAINER" ;;
  esac
}

# Which commit an image was built from (deploy.sh labels every build).
image_commit() {
  local commit
  commit="$(docker image inspect -f '{{ index .Config.Labels "splitpage.commit" }}' "$1" 2>/dev/null || true)"
  if [ -z "$commit" ] || [ "$commit" = "<no value>" ]; then
    commit="an earlier build"
  fi
  echo "$commit"
}

if [ "${1:-}" = "rollback" ]; then
  docker image inspect "$IMAGE:previous" >/dev/null 2>&1 \
    || die "There is no previous version to go back to (no '$IMAGE:previous' image yet)."
  say "1/2  Going back to the previous version ($(image_commit "$IMAGE:previous"))"
  echo "    Your data is not touched: scripts, images and invite links stay exactly as they are."
  docker stop "$CONTAINER" >/dev/null 2>&1 || true
  start_container "$IMAGE:previous"
  say "2/2  Waiting for it to answer its health check"
  if ! wait_healthy; then
    docker logs --tail 40 "$CONTAINER" || true
    die "The previous version didn't come up healthy either. Read the log above; see DEPLOY.md → When something is broken."
  fi
  show_health
  echo
  echo "    Rolled back. The code folder still holds the newer commit; the next"
  echo "    ./deploy.sh builds from it again, so fix the problem on GitHub first."
  exit 0
fi

say "1/7  Getting the latest code ($BRANCH)"
script_before="$(git hash-object "$DIR/deploy.sh")"
git fetch origin
git checkout "$BRANCH"
git pull --ff-only \
  || die "git couldn't update the code folder — it has changes of its own that aren't on GitHub.
Nothing was deployed and the server is untouched. DEPLOY.md → Traps (\"git pull refuses\")."
COMMIT="$(git rev-parse --short HEAD)"
echo "    now at: $(git log --oneline -1)"
# The pull may have replaced this very script, but bash keeps running the
# copy it already opened, so a new deploy.sh would only take effect on the
# *next* deploy. Start over with the new one; the guard variable stops it
# from ever looping. Through bash rather than directly, so a lost executable
# bit can't stop it here.
if [ -z "${SPLITPAGE_DEPLOY_RESTARTED:-}" ] && [ "$(git hash-object "$DIR/deploy.sh")" != "$script_before" ]; then
  echo "    deploy.sh itself changed; restarting with the new version"
  SPLITPAGE_DEPLOY_RESTARTED=1 exec bash "$DIR/deploy.sh" "$@"
fi

say "2/7  Keeping the running version as '$IMAGE:previous'"
# Tag the image the running container actually uses, not whatever
# "$IMAGE:latest" is — after a failed deploy those differ. And only if it is
# healthy: re-running deploy.sh after a failed deploy must not replace the
# last good version with the broken one.
running_image="$(docker inspect -f '{{.Image}}' "$CONTAINER" 2>/dev/null || true)"
if [ -n "$running_image" ] && command -v curl >/dev/null 2>&1 \
  && ! curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:${PORT}/api/health"; then
  echo "    the running version isn't healthy, so the last good one stays as '$IMAGE:previous'"
elif [ -n "$running_image" ]; then
  docker tag "$running_image" "$IMAGE:previous"
  echo "    kept ($(image_commit "$IMAGE:previous")); './deploy.sh rollback' returns to it"
else
  echo "    (no running container — nothing to keep)"
fi

say "3/7  Building the new image (a few minutes the first time; the server stays up)"
# The build context is this folder, which holds data/, backups/ and .env —
# every script and the owner key. .dockerignore is what keeps them out of
# it, so no .dockerignore saying so, no build.
for private in data/ backups/ .env; do
  grep -qxF "$private" .dockerignore 2>/dev/null \
    || die ".dockerignore doesn't exclude $private, so a build here would hand it to docker.
Put GitHub's copy back with: git checkout -- .dockerignore"
done
docker build --label "splitpage.commit=$COMMIT" -t "$IMAGE" .

say "4/7  Stopping the server"
docker stop "$CONTAINER" >/dev/null 2>&1 || echo "    (wasn't running)"

say "5/7  Snapshotting the data folder"
# A hard-link snapshot: a second folder whose file names point at the SAME
# files on disk as data/'s, made in a moment and costing almost no space.
#
# That is a real backup here, not an alias for the live folder, because the
# server never changes a file's contents once written. Every document, the
# invite-links file and every image is written to a temp file and renamed
# over the old name; images are also immutable and named by their SHA-256.
# A rename points data/'s name at a NEW file and leaves the old one — the one
# this snapshot links to — exactly as it was, and a delete removes only
# data/'s name. (A save does bump an image's modification time, which the two
# names share; the bytes never change.) What would break it is editing a file
# in data/ in place by hand — so don't; DEPLOY.md restores by copying.
#
# If this disk can't hard-link, it falls back to an ordinary full copy.
mkdir -p backups
if [ -n "$(find data -mindepth 1 -print -quit 2>/dev/null)" ]; then
  snap="backups/splitpage-$(date +%Y%m%d-%H%M%S)"
  [ ! -e "$snap" ] || snap="$snap-$$"
  if cp -al data "$snap" 2>/dev/null; then
    how="hard-link snapshot"
  else
    rm -rf "$snap"
    cp -a data "$snap"
    how="full copy; this disk can't hard-link"
  fi
  # Newest $KEEP_BACKUPS kept. The names sort by date because the date is in
  # them, so the glob's own order is oldest first. Deleting an old snapshot
  # removes its names only; data/ keeps its own.
  snaps=(backups/splitpage-*)
  excess=$(( ${#snaps[@]} - KEEP_BACKUPS ))
  if [ "$excess" -gt 0 ]; then
    rm -rf -- "${snaps[@]:0:excess}"
  fi
  echo "    saved to $snap/ ($how; keeping the newest $KEEP_BACKUPS)"
else
  echo "    data/ is empty — first run, nothing to back up"
fi

say "6/7  Starting the new container"
start_container "$IMAGE"

say "7/7  Waiting for it to answer its health check (up to ${HEALTH_WAIT_SECONDS}s)"
if ! wait_healthy; then
  docker logs --tail 40 "$CONTAINER" || true
  printf '\n\033[1;31mThe new version (%s) did not come up healthy.\033[0m\n' "$COMMIT" >&2
  if docker image inspect "$IMAGE:previous" >/dev/null 2>&1; then
    echo "Go back to the version that was running before with:" >&2
    echo >&2
    echo "    cd $DIR && ./deploy.sh rollback" >&2
    echo >&2
    echo "It doesn't touch your data. The log above says what went wrong." >&2
  fi
  exit 1
fi
show_health

say "Done — deployed $COMMIT. Showing the log"
echo "    Anyone with Splitpage open should reload it to get the new version."
echo "    'EACCES' below means data/ belongs to the wrong user — DEPLOY.md, Traps."
# Follow the log only when a person is watching. Run unattended (over
# `ssh oldman '... ./deploy.sh'`, from a script) there's no terminal and no one
# to press Ctrl-C, so `logs -f` would never return: print it once and exit.
if [ -t 1 ]; then
  echo "    (Ctrl-C to exit; the server keeps running)"
  docker logs -f --tail 40 "$CONTAINER"
else
  docker logs --tail 40 "$CONTAINER"
fi
