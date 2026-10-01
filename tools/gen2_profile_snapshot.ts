// Regenerate voxelmon/cook/gen2-profile.json, the Gold shape profile the
// cook reads, from Gen2Recomped-DramaticShapes data/voxel_heights.lua (MIT,
// Copyright (c) 2026 DramaticShape, modified by UNDERdecodedHD; the licence
// is voxelmon/cook/gen2-profile.LICENSE). Needs that checkout at the pinned
// commit and LuaJIT; nobody cooking needs either, which is the point.
//
//   VOXELMON_VOXELMOD_GEN2=~/dl/Gen2Recomped-DramaticShapes bun tools/gen2_profile_snapshot.ts
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { dumpGen2Profile, GEN2_PROFILE_SNAPSHOT, voxelmodGen2Dir } from "../voxelmon/cook/data.ts";

const PIN = "726782f";
const dir = voxelmodGen2Dir();
const head = execFileSync("git", ["-C", dir, "rev-parse", "--short=7", "HEAD"], { encoding: "utf8" }).trim();
if (head !== PIN) {
  console.error(`gen2 profile: ${dir} is at ${head}, not the pinned ${PIN}`);
  process.exit(1);
}
const profile = dumpGen2Profile(join(dir, "data/voxel_heights.lua"));
const doc = {
  source: `UNDERdecodedHD/Gen2Recomped-DramaticShapes @ ${PIN}, data/voxel_heights.lua`,
  license: "MIT -- see gen2-profile.LICENSE beside this file",
  note: "heights, collision, and the TilesetX entries of tilesets and buildings, as the cook keeps them",
  profile,
};
writeFileSync(GEN2_PROFILE_SNAPSHOT, JSON.stringify(doc) + "\n");
console.log(`gen2 profile: wrote ${GEN2_PROFILE_SNAPSHOT} (${Object.keys(profile.tilesets ?? {}).length} tilesets)`);
