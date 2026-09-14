# Map load performance — where this got to

Paused mid-investigation. This is the state of it, the numbers that were
actually measured on hardware, and what was going to happen next.

## The measurement that settles the shape of the problem

From `newlog.txt` on a real 3DS, build 213122, walking Lavender Town ->
Route 8 and back:

```
pak cache 24 MB (heap probe found 48 MB free)
pak REDS_HOUSE_2F   2885 KB in  253 ms   built in   6 ms
pak LAVENDER_TOWN   5543 KB in  491 ms   built in  81 ms
pak ROUTE_8        13338 KB in 1225 ms   built in 247 ms
pak LAVENDER_TOWN  cached (0 ms)         built in  82 ms
read ahead ROUTE_10 (8249 KB)
```

**The SD read is about five times the mesh build.** The card is not slow:
13,338 KB in 1,225 ms is ~11 MB/s. Route 8 simply reads 13 MB. Anything that
does not reduce bytes read, or hide the reading, is aimed at the wrong thing —
including caching built geometry, which was the plan until this log arrived.

The pak cache works (Lavender came back in 0 ms). The read-ahead works.

## What has been done

Each of these is its own commit with the reasoning in the message.

1. **Skip the dead `GAME` section** (`bbac8d1`). Every map's pak carries a
   full copy of `gamedata.json`, 1.18 MB, the same bytes in all 219. Nothing
   reads it — the guest is handed `gamedata.json` from its own file at boot.
   The loader reads the header and section table, then every byte run except
   that one.

2. **Shared atlas** (`dacbb9f`). 428 atlas pages are byte-identical in every
   map, ~1.06 MB of the 1.63 MB an average map spends on atlas texels.
   `tools/pak_share_atlas.py` hoists every page carried by two or more maps
   into `common.vxat` and points each pak's directory at it with
   `pak::ATLAS_SHARED_BIT`. The page directory is untouched, so page indices
   are unchanged and nothing downstream of `Pak.atlases` can tell.
   1131 MB -> 832 MB + 7.3 MB. Verified byte-identical page for page over all
   219 paks.

3. **Read only the geometry that will be drawn** (`eb72740`). `build_map`
   spends a fixed vertex budget in a fixed order and drops the rest to coarse
   or box trees, so Viridian Forest was reading 53 MB and keeping ~5 MB of it.
   `pocketvoxel-core::mapplan` replays that allocation from the 128-byte chunk
   records — which sit ahead of the pools in the section — and the loader
   fetches only those ranges. The renderer is HANDED the plan rather than
   re-deriving it, because the border-ring clip drops triangles and a
   re-derived cascade could pick a hull the loader never read.
   `examples/plan_check.rs` runs the real planner over all 219 paks at every
   chunk the player could be standing in: 219 maps, 0 failures.

4. **Cache and read-ahead** (`d39a523`, `f099569`, `680fb69`, `65cc8b1`).
   Budget sized from a heap probe rather than a hardcoded 24 MB; neighbours
   read ahead 64 KB at a time inside an 8 ms slice of each frame; a partial
   read-ahead is adopted rather than discarded when the player crosses; the
   nearest seam is read first rather than the first neighbour in slot order.

## Where it stands

Indoor maps are roughly 4-5x less I/O than they were. The worst outdoor maps
(Viridian Forest 10.9x, Route 23 8.6x, Route 17 4.4x, Saffron 3.8x) are much
better. **Ordinary outdoor-to-outdoor is still slow** and was still being
worked on when this was paused.

Route 8 after all of the above is ~11.6 MB, about 1.05 s cold. The read-ahead
is meant to cover that during the walk across the previous map; whether it
actually lands has not been confirmed on hardware yet.

## Next, in the order worth trying

1. **Confirm from a log whether the read-ahead lands.** Look for
   `pak ROUTE_8 ... (N KB was read ahead)` or `cached (0 ms)` rather than a
   fresh `in 1105 ms`. Everything below depends on this answer.

2. **If it does not land: cache budget.** The probe found only 48 MB free, so
   `PAK_CACHE_BUDGET_KB` clamped to its 24 MB floor. Two neighbouring outdoor
   maps do not both fit, so walking back and forth re-reads. Worth finding out
   where the other ~80 MB of the console's memory has gone — the pak buffer is
   allocated at FULL file length even when the planned read only fills part of
   it, which is pure waste in the cache accounting.

3. **If it does land and it is still slow: the geometry is too big.** Celadon
   is 94% raw terrain that genuinely gets drawn, so neither the atlas work nor
   the plan touches it. That needs cook-time mesh reduction — merging coplanar
   quads, dropping interior faces — which is a different job in
   `voxelmon/cook/`.

## Dead ends, so they are not tried again

- **Windowing chunks by radius.** Measured: the cities are 7x6 and 8x6 chunks,
  smaller than any draw distance worth having, so a radius-3 window covers
  Celadon whole. Helps 8 of 219 maps by more than 10% while risking holes at
  the edge of the view. `cc_window.py` has the numbers.
- **Caching built geometry.** The log says build is a fifth of the cost. Not
  where the time is.

## Things to know before touching this again

- `cc_deploy.sh` writes the 3dsx to three places, one of which
  (`Desktop/voxelmon/`) is the SD-shaped folder copied to the card by hand. It
  prints the build id; the log's `[pv] boot build=` line must match it or the
  copy did not land.
- `dlog` opens and CLOSES the file per line on purpose. Holding the handle
  open produced no log file at all on hardware: HOME takes the process without
  running destructors and the directory entry is never committed.
- `DEV -> CARD TEST` writes a file and reads it back, and says on screen
  whether the card took it. An SD card that has gone read-only reads its maps
  perfectly and gives nothing else away.
