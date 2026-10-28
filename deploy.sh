#!/bin/bash

set -euo pipefail

PORT="${PORT:-8791}"
BRANCH="${BRANCH:-main}"
CONTAINER="splitpage"
IMAGE="splitpage"
HEALTH_WAIT_SECONDS=60

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
warn() { printf '    \033[1;33mWARNING: %s\033[0m\n' "$1"; }
die()  { printf '\n\033[1;31mSTOPPED: %s\033[0m\n' "$1" >&2; exit 1; }

env_args=()
if [ -f .env ]; then
  dupes="$(sed -n 's/^[[:space:]]*\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' .env | sort | uniq -d | tr '\n' ' ')"
  [ -z "$dupes" ] || die "These are set on more than one line in .env: $dupes
Keep one line for each (nano .env), so there is no doubt which one the server uses."

  for fixed in PORT HOST STATIC_DIR; do
    if grep -q "^[[:space:]]*$fixed=" .env; then
      die "$fixed is set in .env. Delete that line (nano .env): the image sets $fixed itself to match
the container, and a different value breaks it."
    fi
  done
  env_args=(--env-file "$DIR/.env")
fi

image_commit() {
  local commit
  commit="$(docker image inspect -f '{{ index .Config.Labels "splitpage.commit" }}' "$1" 2>/dev/null || true)"
  if [ -z "$commit" ] || [ "$commit" = "<no value>" ]; then
    commit="an earlier build"
  fi
  echo "$commit"
}

start_container() {
  docker rm "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d \
    --name "$CONTAINER" \
    --restart unless-stopped \
    -p "${PORT}:8791" \
    ${env_args[@]+"${env_args[@]}"} \
    "$1" >/dev/null
}

wait_healthy() {
  if ! command -v curl >/dev/null 2>&1; then
    echo "    (curl isn't installed, so the health check is skipped — read the log below)"
    return 0
  fi
  local waited=0
  while [ "$waited" -lt "$HEALTH_WAIT_SECONDS" ]; do
    if curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:${PORT}/"; then
      echo "    healthy after ${waited}s"
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

if [ "${1:-}" = "rollback" ]; then
  docker image inspect "$IMAGE:previous" >/dev/null 2>&1 \
    || die "There is no previous version to go back to (no '$IMAGE:previous' image yet)."
  say "1/2  Going back to the previous version ($(image_commit "$IMAGE:previous"))"
  docker stop "$CONTAINER" >/dev/null 2>&1 || true
  start_container "$IMAGE:previous"
  say "2/2  Waiting for it to answer"
  if ! wait_healthy; then
    docker logs --tail 40 "$CONTAINER" || true
    die "The previous version didn't come up healthy either. Read the log above."
  fi
  echo
  echo "    Rolled back. The code folder still holds the newer commit; the next"
  echo "    ./deploy.sh builds from it again, so fix the problem on GitHub first."
  exit 0
fi

say "1/6  Getting the latest code ($BRANCH)"
script_before="$(git hash-object "$DIR/deploy.sh")"
git fetch origin
git checkout "$BRANCH"
git pull --ff-only \
  || die "git couldn't update the code folder — it has changes of its own that aren't on GitHub.
Nothing was deployed and the server is untouched."
COMMIT="$(git rev-parse --short HEAD)"
echo "    now at: $(git log --oneline -1)"
if [ -z "${SPLITPAGE_DEPLOY_RESTARTED:-}" ] && [ "$(git hash-object "$DIR/deploy.sh")" != "$script_before" ]; then
  echo "    deploy.sh itself changed; restarting with the new version"
  SPLITPAGE_DEPLOY_RESTARTED=1 exec bash "$DIR/deploy.sh" "$@"
fi

say "2/6  Keeping the running version as '$IMAGE:previous'"
running_image="$(docker inspect -f '{{.Image}}' "$CONTAINER" 2>/dev/null || true)"
if [ -n "$running_image" ] && command -v curl >/dev/null 2>&1 \
  && ! curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:${PORT}/"; then
  echo "    the running version isn't healthy, so the last good one stays as '$IMAGE:previous'"
elif [ -n "$running_image" ]; then
  docker tag "$running_image" "$IMAGE:previous"
  echo "    kept ($(image_commit "$IMAGE:previous")); './deploy.sh rollback' returns to it"
else
  echo "    (no running container — nothing to keep)"
fi

say "3/6  Building the new image (a few minutes the first time; the server stays up)"
grep -qxF ".env" .dockerignore 2>/dev/null \
  || die ".dockerignore doesn't exclude .env, so a build here would hand it to docker.
Put GitHub's copy back with: git checkout -- .dockerignore"
docker build --label "splitpage.commit=$COMMIT" -t "$IMAGE" .

say "4/6  Stopping the server"
docker stop "$CONTAINER" >/dev/null 2>&1 || echo "    (wasn't running)"

say "5/6  Starting the new container"
start_container "$IMAGE"

say "6/6  Waiting for it to answer (up to ${HEALTH_WAIT_SECONDS}s)"
if ! wait_healthy; then
  docker logs --tail 40 "$CONTAINER" || true
  printf '\n\033[1;31mThe new version (%s) did not come up healthy.\033[0m\n' "$COMMIT" >&2
  if docker image inspect "$IMAGE:previous" >/dev/null 2>&1; then
    echo "Go back to the version that was running before with:" >&2
    echo >&2
    echo "    cd $DIR && ./deploy.sh rollback" >&2
    echo >&2
    echo "The log above says what went wrong." >&2
  fi
  exit 1
fi

say "Done — deployed $COMMIT. Showing the log"
echo "    Anyone with Splitpage open should reload it to get the new version."
if [ -t 1 ]; then
  echo "    (Ctrl-C to exit; the server keeps running)"
  docker logs -f --tail 40 "$CONTAINER"
else
  docker logs --tail 40 "$CONTAINER"
fi
