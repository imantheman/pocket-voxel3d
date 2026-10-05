// Port of gen1recomp src/core/game3/items.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG item identity + host mapping (H2).
// hostId = nil means quarantine-only (never write to host bag).
// Numeric ids match pret include/constants/items.h.

import { ItemsData } from "./items_data.ts";
import { tonumber, tostring } from "../../../import/gen3/lua.ts";
import { match } from "../platform/lpattern.ts";

export const Items = {
  GAME3_MAX_QTY: 999,
  HOST_MAX_QTY: 99,

  // FRLG numeric id → host string id (or false = quarantined / no host counterpart).
  FRLG_TO_HOST: {
    1: "MASTER_BALL",
    2: "ULTRA_BALL",
    3: "GREAT_BALL",
    4: "POKE_BALL",
    13: "POTION",
    14: "ANTIDOTE",
    15: "BURN_HEAL",
    16: "ICE_HEAL",
    17: "AWAKENING",
    18: "PARLYZ_HEAL",
    19: "FULL_RESTORE",
    20: "MAX_POTION",
    21: "HYPER_POTION",
    22: "SUPER_POTION",
    23: "FULL_HEAL",
    24: "REVIVE",
    25: "MAX_REVIVE",
    26: "FRESH_WATER",
    27: "SODA_POP",
    28: "LEMONADE",
    75: "X_ATTACK",
    76: "X_DEFEND",
    77: "X_SPEED",
    78: "X_ACCURACY",
    79: "X_SPECIAL",
    80: "POKE_DOLL",
    83: "SUPER_REPEL",
    84: "MAX_REPEL",
    85: "ESCAPE_ROPE",
    86: "REPEL",
    110: "NUGGET",
    261: "ITEMFINDER",
    280: "METEORITE",
    360: "BICYCLE",
    361: "TOWN_MAP",
    367: "TRI_PASS",
    368: "RAINBOW_PASS",
  } as Record<number, string>,

  // Host ids that must stay in sidecar (even if registered for name display).
  FORCE_QUARANTINE: {
    METEORITE: true,
  } as Record<string, boolean>,

  // Host-safe string ids (1:1 Gen1/Gen2 inventory).
  HOST_SAFE: {
    MASTER_BALL: true, ULTRA_BALL: true, GREAT_BALL: true, POKE_BALL: true,
    POTION: true, ANTIDOTE: true, BURN_HEAL: true, ICE_HEAL: true,
    AWAKENING: true, PARLYZ_HEAL: true, FULL_RESTORE: true, MAX_POTION: true,
    HYPER_POTION: true, SUPER_POTION: true, FULL_HEAL: true, REVIVE: true,
    MAX_REVIVE: true, FRESH_WATER: true, SODA_POP: true, LEMONADE: true,
    SUPER_REPEL: true, MAX_REPEL: true, ESCAPE_ROPE: true, REPEL: true,
    X_ATTACK: true, X_DEFEND: true, X_SPEED: true, X_ACCURACY: true,
    X_SPECIAL: true, POKE_DOLL: true, NUGGET: true, ITEMFINDER: true,
    TOWN_MAP: true, TRI_PASS: true, RAINBOW_PASS: true, BICYCLE: true,
  } as Record<string, boolean>,

  // Lua: items.lua:71
  resolveHostId(itemId: unknown): string | undefined {
    if (itemId == null) return undefined;
    const num = tonumber(itemId);
    if (num !== undefined) {
      return Items.FRLG_TO_HOST[num];
    }
    const s = tostring(itemId);
    if (Items.HOST_SAFE[s] || Items.FORCE_QUARANTINE[s]) return s;
    if (match(s, "^%d+$") != null) return undefined;
    return s;
  },

  // Lua: items.lua:83
  isHostSafe(itemId: unknown): boolean {
    const host = Items.resolveHostId(itemId);
    if (!host) return false;
    if (Items.FORCE_QUARANTINE[host]) return false;
    return Items.HOST_SAFE[host] === true;
  },

  // Lua: items.lua:90
  clampGame3(qty: unknown): number {
    let q = Math.floor(tonumber(qty) ?? 0);
    if (q < 0) q = 0;
    if (q > Items.GAME3_MAX_QTY) q = Items.GAME3_MAX_QTY;
    return q;
  },

  // Lua: items.lua:97
  displayName(itemId: unknown): string {
    return ItemsData.displayName(itemId);
  },

  // Lua: items.lua:101
  pocket(itemId: unknown): string {
    return ItemsData.pocketOf(itemId);
  },
};

export default Items;
