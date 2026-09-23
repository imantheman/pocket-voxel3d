#!/usr/bin/env bash
# One fix, start to finish: the full check, the guest and host builds, the
# 3dsx to every place it is looked for, and -- when asked -- gamedata.json
# beside it. Prints the check's summary first so a regression is the first
# thing on screen, and refuses to deploy over one.
#
# A regression is MORE failures than the baseline -- or FEWER passes: a test
# file that dies loading takes its hundreds of tests with it and reports a
# handful of failures, which read as an improvement to a check that only
# counted those. Both numbers have to hold.
#
#   bash cc_ship.sh            # tests + build + deploy the 3dsx
#   bash cc_ship.sh gamedata   # ...and push gamedata.json too
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
export VOXELMON_G1R="$HOME/gen1recomp"
export VOXELMON_VOXELMOD="$HOME/potato_voxel"
cd ~/pocket-voxel
BASELINE_FAIL=21
BASELINE_PASS=570

echo "=== check"
OUT=$(bash cc_fullcheck.sh 2>&1)
echo "$OUT" | head -5
FAILS=$(echo "$OUT" | grep -E "^ [0-9]+ fail" | awk '{print $1}')
PASSES=$(echo "$OUT" | grep -E "^ [0-9]+ pass" | awk '{print $1}')
if [ -z "$FAILS" ] || [ -z "$PASSES" ] \
   || [ "$FAILS" -gt "$BASELINE_FAIL" ] || [ "$PASSES" -lt "$BASELINE_PASS" ]; then
  echo "$OUT" | grep -E "^\(fail\)|Unhandled|SyntaxError|ReferenceError|TypeError" | head -40
  echo "ship: REFUSED -- $FAILS failures / $PASSES passes against a baseline of $BASELINE_FAIL / $BASELINE_PASS"
  exit 1
fi
echo "=== core"
bash cc_coretest.sh 2>&1 | grep -E "^test result" | tail -1
echo "=== build"
bash cc_build.sh 2>&1 | tail -1
bash cc_build_host.sh 2>&1 | grep -E "^error|Finished" | tail -2
echo "=== deploy"
bash cc_deploy.sh 2>&1 | tail -6
if [ "$1" = "gamedata" ]; then
  echo "=== gamedata"
  bash cc_push_gamedata.sh
fi
echo "ship: DONE"
