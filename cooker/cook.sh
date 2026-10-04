#!/usr/bin/env bash
# Pocket Voxel cooker, Mac and Linux front door.
#
#   ./cook.sh /path/to/red.gb
#
# On a Mac, double-click "Cook Pocket Voxel.command" instead, then drag the
# .gb file into the window it opens and press Return. Everything it does is
# in cooker.py, next to this file. It needs python3; a Mac without it will
# offer Apple's Command Line Tools, which is where python3 comes from there.
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is not installed. On a Mac: xcode-select --install. On Linux: your package manager."
  exit 1
fi
python3 cooker.py "$@"
