// What using an item DOES, ported from gen1recomp src/inventory/ItemEffects.lua
// (engine/items/item_effects.asm). Pure: the tables, the rules and the
// lines; no screens. The bag (game.ts useItem / useKeyItem) and the battle's
// ITEM menu (battle.ts) both ask here and act on the answer, so an item works
// the same way in a fight as out of one, and refuses in the same words.
//
// The item records the importer wrote carry names and prices only -- the
// ROM keeps every effect as code -- so the tables live here, as they do in
// the reference.

import type { PartyMon } from "../battle/mon.ts";
import * as Stats from "./stats.ts";

/** ItemUseMedicine's HP restores, by amount. */
export const HEAL_AMOUNT: Record<string, number> = {
  POTION: 20,
  SUPER_POTION: 50,
  HYPER_POTION: 200,
  FRESH_WATER: 50,
  SODA_POP: 60,
  LEMONADE: 80,
};

/** The status each cure lifts (.cureStatusAilment). */
export const STATUS_HEAL: Record<string, readonly string[]> = {
  ANTIDOTE: ["PSN"],
  BURN_HEAL: ["BRN"],
  ICE_HEAL: ["FRZ"],
  AWAKENING: ["SLP"],
  PARLYZ_HEAL: ["PAR"],
  FULL_HEAL: ["PSN", "BRN", "FRZ", "SLP", "PAR"],
};

export const BALLS = new Set(["POKE_BALL", "GREAT_BALL", "ULTRA_BALL", "MASTER_BALL", "SAFARI_BALL"]);
export const STONES = new Set(["FIRE_STONE", "WATER_STONE", "THUNDER_STONE", "LEAF_STONE", "MOON_STONE"]);

/** Vitamins: stat-exp boosters (ItemUseVitamin), by the stat they raise. */
export const VITAMINS: Record<string, string> = {
  HP_UP: "hp",
  PROTEIN: "attack",
  IRON: "defense",
  CARBOS: "speed",
  CALCIUM: "special",
};

/** REPEL / SUPER REPEL / MAX REPEL, by the steps they last (ItemUseRepelCommon). */
export const REPELS: Record<string, number> = { REPEL: 100, SUPER_REPEL: 200, MAX_REPEL: 250 };

/** Battle-only stat boosters (ItemUseXStat), by the stage they raise. */
export const X_ITEMS: Record<string, string> = {
  X_ATTACK: "attack",
  X_DEFEND: "defense",
  X_SPEED: "speed",
  X_SPECIAL: "special",
};

/** Usable in a battle and nowhere else: OAK's "not the time" outside one. */
export const BATTLE_ONLY = new Set([
  ...Object.keys(X_ITEMS), "X_ACCURACY", "DIRE_HIT", "GUARD_SPEC", "POKE_DOLL",
]);

/** The per-item cure lines (.cureStatusAilment picks the text by item id). */
const CURE_TEXT: Record<string, string> = {
  ANTIDOTE: "_AntidoteText",
  BURN_HEAL: "_BurnHealText",
  ICE_HEAL: "_IceHealText",
  AWAKENING: "_AwakeningText",
  PARLYZ_HEAL: "_ParlyzHealText",
  FULL_HEAL: "_FullHealText",
};

export const ESCAPE_ROPE_TILESETS = new Set(["FOREST", "CEMETERY", "CAVERN", "FACILITY", "INTERIOR"]);

export function isBall(id: string): boolean { return BALLS.has(id); }
export function isStone(id: string): boolean { return STONES.has(id); }

/** Takes item_effects.asm's .healHP path (the bar lengthens before the line). */
export function healsHP(id: string): boolean {
  return HEAL_AMOUNT[id] !== undefined || id === "MAX_POTION" || id === "FULL_RESTORE"
    || id === "REVIVE" || id === "MAX_REVIVE";
}

/** Needs a party member to be used on. */
export function needsTarget(data: any, id: string): boolean {
  return HEAL_AMOUNT[id] !== undefined || STATUS_HEAL[id] !== undefined
    || id === "MAX_POTION" || id === "FULL_RESTORE" || id === "REVIVE" || id === "MAX_REVIVE"
    || id === "RARE_CANDY" || STONES.has(id) || !!data?.items?.[id]?.machine
    || needsMove(id) || id === "ELIXER" || id === "MAX_ELIXER"
    || VITAMINS[id] !== undefined;
}

/** Needs a MOVE picked as well: the ETHERs and PP UP have a move menu. */
export function needsMove(id: string): boolean {
  return id === "ETHER" || id === "MAX_ETHER" || id === "PP_UP";
}

/** Refused mid-battle (jp nz, ItemUseNotTime). */
export function refusedInBattle(data: any, id: string): boolean {
  return VITAMINS[id] !== undefined || STONES.has(id) || id === "PP_UP" || id === "RARE_CANDY"
    || id === "COIN_CASE" || REPELS[id] !== undefined || !!data?.items?.[id]?.machine;
}

/** Field items with no target that the bag hands to the shell. */
export function fieldItem(id: string): boolean {
  return REPELS[id] !== undefined || id === "ESCAPE_ROPE" || id === "COIN_CASE"
    || id === "TOWN_MAP" || id === "ITEMFINDER";
}

/**
 * wRepelRemainingSteps: while any are left, a wild mon under the lead's
 * level never appears (the lead is party slot 1, healthy or not).
 */
export function repelled(save: { repelSteps?: number; party?: { level: number }[] }, level: number): boolean {
  const steps = save.repelSteps ?? 0;
  const lead = save.party?.[0];
  return steps > 0 && lead !== undefined && level < lead.level;
}

export interface ItemBattler {
  name: string;
  mon: PartyMon;
  stages?: Record<string, number | undefined>;
  focusEnergy?: boolean;
  mist?: boolean;
  xAccuracy?: boolean;
  toxicCounter?: number;
}

/** What the battle side hands over: enough to raise a stage or end a fight. */
export interface ItemBattle {
  /** "wild" or "trainer" -- the POKE DOLL only works on the first. */
  kind: string;
  player: ItemBattler;
  enemy?: ItemBattler;
}

export type ItemUseKind =
  | "failed"
  | "consumed"
  | "consumed_escape"
  | "ball"
  | "escape_rope"
  | "townmap"
  | "itemfinder";

export interface ItemUseResult {
  kind: ItemUseKind;
  /** The lines to print, in order. */
  msgs: string[];
  /** The HP the bar animates up from, when an HP restore landed. */
  healedFrom?: number;
  /** A stone took: the species to evolve the target into. */
  evolveTo?: string;
  /** Yellow's own Pikachu turned a stone down (the caller plays its cry). */
  refused?: boolean;
}

/** An extracted line by label, with the ROM's slots filled. */
export function itemText(
  data: any,
  key: string,
  fallback: string,
  subs: Record<string, string | number> = {},
): string {
  const raw = data?.text?.[key];
  let s: string = typeof raw === "string" && raw.length > 0 ? raw : fallback;
  s = s.replace(/\{RAM:wNameBuffer\}/g, String(subs.name ?? ""));
  s = s.replace(/\{RAM:wStringBuffer\}/g, String(subs.str ?? ""));
  s = s.replace(/\{RAM:wEnemyMonNick\}/g, String(subs.enemy ?? ""));
  s = s.replace(/\{USER\}/g, String(subs.name ?? ""));
  s = s.replace(/\{PLAYER\}/g, String(subs.player ?? ""));
  s = s.replace(/\{NUM:[^}]*\}/g, String(subs.num ?? ""));
  return s.replace(/[ \t]+$/g, "");
}

function notTime(data: any, save: any): string {
  return itemText(data, "_ItemUseNotTimeText", "OAK: {PLAYER}!\nThis isn't the\ntime to use that!",
    { player: save?.player?.name ?? "RED" });
}

/** Caught (or given) by this player: no other trainer's name on it. */
export function isOwn(save: any, mon: PartyMon): boolean {
  if (mon.otName === undefined && mon.otId === undefined) return true;
  return mon.otName === save?.player?.name && mon.otId === save?.player?.id;
}

function noEffect(data: any): string {
  return itemText(data, "_ItemUseNoEffectText", "It won't have any\neffect.");
}

function monName(data: any, mon: PartyMon): string {
  return mon.nickname ?? data?.pokemon?.[mon.species]?.name ?? mon.species;
}

/** A move's ceiling with its PP UPs (each adds a fifth of the base). */
export function maxPP(data: any, mv: { id: string; ppUps?: number }): number | null {
  const base = data?.moves?.[mv.id]?.pp;
  if (typeof base !== "number") return null;
  return base + (mv.ppUps ?? 0) * Math.floor(base / 5);
}

/**
 * Curing the ACTIVE battler clears its Toxic escalation flag
 * (.cureStatusAilment / AICureStatus both `res BADLY_POISONED`).
 */
function cureActiveToxic(battle: ItemBattle | null | undefined, target: PartyMon): void {
  if (!battle) return;
  for (const b of [battle.player, battle.enemy]) {
    if (b && b.mon === target) b.toxicCounter = undefined;
  }
}

/**
 * Use `itemId`, on `target` when it takes one, `battle` when used mid-fight
 * (null outside), `moveIndex` for the items with a move menu. Mutates the
 * target the way the ROM does and says what happened; the CALLER removes a
 * consumed item from the bag, so a refusal never costs one.
 *
 * The balls, the flute, the bike and the rods are answered by kind only:
 * each has its own machinery (the throw, the Snorlax, the mount, the cast)
 * that this module does not carry.
 */
export function useItem(
  data: any,
  save: any,
  itemId: string,
  target?: PartyMon | null,
  battle?: ItemBattle | null,
  moveIndex?: number,
): ItemUseResult {
  const def = data?.items?.[itemId];
  const name: string = def?.name ?? itemId;

  if (battle && refusedInBattle(data, itemId)) {
    return { kind: "failed", msgs: [notTime(data, save)] };
  }
  if (BALLS.has(itemId)) return { kind: "ball", msgs: [] };

  if (BATTLE_ONLY.has(itemId)) {
    if (!battle) return { kind: "failed", msgs: [notTime(data, save)] };
    const b = battle.player;
    if (itemId === "X_ACCURACY") {
      // ItemUseXAccuracy sets USING_X_ACCURACY: moves never miss (not a stage)
      b.xAccuracy = true;
      return { kind: "consumed", msgs: [`${b.name}'s\nhits will never\nmiss!`] };
    }
    const stat = X_ITEMS[itemId];
    if (stat) {
      b.stages ??= {};
      const cur = b.stages[stat] ?? 0;
      // ItemUseXStat removes the item BEFORE the stat-up effect runs, so at
      // +6 it is still consumed and the effect just prints "Nothing happened!"
      if (cur >= 6) {
        return { kind: "consumed", msgs: [itemText(data, "_NothingHappenedText", "Nothing happened!")] };
      }
      b.stages[stat] = cur + 1;
      return { kind: "consumed", msgs: [`${b.name}'s\n${stat.toUpperCase()} rose!`] };
    }
    // DIRE HIT / GUARD SPEC always set the bit and consume the item, even
    // when it is already active
    if (itemId === "DIRE_HIT") {
      b.focusEnergy = true;
      return { kind: "consumed", msgs: [itemText(data, "_GettingPumpedText", "{USER}'s\ngetting pumped!", { name: b.name })] };
    }
    if (itemId === "GUARD_SPEC") {
      b.mist = true;
      return { kind: "consumed", msgs: [`${b.name}'s\nprotected against\nstat changes!`] };
    }
    if (itemId === "POKE_DOLL") {
      // ItemUsePokeDoll jumps to ItemUseNotTime in trainer battles
      if (battle.kind !== "wild") return { kind: "failed", msgs: [notTime(data, save)] };
      return {
        kind: "consumed_escape",
        msgs: [itemText(data, "_WildRanText", "Wild {RAM:wEnemyMonNick}\nran!", { enemy: battle.enemy?.name ?? "" })],
      };
    }
  }

  // PP restores. The ETHERs restore the move the player picked; the ELIXERs
  // restore every move with no menu.
  if (itemId === "ETHER" || itemId === "MAX_ETHER" || itemId === "ELIXER" || itemId === "MAX_ELIXER") {
    if (!target) return { kind: "failed", msgs: [noEffect(data)] };
    const full = itemId === "MAX_ETHER" || itemId === "MAX_ELIXER";
    const all = itemId === "ELIXER" || itemId === "MAX_ELIXER";
    const restore = (mv: { id: string; pp: number; ppUps?: number }): boolean => {
      const cap = maxPP(data, mv);
      if (cap === null || mv.pp >= cap) return false;
      mv.pp = full ? cap : Math.min(cap, mv.pp + 10);
      return true;
    };
    let restored = false;
    if (all) {
      for (const mv of target.moves) restored = restore(mv) || restored;
    } else {
      const mv = target.moves[moveIndex ?? 0];
      restored = mv ? restore(mv) : false;
    }
    if (!restored) return { kind: "failed", msgs: [noEffect(data)] };
    return { kind: "consumed", msgs: [itemText(data, "_PPRestoredText", "PP was restored.")] };
  }

  const heal = HEAL_AMOUNT[itemId];
  if (heal !== undefined || itemId === "MAX_POTION" || itemId === "FULL_RESTORE") {
    // a FULL RESTORE on a statused mon already at full HP acts as a FULL
    // HEAL: cured, consumed (item_effects.asm swaps wCurItem to FULL_HEAL)
    if (itemId === "FULL_RESTORE" && target && target.hp > 0 && target.hp >= target.stats.hp && target.status) {
      target.status = null;
      cureActiveToxic(battle, target);
      return {
        kind: "consumed",
        msgs: [itemText(data, CURE_TEXT.FULL_HEAL!, "{RAM:wNameBuffer}'s\nhealth returned!", { name: monName(data, target) })],
      };
    }
    if (!target || target.hp <= 0 || target.hp >= target.stats.hp) {
      return { kind: "failed", msgs: [noEffect(data)] };
    }
    const before = target.hp;
    target.hp = heal === undefined ? target.stats.hp : Math.min(target.stats.hp, target.hp + heal);
    if (itemId === "FULL_RESTORE") {
      target.status = null;
      cureActiveToxic(battle, target);
    }
    return {
      kind: "consumed",
      msgs: [itemText(data, "_PotionText", "{RAM:wNameBuffer}\nrecovered by {NUM}!",
        { name: monName(data, target), num: target.hp - before })],
      healedFrom: before,
    };
  }

  const cures = STATUS_HEAL[itemId];
  if (cures) {
    if (!target || !target.status || !cures.includes(target.status)) {
      return { kind: "failed", msgs: [noEffect(data)] };
    }
    target.status = null;
    cureActiveToxic(battle, target);
    return {
      kind: "consumed",
      msgs: [itemText(data, CURE_TEXT[itemId]!, "{RAM:wNameBuffer}'s\nstatus returned\nto normal!", { name: monName(data, target) })],
    };
  }

  if (itemId === "REVIVE" || itemId === "MAX_REVIVE") {
    if (!target || target.hp > 0) return { kind: "failed", msgs: [noEffect(data)] };
    target.status = null;
    target.hp = itemId === "REVIVE" ? Math.floor(target.stats.hp / 2) : target.stats.hp;
    return {
      kind: "consumed",
      msgs: [itemText(data, "_ReviveText", "{RAM:wNameBuffer}\nis revitalized!", { name: monName(data, target) })],
      healedFrom: 0,
    };
  }

  if (STONES.has(itemId)) {
    if (!target) return { kind: "failed", msgs: [noEffect(data)] };
    // Yellow: your own Pikachu will not evolve (ItemUseEvoStone ->
    // IsThisPartyMonStarterPikachu: species PIKACHU with your ID and name as
    // its trainer). It refuses and the stone is kept.
    if (data?.version === "yellow" && target.species === "PIKACHU" && isOwn(save, target)) {
      return {
        kind: "failed",
        msgs: [itemText(data, "_RefusingText", "{RAM:wNameBuffer}\nis refusing!", { name: monName(data, target) })],
        refused: true,
      };
    }
    for (const evo of data?.pokemon?.[target.species]?.evolutions ?? []) {
      if (evo.method === "ITEM" && evo.item === itemId) {
        return { kind: "consumed", msgs: [], evolveTo: evo.species };
      }
    }
    return { kind: "failed", msgs: [noEffect(data)] };
  }

  // vitamins: +2560 stat exp, refused at 25600+ (ItemUseVitamin)
  const vit = VITAMINS[itemId];
  if (vit) {
    if (!target) return { kind: "failed", msgs: [noEffect(data)] };
    const se = (target.statExp ??= {} as PartyMon["statExp"]) as unknown as Record<string, number>;
    const cur = se[vit] ?? 0;
    if (cur >= 25600) return { kind: "failed", msgs: [noEffect(data)] };
    se[vit] = Math.min(65535, cur + 2560);
    const sdef = data?.pokemon?.[target.species];
    if (sdef) {
      target.stats = Stats.calc(sdef, target.level, target.dvs, target.statExp);
      target.hp = Math.min(target.hp, target.stats.hp);
    }
    return {
      kind: "consumed",
      msgs: [itemText(data, "_VitaminStatRoseText", "{RAM:wNameBuffer}'s\n{RAM:wStringBuffer} rose.",
        { name: monName(data, target), str: vit === "hp" ? "HEALTH" : vit.toUpperCase() })],
    };
  }

  // PP UP boosts the move the player picked (ItemUsePPUp's move menu)
  if (itemId === "PP_UP") {
    if (!target) return { kind: "failed", msgs: [noEffect(data)] };
    const mv = target.moves[moveIndex ?? 0];
    const base = mv ? data?.moves?.[mv.id]?.pp : undefined;
    if (mv && typeof base === "number" && (mv.ppUps ?? 0) < 3) {
      mv.ppUps = (mv.ppUps ?? 0) + 1;
      mv.pp += Math.floor(base / 5);
      return {
        kind: "consumed",
        msgs: [itemText(data, "_PPIncreasedText", "{RAM:wStringBuffer}'s PP\nincreased.",
          { str: data?.moves?.[mv.id]?.name ?? mv.id })],
      };
    }
    return { kind: "failed", msgs: [noEffect(data)] };
  }

  if (itemId === "ESCAPE_ROPE") return { kind: "escape_rope", msgs: [] };
  if (itemId === "TOWN_MAP") {
    if (battle) return { kind: "failed", msgs: [notTime(data, save)] };
    return { kind: "townmap", msgs: [] };
  }
  if (itemId === "ITEMFINDER") {
    if (battle) return { kind: "failed", msgs: [notTime(data, save)] };
    return { kind: "itemfinder", msgs: [] };
  }
  if (itemId === "COIN_CASE") {
    return {
      kind: "failed",
      msgs: [itemText(data, "_CoinCaseNumCoinsText", "Coins\n{NUM}", { num: save?.coins ?? 0 })],
    };
  }
  const repel = REPELS[itemId];
  if (repel !== undefined) {
    save.repelSteps = repel;
    return { kind: "consumed", msgs: [`${save?.player?.name ?? "RED"} used\n${name}!`] };
  }

  return { kind: "failed", msgs: [notTime(data, save)] };
}
