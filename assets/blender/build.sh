#!/usr/bin/env bash
# Rebuild every model from source.
#
# The four GLBs under public/models are not hand-made: they come out of the
# Python scripts next to this file, and the same script produces the same bytes.
# Point BLENDER at your install if it is not in the usual place.
set -euo pipefail

BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
if [ ! -x "$BLENDER" ]; then
  BLENDER="$(command -v blender || true)"
fi
if [ -z "$BLENDER" ] || [ ! -x "$BLENDER" ]; then
  echo "Blender not found. Set BLENDER=/path/to/blender and try again." >&2
  exit 1
fi

cd "$(dirname "$0")/../.."
for part in screw plate hole holder; do
  echo "--- $part ---"
  "$BLENDER" --background --python "assets/blender/$part.py" 2>&1 | grep -E "STATS|BUDGET|Error|Traceback" || true
done
ls -la public/models/
