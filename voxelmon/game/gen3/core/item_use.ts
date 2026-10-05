// Port of gen1recomp src/core/game3/item_use.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG field item-use handlers for game3 bag.
//
// Return shapes (Lua multiple returns -> 0-based tuples):
//   healMon / revive -> [ok, amount]; clearStatus -> [ok, cured];
//   checkGive -> [kind, prev, text]; switchHeld -> [ok, text];
//   giveToMon / takeFromMon / useEscapeRope / useBike* / useTm / useRareCandy /
//   useVitamin / useEvolutionStone / useRod / usePokeFlute / useBlackWhiteFlute /
//   useField -> [ok, reason, text];
//   checkTmPreflight -> [status, text, moveId, moveName].
// The Pokeblock case and the Mach/Acro bike (rse) are Emerald only.
// `love` is always present here (useEvolutionStone's love.graphics guard is constant true).

import { tostring, tonumber, truthy } from "../../../import/gen3/lua.ts";
import { find } from "../platform/lpattern.ts";
import { concat, ipairs, len, seq, type LuaTable } from "../platform/lt.ts";
import { ItemsData } from "./items_data.ts";
import { Bag } from "./bag.ts";
import { Pokemon } from "./pokemon.ts";
import { Runtime as ModRuntime } from "../shared/mods/Runtime.ts";
import { Strings } from "../shared/core/Strings.ts";
import { RomText } from "./rom_text.ts";
import { Capabilities } from "./capabilities.ts";
import { Profile } from "./profile.ts";
import { Mail } from "./mail.ts";
import { R as QuestLogRecorder } from "./quest_log_recorder.ts";
import { Runtime } from "./runtime.ts";
import { Map as MapMod } from "./map.ts";
import { Warp } from "./warp.ts";
import { Field } from "./field.ts";
import { Message } from "../ui/message.ts";
import { Flags } from "./scripting/flags.ts";
import { Constants } from "./constants.ts";
import { Bike } from "./bike.ts";
import { Player } from "./player.ts";
import { Audio } from "./audio.ts";
import { SE } from "./se_ids.ts";
import { LearnMove } from "./battle/learn_move.ts";
import { Gen3Compat } from "../shared/mods/Gen3Compat.ts";
import { Evolution } from "./evolution.ts";
import { EvolutionScene } from "../ui/evolution_scene.ts";
import { Space as SpaceMod } from "./scripting/space.ts";
import { BagMenu } from "../ui/bag_menu.ts";
import { StartMenu } from "../ui/start_menu.ts";
import { Stack } from "../ui/stack.ts";
import { Fade } from "../ui/fade.ts";
import { Collision } from "./collision.ts";
import { FieldMoves } from "./field_moves.ts";
import { RegionMap } from "../ui/region_map.ts";
import { Sem } from "./field_semantics.ts";
import { VsSeeker } from "./vs_seeker.ts";
import { TmCase } from "../ui/tm_case.ts";
import { BerryPouch } from "../ui/berry_pouch.ts";
import { TeachyTv } from "./teachy_tv.ts";
import { FameCheckerUi } from "../ui/fame_checker.ts";
import { Items } from "./items.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type UseResult = [boolean, any, any];

// Lua: item_use.lua:13
function player_name(session: any): string {
  return tostring((session && (session.name ?? session.playerName)) ?? "");
}

// Lua: item_use.lua:17
function mon_text(key: string, mon: any, v2?: any): string {
  return RomText.box(key, { stringVars: seq(Pokemon.displayMonName(mon), v2) });
}

// Lua: item_use.lua:22 -- src/party_menu.c:4528 Task_DisplayHPRestoredMessage
function hp_restored_text(mon: any, restored: unknown): string {
  return mon_text("gText_PkmnHPRestoredByVar2", mon, tostring(restored));
}

// Lua: item_use.lua:27 -- src/item_use.c:191 PrintNotTheTimeToUseThat
function not_the_time(session: any): string {
  if (Profile.family(session) === "rse") {
    // pokeemerald/src/item_use.c:158 DisplayDadsAdviceCannotUseItemMessage
    return RomText.box("gText_DadsAdvice", { playerName: player_name(session) });
  }
  return RomText.box("gText_OakForbidsUseOfItemHere", { playerName: player_name(session) });
}

// Lua: item_use.lua:35
function no_pokemon_text(): string {
  return RomText.box("gText_ThereIsNoPokemon");
}

// Lua: item_use.lua:39
function wont_have_effect(): string {
  return RomText.box("gText_WontHaveEffect");
}

// Lua: item_use.lua:43
function cant_dismount_bike_text(): string {
  if (RomText.has && RomText.has("gText_CantDismountBike")) {
    try {
      const res = RomText.box("gText_CantDismountBike");
      if (truthy(res)) return res;
    } catch { /* pcall */ }
  }
  return "You can't dismount your BIKE here.";
}

// Lua: item_use.lua:52 -- pokefirered/src/data/pokemon/item_effects.h:80
const HERB_HEAL: Record<number, number> = { [30]: 50, [31]: 200 };
const ITEM_REVIVAL_HERB = 33;

// Lua: item_use.lua:56 -- pokefirered/src/data/pokemon/item_effects.h:81
const BITTER_MEDICINE_FRIENDSHIP: Record<number, LuaTable> = {
  [30]: seq(-5, -5, -10),
  [31]: seq(-10, -10, -15),
  [32]: seq(-5, -5, -10),
  [33]: seq(-15, -15, -20),
};

// Lua: item_use.lua:65
function heal_amount(id: any): number | null {
  const H: any = ItemsData.HEAL_AMOUNT;
  const n = H[id];
  if (n != null) return n;
  const num = ItemsData.toNumericId(id) ?? tonumber(id);
  if (num != null && HERB_HEAL[num]) return HERB_HEAL[num];
  if (num != null && H[num] != null) return H[num];
  // Pack holdEffectParam: Potion=20, Super=50, Hyper=200, Full Restore=255->full
  const info: any = ItemsData.info(id);
  const param = info ? tonumber(info.holdEffectParam) : undefined;
  if (param != null && param > 0) {
    if (param >= 255) return 9999;
    return param;
  }
  return null;
}

// Lua: item_use.lua:81 -- [status, sleep]
function mon_status(mon: any): [any, number] {
  if (!mon) return [null, 0];
  const st = mon.status;
  const sleep = tonumber(mon.sleep) ?? 0;
  if (typeof st === "string" && st !== "" && st !== "0") return [st, sleep];
  const n = tonumber(st) ?? 0;
  if (n !== 0) return [n, sleep];
  if (sleep > 0) return ["SLP", sleep];
  return [null, 0];
}

// Lua: item_use.lua:134 -- pokefirered/include/constants/item_effects.h:20
const STATUS_BIT: Record<string | number, number> = {
  PSN: 0x10, TOX: 0x10, BRN: 0x08, FRZ: 0x04, SLP: 0x20, PAR: 0x02,
  [1]: 0x10, [2]: 0x10, [3]: 0x08, [4]: 0x04, [5]: 0x20, [6]: 0x02,
};
const CURED_TEXT_KIND: Record<number, string> = { [0x10]: "poison", [0x08]: "burn", [0x04]: "freeze", [0x20]: "sleep", [0x02]: "paralysis" };
// Lua: item_use.lua:140 -- src/party_menu.c:4340 GetMedicineItemEffectMessage
const CURED_TEXT: Record<string, string> = {
  poison: "gText_PkmnCuredOfPoison",
  sleep: "gText_PkmnWokeUp2",
  burn: "gText_PkmnBurnHealed",
  freeze: "gText_PkmnThawedOut",
  paralysis: "gText_PkmnCuredOfParalysis",
  confusion: "gText_PkmnSnappedOutOfConfusion",
  infatuation: "gText_PkmnGotOverInfatuation",
  status: "gText_PkmnBecameHealthy",
};

// Lua: item_use.lua:152 -- pokefirered/src/party_menu.c:4412
const FLUTES: Record<number, boolean> = { [39]: true, [40]: true, [41]: true };

// Lua: item_use.lua:216 -- pokefirered/src/party_menu.c:1647
function bag_full_text(itemId: any): string {
  const pocket = ItemsData.pocketOf(itemId);
  let name: string;
  if (pocket === "TM_CASE") {
    name = ItemsData.displayName(ItemsData.ITEM_TM_CASE);
  } else if (pocket === "BERRY_POUCH") {
    name = ItemsData.displayName(ItemsData.ITEM_BERRY_POUCH);
  } else {
    name = RomText.plain("gText_MenuBag");
  }
  return RomText.box("gText_BagFullCouldNotRemoveItem", { stringVars: seq(name) });
}

// Lua: item_use.lua:229
function held_item(mon: any): any {
  const prev = mon ? (mon.item ?? mon.heldItem) : null;
  if (prev != null && prev !== false && prev !== 0 && prev !== "" && prev !== "NONE") return prev;
  return null;
}

// Lua: item_use.lua:343 -- pokefirered/include/global.fieldmap.h:191 gMapHeader
function current_map_def(session: any): any {
  const mapId = session ? session.map : undefined;
  if (typeof mapId !== "string") return null;
  const game = Runtime ? Runtime._game : undefined;
  const data = game && game.data ? game.data.maps : undefined;
  const def = data ? data[mapId] : undefined;
  if (def) return def;
  const M: any = MapMod;
  const cur = M && M.currentDef ? M.currentDef() : undefined;
  if (cur != null && typeof cur === "object" && cur.id === mapId) return cur;
  return null;
}

// Lua: item_use.lua:358 -- pokefirered/src/overworld.c:948 Overworld_IsBikingAllowed
function map_header_flag(session: any, key: string): boolean | null {
  const def = current_map_def(session);
  if (def == null || def[key] == null) return null;
  return (tonumber(def[key]) ?? 0) !== 0;
}

// Lua: item_use.lua:364
function is_outdoor(session: any): boolean {
  const mapId = session ? session.map : undefined;
  if (typeof mapId !== "string") return false;
  const def = current_map_def(session);
  const pair = def ? (def.pair ?? (def.midLayout ? def.midLayout.pair : undefined)) : undefined;
  if (typeof pair === "string" && find(pair, "outdoor", 1, true)) {
    return true;
  }
  // Heuristic when layout pair missing
  const has = (s: string): boolean => find(mapId, s, 1, true) !== undefined;
  if (has("HOUSE") || has("CENTER")
    || has("GYM") || has("MART")
    || has("LAB") || has("CAVE")
    || has("TUNNEL") || has("TOWER")
    || has("MANSION")) {
    return false;
  }
  if (has("ROUTE") || has("TOWN")
    || has("CITY") || has("ISLAND")) {
    return true;
  }
  return false;
}

// Lua: item_use.lua:388 -- pokefirered/src/item_use.c:614 CanUseEscapeRopeOnCurrMap
function can_escape(session: any): boolean {
  if (!session) return false;
  return map_header_flag(session, "allowEscaping") === true;
}

// Lua: item_use.lua:642 -- VITAMIN_STAT (pokefirered/src/data/pokemon/item_effects.h:168)
const VITAMIN_STAT: Record<number, string> = {
  [63]: "hp", [64]: "atk", [65]: "def", [66]: "spe", [67]: "spa", [70]: "spd",
};
const VITAMIN_ADD_EV = 10;

// Lua: item_use.lua:648 -- src/party_menu.c:4369
const VITAMIN_STAT_TEXT: Record<string, string> = {
  hp: "gText_ItemEffect_HP", atk: "gText_ItemEffect_Attack", def: "gText_ItemEffect_Defense",
  spe: "gText_ItemEffect_Speed", spa: "gText_ItemEffect_SpAtk", spd: "gText_ItemEffect_SpDef",
};

// Lua: item_use.lua:654 -- pokeemerald/src/party_menu.c:4338
const VITAMIN_STAT_TEXT_RSE: Record<string, string> = {
  hp: "gText_HP3", atk: "gText_Attack3", def: "gText_Defense3",
  spe: "gText_Speed2", spa: "gText_SpAtk3", spd: "gText_SpDef3",
};

// Lua: item_use.lua:682 -- pokefirered/include/constants/item_effects.h:34
const ITEM4_HEAL_PP_ALL = 0x08, ITEM4_HEAL_PP_ONE = 0x10, ITEM4_PP_UP = 0x20;
const ITEM5_PP_MAX = 0x10;

// Lua: item_use.lua:685
function s8(vIn: unknown): number {
  const v = tonumber(vIn) ?? 0;
  if (v >= 0x80) return v - 0x100;
  return v;
}

interface PpEffect { up: boolean; max: boolean; heal?: number; one?: boolean; friendship?: LuaTable }
interface PpChange { slot: number; bonus?: number; max?: number; pp: number }

// Lua: item_use.lua:692 -- pokefirered/src/pokemon.c:4001
function pp_effect(id: any): PpEffect | null {
  const info: any = ItemsData.info(id);
  const e = info ? info.effect : null;
  if (e == null || typeof e !== "object") return null;
  const e4 = tonumber(e[5]) ?? 0, e5 = tonumber(e[6]) ?? 0;
  let idx = 7;
  for (let b = 0; b <= 2; b++) {
    if ((e4 & (1 << b)) !== 0) idx = idx + 1;
  }
  const r: PpEffect = {
    up: (e4 & ITEM4_PP_UP) !== 0,
    max: (e5 & ITEM5_PP_MAX) !== 0,
  };
  if ((e4 & ITEM4_HEAL_PP_ALL) !== 0) {
    r.heal = tonumber(e[idx]) ?? 0;
    r.one = (e4 & ITEM4_HEAL_PP_ONE) !== 0;
    idx = idx + 1;
  }
  if (!(r.up || r.max || r.heal != null)) return null;
  for (let b = 0; b <= 3; b++) {
    if ((e5 & (1 << b)) !== 0) idx = idx + 1;
  }
  if ((e5 & 0xE0) !== 0) {
    r.friendship = [null];
    for (const [k, b] of ipairs<number>(seq(0x20, 0x40, 0x80))) {
      if ((e5 & b) !== 0) {
        r.friendship[k] = s8(e[idx]);
        idx = idx + 1;
      }
    }
  }
  return r;
}

// Lua: item_use.lua:726
function has_move(mon: any, s: number): boolean {
  const m = Pokemon.moveIdAt(mon, s);
  return m != null && m > 0;
}

// Lua: item_use.lua:732 -- pokefirered/src/pokemon.c:3898
function pp_with_bonus(mon: any, s: number, n: number): number {
  const base = tonumber(Pokemon.movePp(Pokemon.moveIdAt(mon, s))) ?? 0;
  return base + Math.floor(base * 20 * n / 100);
}

// Lua: item_use.lua:737
function pp_bonus(mon: any, s: number): number {
  if (typeof mon.ppBonusesPacked === "number") {
    return (mon.ppBonusesPacked >>> ((s - 1) * 2)) & 3;
  }
  const m = tonumber(mon.maxPp ? mon.maxPp[s] : undefined);
  if (m == null) return 0;
  let best = 0;
  for (let n = 0; n <= 3; n++) {
    const v = pp_with_bonus(mon, s, n);
    if (v === m) return n;
    if (v <= m) best = n;
  }
  return best;
}

// Lua: item_use.lua:753 -- pokefirered/src/pokemon.c:4202, :4344, :4463 -- [plan, effect]
function pp_plan(mon: any, id: any, moveSlot: unknown): [(PpChange | null)[] | null, PpEffect | null] {
  const e = pp_effect(id);
  if (!e || !mon) return [null, null];
  const out: (PpChange | null)[] = [null];
  if (e.up || e.max) {
    const s = tonumber(moveSlot);
    if (s != null && has_move(mon, s)) {
      const n = pp_bonus(mon, s);
      const cur = pp_with_bonus(mon, s, n);
      let nn: number | undefined;
      if (e.up && n < 3 && cur > 4) nn = n + 1;
      if (e.max && n < 3) nn = 3;
      if (nn != null) {
        const newMax = pp_with_bonus(mon, s, nn);
        out[len(out) + 1] = {
          slot: s, bonus: nn, max: newMax,
          pp: (tonumber(mon.pp ? mon.pp[s] : undefined) ?? 0) + newMax - cur,
        };
      }
    }
  } else if (e.heal != null) {
    for (let s = 1; s <= 4; s++) {
      if ((!e.one || s === tonumber(moveSlot)) && has_move(mon, s)) {
        const max = pp_with_bonus(mon, s, pp_bonus(mon, s));
        const cur = tonumber(mon.pp ? mon.pp[s] : undefined) ?? 0;
        if (cur !== max) {
          out[len(out) + 1] = { slot: s, pp: Math.min(max, cur + e.heal) };
        }
      }
    }
  }
  return [out, e];
}

// Lua: item_use.lua:873 -- pokefirered/include/constants/items.h:273
const ROD_ITEMS: Record<number, boolean> = { [262]: true, [263]: true, [264]: true };
// const ITEM_BLACK_FLUTE = 42 (declared, unused in item_use.lua)
const ITEM_WHITE_FLUTE = 43;
const ITEM_POKE_FLUTE = 350;
// pokefirered/include/constants/items.h:432 ITEM_BICYCLE
const ITEM_BICYCLE = 360;
// pokefirered/include/constants/items.h:438 ITEM_TEACHY_TV
const ITEM_TEACHY_TV = 366;
// pokefirered/include/constants/items.h:435 ITEM_FAME_CHECKER
const ITEM_FAME_CHECKER = 363;
const ITEM_AWAKENING = 17;
// pokefirered/include/constants/songs.h:346 MUS_POKE_FLUTE
const MUS_POKE_FLUTE = 338;

// Lua: item_use.lua:887
function sys_flag(session: any, flagId: number, value: boolean): void {
  const Space: any = SpaceMod;
  if (Space && Space.store) {
    Flags.setFlag(Space.store, Space.vm ? Space.vm.ctx ?? null : null, flagId, value);
  }
  if (session) {
    session.flags = session.flags ?? {};
    if (value) session.flags[flagId] = value; else delete session.flags[flagId];
  }
}

// Lua: item_use.lua:899
function play_se(id: any): void {
  try {
    if (Audio && Audio.playSe) Audio.playSe(id);
  } catch { /* pcall */ }
}

// Lua: item_use.lua:1047
function useField(session: any, bag: any, id: any, partySlot?: number, moveSlotIn?: number): UseResult {
  let moveSlot = moveSlotIn;
  const info: any = ItemsData.info(id);
  if (!info) return [false, "unknown", Strings("Unknown item.")];
  const use = ItemsData.fieldUseKind(id);

  if (Profile.family(session) === "rse") {
    const n = ItemsData.toNumericId(id) ?? tonumber(id);
    if (n === ITEM_POKE_FLUTE || n === ItemsData.ITEM_TM_CASE || n === ItemsData.ITEM_BERRY_POUCH
      || (info.fieldUseName === "ItemUseOutOfBattle_CannotUse" && (use === "map" || use === "vs_seeker" || use === "bike"))) {
      // pokeemerald/src/item_use.c:150 ItemUseOutOfBattle_CannotUse
      return [false, "none", not_the_time(session)];
    }
  }

  if (info.fieldUseName === "ItemUseOutOfBattle_PokeblockCase") {
    // pokeemerald/src/item_use.c:609
    // NOT FAITHFUL: Emerald only -- src.core.game3.rse.pokeblock is not ported.
    throw new Error("NOT FAITHFUL: Emerald only: src.core.game3.rse.pokeblock");
  }

  if (use === "battle") {
    // src/item_use.c:902 FieldUseFunc_OakStopsYou
    return [false, "battle", not_the_time(session)];
  }

  if (use === "map") {
    RegionMap.show({ session });
    return [true, "map", null];
  }

  if (use === "bike") {
    return ItemUse.useBike(session, id);
  }

  // pokefirered/src/item_use.c:337 FieldUseFunc_CoinCase
  if (use === "coin_case") {
    const B: any = Bag;
    const coins = (B.Coins && B.Coins.get && B.Coins.get(session)) || 0;
    // src/item_use.c:339
    return [true, "coin_case", RomText.box("gText_CoinCase", { stringVars: seq(tostring(coins)) })];
  }

  // pokefirered/src/item_use.c:348 FieldUseFunc_PowderJar
  if (use === "powder_jar") {
    // pokefirered/src/berry_powder.c:90 GetBerryPowder
    let powder = Math.floor(tonumber(session ? session.berryPowder : undefined) ?? 0);
    if (powder < 0) powder = 0;
    // src/item_use.c:350
    return [true, "powder_jar", RomText.box("gText_PowderQty", { stringVars: seq(tostring(powder)) })];
  }

  if (use === "escape") {
    return ItemUse.useEscapeRope(session, bag, id);
  }

  // src/item_use.c:550 FieldUseFunc_Repel
  if (use === "repel") {
    const vars = session.vars != null && typeof session.vars === "object" ? session.vars : null;
    const repelVar: any = Sem.var(session, "repelSteps");
    if ((tonumber(session.repelSteps) ?? (vars ? tonumber(vars[repelVar]) : undefined) ?? 0) > 0) {
      // src/item_use.c:559
      return [false, "repel", RomText.box("gText_RepelEffectsLingered")];
    }
    const R: any = ItemsData.REPEL_STEPS;
    const steps = R[id]
      ?? R[ItemsData.toNumericId(id) ?? -1]
      ?? 100;
    session.repelSteps = steps;
    // src/item_use.c:567 VarSet(VAR_REPEL_STEP_COUNT)
    if (vars) vars[repelVar] = steps;
    Bag.remove(bag, id, 1);
    // src/item_use.c:579 RemoveUsedItem
    const t = RomText.box("gText_PlayerUsedVar2",
      { playerName: player_name(session), stringVars: { [2]: ItemsData.displayName(id) } });
    return [true, "repel", t];
  }

  if (use === "vs_seeker" || id === ItemsData.ITEM_VS_SEEKER || id === "VS_SEEKER"
    || ItemsData.toNumericId(id) === ItemsData.ITEM_VS_SEEKER) {
    if (!Capabilities.gate(session, "vs_seeker")) {
      return [false, "vs_seeker", null];
    }
    if (!VsSeeker.canUseHere(session)) {
      return [false, "vs_seeker", VsSeeker.notTimeText(session)];
    }
    return [true, "vs_seeker", null];
  }

  if (use === "itemfinder" || id === ItemsData.ITEM_ITEMFINDER || id === "ITEMFINDER"
    || ItemsData.toNumericId(id) === ItemsData.ITEM_ITEMFINDER) {
    const [ok, kind, text] = Field.useItemfinder(session);
    return [ok, kind ?? "itemfinder", text];
  }

  if (id === ItemsData.ITEM_TM_CASE || id === "TM_CASE"
    || ItemsData.toNumericId(id) === ItemsData.ITEM_TM_CASE) {
    TmCase.show(session, bag);
    return [true, "tm_case", null];
  }

  if (id === ItemsData.ITEM_BERRY_POUCH || id === "BERRY_POUCH"
    || ItemsData.toNumericId(id) === ItemsData.ITEM_BERRY_POUCH) {
    BerryPouch.show(session, bag);
    return [true, "berry_pouch", null];
  }

  // pokefirered/src/item_use.c:518 FieldUseFunc_TeachyTv
  if (id === ITEM_TEACHY_TV || id === "TEACHY_TV"
    || ItemsData.toNumericId(id) === ITEM_TEACHY_TV) {
    if (!Capabilities.gate(session, "teachy_tv")) {
      return [false, "teachy_tv", null];
    }
    TeachyTv.show(session, bag);
    return [true, "teachy_tv", null];
  }

  // pokefirered/src/item_use.c:680 FieldUseFunc_FameChecker
  if (id === ITEM_FAME_CHECKER || id === "FAME_CHECKER"
    || ItemsData.toNumericId(id) === ITEM_FAME_CHECKER) {
    if (!Capabilities.gate(session, "fame_checker")) {
      return [false, "fame_checker", null];
    }
    // pokefirered/src/item_use.c:696 UseFameCheckerFromBag
    const fromBag = BagMenu && BagMenu.open ? true : false;
    FameCheckerUi.show(session, { fromBag });
    return [true, "fame_checker", null];
  }

  {
    const num = ItemsData.toNumericId(id) ?? tonumber(id);
    if (num != null && ROD_ITEMS[num]) {
      return ItemUse.useRod(session, id);
    }
    if (num === ITEM_POKE_FLUTE) {
      return ItemUse.usePokeFlute(session);
    }
    if (use === "black_white_flute") {
      return ItemUse.useBlackWhiteFlute(session, num);
    }
    // pokefirered/src/item_use.c:253 FieldUseFunc_Bike
    if (num === ITEM_BICYCLE) {
      return ItemUse.useBike(session);
    }
  }

  if (use === "key" || use === "rod" || use === "berry" || use === "mail"
    || use === "flute" || use === "none") {
    return [false, use, not_the_time(session)];
  }

  if (use === "heal" || use === "status" || use === "revive" || use === "tm"
    || use === "pp" || use === "level" || use === "evo" || use === "vitamin") {
    const party = session ? session.party : null;
    if (!party || len(party) < 1) {
      return [false, "noparty", no_pokemon_text()];
    }
    if (!partySlot) {
      return [false, "need_slot", Strings("Select a POK\xC3\xA9MON.")];
    }
    const mon = party[partySlot];
    if (!mon) {
      return [false, "noparty", no_pokemon_text()];
    }
    let ok: any = false;
    let text: any = null;
    const num = ItemsData.toNumericId(id) ?? tonumber(id);

    if (use === "tm") {
      return ItemUse.useTm(session, bag, id, partySlot);
    } else if (use === "evo") {
      [ok, , text] = ItemUse.useEvolutionStone(session, mon, id, bag);
    } else if (use === "level") {
      [ok, , text] = ItemUse.useRareCandy(session, mon);
    // pokefirered/src/pokemon.c:4258
    } else if (use === "revive" || num === ITEM_REVIVAL_HERB) {
      if (num === 45) { // Sacred Ash
        // src/party_menu.c:5280 Task_SacredAshDisplayHPRestored
        const pages: LuaTable = [null];
        for (const [, m] of ipairs<any>(party)) {
          const before = tonumber(m.hp) ?? 0;
          if (ItemUse.revive(m, true)[0]) {
            pages[len(pages) + 1] = hp_restored_text(m, (tonumber(m.hp) ?? 0) - before);
          }
        }
        ok = len(pages) > 0;
        if (ok) text = concat(pages, "\f");
      } else {
        const max = num === 25 || num === ITEM_REVIVAL_HERB || tostring(id) === "MAX_REVIVE";
        let restored: number;
        [ok, restored] = ItemUse.revive(mon, max);
        if (ok) text = hp_restored_text(mon, restored);
      }
    } else if (use === "status") {
      const [stOk, cured] = ItemUse.clearStatus(mon, id);
      ok = stOk;
      if (ok) text = mon_text(CURED_TEXT[cured!] ?? CURED_TEXT.status, mon);
    } else if (use === "pp") {
      if (moveSlot == null && ItemUse.ppItemNeedsMove(id)) {
        return [false, "need_move", null];
      }
      moveSlot = moveSlot ?? 1;
      // pokefirered/src/party_menu.c:4657
      ok = ItemUse.applyPpItem(mon, id, moveSlot, null, session);
      if (ok) text = ItemUse.ppItemText(mon, id, moveSlot);
    } else if (use === "vitamin") {
      [ok, , text] = ItemUse.useVitamin(session, mon, id);
    } else {
      const [healOk, restored] = ItemUse.healMon(session, mon, id);
      ok = healOk;
      if (ok && restored && restored > 0) {
        text = hp_restored_text(mon, restored);
      } else if (ok) {
        // src/party_menu.c:4366
        text = mon_text(CURED_TEXT.status, mon);
      }
    }

    if (truthy(ok)) {
      // pokefirered/src/pokemon.c:4481
      if (num != null && BITTER_MEDICINE_FRIENDSHIP[num]) {
        Pokemon.itemFriendship(mon, BITTER_MEDICINE_FRIENDSHIP[num],
          { mapSec: Pokemon.currentMapSec(session) });
      }
      // pokefirered/src/party_menu.c:4498
      if (!ItemUse.isFlute(id)) Bag.remove(bag, id, 1);
      return [true, use, text];
    }
    return [false, "noeffect", text ?? wont_have_effect()];
  }

  return [false, "none", not_the_time(session)];
}

export const ItemUse = {
  // Lua: item_use.lua:62
  BITTER_MEDICINE_FRIENDSHIP,
  ITEM_REVIVAL_HERB,
  _onFieldCB: null as (() => void) | null,

  // Lua: item_use.lua:93
  healMon(_session: any, mon: any, id: any): [boolean, number] {
    if (!mon) return [false, 0];
    const kind = ItemsData.medicineKind(id);
    const maxHp = tonumber(mon.maxHp) ?? tonumber(mon.maxhp) ?? 0;
    const hp = tonumber(mon.hp) ?? 0;
    if (maxHp <= 0) return [false, 0];

    if (kind === "full_restore") {
      if (hp <= 0) return [false, 0];
      let changed = false;
      let restored = 0;
      if (hp < maxHp) {
        restored = maxHp - hp;
        mon.hp = maxHp;
        changed = true;
      }
      const [st] = mon_status(mon);
      if (st != null) {
        mon.status = null;
        mon.sleep = 0;
        changed = true;
      }
      return [changed, restored];
    }

    const amt = heal_amount(id);
    if (amt == null) return [false, 0];
    if (hp <= 0) return [false, 0];
    if (hp >= maxHp) return [false, 0];
    let newHp: number;
    if (amt >= 9999) {
      newHp = maxHp;
    } else {
      newHp = Math.min(maxHp, hp + amt);
    }
    const restored = newHp - hp;
    mon.hp = newHp;
    return [true, restored];
  },

  // Lua: item_use.lua:153
  isFlute(id: any): boolean {
    return FLUTES[(ItemsData.toNumericId(id) ?? tonumber(id)) as number] === true;
  },

  // Lua: item_use.lua:158 -- pokefirered/src/party_menu.c:5345 GetItemEffectType
  cureKind(id: any): string | null {
    const info: any = ItemsData.info(id);
    const e = info ? info.effect : null;
    if (e == null || typeof e !== "object") return null;
    const statusCure = (tonumber(e[4]) ?? 0) & 0x3F;
    if (statusCure === 0x01) return "confusion";
    if (statusCure === 0 && ((tonumber(e[1]) ?? 0) & 0x80) !== 0) return "infatuation";
    return CURED_TEXT_KIND[statusCure] ?? "status";
  },

  // Lua: item_use.lua:169 -- pokefirered/src/party_menu.c:4510
  medicineText(mon: any, hpBefore: unknown, cured?: string): string {
    const gained = (tonumber(mon ? mon.hp : undefined) ?? 0) - (tonumber(hpBefore) ?? 0);
    if (gained > 0) return hp_restored_text(mon, gained);
    return mon_text(CURED_TEXT[cured as string] ?? CURED_TEXT.status, mon);
  },

  // Lua: item_use.lua:176 -- pokefirered/src/pokemon.c:4511
  clearStatus(mon: any, id: any): [boolean, string | null] {
    if (!mon) return [false, null];
    const [st, sleep] = mon_status(mon);
    if (st == null && sleep <= 0) return [false, null];
    const info: any = ItemsData.info(id);
    const e = info ? info.effect : null;
    if (e == null || typeof e !== "object") return [false, null];
    const mask = (tonumber(e[4]) ?? 0) & 0x3E;
    const have = (st != null ? STATUS_BIT[st] : undefined) ?? ((sleep > 0) ? 0x20 : 0);
    if ((mask & have) === 0) return [false, null];
    const cured = CURED_TEXT_KIND[mask] ?? "status";
    mon.status = null;
    mon.sleep = 0;
    return [true, cured];
  },

  // Lua: item_use.lua:192
  revive(mon: any, max?: boolean): [boolean, number] {
    if (!mon) return [false, 0];
    const maxHp = tonumber(mon.maxHp) ?? tonumber(mon.maxhp) ?? 0;
    const hp = tonumber(mon.hp) ?? 0;
    if (hp > 0 || maxHp <= 0) return [false, 0];
    if (max) {
      mon.hp = maxHp;
    } else {
      mon.hp = Math.max(1, Math.floor(maxHp / 2));
    }
    mon.status = null;
    mon.sleep = 0;
    return [true, mon.hp];
  },

  // Lua: item_use.lua:207
  reviveAll(party: LuaTable): boolean {
    let any = false;
    for (const [, mon] of ipairs<any>(party ?? [null])) {
      if (ItemUse.revive(mon, true)[0]) any = true;
    }
    return any;
  },

  // Lua: item_use.lua:236 -- src/party_menu.c:5607, :5617
  bagGiveSource(bag: any): any {
    return {
      remove: (id: any) => Bag.remove(bag, id, 1),
      restore: (id: any) => Bag.add(bag, id, 1),
      // src/party_menu.c:1580
      quest: (monName: string, itemName: string) => ["GaveMonHeldItem2", seq(monName, itemName)],
    };
  },

  // Lua: item_use.lua:246 -- src/party_menu.c:3422 CB2_SelectBagItemToGive
  partyGiveSource(bag: any): any {
    const source = ItemUse.bagGiveSource(bag);
    // src/party_menu.c:1579
    source.quest = (monName: string, itemName: string) => ["GaveMonHeldItem", seq(monName, itemName)];
    return source;
  },

  // Lua: item_use.lua:254 -- src/party_menu.c:5455 TryGiveItemOrMailToSelectedMon
  checkGive(session: any, id: any, partySlot: number): [string, any, string | null] {
    const party = session ? session.party : null;
    const mon = party ? party[partySlot] : null;
    if (!mon) return ["noparty", null, no_pokemon_text()];
    const pocket = ItemsData.pocketOf(id);
    if (pocket === "KEY_ITEMS" || pocket === "TM_CASE") {
      // src/item_menu.c:1635
      return ["cant_hold", null, RomText.box("gText_ItemCantBeHeld", { stringVars: seq(ItemsData.displayName(id)) })];
    }
    const prev = held_item(mon);
    if (prev == null) return ["give", null, null];
    if (Mail.isMailItem(ItemsData.toNumericId(prev) ?? prev)) {
      // src/party_menu.c:5600 DisplayItemMustBeRemovedFirstMessage
      return ["mail", prev, RomText.box("gText_RemoveMailBeforeItem")];
    }
    // src/party_menu.c:1601 DisplayAlreadyHoldingItemSwitchMessage
    return ["switch", prev, mon_text("gText_PkmnAlreadyHoldingItemSwitch", mon, ItemsData.displayName(prev))];
  },

  // Lua: item_use.lua:274 -- src/party_menu.c:5487 GiveItemToSelectedMon
  giveHeld(session: any, bag: any, id: any, partySlot: number, source?: any): string {
    source = source ?? ItemUse.bagGiveSource(bag);
    const mon = session.party[partySlot];
    const itemName = ItemsData.displayName(id);
    const [key, args] = source.quest(Pokemon.displayMonName(mon), itemName);
    QuestLogRecorder.event(session, key, args);
    mon.item = ItemsData.toNumericId(id) ?? id;
    mon.heldItem = mon.item;
    source.remove(id);
    // src/party_menu.c:1586
    return mon_text("gText_PkmnWasGivenItem", mon, itemName);
  },

  // Lua: item_use.lua:288 -- src/party_menu.c:5563 Task_HandleSwitchItemsFromBagYesNoInput
  switchHeld(session: any, bag: any, id: any, partySlot: number, source?: any): [boolean, string] {
    source = source ?? ItemUse.bagGiveSource(bag);
    const mon = session.party[partySlot];
    const prev = held_item(mon);
    source.remove(id);
    if (!truthy(Bag.add(bag, prev, 1)[0])) {
      source.restore(id);
      return [false, bag_full_text(prev)];
    }
    mon.item = ItemsData.toNumericId(id) ?? id;
    mon.heldItem = mon.item;
    // src/party_menu.c:1612 SetSwappedHeldItemQuestLogEvent
    QuestLogRecorder.event(session, "SwappedHeldItemsOnMon",
      seq(Pokemon.displayMonName(mon), ItemsData.displayName(prev), ItemsData.displayName(id)));
    // src/party_menu.c:1615
    return [true, RomText.box("gText_SwitchedPkmnItem",
      { stringVars: seq(ItemsData.displayName(id), ItemsData.displayName(prev)) })];
  },

  // Lua: item_use.lua:308
  giveToMon(session: any, bag: any, id: any, partySlot: number, source?: any): UseResult {
    const [kind, , text] = ItemUse.checkGive(session, id, partySlot);
    if (kind === "give") {
      return [true, "give", ItemUse.giveHeld(session, bag, id, partySlot, source)];
    } else if (kind === "switch") {
      const [ok, msg] = ItemUse.switchHeld(session, bag, id, partySlot, source);
      return [ok, ok ? "give" : "bag_full", msg];
    }
    return [false, kind, text];
  },

  // Lua: item_use.lua:320
  takeFromMon(session: any, bag: any, partySlot: number): UseResult {
    const party = session ? session.party : null;
    const mon = party ? party[partySlot] : null;
    if (!mon) return [false, "noparty", no_pokemon_text()];
    const held = mon.item ?? mon.heldItem;
    const monName = Pokemon.displayMonName(mon);
    if (held == null || held === false || held === 0 || held === "" || held === "NONE") {
      return [false, "none", mon_text("gText_PkmnNotHolding", mon)];
    }
    if (!Bag.canAdd(bag, held, 1)) {
      return [false, "bag_full", bag_full_text(held)];
    }
    mon.item = null;
    mon.heldItem = null;
    Bag.add(bag, held, 1);
    // src/party_menu.c:1596
    const text = mon_text("gText_ReceivedItemFromPkmn", mon, ItemsData.displayName(held));
    QuestLogRecorder.event(session, "TookHeldItemFromMon",
      seq(monName, ItemsData.displayName(held)));
    return [true, "take", text];
  },

  // Lua: item_use.lua:393
  useEscapeRope(session: any, bag: any, id: any): UseResult {
    if (!can_escape(session)) {
      return [false, "escape", not_the_time(session)];
    }
    const game = Runtime ? Runtime._game : undefined;
    Bag.remove(bag, id, 1);
    // src/item_use.c:579 RemoveUsedItem
    const t = RomText.box("gText_PlayerUsedVar2",
      { playerName: player_name(session), stringVars: { [2]: ItemsData.displayName(id) } });
    let hx = session.healX ?? 8;
    let hy = session.healY ?? 5;
    let mapId = session.healMap ?? "FR_PLAYERS_HOUSE_1F";
    // pokefirered/src/field_effect.c:2126 SetWarpDestinationToEscapeWarp
    const esc = session.escapeWarp;
    if (esc != null && typeof esc === "object" && typeof esc.map === "string") {
      mapId = esc.map;
      hx = tonumber(esc.x) ?? hx;
      hy = tonumber(esc.y) ?? hy;
    }
    // pokefirered/src/item_use.c:642 Task_UseDigEscapeRopeOnField
    const leave = (): void => {
      Warp.startEscapeRope(game, mapId, hx, hy, (m: any, x: any, y: any) => {
        Field.respawnAtHeal({ fieldMove: true, warp: { map: m, x, y } });
      });
    };
    // pokefirered/src/item_use.c:634 ItemUseOnFieldCB_EscapeRope
    const onField = (): void => {
      if (Message && Message.show) {
        // pokefirered/src/new_menu_helpers.c:641 DisplayItemMessageOnField
        Message.show(t, { done: leave } as any);
      } else {
        leave();
      }
    };
    // pokefirered/src/item_use.c:159 SetUpItemUseOnFieldCallback
    if (!ItemUse.setUpOnFieldCallback(onField)) onField();
    return [true, "escape", t];
  },

  // Lua: item_use.lua:436 -- pokeemerald/src/item_use.c:200 ItemUseOutOfBattle_Bike
  useBikeRse(session: any, id: any, BikeRse: any): UseResult {
    const Space: any = SpaceMod;
    const st = Space ? Space.store : undefined;
    const cf = Flags.forVersion(Profile.forSession(session).id).IDS.FLAG_SYS_CYCLING_ROAD;
    if ((cf && st && Flags.getFlag(st, null, cf) === true) || BikeRse.onRail()) {
      return [false, "bike", cant_dismount_bike_text()];
    }
    if (map_header_flag(session, "bikingAllowed") === true && !BikeRse.bikingDisallowedByPlayer()) {
      // pokeemerald/src/item_use.c:223 ItemUseOnFieldCB_Bike
      const acro = Constants.active(session).id("items", "ITEM_ACRO_BIKE");
      const num = ItemsData.toNumericId(id) ?? tonumber(id);
      BikeRse.getOnOff((acro && num === acro) ? "acro" : "mach", session);
      return [true, "bike", null];
    }
    return [false, "bike", not_the_time(session)];
  },

  // Lua: item_use.lua:456 -- pokefirered/src/item_use.c:253 FieldUseFunc_Bike
  useBike(session: any, id?: any): UseResult {
    const BikeRse = Bike.rse(session);
    if (BikeRse) return ItemUse.useBikeRse(session, id, BikeRse);
    const P: any = Player;
    const R: any = Runtime;
    if (truthy(P.biking)) {
      // pokefirered/src/item_use.c:261: If already on bike, cannot dismount on cycling road
      if (P.isOnCyclingRoad && P.isOnCyclingRoad(session)) {
        return [false, "bike", cant_dismount_bike_text()];
      }
      // pokefirered/src/item_use.c:267
      let allowed = map_header_flag(session, "bikingAllowed");
      if (allowed == null) allowed = is_outdoor(session);
      if (!allowed) return [false, "bike", not_the_time(session)];
      P.biking = false;
      if (session) session.biking = false;
      const curSession = R && R.getSession ? R.getSession() : undefined;
      if (curSession) curSession.biking = false;
      const game = R && R.getGame ? R.getGame() : undefined;
      if (game && game.save) {
        game.save.biking = false;
        if (game.save.position) game.save.position.biking = false;
      }
      Audio.bikeMusic(false);
      return [true, "bike", null];
    } else {
      // pokefirered/src/overworld.c:948 Overworld_IsBikingAllowed
      let biking = map_header_flag(session, "bikingAllowed");
      if (biking == null) biking = is_outdoor(session);
      if (!biking) {
        return [false, "bike", not_the_time(session)];
      }
      try {
        if (Audio && Audio.playSe) Audio.playSe(SE.SE_BIKE_BELL);
      } catch { /* pcall */ }
      P.biking = true;
      if (session) session.biking = true;
      const curSession = R && R.getSession ? R.getSession() : undefined;
      if (curSession) curSession.biking = true;
      const game = R && R.getGame ? R.getGame() : undefined;
      if (game && game.save) {
        game.save.biking = true;
        if (game.save.position) game.save.position.biking = true;
      }
      Audio.bikeMusic(true);
      return [true, "bike", null];
    }
  },

  // Lua: item_use.lua:511 -- src/party_menu.c:4762 ItemUseCB_TMHM
  checkTmPreflight(mon: any, tmId: any): [string, string | null, number | null, string | null] {
    if (!mon) return ["none", no_pokemon_text(), null, null];
    const moveId = Pokemon.moveFromTmItem(tmId);
    if (!moveId) {
      return ["invalid", wont_have_effect(), null, null];
    }
    const moveName = Pokemon.moveName(moveId);
    const species = tonumber(mon.species ?? mon.speciesId);
    if (!Pokemon.canLearnTmItem(species, tmId)) {
      // src/party_menu.c:4779
      return ["incompatible", mon_text("gText_PkmnCantLearnMove", mon, moveName), moveId, moveName];
    }
    if (Pokemon.knowsMove(mon, moveId)) {
      // src/party_menu.c:4782
      return ["knows", mon_text("gText_PkmnAlreadyKnows", mon, moveName), moveId, moveName];
    }
    if (Pokemon.moveSlotCount(mon) >= 4) {
      // src/party_menu.c:4793
      return ["ok", mon_text("gText_PkmnNeedsToReplaceMove", mon, moveName), moveId, moveName];
    }
    return ["ok", null, moveId, moveName];
  },

  // Lua: item_use.lua:535
  useTm(session: any, bag: any, id: any, partySlot: number): UseResult {
    const party = session ? session.party : null;
    const mon = party ? party[partySlot] : null;
    if (!mon) {
      return [false, "noparty", no_pokemon_text()];
    }
    const [status, preflightMsg, moveId, moveName] = ItemUse.checkTmPreflight(mon, id);
    if (status !== "ok") {
      return [false, status, preflightMsg];
    }
    const monName = Pokemon.displayMonName(mon);

    const isHm = ItemsData.isHm(id);
    let consumed = false;

    const finish_consume = (learned: any): void => {
      if (truthy(learned)) {
        // pokefirered/src/party_menu.c:4287
        Pokemon.adjustFriendship(mon, Pokemon.FRIENDSHIP_EVENT_LEARN_TMHM,
          { mapSec: Pokemon.currentMapSec(session) });
        QuestLogRecorder.event(session,
          isHm ? "MonLearnedMoveFromHM" : "MonLearnedMoveFromTM", seq(monName, moveName));
      }
      if (truthy(learned) && !isHm && !consumed) {
        Bag.remove(bag, id, 1);
        consumed = true;
      }
    };

    if (Pokemon.moveSlotCount(mon) < 4) {
      const ok = Pokemon.teachMove(mon, moveId)[0];
      if (ok) {
        finish_consume(true);
        // src/party_menu.c:4817
        return [true, "tm", mon_text("gText_PkmnLearnedMove3", mon, moveName)];
      }
    }

    LearnMove.begin({
      mon,
      moveId,
      displayName: monName,
      headless: true,
      onDone: (learned: any) => {
        finish_consume(learned);
      },
    });
    if (Pokemon.moveSlotCount(mon) >= 4) {
      // src/party_menu.c:4793
      return [false, "full", mon_text("gText_PkmnNeedsToReplaceMove", mon, moveName)];
    }
    return [true, "tm", mon_text("gText_PkmnLearnedMove3", mon, moveName)];
  },

  // Lua: item_use.lua:591
  needsPartyTarget(id: any): boolean {
    if (!id) return false;
    const info: any = ItemsData.info(id);
    if (!info) return false;
    const use = ItemsData.fieldUseKind(id);
    if (use === "heal" || use === "status" || use === "revive" || use === "tm"
      || use === "pp" || use === "level" || use === "evo" || use === "vitamin") {
      return true;
    }
    if (info.pocket === "TM_CASE") return true;
    return false;
  },

  // Lua: item_use.lua:605 -- pokefirered/src/party_menu.c:5018
  levelUpEvent(mon: any, level: number): void {
    if (!ModRuntime.wants("pokemon.level_up")) return;
    const learnable: LuaTable = [null], learnableIds: LuaTable = [null];
    for (const [, mv] of ipairs<number>(Pokemon.movesLearnedAt(tonumber(mon.species ?? mon.speciesId), level))) {
      learnable[len(learnable) + 1] = Gen3Compat.moveName(mv);
      learnableIds[len(learnableIds) + 1] = mv;
    }
    ModRuntime.emit("pokemon.level_up", {
      mon, level, prevLevel: level - 1,
      learnable, learnableIds, via: "item",
    });
  },

  // Lua: item_use.lua:619
  useRareCandy(session: any, mon: any): UseResult {
    if (!mon) return [false, "none", no_pokemon_text()];
    const lvl = tonumber(mon.level) ?? 1;
    const hp = tonumber(mon.hp) ?? 0;
    if (lvl >= 100 || hp <= 0) {
      return [false, "no_effect", wont_have_effect()];
    }
    const oldMax = tonumber(mon.maxHp) ?? tonumber(mon.maxhp) ?? 1;
    const oldHp = hp;
    mon.level = lvl + 1;
    Pokemon.applyStats(mon);
    const newMax = tonumber(mon.maxHp) ?? tonumber(mon.maxhp) ?? oldMax;
    mon.hp = Math.min(newMax, oldHp + Math.max(0, newMax - oldMax));
    // pokefirered/src/data/pokemon/item_effects.h:200 sItemEffect_RareCandy
    Pokemon.itemFriendship(mon, Pokemon.VITAMIN_FRIENDSHIP_CHANGE,
      { mapSec: Pokemon.currentMapSec(session) });
    ItemUse.levelUpEvent(mon, mon.level);
    // src/party_menu.c:5061
    const t = mon_text("gText_PkmnElevatedToLvVar2", mon, tostring(mon.level));
    return [true, "level", t];
  },

  // Lua: item_use.lua:659
  useVitamin(session: any, mon: any, itemId: any): UseResult {
    if (!mon) return [false, "none", no_pokemon_text()];
    const num = ItemsData.toNumericId(itemId) ?? tonumber(itemId);
    const key = num != null ? VITAMIN_STAT[num] : undefined;
    if (!key) {
      return [false, "no_effect", wont_have_effect()];
    }
    // pokefirered/src/party_menu.c:4405 NotUsingHPEVItemOnShedinja
    if (key === "hp" && (tonumber(mon.species ?? mon.speciesId) ?? 0) === 303) {
      return [false, "no_effect", wont_have_effect()];
    }
    const gained = Pokemon.raiseEvFromItem(mon, key, VITAMIN_ADD_EV);
    if (!gained || gained <= 0) {
      return [false, "no_effect", wont_have_effect()];
    }
    Pokemon.itemFriendship(mon, Pokemon.VITAMIN_FRIENDSHIP_CHANGE,
      { mapSec: Pokemon.currentMapSec(session) });
    const statTextKey = Profile.family(session) === "rse" ? VITAMIN_STAT_TEXT_RSE : VITAMIN_STAT_TEXT;
    const t = mon_text("gText_PkmnBaseVar2StatIncreased", mon, RomText.plain(statTextKey[key]));
    return [true, "vitamin", t];
  },

  // Lua: item_use.lua:788 -- pokefirered/src/party_menu.c:4591, :4709
  ppItemNeedsMove(id: any): boolean {
    const e = pp_effect(id);
    return e != null && (e.one || e.up || e.max) ? true : false;
  },

  // Lua: item_use.lua:793
  ppItemBoosts(id: any): boolean {
    const e = pp_effect(id);
    return e != null && (e.up || e.max) ? true : false;
  },

  // Lua: item_use.lua:799 -- pokefirered/src/pokemon.c:4529
  ppItemHasEffect(mon: any, id: any, moveSlot: unknown): boolean {
    const [plan] = pp_plan(mon, id, moveSlot);
    return plan != null && len(plan) > 0;
  },

  // Lua: item_use.lua:805 -- pokefirered/src/party_menu.c:4340
  ppItemText(mon: any, id: any, moveSlot: number): string {
    if (ItemUse.ppItemBoosts(id)) {
      // src/party_menu.c:4667
      return RomText.box("gText_MovesPPIncreased",
        { stringVars: seq(Pokemon.moveName(Pokemon.moveIdAt(mon, moveSlot))) });
    }
    return RomText.box("gText_PPWasRestored");
  },

  // Lua: item_use.lua:814
  applyPpItem(mon: any, id: any, moveSlot: unknown, battler: any, session?: any): boolean {
    const [plan, e] = pp_plan(mon, id, moveSlot);
    if (!plan || len(plan) === 0) return false;
    mon.pp = mon.pp ?? [null];
    for (const [, c] of ipairs<PpChange>(plan)) {
      mon.pp[c.slot] = c.pp;
      if (c.max != null) {
        mon.maxPp = mon.maxPp ?? [null];
        mon.maxPp[c.slot] = c.max;
        if (typeof mon.ppBonusesPacked === "number") {
          const shift = (c.slot - 1) * 2;
          mon.ppBonusesPacked = (mon.ppBonusesPacked & ~(3 << shift)) | (c.bonus! << shift);
        }
      }
      // pokefirered/src/pokemon.c:4366
      const bMon = battler ? battler.mon : null;
      if (bMon && bMon !== mon && !truthy(battler.transformed)
        && (!battler.permanentSlots || truthy(battler.permanentSlots[c.slot]))) {
        bMon.pp = bMon.pp ?? [null];
        bMon.pp[c.slot] = c.pp;
      }
    }
    // pokefirered/src/pokemon.c:3976
    if (e!.friendship) {
      Pokemon.itemFriendship(mon, e!.friendship, { mapSec: Pokemon.currentMapSec(session) });
    }
    return true;
  },

  // Lua: item_use.lua:844
  useEvolutionStone(session: any, mon: any, itemId: any, bag: any): UseResult {
    const target = Evolution.itemTarget ? Evolution.itemTarget(mon, itemId, session) : undefined;
    if (!target) {
      return [false, "no_evo", wont_have_effect()];
    }
    const oldName = Pokemon.displayMonName(mon);
    const newName = Pokemon.name(target);

    let Ev: any = null;
    try { Ev = EvolutionScene; } catch { Ev = null; }
    if (Ev && Ev.start) {
      Ev.start(mon, target, {
        canStop: false,
        session,
        bag,
        savedSong: Audio._mapSong,
        via: "item",
      });
      return [true, "evo", null];
    } else {
      Evolution.apply(mon, target, session, bag, "item");
      // src/evolution_scene.c:775
      const t = RomText.box("gText_CongratsPkmnEvolved", { stringVars: seq(oldName, newName) });
      return [true, "evo", t];
    }
  },

  // Lua: item_use.lua:907 -- pokefirered/src/item_use.c:159 SetUpItemUseOnFieldCallback
  exitMenusToField(): boolean {
    let closed = false;
    const BM: any = BagMenu;
    if (BM && BM.isOpen && BM.isOpen() && BM.close) {
      BM.close();
      closed = true;
    }
    const SM: any = StartMenu;
    if (SM && SM.isOpen && SM.isOpen()) {
      SM.open = false;
      SM._onClose = null;
      if (Stack && (Stack as any).pop) (Stack as any).pop("start");
      closed = true;
    }
    if (closed) {
      const F: any = Fade;
      if (F && F.begin && F.MODE) {
        F.begin(F.MODE.FROM_BLACK, 1);
      }
    }
    return closed;
  },

  // Lua: item_use.lua:932 -- pokefirered/src/item_use.c:159 SetUpItemUseOnFieldCallback
  setUpOnFieldCallback(cb: () => void): boolean {
    const BM: any = BagMenu;
    if (!(BM && BM.isOpen && BM.isOpen())) return false;
    ItemUse._onFieldCB = cb;
    return true;
  },

  // Lua: item_use.lua:940 -- pokefirered/src/item_use.c:176 Task_WaitFadeIn_CallItemUseOnFieldCB
  runOnFieldCallback(): boolean {
    const cb = ItemUse._onFieldCB;
    ItemUse._onFieldCB = null;
    if (cb) cb();
    return cb != null;
  },

  // Lua: item_use.lua:948 -- pokefirered/src/item_use.c:182 DisplayItemMessageInCurrentContext
  showFieldMessage(text: any, onDone?: () => void): boolean {
    if (!truthy(text)) return false;
    // pokefirered/src/item_menu.c:1018 DisplayItemMessageInBag
    const BM: any = BagMenu;
    if (BM && BM.isOpen && BM.isOpen() && BM.showMessage) {
      BM.showMessage(text, onDone);
      return true;
    }
    // pokefirered/src/new_menu_helpers.c:641 DisplayItemMessageOnField
    if (!(Message && Message.show)) return false;
    Message.show(text, { done: onDone } as any);
    return true;
  },

  // Lua: item_use.lua:964 -- pokefirered/src/item_use.c:296 CanFish
  canFish(): boolean {
    const P: any = Player;
    const C: any = Collision;
    const DELTA: Record<string, [null, number, number]> = { up: [null, 0, -1], down: [null, 0, 1], left: [null, -1, 0], right: [null, 1, 0] };
    const d = DELTA[P.facing ?? "down"] ?? DELTA.down;
    const fx = P.cellX + d[1], fy = P.cellY + d[2];
    const beh = C.behavior ? C.behavior(fx, fy) : undefined;
    if (FieldMoves.isWaterfallBehavior(beh)) return false;
    if (!truthy(P.surfing)) {
      // pokefirered/src/field_player_avatar.c:1209 IsPlayerFacingSurfableFishableWater
      return (C.isWater && C.isWater(fx, fy)) === true;
    }
    return (C.isSurfable && C.isSurfable(beh)) === true
      && C.isWater(fx, fy) === true;
  },

  // Lua: item_use.lua:982 -- pokefirered/src/item_use.c:286 FieldUseFunc_Rod
  useRod(session: any, id: any): UseResult {
    if (!ItemUse.canFish()) {
      // pokefirered/src/item_use.c:294 PrintNotTheTimeToUseThat
      const text = not_the_time(session);
      return [false, "rod", text];
    }
    const info: any = ItemsData.info(id);
    // pokefirered/src/item_use.c:326 ItemUseOnFieldCB_Rod
    Field.startFishing(tonumber(info ? info.secondaryId : undefined) ?? 0);
    return [true, "rod", null];
  },

  // Lua: item_use.lua:996 -- pokefirered/src/item_use.c:359 FieldUseFunc_PokeFlute
  usePokeFlute(session: any): UseResult {
    let woke = false;
    for (const [, mon] of ipairs<any>((session && session.party) || [null])) {
      const isEgg = truthy(mon.isEgg) || (typeof mon.egg === "boolean" && mon.egg);
      if (!isEgg && ItemUse.clearStatus(mon, ITEM_AWAKENING)[0]) woke = true;
    }
    if (!woke) {
      // src/item_use.c:381
      return [true, "flute", RomText.box("gText_PlayedPokeFluteCatchy")];
    }
    try {
      const A: any = Audio;
      if (A && A.playFanfare) A.playFanfare(MUS_POKE_FLUTE);
    } catch { /* pcall */ }
    // src/item_use.c:374, :398
    const text = RomText.box("gText_PlayedPokeFlute") + "\f" + RomText.box("gText_PokeFluteAwakenedMon");
    return [true, "flute", text];
  },

  // Lua: item_use.lua:1016 -- pokefirered/src/item_use.c:582 FieldUseFunc_BlackWhiteFlute
  useBlackWhiteFlute(session: any, num: any): UseResult {
    const ctx = {
      playerName: tostring((session && (session.name ?? session.playerName)) ?? ""),
      stringVars: { [2]: ItemsData.displayName(num) },
    };
    let text: string;
    if (num === ITEM_WHITE_FLUTE) {
      sys_flag(session, FieldMoves.SYS_FLAGS.WHITE_FLUTE_ACTIVE, true);
      sys_flag(session, FieldMoves.SYS_FLAGS.BLACK_FLUTE_ACTIVE, false);
      // pokefirered/src/item_use.c:590
      text = RomText.box("gText_UsedVar2WildLured", ctx);
    } else {
      sys_flag(session, FieldMoves.SYS_FLAGS.BLACK_FLUTE_ACTIVE, true);
      sys_flag(session, FieldMoves.SYS_FLAGS.WHITE_FLUTE_ACTIVE, false);
      // pokefirered/src/item_use.c:599
      text = RomText.box("gText_UsedVar2WildRepelled", ctx);
    }
    return [true, "black_white_flute", text];
  },

  // Lua: item_use.lua:1038 -- pokefirered/src/item_use.c:605 Task_UsedBlackWhiteFlute
  BLACK_WHITE_FLUTE_DELAY: 8,

  // Lua: item_use.lua:1040
  playBlackWhiteFlute(): void {
    // pokefirered/include/constants/songs.h:114
    play_se(SE.SE_GLASS_FLUTE);
  },

  // Lua: item_use.lua:1287
  useField(session: any, bag: any, id: any, partySlot?: number, moveSlot?: number): UseResult {
    let ok: any, kind: any, text: any;
    if (ModRuntime.wantsHook("item.use")) {
      [ok, kind, text] = ModRuntime.call("item.use", (_a: any, _b: any, hid: any, hslot: any) => {
        return useField(session, bag, hid, hslot, moveSlot);
      }, Runtime ? Runtime._game : undefined, null, id, partySlot, bag);
    } else {
      [ok, kind, text] = useField(session, bag, id, partySlot, moveSlot);
    }
    if (truthy(ok) && kind !== "tm" && kind !== "tm_case" && kind !== "berry_pouch" && kind !== "vs_seeker") {
      const mon = partySlot && session && session.party ? session.party[partySlot] : null;
      QuestLogRecorder.event(session,
        mon ? "UsedItemOnMonAtThisLocation" : "UsedTheItem",
        seq(Items.displayName(id), mon ? Pokemon.displayMonName(mon) : null));
    }
    return [ok, kind, text];
  },
};

export default ItemUse;
