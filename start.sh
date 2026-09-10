#!/bin/sh
# Splitpage on macOS and Linux.
set -e
cd "$(dirname "$0")"
if command -v node >/dev/null 2>&1; then
  exec node start.mjs "$@"
fi
cat >&2 <<'MSG'
Splitpage needs Node to serve itself on this platform.

Install it from https://nodejs.org and run this again. Without a served page a
browser will not offer "Install app", will not run the offline service worker,
and will not give the teleprompter a microphone for Follow My Voice.

You can still open index.html directly in a browser to write and export.
MSG
exit 1
