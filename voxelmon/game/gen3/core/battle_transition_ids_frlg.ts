// Port of gen1recomp src/core/game3/battle_transition_ids_frlg.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG battle transition ids, terrain classes and the wild / trainer pickers
// (pret battle_setup.c, battle_transition.c).
//
// Port notes:
// - TABLE_WILD / TABLE_TRAINER entries are lt.ts sequences ({a, b} -> seq(a, b));
//   the tables themselves are keyed by terrain id (plain objects).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, truthy } from "../../../import/gen3/lua.ts";
import { seq, type LuaTable } from "../platform/lt.ts";

export interface IdsModule {
  family: string;
  ID: Record<string, number>;
  TERRAIN: Record<string, number>;
  MUGSHOT_BY_ID: Record<number, string>;
  MUGSHOT_PIC: Record<string, number>;
  MUGSHOT_COORDS: Record<string, LuaTable>;
  MUGSHOT_DEFAULT_PIC: number;
  MUGSHOT_PLAYER_PIC: Record<string, number>;
  TUNE: Record<string, number>;
  getTerrainByMap(opts?: any): number;
  pickWild(opts?: any): number;
  pickTrainer(opts?: any): number;
}

export const Ids = {} as IdsModule;

Ids.family = "frlg";

const ID = {
  BLUR: 0,
  SWIRL: 1,
  SHUFFLE: 2,
  BIG_POKEBALL: 3,
  POKEBALLS_TRAIL: 4,
  CLOCKWISE_WIPE: 5,
  RIPPLE: 6,
  WAVE: 7,
  SLICE: 8,
  WHITE_BARS_FADE: 9,
  GRID_SQUARES: 10,
  ANGLED_WIPES: 11,
  LORELEI: 12,
  BRUNO: 13,
  AGATHA: 14,
  LANCE: 15,
  BLUE: 16,
  SPIRAL: 17,
};
Ids.ID = ID;

const TERRAIN = {
  NORMAL: 0,
  CAVE: 1,
  FLASH: 2,
  WATER: 3,
};
Ids.TERRAIN = TERRAIN;

// src/battle_setup.c:87
const TABLE_WILD: Record<number, LuaTable> = {
  [TERRAIN.NORMAL]: seq(ID.SLICE, ID.WHITE_BARS_FADE),
  [TERRAIN.CAVE]: seq(ID.CLOCKWISE_WIPE, ID.GRID_SQUARES),
  [TERRAIN.FLASH]: seq(ID.BLUR, ID.GRID_SQUARES),
  [TERRAIN.WATER]: seq(ID.WAVE, ID.RIPPLE),
};

// src/battle_setup.c:95
const TABLE_TRAINER: Record<number, LuaTable> = {
  [TERRAIN.NORMAL]: seq(ID.POKEBALLS_TRAIL, ID.ANGLED_WIPES),
  [TERRAIN.CAVE]: seq(ID.SHUFFLE, ID.BIG_POKEBALL),
  [TERRAIN.FLASH]: seq(ID.BLUR, ID.GRID_SQUARES),
  [TERRAIN.WATER]: seq(ID.SWIRL, ID.RIPPLE),
};

Ids.MUGSHOT_BY_ID = {
  [ID.LORELEI]: "lorelei",
  [ID.BRUNO]: "bruno",
  [ID.AGATHA]: "agatha",
  [ID.LANCE]: "lance",
  [ID.BLUE]: "blue",
};

// src/battle_transition.c:1849
Ids.MUGSHOT_PIC = { lorelei: 112, bruno: 113, agatha: 114, lance: 115, blue: 125 };
Ids.MUGSHOT_COORDS = {
  lorelei: seq(-8, 0), bruno: seq(-10, 0), agatha: seq(0, 0), lance: seq(-32, 0), blue: seq(0, 0),
};
Ids.MUGSHOT_DEFAULT_PIC = 125;
Ids.MUGSHOT_PLAYER_PIC = { male: 135, female: 136 };

// Lua: battle_transition_ids_frlg.lua:67
Ids.getTerrainByMap = function (opts?: any): number {
  opts = opts ?? {};
  if (truthy(opts.flash) || (truthy(opts.flashLevel) && opts.flashLevel > 0)) {
    return TERRAIN.FLASH;
  }
  if (truthy(opts.surfing) || truthy(opts.isWater) || opts.mapKind === "water" || opts.mapType === 4 || opts.mapType === 5) {
    return TERRAIN.WATER;
  }
  if (truthy(opts.isCave) || opts.mapKind === "cave" || opts.mapKind === "dungeon" || opts.mapType === 3) {
    return TERRAIN.CAVE;
  }
  return TERRAIN.NORMAL;
};

// Lua: battle_transition_ids_frlg.lua:81
Ids.pickWild = function (opts?: any): number {
  opts = opts ?? {};
  const terrain = truthy(opts.terrain) ? opts.terrain : Ids.getTerrainByMap(opts);
  const tableEntry = TABLE_WILD[terrain] ?? TABLE_WILD[TERRAIN.NORMAL];
  const playerLv = tonumber(opts.playerLevel) ?? 5;
  const enemyLv = tonumber(opts.enemyLevel) ?? 3;
  if (enemyLv < playerLv) {
    return tableEntry[1];
  } else {
    return tableEntry[2];
  }
};

// pokefirered/include/constants/trainers.h:270, :273
const TRAINER_CLASS_ELITE_FOUR = 87;
const TRAINER_CLASS_CHAMPION = 90;
// pokefirered/include/constants/opponents.h:416-419, :741-744 (first run, rematch)
const ELITE_FOUR_TRANSITION: Record<number, number> = {
  [410]: ID.LORELEI, [735]: ID.LORELEI,
  [411]: ID.BRUNO, [736]: ID.BRUNO,
  [412]: ID.AGATHA, [737]: ID.AGATHA,
  [413]: ID.LANCE, [738]: ID.LANCE,
};

// pokefirered/src/battle_setup.c:624 GetTrainerBattleTransition: the Elite Four
// and the champion are recognised by class id, never by the class's name.
// Lua: battle_transition_ids_frlg.lua:107
Ids.pickTrainer = function (opts?: any): number {
  opts = opts ?? {};
  const tid = tonumber(opts.trainerId) ?? 0;
  // A Trainer Tower or e-Reader foe carries a facility class, whose numbers
  // overlap the trainer classes (FACILITY_CLASS_LASS is 90, the champion's,
  // pokefirered/include/constants/trainers.h:381); pret never picks their
  // transition by class (battle_setup.c:660).
  const tClass = !(truthy(opts.trainerTower) || truthy(opts.eReader)) ? tonumber(opts.trainerClass) : undefined;

  if (tClass === TRAINER_CLASS_ELITE_FOUR) {
    if (truthy(opts.isLorelei)) return ID.LORELEI;
    if (truthy(opts.isBruno)) return ID.BRUNO;
    if (truthy(opts.isAgatha)) return ID.AGATHA;
    if (truthy(opts.isLance)) return ID.LANCE;
    return ELITE_FOUR_TRANSITION[tid] ?? ID.BLUE;
  }
  if (tClass === TRAINER_CLASS_CHAMPION || truthy(opts.isRival) || truthy(opts.isChampion)) {
    return ID.BLUE;
  }
  if (truthy(opts.isLorelei)) return ID.LORELEI;
  if (truthy(opts.isBruno)) return ID.BRUNO;
  if (truthy(opts.isAgatha)) return ID.AGATHA;
  if (truthy(opts.isLance)) return ID.LANCE;
  if (truthy(opts.isBlue)) return ID.BLUE;

  const terrain = truthy(opts.terrain) ? opts.terrain : Ids.getTerrainByMap(opts);
  const tableEntry = TABLE_TRAINER[terrain] ?? TABLE_TRAINER[TERRAIN.NORMAL];
  const playerLv = tonumber(opts.playerLevel) ?? 5;
  const enemyLv = tonumber(opts.enemyLevel) ?? 3;
  if (enemyLv < playerLv) {
    return tableEntry[1];
  } else {
    return tableEntry[2];
  }
};

// pokefirered/src/battle_transition.c:708
Ids.TUNE = {
  introFades: 2,
  blurDelay: 2,
  wipeStepX: 32,
  wipeStepY: 16,
  rippleFadeAt: 41,
  rippleFadeDelay: -8,
};

export default Ids;
