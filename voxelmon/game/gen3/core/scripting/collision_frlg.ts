// Port of gen1recomp src/core/game3/scripting/collision_frlg.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG metatile behavior -> Gen1/Gen2 collision bytes (Island 1 seed table).
// The Lua's multiple returns are tuples: classify -> [category, ledgeDir],
// fromCell -> [collByte, category, ledgeDir].

// pokefirered/src/metatile_behavior.c:5 sBehaviorSurfable
const WATER_BEH: Record<number, boolean> = {
  [0x10]: true, [0x11]: true, [0x12]: true, [0x13]: true,
  [0x15]: true, [0x1A]: true, [0x1B]: true,
  [0x50]: true, [0x51]: true, [0x52]: true, [0x53]: true,
};
// pokefirered/src/event_object_movement.c:8143
const WALK_ON_WATER_BEH: Record<number, boolean> = { [0x16]: true, [0x17]: true };
const JUMP_DIR: Record<number, string> = {
  [0x38]: "E", [0x39]: "W", [0x3A]: "N", [0x3B]: "S",
};
const DOOR_BEH: Record<number, boolean> = {
  [0x60]: true, [0x62]: true, [0x63]: true, [0x64]: true,
  [0x65]: true, [0x67]: true, [0x69]: true,
};
// pokefirered/src/metatile_behavior.c:624,640,658
const KEEP_FACING_WARP_BEH: Record<number, boolean> = {
  [0x66]: true, [0x68]: true, [0x71]: true,
};
// MB_ROCK_STAIRS: walkable tier bands (not warps).
const STAIR_BEH: Record<number, boolean> = { [0x2A]: true };
// MB_UP/DOWN_ESCALATOR (+ ladder/warp stairs): Gen2 COLL_STAIRCASE.
const WARP_STAIR_BEH: Record<number, boolean> = {
  [0x61]: true, // MB_LADDER
  [0x6A]: true, // MB_UP_ESCALATOR
  [0x6B]: true, // MB_DOWN_ESCALATOR
  [0x6C]: true, [0x6D]: true, [0x6E]: true, [0x6F]: true,
};
const SIGN_BEH: Record<number, boolean> = { [0x84]: true, [0x87]: true, [0x88]: true };
const PC_BEH: Record<number, boolean> = { [0x83]: true };           // MB_PC
const COUNTER_BEH: Record<number, boolean> = { [0x80]: true };      // MB_COUNTER (nurse desk)
const MOUNTAIN_TOP_BEH = 0x0C;

const TREE_MIDS: Record<number, boolean> = {
  [0x00A]: true, [0x00B]: true, [0x00C]: true, [0x00E]: true,
  [0x00F]: true, [0x013]: true,
};
for (let mid = 0x014; mid <= 0x01F; mid++) TREE_MIDS[mid] = true;
for (let mid = 0x024; mid <= 0x027; mid++) TREE_MIDS[mid] = true;

const SHRUB_MIDS: Record<number, boolean> = {
  [0x286]: true, [0x287]: true, [0x28E]: true, [0x28F]: true,
  [0x296]: true, [0x29E]: true, [0x29F]: true,
  [0x2A5]: true, [0x2A6]: true, [0x2A7]: true,
  [0x2AD]: true, [0x2AE]: true, [0x2AF]: true,
};

const PIER_MIDS: Record<number, boolean> = {
  [0x1C5]: true, [0x1C6]: true, [0x1C7]: true, [0x2B4]: true, [0x2B6]: true,
};

const CLIFF_MIDS: Record<number, boolean> = {
  [0x070]: true, [0x071]: true, [0x072]: true, [0x073]: true,
  [0x075]: true, [0x07A]: true, [0x07B]: true, [0x07C]: true, [0x07D]: true,
  [0x0B2]: true, [0x0B3]: true, [0x0B4]: true, [0x0B5]: true,
};

const LEDGE_COLL: Record<string, number> = { E: 0xA0, W: 0xA1, N: 0xA2, S: 0xA3 };
const CAT_COLL: Record<string, number> = {
  WATER: 0x29,
  TALL_GRASS: 0x18,
  TREE: 0x07,
  CLIFF: 0x07,
  COAST_CLIFF: 0x07,
  BLOCKED: 0x07,
  BUILDING: 0x07,
  // Outdoor doorway default. Indoor exits override in seed() — see below.
  DOOR: 0x71,
  SIGN: 0x82,
  PC: 0x93,       // Gen2 COLL_PC → TileCollisionStdScripts PCScript
  COUNTER: 0x90,  // Gen2 COLL_COUNTER → talk through desk
  CAVE: 0x2B,
  STAIR: 0x00,
  SAND: 0x00,
  PATH: 0x00,
  PIER: 0x00,
  SHORT_GRASS: 0x00,
  TOWN_PATH: 0x00,
  ROCK_DECK: 0x00,
  LEDGE: 0xA3,
};

const NUM_PRIMARY = 640;

// Gen2 spawnFacing: COLL_DOOR / COLL_STAIRCASE force face-down on arrival.
// Outdoor doors want that (exit onto the street facing out). Indoor door
// mats and escalators must NOT — keep the facing you walked in with.
// 0x72 is an unused HI_NYBBLE_WARPS id: immediate warp, walkable, no
// CheckWarpFacingDown / doorForcedDirection.
const COLL_DOOR = 0x71;
const COLL_WARP_KEEP_FACING = 0x72;

type Cat = [string, string | undefined];

export const CollisionFrlg = {
  // Lua: collision_frlg.lua:90 -- map grid collision nibble (0–3); impassable if ~= 0
  classify(mid: number, mapColl: number | undefined, behavior: number | undefined, kind?: string): Cat {
    kind = kind ?? "route";
    const beh = behavior ?? 0;
    if (WATER_BEH[beh]) {
      // pokefirered/src/event_object_movement.c:4835
      if ((mapColl ?? 0) !== 0) return ["BLOCKED", undefined];
      return ["WATER", undefined];
    }
    if (WALK_ON_WATER_BEH[beh]) {
      if ((mapColl ?? 0) !== 0) return ["BLOCKED", undefined];
      return ["PATH", undefined];
    }
    // pokefirered/src/metatile_behavior.c:432
    if (beh === 0x02 || beh === 0xD1) return ["TALL_GRASS", undefined];
    // pokefirered/src/metatile_behavior.c:72
    if (beh === 0x21 || beh === 0x2B) return ["SAND", undefined];
    if (JUMP_DIR[beh]) return ["LEDGE", JUMP_DIR[beh]];
    if (WARP_STAIR_BEH[beh]) return ["STAIR", "WARP"];
    if (STAIR_BEH[beh]) return ["STAIR", undefined];
    if (DOOR_BEH[beh]) return ["DOOR", undefined];
    if (KEEP_FACING_WARP_BEH[beh]) return ["WARP_KEEP_FACING", undefined];
    if (SIGN_BEH[beh]) return ["SIGN", undefined];
    if (PC_BEH[beh]) return ["PC", undefined];
    if (COUNTER_BEH[beh]) return ["COUNTER", undefined];
    if (beh === 0x08) return ["CAVE", undefined];
    if (beh === MOUNTAIN_TOP_BEH) return ["ROCK_DECK", undefined];
    // Outdoor General-tileset tree IDs. If mapColl == 0, it is a walkable path behind tree tops.
    // (A nil mapColl is "~= 0" in Lua, and !== 0 here.)
    if (TREE_MIDS[mid] && kind !== "indoor") {
      if (mapColl !== 0) return ["TREE", undefined];
      return [kind === "town" ? "TOWN_PATH" : "SHORT_GRASS", undefined];
    }
    // Shrub list is primary-tileset decoration only. On Sevii secondary those
    // same numeric ids are house roofs/walls (were mis-tagged as grass road).
    if (SHRUB_MIDS[mid] && mid < NUM_PRIMARY) {
      if (mapColl !== 0) return ["BLOCKED", undefined];
      return [kind === "town" ? "TOWN_PATH" : "SHORT_GRASS", undefined];
    }
    // Cliff list is outdoor rock faces; indoor building tilesets reuse ids.
    if (CLIFF_MIDS[mid] && kind !== "indoor") {
      if (mapColl !== 0) return ["CLIFF", undefined];
      return [kind === "town" ? "TOWN_PATH" : "SHORT_GRASS", undefined];
    }
    if (PIER_MIDS[mid] && mapColl === 0) return ["PIER", undefined];
    // Secondary solids: houses in town; interior walls/furniture indoors.
    // On routes the same secondary sheet is cliff / rock — not building-front.
    if (mid >= NUM_PRIMARY && kind === "town") {
      if (mapColl !== 0) return ["BUILDING", undefined];
    }
    if (mid >= NUM_PRIMARY && kind === "indoor" && mapColl !== 0) {
      return ["BUILDING", undefined];
    }
    if (mid >= NUM_PRIMARY && mapColl !== 0) return ["CLIFF", undefined];
    if (mapColl !== 0 && mid < 0x100 && beh === 0) return ["BLOCKED", undefined];
    if (mapColl !== 0) return ["BLOCKED", undefined];
    if (kind === "town") return ["TOWN_PATH", undefined];
    return ["SHORT_GRASS", undefined];
  },

  // Lua: collision_frlg.lua:156
  seed(category: string, ledgeDir?: string, kind?: string): number {
    if (category === "LEDGE") {
      return LEDGE_COLL[ledgeDir ?? "S"] ?? 0xA3;
    }
    if (category === "DOOR") {
      if (kind === "indoor") return COLL_WARP_KEEP_FACING;
      return COLL_DOOR;
    }
    if (category === "STAIR" && ledgeDir === "WARP") {
      return COLL_WARP_KEEP_FACING;
    }
    if (category === "WARP_KEEP_FACING") {
      return COLL_WARP_KEEP_FACING;
    }
    return CAT_COLL[category] ?? 0x00;
  },

  // Lua: collision_frlg.lua:173 -- [collByte, category, ledgeDir]
  fromCell(mid: number, mapColl: number | undefined, behavior: number | undefined, kind?: string): [number, string, string | undefined] {
    const [cat, ledge] = CollisionFrlg.classify(mid, mapColl, behavior, kind);
    return [CollisionFrlg.seed(cat, ledge, kind), cat, ledge];
  },
};

export default CollisionFrlg;
