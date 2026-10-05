// Port of gen1recomp src/core/game3/battle/pokedude.lua (GPLv3 + additional terms; see LICENSE.md).
// Teachy TV's Poké Dude battles (pokefirered/src/battle_controller_pokedude.c):
// scripted parties, simulated input and the voiceover script.
//
// Port notes:
// - Lua tables keyed by battler side / script id (PLAYER = 0, OPPONENT = 1,
//   TTVSCR_* = 0..3) are plain objects with those integer keys; lists are
//   lt.ts sequences.
// - Multiple returns are 0-based tuples: sendOutOrigin -> [x, y];
//   build -> [party, foes]. Battle.start returns [true] / [null, err].
//   BattleItems.use returns a tuple; open_item_party uses its first value.
// - Lazy requires and `package.loaded[...]` probes (runtime, bag_menu,
//   start_menu) are static imports: every module is in the bundle, so each
//   probe reads the module. HIDDEN_MENUS maps Brian's module names to them.
// - create_mon draws gameplay RNG (core/rng.ts Random32, i.e. two Random()
//   calls per try) until nature and gender match, as pret does.
// - BattleBg.TERRAIN and BattleTransition.ID are metatable accessors in the
//   Lua (bg.lua / battle_transition.lua); this module reads them as plain
//   properties, so those ports must expose them.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, tostring, truthy } from "../../../../import/gen3/lua.ts";
import { seq, len, ipairs, pairs, type LuaTable } from "../../platform/lt.ts";
import RomText from "../rom_text.ts";
import Pokemon from "../pokemon.ts";
import Rng from "../rng.ts";
import SummaryData from "../summary_data.ts";
import BattleText from "./battle_text.ts";
import Ui from "./ui.ts";
import Audio from "../audio.ts";
import Commands from "./commands.ts";
import SE from "../se_ids.ts";
import Runtime from "../runtime.ts";
import Battle from "../battle.ts";
import PartyMenu from "../../ui/party_menu.ts";
import BagMenu from "../../ui/bag_menu.ts";
import StartMenu from "../../ui/start_menu.ts";
import State from "./state.ts";
import BattleItems from "./items.ts";
import Stack from "../../ui/stack.ts";
import TeachyTv from "../teachy_tv.ts";
import BattleBg from "./bg.ts";
import BattleTransition from "../battle_transition.ts";

/** Lua `a or b` (b already evaluated). */
function lor<A, B>(a: A, b: B): A | B {
  return truthy(a) ? a : b;
}

/** Lua `a and b` (b already evaluated). */
function land<A, B>(a: A, b: B): A | B {
  return truthy(a) ? b : a;
}

/** Lua `a ~= b` for values that may be nil (null and undefined are both nil). */
function neq(a: unknown, b: unknown): boolean {
  return a == null ? b != null : a !== b;
}

export interface PokedudeRow { cursor: Record<number, number>; delay: Record<number, number> }
export interface PokedudeVo { cmd: string; side: number; stringId: string | undefined; kind: string | undefined }
export interface PokedudeMonInfo { side: number; level: number; species: number; moves: LuaTable; nature: number; gender: number }

export interface PokedudeBattlerState {
  actionIdx: number; moveIdx: number; timer: number; actionCursor: number; moveCursor: number;
}

export interface PokedudeState {
  script: number;
  messageNo: number;
  battlers: Record<number, PokedudeBattlerState>;
  log: LuaTable;
  step?: string | null;
  choice?: number;
  menu?: string | null;
  menuCmd?: any;
}

export interface PokedudeModule {
  OUTCOME: { WON: number; LOST: number; DREW: number; RAN: number; CAUGHT: number };
  BACK_PIC: number;
  sendOutOrigin(st: any): [number, number];
  PARTIES: Record<number, LuaTable>;
  TEXT_SCRIPTS: Record<number, LuaTable>;
  TEXT_TABLES: Record<number, string>;
  textKey(script: any, index0: number): string;
  build(scriptId: any): [LuaTable, LuaTable];
  newState(scriptId: any): PokedudeState;
  textFor(st: any, index0: number): string;
  event(st: any, cmd: string, side: any, stringId?: any): boolean;
  enemyAction(st: any): any;
  autoPlayerAction(st: any): any;
  commandStep(st: any, Ui: any, input?: any): any;
  startTeachyTvBattle(session: any, scriptId: any, opts?: any): boolean;
}

export const Pokedude = {} as PokedudeModule;

const PLAYER = 0;
const OPPONENT = 1;

// pokefirered/include/teachy_tv.h:4
const TTVSCR_BATTLE = 0;
const TTVSCR_STATUS = 1;
const TTVSCR_MATCHUPS = 2;
const TTVSCR_CATCHING = 3;

// pokefirered/include/constants/battle.h:78
Pokedude.OUTCOME = { WON: 1, LOST: 2, DREW: 3, RAN: 4, CAUGHT: 7 };

// pokefirered/include/constants/items.h:7
const ITEM_POKE_BALL = 4;
const ITEM_ANTIDOTE = 14;

// pokefirered/include/constants/trainers.h:175
Pokedude.BACK_PIC = 4;

// pokefirered/src/pokeball.c:389
// Lua: pokedude.lua:19
Pokedude.sendOutOrigin = function (st: any): [number, number] {
  if (truthy(st) && truthy(st.pokedude)) return [32, 64];
  return [48, 70];
};

// pokefirered/src/battle_controller_pokedude.c:2326 sParties_Battle
Pokedude.PARTIES = {
  [TTVSCR_BATTLE]: seq<PokedudeMonInfo>(
    { side: PLAYER, level: 15, species: 19, moves: seq(33, 39, 158, 98), nature: 1, gender: 0 },
    { side: OPPONENT, level: 18, species: 16, moves: seq(33, 28, 16, 98), nature: 4, gender: 0 },
  ),
  // pokefirered/src/battle_controller_pokedude.c:2347 sParties_Status
  [TTVSCR_STATUS]: seq<PokedudeMonInfo>(
    { side: PLAYER, level: 15, species: 19, moves: seq(33, 39, 158, 98), nature: 1, gender: 0 },
    { side: OPPONENT, level: 14, species: 43, moves: seq(71, 230, 77), nature: 19, gender: 0 },
  ),
  // pokefirered/src/battle_controller_pokedude.c:2368 sParties_Matchups
  [TTVSCR_MATCHUPS]: seq<PokedudeMonInfo>(
    { side: PLAYER, level: 15, species: 60, moves: seq(55, 95, 145), nature: 19, gender: 0 },
    { side: PLAYER, level: 15, species: 12, moves: seq(93, 77, 78, 79), nature: 19, gender: 0 },
    { side: OPPONENT, level: 14, species: 43, moves: seq(71, 230, 77), nature: 19, gender: 0 },
  ),
  // pokefirered/src/battle_controller_pokedude.c:2397 sParties_Catching
  [TTVSCR_CATCHING]: seq<PokedudeMonInfo>(
    { side: PLAYER, level: 15, species: 12, moves: seq(93, 77, 79, 78), nature: 19, gender: 0 },
    { side: OPPONENT, level: 11, species: 39, moves: seq(47, 111, 1), nature: 23, gender: 0 },
  ),
};

// Lua: pokedude.lua:48
function row(p: number, o: number, dp: number, dop: number): PokedudeRow {
  return { cursor: { [PLAYER]: p, [OPPONENT]: o }, delay: { [PLAYER]: dp, [OPPONENT]: dop } };
}

// pokefirered/src/battle_controller_pokedude.c:2002 sInputScripts_ChooseAction_Battle
const ACTION_ROWS: LuaTable = seq(
  row(0, 0, 64, 0), row(4, 4, 0, 0),
  row(0, 0, 64, 0), row(1, 0, 64, 0), row(0, 0, 64, 0),
  row(0, 0, 64, 0), row(2, 0, 64, 0), row(0, 0, 64, 0),
  row(0, 0, 64, 0), row(0, 0, 64, 0), row(1, 0, 64, 0),
);
const ACTION_BASE: Record<number, number> = { [TTVSCR_BATTLE]: 0, [TTVSCR_STATUS]: 2, [TTVSCR_MATCHUPS]: 5, [TTVSCR_CATCHING]: 8 };

// pokefirered/src/battle_controller_pokedude.c:2070 sInputScripts_ChooseMove_Battle
const MOVE_ROWS: Record<number, LuaTable> = {
  [TTVSCR_BATTLE]: seq(row(2, 2, 64, 0), row(255, 255, 0, 0)),
  [TTVSCR_STATUS]: seq(row(2, 2, 64, 0), row(2, 0, 64, 0), row(2, 0, 64, 0), row(255, 255, 0, 0)),
  [TTVSCR_MATCHUPS]: seq(row(2, 0, 64, 0), row(0, 0, 64, 0), row(0, 0, 64, 0), row(255, 255, 0, 0)),
  [TTVSCR_CATCHING]: seq(row(0, 2, 64, 0), row(2, 2, 64, 0), row(255, 255, 0, 0)),
};

// Lua: pokedude.lua:69
function vo(cmd: string, side: number, stringId: string | undefined, kind: string | undefined): PokedudeVo {
  return { cmd: cmd, side: side, stringId: stringId, kind: kind };
}

// pokefirered/src/battle_controller_pokedude.c:2146 sPokedudeTextScripts_Battle
Pokedude.TEXT_SCRIPTS = {
  [TTVSCR_BATTLE]: seq(
    vo("chooseaction", PLAYER, undefined, "voiceover"),
    vo("printstring", OPPONENT, "STRINGID_USEDMOVE", "voiceover"),
    vo("chooseaction", PLAYER, undefined, "voiceover"),
    vo("printstring", PLAYER, "STRINGID_PKMNGAINEDEXP", "voiceover"),
  ),
  [TTVSCR_STATUS]: seq(
    vo("chooseaction", PLAYER, undefined, undefined),
    vo("chooseaction", PLAYER, undefined, "healthbox"),
    vo("openbag", PLAYER, undefined, "voiceover"),
    vo("printstring", OPPONENT, "STRINGID_USEDMOVE", "voiceover"),
    vo("printstring", PLAYER, "STRINGID_PKMNGAINEDEXP", "voiceover"),
  ),
  [TTVSCR_MATCHUPS]: seq(
    vo("printstring", OPPONENT, "STRINGID_USEDMOVE", "voiceover"),
    vo("chooseaction", PLAYER, undefined, "voiceover"),
    vo("choosepokemon", PLAYER, undefined, "voiceover"),
    vo("printstring", OPPONENT, "STRINGID_USEDMOVE", "voiceover"),
    vo("chooseaction", PLAYER, undefined, "voiceover"),
    vo("choosemove", PLAYER, undefined, "voiceover"),
    vo("printstring", PLAYER, "STRINGID_PKMNGAINEDEXP", "voiceover"),
  ),
  [TTVSCR_CATCHING]: seq(
    vo("chooseaction", PLAYER, undefined, "voiceover"),
    vo("chooseaction", PLAYER, undefined, undefined),
    vo("chooseaction", PLAYER, undefined, "voiceover"),
    vo("printstring", OPPONENT, "STRINGID_PKMNFASTASLEEP", "voiceover"),
    vo("openbag", PLAYER, undefined, "voiceover"),
    vo("endlinkbattle", PLAYER, undefined, "voiceover"),
  ),
};

// pokefirered/src/battle_controller_pokedude.c:2288
Pokedude.TEXT_TABLES = {
  [TTVSCR_BATTLE]: "sPokedudeTexts_Battle",
  [TTVSCR_STATUS]: "sPokedudeTexts_Status",
  [TTVSCR_MATCHUPS]: "sPokedudeTexts_TypeMatchup",
  [TTVSCR_CATCHING]: "sPokedudeTexts_Catching",
};

// Lua: pokedude.lua:115
Pokedude.textKey = function (script: any, index0: number): string {
  // require("src.core.game3.rom_text")
  const table = Pokedude.TEXT_TABLES[script];
  if (!truthy(table)) throw new Error("no pokedude text table");
  return RomText.key(table, index0);
};

// pokefirered/src/item_menu.c:2262 Task_Bag_TeachyTvCatching
const BAG_ITEM: Record<number, number> = { [TTVSCR_STATUS]: ITEM_ANTIDOTE, [TTVSCR_CATCHING]: ITEM_POKE_BALL };

// pokefirered/include/constants/songs.h:306
const MUS_VS_WILD = 298;
// pokefirered/include/constants/songs.h:319
const MUS_VICTORY_WILD = 311;

const SIDE_OF: Record<string | number, number> = { player: PLAYER, enemy: OPPONENT, [PLAYER]: PLAYER, [OPPONENT]: OPPONENT };

// pokefirered/src/battle_message.c:1693
const STRING_ALIAS: Record<string | number, string> = { sText_AttackerUsedX: "STRINGID_USEDMOVE", [4]: "STRINGID_USEDMOVE" };

// pokefirered/src/pokemon.c:1877 CreateMonWithGenderNatureLetter
// Lua: pokedude.lua:134
function create_mon(info: PokedudeMonInfo): any {
  // require pokemon, rng, summary_data
  const want = (info.gender === 0) ? "M" : "F";
  let personality: number;
  do {
    personality = Rng.Random32();
  } while (!(Pokemon.natureId(personality) === info.nature && Pokemon.gender(info.species, personality) === want));
  const moves: LuaTable = seq();
  const pp: LuaTable = seq();
  const maxPp: LuaTable = seq();
  // pokefirered/src/battle_controller_pokedude.c:2696 SetMonMoveSlot
  for (let j = 1; j <= 4; j++) {
    const mv = info.moves[j];
    if (truthy(mv) && mv !== 0) {
      moves[len(moves) + 1] = mv;
      pp[len(pp) + 1] = Pokemon.movePp(mv);
      maxPp[len(maxPp) + 1] = Pokemon.movePp(mv);
    }
  }
  const growthRate = Pokemon.growthRate(info.species);
  const ability = Pokemon.abilityId(info.species, personality);
  const meta = Pokemon.speciesMeta(info.species);
  // pokefirered/src/pokemon.c:1904 CreateMon
  const mon: any = {
    species: info.species,
    speciesId: info.species,
    speciesNumbering: Pokemon.NUMBERING_INTERNAL,
    name: Pokemon.name(info.species),
    nickname: "",
    level: info.level,
    metLevel: info.level,
    growthRate: growthRate,
    exp: SummaryData.expForLevel(growthRate, info.level),
    moves: moves,
    pp: pp,
    maxPp: maxPp,
    personality: personality,
    nature: info.nature,
    ivs: { hp: 0, atk: 0, def: 0, spe: 0, spa: 0, spd: 0 },
    evs: { hp: 0, atk: 0, def: 0, spe: 0, spa: 0, spd: 0 },
    ability: ability,
    abilityId: ability,
    gender: want,
    item: 0,
    friendship: lor(land(meta, meta?.friendship), 70),
    happiness: lor(land(meta, meta?.friendship), 70),
    pokeball: ITEM_POKE_BALL,
  };
  Pokemon.applyStats(mon);
  return mon;
}

// pokefirered/src/battle_controller_pokedude.c:2675 InitPokedudePartyAndOpponent
// Lua: pokedude.lua:187
Pokedude.build = function (scriptId: any): [LuaTable, LuaTable] {
  const rows = Pokedude.PARTIES[tonumber(scriptId) as number];
  if (!truthy(rows)) throw new Error("no pokedude party for script " + tostring(scriptId));
  const party: LuaTable = seq();
  const foes: LuaTable = seq();
  for (const [, info] of ipairs<PokedudeMonInfo>(rows)) {
    const mon = create_mon(info);
    if (info.side === PLAYER) party[len(party) + 1] = mon; else foes[len(foes) + 1] = mon;
  }
  return [party, foes];
};

// Lua: pokedude.lua:198
Pokedude.newState = function (scriptId: any): PokedudeState {
  return {
    script: tonumber(scriptId) ?? TTVSCR_BATTLE,
    messageNo: 0,
    battlers: {
      [PLAYER]: { actionIdx: 0, moveIdx: 0, timer: 0, actionCursor: 0, moveCursor: 0 },
      [OPPONENT]: { actionIdx: 0, moveIdx: 0, timer: 0, actionCursor: 0, moveCursor: 0 },
    },
    log: seq(),
  };
};

// Lua: pokedude.lua:210
Pokedude.textFor = function (st: any, index0: number): string {
  // require("src.core.game3.battle.battle_text")
  return BattleText.get(Pokedude.textKey(st.pd.script, index0), { playerName: st.playerName });
};

// Lua: pokedude.lua:215
function push_voiceover(st: any, index0: number, entry: PokedudeVo, onDone?: () => void): void {
  // require("src.core.game3.battle.ui")
  const text = Pokedude.textFor(st, index0);
  st.pd.log[len(st.pd.log) + 1] = Pokedude.textKey(st.pd.script, index0);
  Ui.markVoiceover(text, { litHealthbox: entry.kind === "healthbox" });
  Ui.push(text, () => {
    // pokefirered/src/battle_controller_pokedude.c:2573 msg_idx == STRINGID_PKMNGAINEDEXP
    if (entry.stringId === "STRINGID_PKMNGAINEDEXP") {
      // require("src.core.game3.audio")
      Audio.playSong(MUS_VICTORY_WILD);
    }
    if (truthy(onDone)) onDone!();
  });
}

// pokefirered/src/battle_controller_pokedude.c:2508 HandlePokedudeVoiceoverEtc
// Lua: pokedude.lua:231
Pokedude.event = function (st: any, cmd: string, sideIn: any, stringIdIn?: any): boolean {
  const pd = land(st, st?.pd);
  if (!truthy(pd)) return false;
  const side = sideIn == null ? undefined : SIDE_OF[sideIn];
  const stringId = lor(stringIdIn == null ? undefined : STRING_ALIAS[stringIdIn], stringIdIn);
  const script = lor(Pokedude.TEXT_SCRIPTS[pd.script], seq());
  let queued = false;
  while (true) {
    const entry: PokedudeVo | undefined = script[pd.messageNo + 1];
    if (!truthy(entry) || entry!.cmd !== cmd || neq(entry!.side, side)) break;
    if (cmd === "printstring" && neq(entry!.stringId, stringId)) break;
    const index0 = pd.messageNo;
    pd.messageNo = pd.messageNo + 1;
    if (!truthy(entry!.kind)) break;
    push_voiceover(st, index0, entry!);
    queued = true;
  }
  return queued;
};

// Lua: pokedude.lua:251
function action_row(pd: PokedudeState, idx: number): PokedudeRow | undefined {
  return ACTION_ROWS[ACTION_BASE[pd.script] + idx + 1];
}

// Lua: pokedude.lua:255
function move_row(pd: PokedudeState, idx: number): PokedudeRow | undefined {
  return MOVE_ROWS[pd.script][idx + 1];
}

// pokefirered/src/battle_controller_pokedude.c:2459
// Lua: pokedude.lua:260
function take_action(pd: PokedudeState, side: number): number {
  const b = pd.battlers[side];
  const r = action_row(pd, b.actionIdx)!;
  b.actionIdx = b.actionIdx + 1;
  const nxt = action_row(pd, b.actionIdx);
  if (truthy(nxt) && nxt!.cursor[side] === 4) b.actionIdx = 0;
  return r.cursor[side];
}

// pokefirered/src/battle_controller_pokedude.c:2490
// Lua: pokedude.lua:270
function take_move(pd: PokedudeState, side: number): number {
  const b = pd.battlers[side];
  const r = move_row(pd, b.moveIdx)!;
  b.moveIdx = b.moveIdx + 1;
  if (move_row(pd, b.moveIdx)!.cursor[side] === 255) b.moveIdx = 0;
  return r.cursor[side];
}

// pokefirered/src/battle_controller_pokedude.c:2429 PokedudeSimulateInputChooseAction
// Lua: pokedude.lua:279
Pokedude.enemyAction = function (st: any): any {
  const pd = st.pd;
  const choice = take_action(pd, OPPONENT);
  const mon = lor(land(st.enemy, st.enemy?.mon), {});
  let slot = 1;
  if (choice === 0) {
    slot = take_move(pd, OPPONENT) + 1;
  }
  let mv = land(mon.moves, mon.moves?.[slot]);
  if (!truthy(mv) || mv === 0) {
    slot = 1;
    mv = land(mon.moves, mon.moves?.[1]);
  }
  return { kind: "move", move: mv, slot: slot, user: "enemy" };
};

// Lua: pokedude.lua:292
function action_command(st: any, choice: number, moveSlot?: number): any {
  const pd = st.pd;
  if (choice === 1) {
    return { kind: "bag", user: "player", itemId: BAG_ITEM[pd.script] ?? ITEM_POKE_BALL,
      partySlot: lor(land(st.player, st.player?.partyIndex), 1) };
  } else if (choice === 2) {
    // pokefirered/src/party_menu.c:2020 Task_PartyMenu_Pokedude
    return { kind: "switch", user: "player", slot: (truthy(st.player) && st.player.partyIndex === 2) ? 1 : 2 };
  } else if (choice === 3) {
    return { kind: "run", user: "player" };
  }
  // require("src.core.game3.battle.commands")
  return Commands.playerAction(st, 1, lor(moveSlot, 1));
}

// Lua: pokedude.lua:307
Pokedude.autoPlayerAction = function (st: any): any {
  const pd = st.pd;
  Pokedude.event(st, "chooseaction", PLAYER);
  const choice = take_action(pd, PLAYER);
  if (choice === 0) {
    Pokedude.event(st, "choosemove", PLAYER);
    return action_command(st, 0, take_move(pd, PLAYER) + 1);
  } else if (choice === 1) {
    Pokedude.event(st, "openbag", PLAYER);
  } else if (choice === 2) {
    Pokedude.event(st, "choosepokemon", PLAYER);
  }
  return action_command(st, choice);
};

// Lua: pokedude.lua:322
function select_se(): void {
  // require audio, se_ids
  Audio.playSe(SE.SE_SELECT);
}

// Lua: pokedude.lua:328
function menu_session(UiM: any): any {
  // package.loaded["src.core.game3.runtime"]
  const R = Runtime;
  if (truthy(UiM._session)) return UiM._session;
  return (truthy(R) && truthy(R.getSession)) ? R.getSession() : undefined;
}

// Lua: pokedude.lua:333
function menu_cancel(pd: PokedudeState): void {
  pd.menu = undefined;
  pd.step = "menu_cancelled";
  // require("src.core.game3.battle")
  Battle.quitPokedude();
}

const QUIET_ADAPTER = { say: function (): void { /* quiet */ } };

// pokefirered/src/party_menu.c:5866 Pokedude_ChooseMonForInBattleItem
// Lua: pokedude.lua:342
function open_item_party(st: any, UiM: any, itemId: any): void {
  const pd = st.pd;
  // require party_menu, state
  const session = menu_session(UiM);
  if (truthy(st.player) && truthy(st.playerParty)) State.syncBattlerToParty(st.player, st.playerParty);
  pd.menu = "party";
  PartyMenu.showPokedude(st.playerParty, {
    plan: "item",
    session: session,
    bag: land(session, session?.bag),
    item: itemId,
    battleOrder: PartyMenu.battleOrder(st),
    activeSlot: lor(land(st.player, st.player?.partyIndex), 1),
    onUse: (slot: number) => {
      // require battle.items, rom_text, pokemon
      const mon = st.playerParty[slot];
      const result = BattleItems.use(st, QUIET_ADAPTER, land(session, session?.bag), session, itemId, slot)[0];
      if (result !== "heal") return RomText.box("gText_WontHaveEffect", { maxWidth: 216 });
      // pokefirered/src/party_menu.c:4345
      return RomText.box("gText_PkmnCuredOfPoison", { stringVars: seq(Pokemon.displayMonName(mon)), maxWidth: 216 });
    },
    onSelect: (slot: number) => {
      pd.menu = undefined;
      pd.menuCmd = { kind: "bag", user: "player", itemId: itemId, partySlot: slot, pokedudeUsed: true };
    },
    onCancel: () => { menu_cancel(pd); },
  });
}

// pokefirered/src/battle_controller_pokedude.c:376 CompleteWhenChoseItem
// Lua: pokedude.lua:375
function open_bag(st: any, UiM: any): void {
  const pd = st.pd;
  // require("src.ui.game3.bag_menu")
  const session = menu_session(UiM);
  const plan = (pd.script === TTVSCR_STATUS) ? "status" : "catching";
  pd.menu = "bag";
  UiM._mode = "bag";
  BagMenu.showPokedude(land(session, session?.bag), {
    session: session,
    plan: plan,
    onItem: (itemId: any) => {
      UiM._mode = "none";
      if (plan === "status") {
        // pokefirered/src/item_menu.c:2351 ItemMenu_SetExitCallback(Pokedude_ChooseMonForInBattleItem)
        open_item_party(st, UiM, itemId);
        return;
      }
      pd.menu = undefined;
      pd.menuCmd = { kind: "bag", user: "player", itemId: itemId };
    },
    onCancel: () => {
      UiM._mode = "none";
      menu_cancel(pd);
    },
  });
}

// pokefirered/src/party_menu.c:5859 Pokedude_OpenPartyMenuInBattle
// Lua: pokedude.lua:403
function open_switch_party(st: any, UiM: any): void {
  const pd = st.pd;
  // require party_menu, state, commands
  if (truthy(st.player) && truthy(st.playerParty)) State.syncBattlerToParty(st.player, st.playerParty);
  pd.menu = "party";
  UiM._mode = "party";
  PartyMenu.showPokedude(st.playerParty, {
    plan: "switch",
    session: menu_session(UiM),
    activeSlot: lor(land(st.player, st.player?.partyIndex), 1),
    validate: (slot: number) => Commands.switchError(st, slot),
    onSelect: (slot: number) => {
      UiM._mode = "none";
      pd.menu = undefined;
      pd.menuCmd = { kind: "switch", user: "player", slot: slot };
    },
    onCancel: () => {
      UiM._mode = "none";
      menu_cancel(pd);
    },
  });
}

// Lua: pokedude.lua:428
function open_menu(st: any, UiM: any, choice: number): any {
  if (truthy(UiM._headless)) return action_command(st, choice);
  st.pd.step = "menu";
  if (choice === 1) open_bag(st, UiM); else open_switch_party(st, UiM);
  return undefined;
}

const NO_INPUT = { wasPressed: (): boolean => false, isDown: (): boolean => false };

// Lua: pokedude.lua:437
function menu_step(st: any, UiM: any, input: any): any {
  const pd = st.pd;
  if (truthy(pd.menuCmd)) {
    const cmd = pd.menuCmd;
    pd.menuCmd = undefined;
    pd.step = undefined;
    return cmd;
  }
  if (pd.menu === "bag") {
    // require("src.ui.game3.bag_menu")
    BagMenu.handleInput(lor(input, NO_INPUT));
  } else if (pd.menu === "party") {
    // require("src.ui.game3.party_menu")
    if (truthy(PartyMenu.isOpen())) PartyMenu.handleInput(lor(input, NO_INPUT));
  }
  if (truthy(pd.menuCmd)) return menu_step(st, UiM, input);
  return undefined;
}

// pokefirered/src/battle_controller_pokedude.c:2429 PokedudeSimulateInputChooseAction
// pokefirered/src/battle_controller_pokedude.c:2477 PokedudeSimulateInputChooseMove
// Lua: pokedude.lua:457
Pokedude.commandStep = function (st: any, UiM: any, input?: any): any {
  const pd: PokedudeState = st.pd;
  const b = pd.battlers[PLAYER];
  let step = pd.step;
  if (step === "menu") return menu_step(st, UiM, input);
  if (step === "menu_cancelled") return undefined;
  if (step == null) {
    UiM._mode = "none";
    if (Pokedude.event(st, "chooseaction", PLAYER)) {
      pd.step = "vo_action";
      return undefined;
    }
    step = "open_action";
  }
  if (step === "vo_action" || step === "vo_move" || step === "vo_bag" || step === "vo_party") {
    if (!truthy(UiM.pump())) return undefined;
    if (step === "vo_action") step = "open_action";
    else if (step === "vo_move") step = "open_move";
    else {
      pd.step = undefined;
      return open_menu(st, UiM, pd.choice as number);
    }
  }
  if (step === "open_action") {
    UiM.openMenu();
    UiM._menuIndex = b.actionCursor + 1;
    b.timer = 0;
    pd.step = "action";
    return undefined;
  }
  if (step === "open_move") {
    UiM._mode = "moves";
    UiM._moveIndexBattler = st.player;
    UiM._moveIndex = b.moveCursor + 1;
    b.timer = 0;
    pd.step = "move";
    return undefined;
  }
  UiM.tick();
  if (step === "action") {
    const r = action_row(pd, b.actionIdx)!;
    const target = r.cursor[PLAYER];
    const delay = r.delay[PLAYER];
    if (delay === b.timer) {
      select_se();
      b.timer = 0;
      const choice = take_action(pd, PLAYER);
      pd.choice = choice;
      if (choice === 0) {
        UiM._mode = "none";
        if (Pokedude.event(st, "choosemove", PLAYER)) {
          pd.step = "vo_move";
          return undefined;
        }
        pd.step = "open_move";
        return undefined;
      }
      UiM._mode = "none";
      const cmd = (choice === 1 && "openbag") || (choice === 2 && "choosepokemon") || undefined;
      if (truthy(cmd) && Pokedude.event(st, cmd as string, PLAYER)) {
        pd.step = (choice === 1) ? "vo_bag" : "vo_party";
        return undefined;
      }
      pd.step = undefined;
      if (truthy(cmd)) return open_menu(st, UiM, choice);
      return action_command(st, choice);
    }
    if (b.actionCursor !== target && Math.floor(delay / 2) === b.timer) {
      select_se();
      b.actionCursor = target;
      UiM._menuIndex = target + 1;
    }
    b.timer = b.timer + 1;
    return undefined;
  }
  if (step === "move") {
    const r = move_row(pd, b.moveIdx)!;
    const target = r.cursor[PLAYER];
    const delay = r.delay[PLAYER];
    if (delay === b.timer) {
      select_se();
      b.timer = 0;
      const slot = take_move(pd, PLAYER) + 1;
      pd.step = undefined;
      UiM._mode = "none";
      return action_command(st, 0, slot);
    }
    if (b.moveCursor !== target && Math.floor(delay / 2) === b.timer) {
      select_se();
      b.moveCursor = target;
      UiM._moveIndex = target + 1;
    }
    b.timer = b.timer + 1;
    return undefined;
  }
  return undefined;
};

// Lua: pokedude.lua:553
function stack_module(): typeof Stack {
  // require("src.ui.game3.stack")
  return Stack;
}

const HIDDEN_MENUS: LuaTable = seq("src.ui.game3.bag_menu", "src.ui.game3.start_menu");
// package.loaded[name] for the HIDDEN_MENUS (both are in the bundle)
const LOADED: Record<string, any> = {
  "src.ui.game3.bag_menu": BagMenu,
  "src.ui.game3.start_menu": StartMenu,
};

// Lua: pokedude.lua:559
function hide_menus(saved: any): void {
  saved.menus = {};
  for (const [, name] of ipairs<string>(HIDDEN_MENUS)) {
    const mod = LOADED[name];
    if (truthy(mod) && truthy(mod.open)) {
      saved.menus[name] = true;
      mod.open = false;
    }
  }
}

// Lua: pokedude.lua:570
function show_menus(saved: any): void {
  for (const [name] of pairs(lor(saved.menus, {}))) {
    const mod = LOADED[name as string];
    if (truthy(mod)) mod.open = true;
  }
}

// Lua: pokedude.lua:577
function finish_battle(session: any, opts: any, saved: any, result: any): void {
  // require("src.core.game3.teachy_tv")
  // pokefirered/src/item_menu.c:2082 RestorePlayerBag
  TeachyTv.restorePlayerBag(session);
  const S = stack_module();
  S._layers = saved.layers;
  show_menus(saved);
  let outcome = Pokedude.OUTCOME.WON;
  if (result === "draw") outcome = Pokedude.OUTCOME.DREW;
  else if (result === "catch") outcome = Pokedude.OUTCOME.CAUGHT;
  else if (result === "lose") outcome = Pokedude.OUTCOME.LOST;
  else if (result === "run") outcome = Pokedude.OUTCOME.RAN;
  // pokefirered/src/teachy_tv.c:1207 TeachyTvRestorePlayerPartyCallback
  if (truthy(opts.onDone)) opts.onDone(outcome);
}

// pokefirered/src/teachy_tv.c:1172 TeachyTvPrepBattle
// Lua: pokedude.lua:594
Pokedude.startTeachyTvBattle = function (session: any, scriptId: any, optsIn?: any): boolean {
  const opts = optsIn ?? {};
  // require("src.core.game3.battle")
  if (Battle.isActive()) return false;
  const [party, foes] = Pokedude.build(scriptId);
  const saved: any = {};
  const start = (): void => {
    const S = stack_module();
    saved.layers = S._layers;
    S._layers = seq();
    // pokefirered/src/teachy_tv.c:1175 TeachyTvFree
    hide_menus(saved);
    // require("src.core.game3.teachy_tv")
    TeachyTv.initPokedudeBag(session, scriptId);
    // require("src.core.game3.battle.bg")
    const r: any[] = Battle.start({
      wild: true,
      pokedude: true,
      pdScriptNum: scriptId,
      playerParty: party,
      foe: foes[1],
      session: session,
      playerName: land(session, session?.name),
      playerGender: Pokedude.BACK_PIC,
      terrain: BattleBg.TERRAIN.GRASS,
      onDone: (result: any) => {
        finish_battle(session, opts, saved, result);
      },
    });
    const ok = r[0];
    const err = r[1];
    if (!truthy(ok)) {
      finish_battle(session, opts, saved, "draw");
      throw new Error("pokedude battle failed to start: " + tostring(err));
    }
  };
  if (truthy(opts.headless)) {
    start();
    return true;
  }
  // pokefirered/src/teachy_tv.c:1180 PlayMapChosenOrBattleBGM(MUS_DUMMY)
  // require("src.core.game3.audio")
  Audio.playSong(MUS_VS_WILD);
  // pokefirered/src/teachy_tv.c:1195 BattleTransition_StartOnField
  // require("src.core.game3.battle_transition")
  BattleTransition.start(truthy(opts.transition) ? opts.transition : BattleTransition.ID.SLICE,
    { overUi: true }, start);
  return true;
};

export default Pokedude;
