#!/usr/bin/env bash
# gamedata.json alone: when only the DATASET changed (no new atlas pages),
# the paks stay as they are and this one file carries the change.
#
# Desktop/voxelmon/ comes and goes -- it gets moved to the card -- so when
# it is not there the file still lands on the Desktop itself, loose, where
# it can be carried across by hand like the 3dsx.
set -e
SRC=/home/isaac/pocket-voxel/dist/voxelmon/paks/gamedata.json
CITRA=/mnt/c/Users/isaac/AppData/Roaming/Citra/sdmc/3ds/voxelmon/paks
DESKTOP=/mnt/c/Users/isaac/OneDrive/Desktop

cp -f "$SRC" "$CITRA/gamedata.json"
if [ -d "$DESKTOP/voxelmon/paks" ]; then
  DEST="$DESKTOP/voxelmon/paks/gamedata.json"
else
  DEST="$DESKTOP/gamedata.json"
fi
cp -f "$SRC" "$DEST"

WANT=$(md5sum < "$SRC" | cut -d' ' -f1)
for f in "$CITRA/gamedata.json" "$DEST"; do
  if [ "$(md5sum < "$f" | cut -d' ' -f1)" = "$WANT" ]; then
    echo "  match  $f"
  else
    echo "  DIFF   $f"
  fi
done
echo "  (goes in paks/ beside the .vxpak files, next to common.vxat)"
