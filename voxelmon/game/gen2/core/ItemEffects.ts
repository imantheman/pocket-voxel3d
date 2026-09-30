// gen1recomp src/core/gen2/ItemEffects.lua at bdfac727 (MIT): Gen 2 pack
// items used on a party mon outside battle -- the ITEMMENU_PARTY half of
// engine/items/pack.asm UseItem, per item family from
// engine/items/item_effects.asm.
//
// Table math over a party record; the screens (PackMenu -> PartyMenu ->
// MoveDeleter) only choose the target and print what comes back. Two
// contracts from UseItem_SelectMon: an EGG refuses with CantUseOnEggMessage
// before any effect runs, and a refusal costs nothing (the caller removes the
// item only when `used` comes back true).
//
// Indices: usePpItem's `slot` is the 1-BASED move slot the Lua passes.

import { Happiness } from "./Happiness.ts";
import { Evolution } from "./Evolution.ts";
import { Mon } from "../battle/Mon.ts";
import { Strings } from "../shared/core/Strings.ts";
import { sortedKeys, tostring } from "../platform/lua.ts";

/** A party record, as far as this module reads it. */
export interface ItemMon {
  species?: string;
  nickname?: string;
  name?: string;
  level?: number;
  hp?: number;
  maxHp?: number;
  stats?: { hp?: number; [k: string]: unknown };
  status?: string;
  item?: string;
  isEgg?: boolean;
  moves?: any[];
  statExp?: Record<string, number>;
  [k: string]: any;
}

export interface ItemData {
  pokemon?: Record<string, any>;
  moves?: Record<string, any>;
  items?: Record<string, any>;
  gen2Statuses?: Record<string, any>;
  gen2HeldItems?: Record<string, HeldRow>;
  gen2ItemEffects?: Record<string, ItemRecord>;
  [k: string]: any;
}

/** What every use returns: { used, text, learned?, level?, sfx?, evolution? }. */
export interface ItemResult {
  used: boolean;
  text?: string;
  learned?: (string | number)[];
  level?: number;
  sfx?: string;
  evolution?: unknown;
}

export interface ItemCtx {
  item: string;
  mon: ItemMon;
  data?: ItemData;
  slot?: number;
}

export interface ItemRecord {
  use: (ctx: ItemCtx) => ItemResult;
  action: string;
  field: boolean;
  needsTarget: boolean;
}

export interface HeldRow {
  heldEffect?: unknown;
  heldParameter?: unknown;
}

type PpRow = { amount: number | "all"; each?: boolean };

// Lua: ItemEffects.lua:70 -- EnergypowderEnergyRootCommon / HealPowderEffect:
// the herbs charge happiness for tasting bitter.
const BITTER: Record<string, string> = {
  ENERGYPOWDER: "BITTERPOWDER", ENERGY_ROOT: "ENERGYROOT",
  HEAL_POWDER: "BITTERPOWDER", REVIVAL_HERB: "REVIVALHERB",
};

// Lua: ItemEffects.lua:96 -- PrintPartyMenuActionText's .MenuActionTexts.
const STATUS_TEXT: Record<string, string> = {
  psn: Strings.source("%s's\ncured of poison."),
  par: Strings.source("%s's\nrid of paralysis."),
  brn: Strings.source("%s's\nburn was healed."),
  frz: Strings.source("%s\nwas defrosted."),
  slp: Strings.source("%s\nwoke up."),
  all: Strings.source("%s's\nhealth returned."),
};

// Lua: ItemEffects.lua:266 -- item_effects.asm:1216 StatStrings.
const VITAMIN_LABEL: Record<string, string> = {
  hp: Strings.source("HEALTH"), attack: Strings.source("ATTACK"),
  defense: Strings.source("DEFENSE"), speed: Strings.source("SPEED"),
  special: Strings.source("SPECIAL"),
};

// Lua: ItemEffects.lua:123
function monName(mon: ItemMon | undefined): string {
  return (mon && (mon.nickname ?? mon.name ?? mon.species)) ?? "?";
}

// Lua: ItemEffects.lua:127
function maxHpOf(mon: ItemMon): number {
  return mon.maxHp ?? (mon.stats && mon.stats.hp) ?? 0;
}

// Lua: ItemEffects.lua:131
function fainted(mon: ItemMon): boolean {
  return (mon.hp ?? 0) <= 0;
}

// Lua: ItemEffects.lua:139 -- HealStatus's field half: status, toxic counter
// and turn counter clear together.
function clearStatus(mon: ItemMon): void {
  mon.status = undefined;
  mon.statusTurns = undefined;
  mon.toxicCounter = undefined;
}

// Lua: ItemEffects.lua:145
function bitterHappiness(itemId: string, mon: ItemMon): void {
  const event = BITTER[itemId];
  if (event) Happiness.change(mon, event);
}

function noEffect(): ItemResult {
  return { used: false, text: Strings.get(ItemEffects.TEXT_NO_EFFECT) };
}

// Lua: ItemEffects.lua:152 -- ItemRestoreHP: fainted and full-HP refuse,
// then the HealingHPAmounts row capped at max HP.
function restoreHp(itemId: string, mon: ItemMon): ItemResult {
  const amount = ItemEffects.HEAL_HP[itemId]!;
  const maxHp = maxHpOf(mon);
  if (fainted(mon) || (mon.hp ?? 0) >= maxHp) {
    return noEffect();
  }
  const healed = Math.min(maxHp, (mon.hp ?? 0) + amount);
  const gained = healed - (mon.hp ?? 0);
  mon.hp = healed;
  // FullRestoreEffect's .FullRestore clears the status alongside the refill.
  if (itemId === "FULL_RESTORE") clearStatus(mon);
  bitterHappiness(itemId, mon);
  return {
    used: true,
    // data/text/common_1.asm:30, home/text.asm:772
    text: Strings.get("%s\nrecovered %dHP!", monName(mon), gained),
  };
}

// Lua: ItemEffects.lua:190 -- UseStatusHealer (field only).
function healStatus(itemId: string, mon: ItemMon, cls: string, data?: ItemData): ItemResult {
  if (fainted(mon)) {
    return noEffect();
  }
  const have = ItemEffects.healClassOf(mon.status, data);
  if (!have || (cls !== "all" && have !== cls)) {
    return noEffect();
  }
  clearStatus(mon);
  bitterHappiness(itemId, mon);
  const shape = STATUS_TEXT[cls === "all" ? "all" : have]!;
  return { used: true, text: Strings.get(shape, monName(mon)) };
}

// Lua: ItemEffects.lua:206 -- RevivePokemon: REVIVE halves, the rest full.
function revive(itemId: string, mon: ItemMon): ItemResult {
  if (!fainted(mon)) {
    return noEffect();
  }
  const maxHp = maxHpOf(mon);
  mon.hp = ItemEffects.REVIVE[itemId] === "half" ? Math.max(1, Math.floor(maxHp / 2)) : maxHp;
  clearStatus(mon);
  bitterHappiness(itemId, mon);
  return {
    used: true,
    text: Strings.get("%s\nis revitalized.", monName(mon)),
  };
}

// Lua: ItemEffects.lua:227 -- RareCandyEffect: exp SET to the new level's
// threshold, stats recomputed, current HP gains the max-HP delta (no clamp).
function rareCandy(mon: ItemMon, data?: ItemData): ItemResult {
  if ((mon.level ?? 0) >= Mon.MAX_LEVEL) {
    return noEffect();
  }
  // pokecrystal/engine/items/item_effects.asm:1208
  const def = data && data.pokemon && data.pokemon[Mon.partySpecies(mon)];
  // through Mon.growthFor, so a registered curve is the candy's curve too
  const growth = Mon.growthFor(data, def && def.growthRate);
  const newLevel = (mon.level ?? 1) + 1;
  mon.level = newLevel;
  mon.experience = Mon.experienceForLevel(growth, newLevel);
  const previousMax = maxHpOf(mon);
  if (def && def.baseStats) {
    const stats = Mon.writeStats(mon, Mon.stats(def.baseStats, mon.dvs, newLevel, mon.statExp));
    mon.maxHp = stats.hp;
    mon.hp = (mon.hp ?? previousMax) + (mon.maxHp! - previousMax);
  }
  Happiness.change(mon, "GAINLEVEL");
  const learned: (string | number)[] = [];
  for (const entry of (def && def.levelMoves) || []) {
    if (entry.level === newLevel) learned.push(entry.move);
  }
  return {
    used: true,
    level: newLevel,
    learned,
    // data/text/common_1.asm:86
    sfx: "Sfx_DexFanfare5079",
    text: Strings.get("%s grew to\nlevel %d!", monName(mon), newLevel),
  };
}

// Lua: ItemEffects.lua:273 -- item_effects.asm:1149 VitaminEffect.
function vitamin(itemId: string, mon: ItemMon, data?: ItemData): ItemResult {
  const stat = ItemEffects.VITAMIN[itemId]!;
  mon.statExp = mon.statExp || Mon.newStatExp();
  const cur = mon.statExp![stat] ?? 0;
  if (cur >= 25600) {
    return noEffect();
  }
  mon.statExp![stat] = Math.min(Mon.MAX_STAT_EXP, cur + 2560);
  // pokecrystal/engine/items/item_effects.asm:1208
  const def = data && data.pokemon && data.pokemon[Mon.partySpecies(mon)];
  if (def && def.baseStats) {
    const stats = Mon.writeStats(mon, Mon.stats(def.baseStats, mon.dvs, mon.level as number, mon.statExp));
    mon.maxHp = stats.hp;
  }
  Happiness.change(mon, "USEDITEM");
  return {
    used: true,
    text: Strings.get("%s's\n%s rose.", monName(mon), Strings.get(VITAMIN_LABEL[stat]!)),
  };
}

// Lua: ItemEffects.lua:426 -- RestorePP over one move entry: a full slot
// refuses, "all" fills, a number adds capped at max.
function restoreMove(move: any, amount: number | "all"): boolean {
  if (move === null || typeof move !== "object" || move.id == null) return false;
  const maxPp = move.maxPp ?? move.pp ?? 0;
  if ((move.pp ?? 0) >= maxPp) return false;
  if (amount === "all") {
    move.pp = maxPp;
  } else {
    move.pp = Math.min(maxPp, (move.pp ?? 0) + amount);
  }
  return true;
}

export const ItemEffects = {
  // Lua: ItemEffects.lua:26 -- data/items/heal_hp.asm HealingHPAmounts.
  HEAL_HP: {
    FRESH_WATER: 50, SODA_POP: 60, LEMONADE: 80,
    HYPER_POTION: 200, SUPER_POTION: 50, POTION: 20,
    MAX_POTION: 999, FULL_RESTORE: 999, MOOMOO_MILK: 100,
    BERRY: 10, GOLD_BERRY: 30, ENERGYPOWDER: 50, ENERGY_ROOT: 200,
    RAGECANDYBAR: 20, BERRY_JUICE: 20,
  } as Record<string, number>,

  // Lua: ItemEffects.lua:37 -- data/items/heal_status.asm, folded to the
  // class each mask names (FULL_RESTORE's status half is in its heal arm).
  HEAL_STATUS: {
    ANTIDOTE: "psn", BURN_HEAL: "brn", ICE_HEAL: "frz",
    AWAKENING: "slp", PARLYZ_HEAL: "par",
    FULL_HEAL: "all", HEAL_POWDER: "all",
    PSNCUREBERRY: "psn", PRZCUREBERRY: "par", BURNT_BERRY: "frz",
    ICE_BERRY: "brn", MINT_BERRY: "slp", MIRACLEBERRY: "all",
  } as Record<string, string>,

  // Lua: ItemEffects.lua:47 -- `cp REVIVE / jr z, .revive_half_hp`.
  REVIVE: {
    REVIVE: "half", MAX_REVIVE: "full", REVIVAL_HERB: "full",
  } as Record<string, string>,

  // Lua: ItemEffects.lua:54 -- RestorePP amounts; `each` is
  // Elixer_RestorePPofAllMoves.
  RESTORE_PP: {
    ETHER: { amount: 10 },
    MAX_ETHER: { amount: "all" },
    MYSTERYBERRY: { amount: 5 },
    ELIXER: { amount: 10, each: true },
    MAX_ELIXER: { amount: "all", each: true },
  } as Record<string, PpRow>,

  // Lua: ItemEffects.lua:63 -- item_effects.asm:1245 StatExpItemPointerOffsets.
  VITAMIN: {
    HP_UP: "hp", PROTEIN: "attack", IRON: "defense",
    CARBOS: "speed", CALCIUM: "special",
  } as Record<string, string>,

  // Lua: ItemEffects.lua:81-89 -- data/text/common_3.asm.
  TEXT_NO_EFFECT: Strings.source("It won't have any\neffect."),
  TEXT_CANT_USE_ON_EGG: Strings.source("That can't be used\non an EGG."),
  // _ItemCantUseOnMonText (data/text/common_3.asm:1265).
  TEXT_CANT_USE_ON_MON: Strings.source("That can't be used\non this #MON."),
  TEXT_PP_RESTORED: Strings.source("PP was restored."),
  TEXT_PP_MAXED: Strings.source("%s's PP\nis maxed out."),
  TEXT_PP_INCREASED: Strings.source("%s's PP\nincreased."),

  // Lua: ItemEffects.lua:114 -- every status spelling the port writes,
  // folded to the heal tables' class letters (FNT is an HP fact, not here).
  STATUS_CLASS: {
    psn: "psn", poison: "psn", toxic: "psn",
    brn: "brn", burn: "brn",
    frz: "frz", freeze: "frz",
    par: "par", paralysis: "par", paralyze: "par",
    slp: "slp", sleep: "slp",
  } as Record<string, string>,

  // Lua: ItemEffects.lua:178 -- the fold table, then a mod status's own
  // `healClass` off data.gen2Statuses.
  healClassOf(status: unknown, data?: ItemData): string | undefined {
    const key = tostring(status ?? "").toLowerCase();
    const cls = Object.prototype.hasOwnProperty.call(ItemEffects.STATUS_CLASS, key) ? ItemEffects.STATUS_CLASS[key] : undefined;
    if (cls) return cls;
    const statuses = data && data.gen2Statuses;
    const record = statuses && (statuses[status as string] || statuses[key]);
    return (record && record.healClass) || undefined;
  },

  // Lua: ItemEffects.lua:324 -- the held_items merge target, built before
  // mods load.
  heldItemsFrom(items: Record<string, any> | undefined): Record<string, HeldRow> {
    const out: Record<string, HeldRow> = {};
    for (const id of Object.keys(items || {})) {
      const def = items![id];
      if (def !== null && typeof def === "object" && def.heldEffect != null) {
        out[id] = { heldEffect: def.heldEffect, heldParameter: def.heldParameter ?? 0 };
      }
    }
    return out;
  },

  // Lua: ItemEffects.lua:335
  heldSnapshot(view: Record<string, any> | undefined): Record<string, HeldRow> {
    const out: Record<string, HeldRow> = {};
    for (const id of Object.keys(view || {})) {
      const row = view![id];
      if (row !== null && typeof row === "object") {
        out[id] = { heldEffect: row.heldEffect, heldParameter: row.heldParameter };
      }
    }
    return out;
  },

  // Lua: ItemEffects.lua:347 -- the merged held_items record, or the item's
  // own columns.
  heldItemFor(itemId: string | undefined, data?: ItemData): HeldRow | undefined {
    if (itemId == null) return undefined;
    const merged = data && data.gen2HeldItems;
    const row = merged && merged[itemId];
    if (row) return row;
    const def = data && data.items && data.items[itemId];
    if (def === null || typeof def !== "object" || def.heldEffect == null) return undefined;
    return { heldEffect: def.heldEffect, heldParameter: def.heldParameter ?? 0 };
  },

  // Lua: ItemEffects.lua:360 -- write back only what the held_items merge
  // changed against the snapshot. Returns the count (0 on a mod-free boot).
  applyHeldItems(data: ItemData | undefined, snapshot?: Record<string, HeldRow>): number {
    const items = data && data.items;
    const merged = data && data.gen2HeldItems;
    if (!(items && merged)) return 0;
    let applied = 0;
    for (const id of sortedKeys(merged)) {
      const row = merged[id];
      if (row !== null && typeof row === "object") {
        const was = (snapshot || {})[id];
        if (!was || was.heldEffect !== row.heldEffect || was.heldParameter !== row.heldParameter) {
          const def = items[id];
          if (def !== null && typeof def === "object") {
            def.heldEffect = row.heldEffect;
            def.heldParameter = row.heldParameter ?? 0;
            applied = applied + 1;
          }
        }
      }
    }
    // a tombstoned id leaves the merged table without the row
    for (const id of sortedKeys(snapshot || {})) {
      const was = snapshot![id]!;
      if (merged[id] == null && items[id] !== null && typeof items[id] === "object" && was.heldEffect != null && was.heldEffect !== false) {
        items[id].heldEffect = undefined;
        items[id].heldParameter = undefined;
        applied = applied + 1;
      }
    }
    return applied;
  },

  // Lua: ItemEffects.lua:395 -- the merged item_effects record, or ours.
  recordFor(itemId: string | undefined, data?: ItemData): ItemRecord | undefined {
    if (itemId == null) return undefined;
    const merged = data && data.gen2ItemEffects;
    return (merged && merged[itemId]) || ItemEffects.RECORDS[itemId];
  },

  // Lua: ItemEffects.lua:403 -- which family a PACK item runs on a mon.
  partyAction(itemId: string | undefined, data?: ItemData): string | undefined {
    const record = ItemEffects.recordFor(itemId, data);
    return record ? record.action : undefined;
  },

  // Lua: ItemEffects.lua:410 -- the one-call families (not PP).
  useOnMon(itemId: string, mon: ItemMon | undefined, data?: ItemData): ItemResult {
    if (!mon) return noEffect();
    if (mon.isEgg) {
      return { used: false, text: Strings.get(ItemEffects.TEXT_CANT_USE_ON_EGG) };
    }
    const record = ItemEffects.recordFor(itemId, data);
    if (!record || !record.use || record.action === "pp") {
      return noEffect();
    }
    return record.use({ item: itemId, mon, data });
  },

  // Lua: ItemEffects.lua:441 -- the PP family on a (1-based) move slot.
  usePpItem(itemId: string, mon: ItemMon | undefined, slot: number | undefined, data?: ItemData): ItemResult {
    if (!mon) return noEffect();
    if (mon.isEgg) {
      return { used: false, text: Strings.get(ItemEffects.TEXT_CANT_USE_ON_EGG) };
    }
    const record = ItemEffects.recordFor(itemId, data);
    if (!record || !record.use || record.action !== "pp") {
      return noEffect();
    }
    return record.use({ item: itemId, mon, data, slot });
  },

  // Lua: ItemEffects.lua:470 -- the tables above as `item_effects` records:
  // use(ctx) -> ItemResult, action (the family), field, needsTarget.
  RECORDS: {} as Record<string, ItemRecord>,

  // Lua: ItemEffects.lua:575 -- vanilla registrations, engine-owned.
  registerInto(registry: { register(id: string, record: unknown, owner: unknown): unknown }, _data: unknown, owner: unknown): void {
    for (const id of sortedKeys(ItemEffects.RECORDS)) {
      registry.register(id, ItemEffects.RECORDS[id], owner);
    }
  },
};

// Lua: ItemEffects.lua:472
function record(itemId: string, action: string, use: (ctx: ItemCtx) => ItemResult): void {
  ItemEffects.RECORDS[itemId] = {
    use, action, field: true, needsTarget: true,
  };
}

// Lua: ItemEffects.lua:482-571 -- built in reverse precedence order (heal
// wins, then status, revive, candy, pp); nothing overlaps today.
for (const itemId of Object.keys(ItemEffects.RESTORE_PP)) {
  const row = ItemEffects.RESTORE_PP[itemId]!;
  record(itemId, "pp", (ctx) => {
    // ETHER family: the chosen slot; ELIXER family: every slot, one is enough.
    const moves = ctx.mon.moves || [];
    let any = false;
    if (row.each) {
      for (const move of moves) {
        if (restoreMove(move, row.amount)) any = true;
      }
    } else {
      any = restoreMove(moves[(ctx.slot ?? 0) - 1], row.amount);
    }
    if (!any) {
      return noEffect();
    }
    return { used: true, text: Strings.get(ItemEffects.TEXT_PP_RESTORED) };
  });
}

// Lua: ItemEffects.lua:504 -- item_effects.asm:2320 RestorePPEffect's PP_UP arm.
record("PP_UP", "pp", (ctx) => {
  const move = (ctx.mon.moves || [])[(ctx.slot ?? 0) - 1];
  if (move === null || typeof move !== "object" || move.id == null) {
    return noEffect();
  }
  const row = ((ctx.data && ctx.data.moves) || {})[move.id];
  const name = (row && row.name) ?? move.id;
  // constants/pokemon_data_constants.asm:216 PP_UP_MASK.
  if (move.id === "SKETCH" || (move.ppUps ?? 0) >= 3) {
    return { used: false, text: Strings.get(ItemEffects.TEXT_PP_MAXED, name) };
  }
  const base = (row && row.pp) ?? move.maxPp;
  if (base == null) {
    return { used: false, text: Strings.get(ItemEffects.TEXT_PP_MAXED, name) };
  }
  // engine/items/item_effects.asm:2736 ComputeMaxPP.
  const bonus = Math.min(Math.floor(base / 5), 7);
  move.ppUps = (move.ppUps ?? 0) + 1;
  move.maxPp = base + move.ppUps * bonus;
  move.pp = (move.pp ?? 0) + bonus;
  return { used: true, text: Strings.get(ItemEffects.TEXT_PP_INCREASED, name) };
});

for (const itemId of Object.keys(ItemEffects.VITAMIN)) {
  record(itemId, "vitamin", (ctx) => vitamin(ctx.item, ctx.mon, ctx.data));
}

record("RARE_CANDY", "candy", (ctx) => rareCandy(ctx.mon, ctx.data));

for (const itemId of ["SUN_STONE", "MOON_STONE", "FIRE_STONE", "THUNDERSTONE", "WATER_STONE", "LEAF_STONE"]) {
  record(itemId, "stone", (ctx) => {
    if (ctx.mon.item === "EVERSTONE") {
      return noEffect();
    }
    const [entry] = Evolution.checkMon(ctx.data, ctx.mon, { force: true, item: ctx.item });
    if (!entry) return noEffect();
    return { used: true, evolution: entry };
  });
}

for (const itemId of Object.keys(ItemEffects.REVIVE)) {
  record(itemId, "revive", (ctx) => revive(ctx.item, ctx.mon));
}

for (const itemId of Object.keys(ItemEffects.HEAL_STATUS)) {
  const cls = ItemEffects.HEAL_STATUS[itemId]!;
  record(itemId, "status", (ctx) => healStatus(ctx.item, ctx.mon, cls, ctx.data));
}

for (const itemId of Object.keys(ItemEffects.HEAL_HP)) {
  record(itemId, "heal", (ctx) => {
    // FullRestoreEffect: a full-HP target falls through to FullyHealStatus.
    if (ctx.item === "FULL_RESTORE" && !fainted(ctx.mon) && (ctx.mon.hp ?? 0) >= maxHpOf(ctx.mon)) {
      return healStatus(ctx.item, ctx.mon, "all", ctx.data);
    }
    return restoreHp(ctx.item, ctx.mon);
  });
}

export default ItemEffects;
