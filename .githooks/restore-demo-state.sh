#!/bin/sh
# Put the demo document back into index.html, leaving all code changes alone.
#
# Swaps only the single JSON line inside <script id="state-data"> for the
# baseline in .githooks/demo-state.json. Use this after accidentally saving a
# script into the app's own index.html — `git checkout -- index.html` would
# also throw away any real code edits, which is usually not what you want.

set -e
cd "$(dirname "$0")/.."

BASE=".githooks/demo-state.json"
[ -f "$BASE" ] || { echo "restore: $BASE is missing." >&2; exit 1; }
[ -f "index.html" ] || { echo "restore: index.html is missing." >&2; exit 1; }

# Anchored to ^ and stopped at the first hit ON PURPOSE. The string
# '<script id="state-data" type="application/json">' also appears INSIDE the
# app's JavaScript (buildPublishHtml's openTag, indented). An unanchored match
# rewrites the line after that one too, which silently corrupts the code —
# this cost a real file during testing. The document's own tag is the only
# one at column 0, and it comes first.
CURRENT=$(awk '/^<script id="state-data"/{getline; print; exit}' index.html)
if [ -z "$CURRENT" ]; then
  echo "restore: could not find the state-data line in index.html." >&2
  exit 1
fi
if [ "$CURRENT" = "$(cat "$BASE")" ]; then
  echo "restore: index.html already carries the demo document — nothing to do."
  exit 0
fi

# Write via a temp file and move it into place, so an interrupted run cannot
# leave a half-written index.html behind.
TMP="index.html.restore.$$"
awk -v basefile="$BASE" '
  BEGIN { getline demo < basefile; done = 0 }
  { print }
  /^<script id="state-data"/ && !done { getline; print demo; done = 1 }
' index.html > "$TMP"

# Refuse to install an obviously broken result rather than trusting the awk.
if [ ! -s "$TMP" ] || ! grep -q '</html>' "$TMP"; then
  rm -f "$TMP"
  echo "restore: the rewritten file looked wrong — index.html left untouched." >&2
  exit 1
fi

mv "$TMP" index.html
echo "restore: demo document put back. Your code changes are untouched."
echo "         Remember to save real scripts outside this repo."
