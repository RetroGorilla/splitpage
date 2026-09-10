#!/bin/sh
# Remove a portable Splitpage. See uninstall.mjs for what it will and won't take.
set -e
cd "$(dirname "$0")"
if command -v node >/dev/null 2>&1; then
  exec node uninstall.mjs "$@"
fi
echo "This needs Node to run. Without it, just delete this folder — but move" >&2
echo "any scripts in data/ somewhere safe first." >&2
exit 1
