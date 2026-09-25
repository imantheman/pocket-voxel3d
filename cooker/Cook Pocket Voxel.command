#!/usr/bin/env bash
# Pocket Voxel cooker, the Mac double-click. Same as cook.sh.
cd "$(dirname "$0")" || exit 1
exec bash ./cook.sh "$@"
