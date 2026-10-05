#!/bin/bash
# Port of gen1recomp src/core/game3/m4a_worker.lua (GPLv3 + additional terms; see crates/pocketvoxel-core/src/gen3/LICENSE.md).
#
# Writes the M4A oracle the gen3 Rust test compares against:
#   ~/gen3ref/m4a_oracle/44100/ and ~/gen3ref/m4a_oracle/22050/
# from the reference audio cache ~/gen3ref/frfull (gen1recomp's importer).
# Then: cd crates/pocketvoxel-core && cargo test --features gen3 gen3
set -e
here="$(cd "$(dirname "$0")" && pwd)"
cache="${M4A_CACHE:-$HOME/gen3ref/frfull}"
out="${M4A_ORACLE:-$HOME/gen3ref/m4a_oracle}"
src="${GEN1RECOMP:-$HOME/gen1recomp-latest}"
for rate in 44100 22050; do
  mkdir -p "$out/$rate"
  (cd "$src" && luajit "$here/m4a_oracle.lua" "$cache" "$out/$rate" "$rate")
done
# Hash sweep over every song, SE bake and cry (sweep.txt), at 22050 Hz —
# the 3DS host's rate. Writes manifest.txt too, so it gets its own folder.
mkdir -p "$out/sweep22050"
(cd "$src" && luajit "$here/m4a_oracle.lua" "$cache" "$out/sweep22050" 22050 sweep)
