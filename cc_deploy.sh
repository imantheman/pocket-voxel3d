#!/usr/bin/env bash
# Put the freshly built 3dsx everywhere it is looked for, and say which build
# it is so a log can be matched to it at a glance.
#
# Desktop/voxelmon/ is the SD-card-shaped folder (paks/, save.lua, the 3dsx)
# that gets copied across by hand. It was NOT being written here, so its copy
# sat stale for a whole day while the loose Desktop one was current -- which
# is indistinguishable, from the outside, from the game ignoring a change.
set -e
SRC=/home/isaac/pocket-voxel/crates/pocketvoxel-3ds/target/armv6k-nintendo-3ds/release/pocketvoxel-3ds.3dsx
DESKTOP=/mnt/c/Users/isaac/OneDrive/Desktop
CITRA=/mnt/c/Users/isaac/AppData/Roaming/Citra/sdmc/3ds/voxelmon

cp "$SRC" "$DESKTOP/pocketvoxel-3ds.3dsx"
mkdir -p "$CITRA"
cp "$SRC" "$CITRA/pocketvoxel-3ds.3dsx"
# The hand-copied SD staging folder, when it exists. It comes and goes --
# it gets moved to the card -- and a SILENT skip here is indistinguishable
# from a build that did not land, so say which it was.
STAGING="skipped (no $DESKTOP/voxelmon)"
if [ -d "$DESKTOP/voxelmon" ]; then
  cp "$SRC" "$DESKTOP/voxelmon/pocketvoxel-3ds.3dsx"
  STAGING="updated"
fi

ID=$(cat /home/isaac/pocket-voxel/.pv_build_id 2>/dev/null || echo "?")
echo "-------------------------------------------------------------"
echo "  build $ID   —  the log's '[pv] boot build=' must say this"
echo "-------------------------------------------------------------"
for f in "$DESKTOP/pocketvoxel-3ds.3dsx" "$DESKTOP/voxelmon/pocketvoxel-3ds.3dsx" \
         "$CITRA/pocketvoxel-3ds.3dsx"; do
  [ -f "$f" ] && ls -l --time-style=+"%H:%M:%S" "$f" | awk '{print "  " $6, $7}'
done
echo "  Desktop/voxelmon: $STAGING"
# Every copy has to BE the build, not just be dated like it.
WANT=$(md5sum < "$SRC" | cut -d' ' -f1)
for f in "$DESKTOP/pocketvoxel-3ds.3dsx" "$DESKTOP/voxelmon/pocketvoxel-3ds.3dsx" \
         "$CITRA/pocketvoxel-3ds.3dsx"; do
  [ -f "$f" ] || continue
  if [ "$(md5sum < "$f" | cut -d' ' -f1)" != "$WANT" ]; then
    echo "  MISMATCH $f"
  fi
done
