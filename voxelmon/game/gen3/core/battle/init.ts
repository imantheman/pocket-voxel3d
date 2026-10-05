// Port of gen1recomp src/core/game3/battle/init.lua (GPLv3 + additional terms; see LICENSE.md).
// Game3 owned battle engine entry.
// Anim VM + hit sequencer pace presentation; effects/residuals owned.
//
// Port notes:
// - require / package.loaded / pcall(require): every runtime module is in the
//   bundle, so each is a static import used exactly as Brian guards it.
//   package.loaded probes of UI screens (`M and M.isOpen and M.isOpen()`) go
//   through probeOpen(): a module that is still a stub cannot have been opened,
//   so its isOpen refusing (NotPortedError) reads as "not loaded / closed", as
//   objects.ts does with stubbed(). Hard requires call straight in (a stub
//   throws when reached).
// - Modules with no file in the port at all: package.loaded probes read nil
//   (src.ui.game3.stat_growth, src.ui.game3.rse.pyramid_bag); pcall(require)
//   fails (src.core.game3.rse.frontier.pike); a plain require throws
//   NotPortedError via requireMissing() (src.core.game3.rse.init,
//   src.ui.game3.rse.pokedex -- both Emerald only).
// - Lua multiple returns are 0-based tuples: Battle.start -> [true] or
//   [null, err]; D.targetPlan -> [can, cursor, start, tt]. Callees returning
//   tuples: Engine.planTurnFromActions [actions, meta], Engine.planTurnActions
//   [actions, nil], Engine.tryFlee / Engine.canSwitch [ok, why],
//   Catching.tryCatch [caught, shakes], BattleItems.use [result, msgs,
//   endsTurn, endsBattle], Wally.take [act, step], Commands.fightShortcut
//   [act, text], Trainers.getBattleMusicRole / getVictoryMusicRole [role,
//   fallback], Pokemon.movesAtLevel [moves, pp, maxPp], Pokemon.teachMove
//   [ok, slot], facility:actions [playerAct, enemyAct].
// - Lua sequences keep their keys (platform/lt.ts): action lists, parties,
//   foeParty, SEL_ORDER, pursuers, texts are `seq(...)`. Tables keyed by
//   battler id (chosen, monToSwitchInto, actions views) are plain objects with
//   integer keys 0..3. `out` tables from Engine.resolveMove are plain objects
//   (a message sequence plus `_anim` / `pendingChoice`).
// - xpcall(..., debug.traceback) in Battle.update: the caught error's JS stack
//   stands in for Lua's traceback.
// - print -> console.log.
// - NOT FAITHFUL: Emerald only: the safari POKeBLOCK menu case
//   (rse.init.call), the RSE caught-mon Pokedex page and its input
//   (ui.rse.pokedex), and Battle._rseDex resets throw (requireMissing).
// - NOT FAITHFUL: src.ui.game3.stat_growth has no file in the port, so its
//   package.loaded probes read nil (the level-up stat window is never open).
// - Link battles (src.core.game3.link.battle, deferred): every call is behind
//   Brian's own `st.link` / pending-link-state guards, so offline battles
//   never reach the link stub.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { requireLua } from "../require_map.ts";
import { G3Lazy } from "../lazy_registry.ts";
import { NotPortedError, notPorted } from "../../notported.ts";
import { seq, len, ipairs, pairs, insert, remove, sort, type LuaTable } from "../../platform/lt.ts";
import { truthy, tostring, tonumber, format, sub, mod as lmod } from "../../../../import/gen3/lua.ts";
import State from "./state.ts";
import Adapter from "./adapter.ts";
import Engine from "./engine.ts";
import Ui from "./ui.ts";
import Damage from "./damage.ts";
import Commands from "./commands.ts";
import Moves from "./moves.ts";
import Anim from "./anim.ts";
import AnimSeq from "./anim_seq.ts";
import ExpSeq from "./exp_seq.ts";
import EvoSeq from "./evo_seq.ts";
import IntroSeq from "./intro_seq.ts";
import CatchSeq from "./catch_seq.ts";
import Experience from "./experience.ts";
import Pokemon from "../pokemon.ts";
import Evolution from "../evolution.ts";
import LearnMove from "./learn_move.ts";
// Lua requires src.core.game3.task here but never uses it.
import Task from "../task.ts";
import Trainers from "../scripting/trainers.ts";
import SwitchSeq from "./switch_seq.ts";
import Oak from "./oak_advice.ts";
import Pokedude from "./pokedude.ts";
import Rules from "./rules.ts";
import BattleProfile from "./profile.ts";
import Kinds from "./kinds.ts";
import Wally from "./tutorial_wally.ts";
import ModRuntime from "../../shared/mods/Runtime.ts";
import Strings from "../../shared/core/Strings.ts";
import RomText from "../rom_text.ts";
import BattleText from "./battle_text.ts";
import Audio from "../audio.ts";
import SE from "../se_ids.ts";
import BattleChrome from "../../ui/battle_chrome.ts";
import Fade from "../../ui/fade.ts";
// Lazy requires / package.loaded probes (all linked in):
import Guard from "./link_guard.ts";
import Rng from "../rng.ts";
import MapMod from "../map.ts";
import MapCatalog from "../../../../import/gen3/map_catalog.ts";
import Runtime from "../runtime.ts";
import Bag from "../bag.ts";
import Weather from "../weather.ts";
import G3 from "../../shared/mods/Gen3Compat.ts";
import Dex from "../dex.ts";
import Catching from "./catching.ts";
import FieldModules from "../field_modules.ts";
import QuestLogRecorder from "../quest_log_recorder.ts";
import Message from "../../ui/message.ts";
import Field from "../field.ts";
import Safari from "../safari.ts";
import Encounters from "../encounters.ts";
import BattleBg from "./bg.ts";
import TrainerTower from "../trainer_tower.ts";
import Ai from "./ai.ts";
import Prize from "./prize.ts";
import BattleBridge from "../battle_bridge.ts";
import Options from "../options.ts";
import BattleItems from "./items.ts";
import Types from "./types.ts";
import Storage from "../storage.ts";
import Naming from "../../ui/naming.ts";
import Pokedex from "../../ui/pokedex.ts";
import SummaryMenu from "../../ui/summary_menu.ts";
import PartyMenuMod from "../../ui/party_menu.ts";
import BagMenuMod from "../../ui/bag_menu.ts";
import Screens from "../../ui/screens.ts";
import EvolutionScene from "../../ui/evolution_scene.ts";
import LinkBattle from "../link/battle.ts";

void Task;

type Tbl = LuaTable;
type Fn = (...a: any[]) => any;

/** Lua `a or b` (b already evaluated; use only where b is pure). */
function lor<A, B>(a: A, b: B): A | B {
  return truthy(a) ? a : b;
}

/** Lua `a and b` (b already evaluated; use only where b is pure). */
function land<A, B>(a: A, b: B): A | B {
  return truthy(a) ? b : a;
}

/** Lua `t and t.k`. */
function tk(t: any, k: string | number): any {
  return truthy(t) ? t[k] : t;
}

/** Lua `a or b or c ...` with lazy operands: the first truthy value, else the last one. */
function orl(...fs: (() => any)[]): any {
  let v: any;
  for (let i = 0; i < fs.length; i++) {
    v = fs[i]();
    if (truthy(v)) return v;
  }
  return v;
}

/** Lua `type(v) == "table"`. */
function isTable(v: unknown): v is Tbl {
  return v !== null && typeof v === "object";
}

/** Lua `(v) or nil`. */
function orNil(v: any): any {
  return truthy(v) ? v : undefined;
}

/** A plain `require` of a module that has no file in the port: fails, as in Lua. */
function requireMissing(name: string): any {
  const m = requireLua(name); // ported since this file was written
  if (m !== undefined) return m;
  return notPorted(`require("${name}") (no such module in the port)`);
}

/**
 * `M and M.isOpen and M.isOpen()` on a package.loaded probe. A module that is
 * still a stub cannot have been loaded / opened: its isOpen refusing reads as
 * nil (closed).
 */
function probeOpen(M: any): boolean {
  if (!truthy(M) || !truthy(M.isOpen)) return false;
  try {
    return truthy(M.isOpen());
  } catch (e) {
    if (e instanceof NotPortedError) return false;
    throw e;
  }
}

// package.loaded["src.ui.game3.stat_growth"]: no file in the port, reads nil.
// package.loaded["src.ui.game3.stat_growth"]: a lazy module, registered in G3Lazy
function statGrowthLoaded(): any { return G3Lazy["src.ui.game3.stat_growth"]; }
// package.loaded["src.ui.game3.rse.pyramid_bag"]: no file in the port, reads nil.
const PyramidBagLoaded: any = undefined;

// Runtime.getSession through `Runtime and Runtime.getSession and Runtime.getSession()`.
function runtime_session(): any {
  return truthy(Runtime) && truthy(Runtime.getSession) ? Runtime.getSession() : undefined;
}

export interface BattleModule {
  _active: boolean;
  _st: Tbl;
  _adapter: Tbl;
  _phase: string | null | undefined;
  _actions: Tbl;
  _actionI: number;
  _onDone: Fn | null | undefined;
  _pendingEnd: string | null | undefined;
  _auto: boolean;
  _metaAct: Tbl;
  _headless: boolean;
  _fade: boolean;
  _lowHpSong: boolean;
  _residualEvents: Tbl;
  _residualIndex: number;
  _residualStepState: string | null | undefined;
  // Fields init.lua sets on the fly:
  _catchDexReturn: Fn | null | undefined;
  _rseDex: boolean | null | undefined;
  _pendingChoice: Tbl;
  _leveledUp: Tbl;
  _linkFault: boolean | null | undefined;
  _nextFacility: Tbl;
  _linkSwitch: Tbl;
  _midTurn: boolean | null | undefined;
  _linkAct: Tbl;
  _linkDouble: boolean | null | undefined;
  _linkMulti: boolean | null | undefined;
  _onExpDone: Fn | null | undefined;
  _shiftEnemyIdx: number | null | undefined;
  _shiftAsked: boolean;
  _singleAfterAnim: Fn | null | undefined;
  _dblSel: Tbl;
  _dblFaint: Tbl;
  _dblSwitch: Tbl;
  _dblAfterAnim: Fn | null | undefined;
  _dblLeveled: Tbl;
  _facilityResume: Fn | null | undefined;
  // Exposed locals:
  _updateLowHpMusic: () => void;
  _linkEnemyAction: (st: Tbl, msg: Tbl, id?: number | null) => Tbl;
  _linkSwitchStep: () => boolean;
  _spectateTurnStep: () => boolean;
  _linkTurnStep: () => boolean;
  _linkBattle: () => any;
  _refuseLinkItem: (input: any) => boolean;
  _choiceHooksForTests: () => Tbl;
  _mergeLeveledSet: (set: Tbl) => Tbl;
  safariSyncBalls: (st: Tbl) => void;
  _openPendingChoiceForTests: () => any;
  startPostCatchFlow: (catchRes: Tbl) => void;
  finishCatchFlow: (catchRes: Tbl, ename: any, nicknamed?: boolean) => void;
  statWindowPhase(): boolean;
  isActive(): boolean;
  getResult(): any;
  getState(): Tbl;
  songInfo(st: Tbl): Tbl;
  linkEndText(st: Tbl, outcome: any, ran?: any): string;
  start(opts?: Tbl): [true] | [null, string];
  quitPokedude(): boolean;
  update(dt?: number | null, game?: Tbl): void;
  runToEnd(): any;
  draw(_game: any, w?: number, h?: number): void;
  abort(result?: string | null): void;
  reset(): void;
  linkEnd(result?: string | null, text?: string | null, reason?: string | null): boolean;
}

export const Battle = {} as BattleModule;

Battle._active = false;
Battle._st = undefined;
Battle._adapter = undefined;
Battle._phase = undefined;
Battle._actions = undefined;
Battle._actionI = 1;
Battle._onDone = undefined;
Battle._pendingEnd = undefined;
Battle._auto = false;
Battle._metaAct = undefined;
Battle._headless = false;
Battle._fade = true;
Battle._lowHpSong = false;
Battle._residualEvents = undefined;
Battle._residualIndex = 1;
Battle._residualStepState = undefined;

// The doubles controller (and a few shared helpers) -- `local D = {}`.
const D: Record<string, Fn> = {};

// Lua: init.lua:60
function LB_copy(value: any, depth?: number): any {
  if (!isTable(value) || (depth ?? 0) > 8) return value;
  const out: Tbl = Array.isArray(value) ? [] : {};
  for (const [k, v] of pairs(value)) out[k] = LB_copy(v, (depth ?? 0) + 1);
  return out;
}

// Phases in which the level-up stat window can still be dismissed by the
// player.  Input routing and drawing both key off this, so the window can never
// linger somewhere it can no longer be dismissed (#2324).
const STAT_WINDOW_PHASES: Record<string, boolean> = {
  awarding: true,
  evolving: true,
  switching: true,
  shift_prompt: true,
  catch_nickname_prompt: true,
};

// Lua: init.lua:78
Battle.statWindowPhase = function (): boolean {
  return STAT_WINDOW_PHASES[Battle._phase as string] === true;
};

// pokefirered/src/battle_interface.c:2168
// Lua: init.lua:83
function hp_bar_red(hp: number, maxHp: number): boolean {
  if (!truthy(BattleChrome) || !truthy(BattleChrome.hpBarLevel)) return false;
  return BattleChrome.hpBarLevel(hp, maxHp) === "red";
}

// Lua: init.lua:88
function stop_low_hp_song(): void {
  if (!Battle._lowHpSong) return;
  Battle._lowHpSong = false;
  if (truthy(Audio) && truthy(Audio.stopSe) && truthy(SE)) {
    Audio.stopSe(SE.SE_LOW_HEALTH);
  }
}

// Lua: init.lua:96
function apply_low_hp(on: any): void {
  if (truthy(on) && !Battle._lowHpSong) {
    Battle._lowHpSong = true;
    if (truthy(Audio) && truthy(Audio.playSe) && truthy(SE)) {
      Audio.playSe(SE.SE_LOW_HEALTH, { loop: true });
    }
  } else if (!truthy(on)) {
    stop_low_hp_song();
  }
}

/** pret HandleLowHpMusicChange / HandleBattleLowHpMusicChange */
// Lua: init.lua:108
function update_low_hp_music(): void {
  const st = Battle._st;
  const mon = truthy(st) && truthy(st.player) ? st.player.mon : undefined;
  if (!truthy(mon)) {
    stop_low_hp_song();
    return;
  }
  if (truthy(Anim.hpTweening) && truthy(Anim.hpTweening())) return;
  const pres = Anim.present("player");
  const hp = Math.floor(tonumber(tk(pres, "displayHp")) ?? tonumber(mon.hp) ?? 0);
  const maxHp = Math.floor(tonumber(tk(pres, "displayMaxHp")) ?? tonumber(mon.maxHp) ?? 0);
  const red = hp_bar_red(hp, maxHp);
  if (ModRuntime.wantsHook("battle.low_health_alarm")) {
    ModRuntime.call("battle.low_health_alarm", (ctx: any) => {
      apply_low_hp(ctx.on);
    }, { on: red, battle: st });
  } else {
    apply_low_hp(red);
  }
}

Battle._updateLowHpMusic = update_low_hp_music;

// Lua: init.lua:131
function party_menu_input(PartyMenu: any, input: any): void {
  // package.loaded["src.ui.game3.summary_menu"]
  const SummaryMenuL = SummaryMenu;
  if (probeOpen(SummaryMenuL)) {
    if (truthy(SummaryMenuL.update)) SummaryMenuL.update(1 / 60);
    SummaryMenuL.handleInput(input);
    return;
  }
  PartyMenu.handleInput(input);
}

// pokefirered/src/battle_script_commands.c:1108
// Lua: init.lua:142
function seq_push(text: any, wait?: any, id?: any): any {
  const st = Battle._st;
  if (truthy(st) && truthy(st.pokedude) && truthy(id)) {
    // pokefirered/src/battle_controller_pokedude.c:209 HandlePokedudeVoiceoverEtc
    Pokedude.event(st, "printstring", st.pdActor, id);
  }
  text = tostring(lor(text, ""));
  // pokeemerald/src/battle_message.c:3005
  if (sub(text, -2) === "\\p" && !(truthy(st) && (truthy(st.link) || truthy(st.pokedude) || (truthy(st.kinds) && truthy(st.kinds.recordedLink))))) return Ui.push(text);
  Ui.pushTimed(text, tonumber(wait) ?? (truthy(AnimSeq.isMoveUsedId(id)) ? 0 : 64));
}

// Lua: init.lua:154
function push_msgs(list: Tbl): void {
  for (const [, t] of ipairs(lor(list, seq()))) {
    Ui.push(t);
  }
}

// Lua: init.lua:160
function link_mon_from(foe: any): Tbl {
  if (!isTable(foe)) throw new Error("link battle: the peer sent no mon");
  for (const key of ["personality", "ivs", "item"]) {
    if (foe[key] == null) throw new Error("link battle: the peer's mon has no " + key);
  }
  if (!isTable(foe.moves) || len(foe.moves) === 0) throw new Error("link battle: the peer's mon has no moves");
  const mon = LB_copy(foe);
  mon.item = tonumber(foe.item) ?? 0;
  mon.heldItem = mon.item;
  if (!truthy(mon.maxPp) || len(mon.maxPp) === 0) {
    mon.maxPp = seq();
    for (const [i, m] of ipairs(mon.moves)) mon.maxPp[i] = Pokemon.movePp(m);
  }
  if (!truthy(mon.pp) || len(mon.pp) === 0) {
    mon.pp = seq();
    for (const [i] of ipairs(mon.moves)) mon.pp[i] = mon.maxPp[i];
  }
  return Damage.ensureStats(mon, mon.level);
}

// Lua: init.lua:180
function foe_mon_from(foe: any, link?: boolean): Tbl {
  if (truthy(link)) return link_mon_from(foe);
  if (!isTable(foe)) {
    return Damage.ensureStats({
      species: 16, level: 3,
      moves: seq(33, 45), pp: seq(35, 40),
    }, 3);
  }
  const species = orl(() => foe.species, () => foe.id, () => 16);
  let personality = foe.personality;
  if (personality == null) {
    // pret GenerateWildMon → CreateMonWithNature uses Random stream;
    // Random32 matches Unown path; nature comes from personality % 25.
    personality = Rng.Random32();
  }
  let gender = foe.gender;
  if (gender !== "M" && gender !== "F" && gender !== "U") {
    gender = truthy(Pokemon.gender) ? lor(Pokemon.gender(species, personality), "U") : "U";
  }
  let ivs = foe.ivs;
  if (ivs == null) {
    const iv1 = Rng.Random();
    const iv2 = Rng.Random();
    ivs = {
      hp: lmod(iv1, 32),
      atk: lmod(Math.floor(iv1 / 32), 32),
      def: lmod(Math.floor(iv1 / 1024), 32),
      spe: lmod(iv2, 32),
      spa: lmod(Math.floor(iv2 / 32), 32),
      spd: lmod(Math.floor(iv2 / 1024), 32),
    };
  }
  let item = foe.item;
  if (item == null && BattleProfile.get(undefined).family !== "rse") {
    const meta = truthy(Pokemon.speciesMeta) ? Pokemon.speciesMeta(species) : Pokemon.speciesMeta;
    if (truthy(meta)) {
      const common = tonumber(meta.itemCommon) ?? 0;
      const rare = tonumber(meta.itemRare) ?? 0;
      if (common !== 0 || rare !== 0) {
        const r = lmod(Rng.Random(), 100);
        if (common !== 0 && rare !== 0) {
          if (r < 50) item = common;
          else if (r < 55) item = rare;
        } else if (common !== 0) {
          if (r < 50) item = common;
        } else if (rare !== 0) {
          if (r < 5) item = rare;
        }
      }
    }
  }
  const mon: Tbl = {
    species: species,
    name: lor(foe.name, foe.nickname),
    nickname: foe.nickname,
    level: lor(foe.level, 5),
    hp: foe.hp,
    maxHp: foe.maxHp,
    moves: foe.moves,
    pp: foe.pp,
    status: foe.status,
    attack: lor(foe.attack, foe.atk),
    defense: lor(foe.defense, foe.def),
    spAtk: lor(foe.spAtk, foe.spa),
    spDef: lor(foe.spDef, foe.spd),
    speed: lor(foe.speed, foe.spe),
    item: item,
    gender: gender,
    ivs: ivs,
    evs: foe.evs,
    personality: personality,
    nature: orl(() => foe.nature, () => truthy(Pokemon.natureId) ? Pokemon.natureId(personality) : Pokemon.natureId, () => 0),
    ability: lor(foe.ability, foe.abilityId),
    dvs: foe.dvs,
    friendship: foe.friendship,
  };
  if (!truthy(mon.moves) || len(mon.moves) === 0) {
    // pokefirered/src/pokemon.c:2265
    const [moves, pp, maxPp] = Pokemon.movesAtLevel(mon.species, mon.level);
    if (!truthy(moves) || len(moves) === 0) {
      throw new Error(format("species %s has no moves at level %s", tostring(mon.species), tostring(mon.level)));
    }
    mon.moves = moves;
    mon.pp = pp;
    mon.maxPp = maxPp;
  }
  if (!truthy(mon.maxPp) || len(mon.maxPp) === 0) {
    mon.maxPp = seq();
    for (const [i, m] of ipairs(mon.moves)) {
      mon.maxPp[i] = Pokemon.movePp(m);
    }
  }
  if (!truthy(mon.pp) || len(mon.pp) === 0) {
    mon.pp = seq();
    for (const [i] of ipairs(mon.moves)) {
      mon.pp[i] = mon.maxPp[i];
    }
  }
  return Damage.ensureStats(mon, mon.level);
}

const ITEM_SILPH_SCOPE = 359;

// pokefirered/src/battle_setup.c:220
// Lua: init.lua:284
function ghost_battle(opts: Tbl, st: Tbl): boolean {
  if (opts.ghost != null) return truthy(opts.ghost) ? true : false;
  if (isTable(opts.foe) && opts.foe.ghost != null) return truthy(opts.foe.ghost) ? true : false;
  if (!truthy(st.wild)) return false;
  if (!truthy(BattleProfile.get(lor(opts.session, st.session)).kinds.ghost)) return false;
  // package.loaded["src.core.game3.map"]
  const mapId = lor(opts.mapId, tk(MapMod, "current"));
  if (typeof mapId !== "string") return false;
  // pcall(require, "src.import.gba.map_catalog") succeeds: it is linked in.
  const okC = true;
  let tower = false;
  for (let f = 1; f <= 7; f++) {
    const id = lor(okC ? MapCatalog.pretToEngine("PokemonTower_" + tostring(f) + "F") : undefined,
      "FR_POKEMON_TOWER_" + tostring(f) + "F");
    if (mapId === id) { tower = true; break; }
  }
  if (!tower) return false;
  // package.loaded["src.core.game3.runtime"]
  const session = lor(opts.session, runtime_session());
  // pcall(require, "src.core.game3.bag") succeeds: it is linked in.
  const okB = true;
  if (okB && truthy(session) && truthy(session.bag) && truthy(Bag.has) && Bag.has(session.bag, ITEM_SILPH_SCOPE, 1)) return false;
  return true;
}

// pokefirered/src/battle_util.c:1709
// Lua: init.lua:307
function overworld_weather(): string | undefined {
  // package.loaded["src.core.game3.weather"]
  const W: any = Weather;
  let id = 0;
  if (truthy(W)) {
    const g = truthy(W.get) ? W.get() : W.get;
    id = tonumber(lor(g, W.current)) ?? 0;
  }
  if (id === 3 || id === 5 || id === 13) return "RAIN";
  if (id === 8) return "SAND";
  if (id === 12) return "SUN";
  return undefined;
}

// Lua: init.lua:316
function flags_or(a: any, b: any): number {
  let x = Math.floor(tonumber(a) ?? 0);
  let y = Math.floor(tonumber(b) ?? 0);
  let r = 0;
  let bit = 1;
  for (let i = 1; i <= 32; i++) {
    if (lmod(x, 2) === 1 || lmod(y, 2) === 1) r = r + bit;
    x = Math.floor(x / 2);
    y = Math.floor(y / 2);
    bit = bit * 2;
  }
  return r;
}

// Lua: init.lua:326
function action_view(act: any): Tbl {
  if (!isTable(act)) return undefined;
  // require("src.mods.Gen3Compat")
  const n0 = (act.kind === "move" && act.move != null) ? Engine.moveNum(act.move) : undefined;
  const num = orNil(n0);
  const name = truthy(num) ? orNil(G3.moveName(num)) : undefined;
  return {
    kind: act.kind, id: name, move: name, moveNum: num, slot: act.slot,
    index: act.kind === "switch" ? orNil(act.slot) : undefined,
    item: truthy(act.itemId) ? orNil(G3.itemName(act.itemId)) : undefined, itemId: act.itemId,
    battler: act.battler, target: act.target,
  };
}

// pokefirered/src/battle_main.c:3532
// Lua: init.lua:340
function open_turn(st: Tbl, playerAct: Tbl, enemyAct: Tbl, chosen: Tbl): void {
  st._modTurnOpen = true;
  if (!ModRuntime.wants("battle.turn_started")) return;
  let actions: Tbl;
  if (truthy(chosen)) {
    actions = {};
    for (let id = 0; id <= 3; id++) actions[id] = action_view(chosen[id]);
  }
  ModRuntime.emit("battle.turn_started", {
    battle: st, turn: st.turn, playerAction: action_view(playerAct),
    enemyAction: action_view(enemyAct), actions: actions,
  });
}

// pokefirered/src/battle_main.c:2953
// Lua: init.lua:355
function close_turn(st: Tbl): void {
  if (!(truthy(st) && truthy(st._modTurnOpen))) return;
  st._modTurnOpen = undefined;
  if (ModRuntime.wants("battle.turn_ended")) {
    ModRuntime.emit("battle.turn_ended", { battle: st, turn: st.turn });
  }
}

// Lua: init.lua:363
Battle.isActive = function (): boolean {
  return Battle._active === true;
};

// Lua: init.lua:367
Battle.getResult = function (): any {
  return tk(Battle._st, "result");
};

// Lua: init.lua:371
Battle.getState = function (): Tbl {
  return Battle._st;
};

// Lua: init.lua:375
Battle.songInfo = function (st: Tbl): Tbl {
  const k = (truthy(st) && truthy(st.kinds)) ? st.kinds : {};
  return {
    wild: lor(tk(st, "wild"), false),
    link: lor(tk(st, "link"), false),
    trainerClass: tk(st, "trainerClass"),
    trainerName: tk(st, "trainerName"),
    frontier: k.frontier,
    kind: orl(() => land(k.kyogreGroudon, "kyogreGroudon"), () => land(k.regi, "regi"), () => undefined),
  };
};

// pokefirered/src/battle_message.c:1695 STRINGID_BATTLEEND
// Lua: init.lua:388
Battle.linkEndText = function (st: Tbl, outcome: any, ran?: any): string {
  const out = lor(({ lose: "lost", draw: "drew" } as Record<string, string>)[outcome], "won");
  return BattleText.get(BattleText.BATTLEEND, Adapter.fill(st, { outcome: out, linkRan: truthy(ran) ? true : undefined }));
};

// Lua: init.lua:393
function finish(result?: any): void {
  if (!Battle._active) return;
  const pst = Battle._st;
  if (truthy(pst) && truthy(pst.pokedude) && !truthy(pst.pdEnded) && Battle._headless) {
    pst.pdEnded = true;
    // pokefirered/data/battle_scripts_2.s:102 endlinkbattle
    Pokedude.event(pst, "endlinkbattle", "player");
  }
  stop_low_hp_song();
  Guard.disarm();
  Battle._active = false;
  Battle._phase = undefined;
  Ui.clearCaughtDexScene();
  Battle._catchDexReturn = undefined;
  // NOT FAITHFUL: Emerald only (src.ui.game3.rse.pokedex has no file in the port).
  if (truthy(Battle._rseDex)) requireMissing("src.ui.game3.rse.pokedex").reset();
  Battle._rseDex = undefined;
  Battle._residualEvents = undefined;
  Battle._residualIndex = 1;
  Battle._residualStepState = undefined;
  Battle._pendingChoice = undefined;
  D.reset();
  const st = Battle._st;
  close_turn(st);
  if (truthy(st)) {
    st.over = true;
    st.result = orl(() => result, () => st.result, () => "win");
    if (truthy(st.facility) && truthy(st.facility.finalResult)) {
      // pokeemerald/src/battle_script_commands.c:3576
      st.result = st.facility.finalResult(st, st.result);
      result = st.result;
    }
    // package.loaded["src.core.game3.runtime"]
    const session = truthy(Runtime) ? Runtime.getSession() : undefined;
    // pokeemerald/src/battle_main.c:5221
    if (truthy(session) && !truthy(st.link) && BattleProfile.of(st).family === "rse") {
      Pokemon.randomlyGivePartyPokerus(session.party, session);
      Pokemon.partySpreadPokerus(session.party, session);
    }
    // pokefirered/src/quest_log_battle.c:14
    if (truthy(session) && !Battle._headless && !(truthy(st.link) || truthy(st.oldManTutorial) || truthy(st.pokedude))
        && FieldModules.enabled("questLog", session)) {
      QuestLogRecorder.battle(session, st);
    }
  }
  AnimSeq.reset();
  CatchSeq.reset();
  ExpSeq.reset();
  EvoSeq.reset();
  IntroSeq.reset();
  LearnMove.reset();
  SwitchSeq.reset();
  Anim.reset({ headless: true });
  // pcall(require, "src.ui.game3.message") succeeds: it is linked in.
  const okM = true;
  if (okM && truthy(Message)) {
    if (truthy(Message.setFrame)) Message.setFrame("dialogue");
    if (truthy(Message.open) && truthy(Message.close)) Message.close();
  }
  // package.loaded["src.core.game3.field"]
  if (truthy(Field) && truthy(Field.unlock)) Field.unlock();
  if (Battle._headless) {
    // pcall(require, "src.ui.game3.fade") succeeds: it is linked in.
    if (truthy(Fade) && truthy(Fade.clear)) Fade.clear();
  }
  // battle_main.c:3746-3759
  const cb = Battle._onDone;
  Battle._onDone = undefined;
  if (truthy(cb)) cb!(orl(() => tk(st, "result"), () => result, () => "win"), st);
  if (truthy(st) && truthy(st.safari) && truthy(st.safariState) && truthy(st.safariState.rse)) {
    // pokeemerald/src/safari_zone.c:97
    Safari.endBattleRse(st.session, st);
  // pokefirered/src/safari_zone.c:66
  } else if (truthy(st) && truthy(st.safari) && st.endReason === "no_safari_balls") {
    // pcall(require, "src.core.game3.safari") succeeds: it is linked in.
    const okS = true;
    // pokefirered/src/safari_zone.c:12 GetSafariZoneFlag
    if (okS && truthy(Safari) && truthy(Safari.isActive) && truthy(Safari.isActive(st.session))) {
      Safari.outOfBallsMidBattle(st.session);
    }
  }
}

// Lua: init.lua:474
Battle.start = function (optsIn?: Tbl): [true] | [null, string] {
  const opts: Tbl = lor(optsIn, {});
  if (Battle._active) {
    return [null, "battle already active"];
  }
  const playerParty = lor(opts.playerParty, seq());
  if (len(playerParty) === 0) {
    return [null, "empty party"];
  }
  // pcall(require, "src.ui.game3.message") succeeds: it is linked in.
  const StayMessage = Message;
  if (truthy(StayMessage) && truthy(StayMessage.closeStay)) StayMessage.closeStay();
  const linkBattle = (truthy(opts.link) || (isTable(opts.foe) && truthy(opts.foe.link))) ? true : false;
  if (linkBattle) Guard.arm(); else Guard.disarm();
  let foeMon: Tbl;
  let foeParty: Tbl;
  if (linkBattle) {
    foeParty = seq();
    for (const [, fm] of ipairs(lor(isTable(opts.foe) ? opts.foe.party : false, seq()))) {
      foeParty[len(foeParty) + 1] = foe_mon_from(fm, true);
    }
    if (len(foeParty) === 0) {
      Guard.disarm();
      return [null, "the peer sent no party"];
    }
  } else {
    foeMon = foe_mon_from(opts.foe);
    foeParty = opts.foeParty;
    if (!truthy(foeParty) && truthy(opts.foe) && truthy(opts.foe.party)) {
      foeParty = seq();
      for (const [, fm] of ipairs(opts.foe.party)) {
        foeParty[len(foeParty) + 1] = foe_mon_from(fm);
      }
    }
    if (truthy(foeParty) && truthy(foeParty[1]) && isTable(opts.foe) && opts.foe.species == null && opts.foe.id == null) {
      foeMon = foeParty[1];
    }
    // pokeemerald/src/pokemon.c:6678
    if (truthy(foeMon) && truthy(opts.wild) && !(truthy(opts.legendary) || truthy(opts.recordedLink) || truthy(opts.pyramid) || truthy(opts.pike))
        && BattleProfile.get(opts.session).family === "rse") {
      const held = Encounters.rules().wildHeldItem(foeMon.species,
        { alteringCave: opts.alteringCave });
      if (truthy(held) && held !== 0) foeMon.item = held;
    }
  }
  Moves.loadRomPack(opts.cache);
  const double = (opts.double === true) && !truthy(opts.wild);
  const multi = (linkBattle && double && isTable(opts.multi)) ? opts.multi : undefined;
  const st = State.new({
    wild: opts.wild,
    double: double ? true : undefined,
    playerIndex: truthy(opts.playerIndex) ? opts.playerIndex : (!truthy(multi) ? orNil(State.firstUsable(playerParty)) : undefined),
    playerParty: playerParty,
    foeMon: foeMon,
    foeParty: foeParty,
    rng: opts.rng,
    multi: truthy(multi) ? true : undefined,
    partyOwner: truthy(multi) ? orNil(multi.owners) : undefined,
    // pokeemerald/src/battle_main.c:697
    foeHalf: (double && truthy(opts.twoOpponents) && !truthy(multi)) ? orNil(opts.foeHalf) : undefined,
    // pokeemerald/src/battle_tower.c:2124
    playerHalf: (double && truthy(opts.partner) && !truthy(multi)) ? orNil(opts.playerHalf) : undefined,
  });
  if (truthy(st.multi)) {
    // pokefirered/src/battle_controllers.c:223
    st.linkOwn = tonumber(multi.own);
    st.linkNames = lor(multi.names, {});
    st.linkGenders = lor(multi.genders, {});
    st.linkSeatOf = lor(multi.seatOf, {});
    st.linkLocalOf = lor(multi.localOf, {});
    st.linkOrder = multi.order;
  }
  // pokefirered/src/battle_main.c:2584
  SwitchSeq.stampSwitchIn(st);
  D.reset();
  Battle._leveledUp = {};
  // pokefirered/src/cable_club.c:664 BATTLE_TYPE_LINK
  st.link = linkBattle;
  st.spectate = (linkBattle && truthy(opts.spectate)) ? true : false;
  st.linkFlags = tonumber(opts.linkFlags);
  // pokefirered/src/battle_controllers.c:148 InitLinkBtlControllers
  st.linkMaster = (opts.linkMaster !== false) ? true : false;
  // pokeemerald/src/battle_controllers.c:397
  st.hostRules = (linkBattle && typeof opts.hostRules === "string") ? opts.hostRules : undefined;
  st.unionRoom = truthy(opts.unionRoom) ? true : false;
  st.peerName = orl(() => opts.peerName, () => land(opts.foe, tk(opts.foe, "name")), () => undefined);
  // pokefirered/src/battle_controller_pokedude.c:2683
  st.pokedude = truthy(opts.pokedude) ? true : false;
  if (st.pokedude) st.pd = Pokedude.newState(opts.pdScriptNum);
  st.ghostBattle = ghost_battle(opts, st);
  if (st.ghostBattle) {
    // pokefirered/src/battle_setup.c:326
    st.ghostUnveiled = (truthy(opts.ghostUnveiled) || (isTable(opts.foe) && truthy(opts.foe.ghostUnveiled))) ? true : undefined;
    // pokefirered/src/battle_setup.c:334
    if (truthy(st.enemy) && truthy(st.enemy.mon)) st.enemy.mon.nickname = RomText.plain("gText_Ghost");
  }
  Battle._headless = truthy(opts.headless) ? true : false;
  Battle._auto = (opts.autoFight === true) || (truthy(opts.headless) && opts.autoFight !== false);
  Battle._fade = (opts.fade !== false) && !Battle._headless;
  Ui.reset({ headless: opts.headless });
  {
    // package.loaded["src.core.game3.runtime"]
    const session = lor(opts.session, runtime_session());
    st.session = session;
    st.pyramid = opts.pyramid === true;
    st.dex = lor(opts.dex, tk(session, "dex"));
    Ui.bindState(st, session);
    st.playerName = lor(tk(session, "name"), opts.playerName);
    // pokefirered/src/battle_main.c:2618
    // pokefirered/src/battle_script_commands.c:4520
    if (truthy(session) && truthy(session.dex) && truthy(foeMon) && truthy(lor(foeMon.species, foeMon.speciesId))
        && !truthy(st.link)
        && !truthy(st.oldManTutorial)
        && !truthy(st.pokedude)
        && !(truthy(st.ghostBattle) && !truthy(st.ghostUnveiled))) {
      Dex.handleSetPokedexFlag(session.dex, lor(foeMon.species, foeMon.speciesId), false, foeMon.personality);
      const b3 = (truthy(st.double) && !truthy(st.absent[3])) ? st.battlers[3] : undefined;
      if (truthy(b3) && truthy(b3.mon)) {
        Dex.handleSetPokedexFlag(session.dex, lor(b3.mon.species, b3.mon.speciesId), false, b3.mon.personality);
      }
    }
    // pokefirered/src/pokemon.c:1796
    const wildMon = (truthy(st.wild) && truthy(st.enemy)) ? st.enemy.mon : undefined;
    const otId = truthy(session) ? tonumber(orl(() => session.trainerId, () => session.id, () => session.playerId)) : undefined;
    if (truthy(wildMon) && otId != null) {
      wildMon.otId = otId;
      wildMon.otSecretId = Catching.playerSecretId(session);
    }
  }
  Anim.reset({ headless: opts.headless, double: st.double });
  AnimSeq.reset();
  CatchSeq.reset();
  ExpSeq.reset();
  IntroSeq.reset();
  SwitchSeq.reset();
  // Align party exp to ROM growth curves before battle display
  for (const [, mon] of ipairs(playerParty)) {
    Experience.syncExpToLevel(mon);
  }
  if (truthy(foeMon)) Experience.syncExpToLevel(foeMon);
  if (truthy(foeParty)) {
    for (const [, fm] of ipairs(foeParty)) {
      Experience.syncExpToLevel(fm);
    }
  }
  Anim.syncDisplayFromState(st);
  Battle._st = st;
  Battle._adapter = Adapter.new(st, (text: any) => { Ui.push(text); });
  Battle._onDone = opts.onDone;
  Battle._active = true;
  Battle._linkFault = undefined;
  Battle._lowHpSong = false;
  Battle._phase = "intro";
  Battle._actions = undefined;
  Battle._actionI = 1;
  Battle._pendingEnd = undefined;
  Battle._metaAct = undefined;
  Battle._pendingChoice = undefined;

  // Trainer presentation identity
  const trainerId = orl(() => opts.trainerId,
    () => land(opts.foe, tk(opts.foe, "trainerId")),
    () => land(foeMon, tk(foeMon, "trainerId")));
  const rivalName = opts.rivalName;
  const playerGender = lor(opts.playerGender, 0);
  // pokefirered/src/trainer_tower.c:735, src/battle_tower.c:933
  st.trainerTower = lor(opts.trainerTower, false);
  st.eReader = lor(opts.eReader, false);
  // src/battle_tower.c:895-933
  st.battleTower = lor(opts.battleTower, false);
  // pokeemerald/include/constants/battle.h:82
  st.towerLinkMulti = (truthy(opts.link) && truthy(opts.towerLinkMulti)) ? true : undefined;
  st.secretBase = lor(opts.secretBase, false);
  let trainerInfo: Tbl = undefined;
  // pokefirered/src/battle_message.c:2043 the tower and e-reader trainers are not gTrainers rows
  if (truthy(trainerId) && !truthy(st.wild) && !(truthy(st.trainerTower) || truthy(st.eReader) || truthy(st.secretBase))) {
    trainerInfo = Trainers.info(trainerId, { rivalName: rivalName });
  }

  // require("src.core.game3.battle.bg")
  let terrain = opts.terrain;
  // pokefirered/src/battle_main.c:689
  if (terrain == null && (opts.mapBehavior != null || opts.mapType != null)) {
    terrain = BattleBg.resolveFromBehavior(opts.mapBehavior, opts.mapKind, opts.mapType);
  }
  if (terrain == null && truthy(opts.mapKind)) {
    terrain = BattleBg.resolveFromMapKind(opts.mapKind);
  }
  if (terrain == null) {
    terrain = BattleBg.TERRAIN.BUILDING;
  }
  st.terrain = terrain;
  // pokefirered/src/battle_bg.c:714
  BattleBg.setTerrain(BattleBg.resolveOverride(terrain, {
    link: lor(st.link, opts.link),
    trainerTower: lor(st.trainerTower, opts.trainerTower),
    eReader: lor(st.eReader, opts.eReader),
    pokedude: lor(st.pokedude, opts.pokedude),
    trainer: land(!truthy(st.wild), lor(trainerInfo != null, st.secretBase)),
    trainerClass: lor(land(trainerInfo, tk(trainerInfo, "class")), opts.trainerClass),
    mapBattleScene: opts.mapBattleScene,
    battleTower: st.battleTower,
    frontier: opts.frontier,
    recordedLink: opts.recordedLink,
    groudon: opts.groudon,
    kyogre: opts.kyogre,
    rayquaza: opts.rayquaza,
  }));

  st.trainerId = trainerId;
  st.trainerIdB = opts.trainerIdB;
  if (truthy(opts.twoOpponents) && truthy(opts.trainerIdB) && !truthy(st.wild)) {
    // pokeemerald/src/battle_message.c:2673
    const infoB = lor(Trainers.info(opts.trainerIdB, { rivalName: rivalName }), {});
    st.trainerB = {
      class: tonumber(infoB.class), className: infoB.className, name: infoB.name, pic: infoB.pic,
      defeatText: lor(opts.defeatTextB, land(infoB.dialogs, tk(infoB.dialogs, "defeat"))),
    };
  } else if ((truthy(opts.twoOpponents) || truthy(st.towerLinkMulti)) && isTable(opts.frontierTrainerB) && !truthy(st.wild)) {
    // pokeemerald/src/battle_tower.c:1620
    const fb = opts.frontierTrainerB;
    st.trainerB = {
      class: tonumber(fb.class), className: fb.className, name: fb.name, pic: fb.pic,
      defeatText: opts.defeatTextB, victoryText: opts.victoryTextB,
    };
  }
  st.trainerClass = (truthy(trainerInfo) ? tonumber(trainerInfo.class) : undefined) ?? tonumber(opts.trainerClass);
  st.trainerClassName = lor(land(trainerInfo, tk(trainerInfo, "className")), opts.trainerClassName);
  st.trainerName = lor(tk(trainerInfo, "name"), opts.trainerName);
  // pokefirered/src/trainer_tower.c:447, src/battle_tower.c:1340
  if (truthy(st.trainerTower) || truthy(st.eReader)) {
    const facilityClass = tonumber(land(opts.foe, tk(opts.foe, "trainerClass")));
    const tower = TrainerTower.pack();
    const classes = land(tower, tk(tower, "facilityClassTrainerClass"));
    if (!isTable(classes)) throw new Error("trainer_tower.lua has no facilityClassTrainerClass");
    st.trainerClass = classes[facilityClass as number];
    if (st.trainerClass == null) throw new Error("no trainer class for facility class " + tostring(facilityClass));
  }
  // pokeemerald/src/battle_tower.c:1436
  const ft = (!truthy(st.wild) && isTable(opts.frontierTrainer)) ? opts.frontierTrainer : undefined;
  if (truthy(ft)) {
    st.frontierTrainer = true;
    st.trainerClass = tonumber(ft.class);
    st.trainerClassName = ft.className;
    st.trainerName = lor(ft.name, st.trainerName);
  }
  // pokefirered/src/battle_message.c:394 the link opponent is named, never classed
  if (truthy(st.link) && !truthy(st.unionRoom) && !truthy(st.towerLinkMulti) && truthy(st.peerName)) {
    st.trainerClass = undefined;
    st.trainerClassName = "";
    st.trainerName = st.peerName;
  }
  st.trainerPicId = orl(() => opts.trainerPicId,
    () => land(ft, tk(ft, "pic")),
    () => land(trainerInfo, tk(trainerInfo, "pic")));
  st.trainerPartySize = tk(trainerInfo, "partySize");
  st.defeatText = opts.defeatText;
  st.victoryText = opts.victoryText;
  st.earlyRival = lor(opts.earlyRival, false);
  st.rivalFlags = tonumber(opts.rivalFlags) ?? 0;
  // pokefirered/src/battle_main.c:3783
  st.rivalHealAfter = land(st.earlyRival, lmod(st.rivalFlags, 2) === 1);
  st.wildScripted = orl(() => opts.wildScripted, () => land(opts.foe, tk(opts.foe, "wildScripted")), () => false);
  st.legendary = orl(() => opts.legendary, () => land(opts.foe, tk(opts.foe, "legendary")), () => false);
  st.safari = orl(() => opts.safari, () => land(opts.foe, tk(opts.foe, "safari")), () => false);
  if (truthy(st.safari)) {
    // pokefirered/src/battle_main.c:2565
    State.zeroBattler(st.player);
    // pokefirered/src/battle_main.c:2284
    const fspecies = land(foeMon, lor(tk(foeMon, "species"), tk(foeMon, "speciesId")));
    const fmeta = (truthy(fspecies) && truthy(Pokemon.speciesMeta)) ? Pokemon.speciesMeta(fspecies) : undefined;
    const sfCfg = BattleProfile.of(st).safari;
    if (truthy(sfCfg)) {
      // pokeemerald/src/battle_main.c:3113
      st.safariState = Rules.safari.newStateRse(land(fmeta, tk(fmeta, "catchRate")), sfCfg);
    } else {
      st.safariState = Rules.safari.newState(land(fmeta, tk(fmeta, "catchRate")),
        land(fmeta, tk(fmeta, "safariZoneFleeRate")));
    }
    // pokefirered/src/safari_zone.c:9
    const carried = (truthy(st.session) && truthy(st.session.safari)) ? tonumber(st.session.safari.balls) : undefined;
    if (carried != null) st.safariState.balls = Math.max(0, Math.floor(carried));
  }
  st.roamer = orl(() => opts.roamer, () => land(opts.foe, tk(opts.foe, "roamer")), () => false);
  st.firstBattle = orl(() => opts.firstBattle, () => land(opts.foe, tk(opts.foe, "firstBattle")), () => false);
  st.oldManTutorial = orl(() => opts.oldManTutorial, () => land(opts.foe, tk(opts.foe, "oldManTutorial")), () => false);
  st.kinds = Kinds.fromOpts(opts, st);
  // pokeemerald/src/battle_tower.c:2061
  st.facility = orl(() => opts.facility, () => land(opts.frontier, Battle._nextFacility), () => undefined);
  Battle._nextFacility = undefined;
  if (truthy(st.facility) && truthy(st.facility.start)) st.facility.start(st);
  const battleProfile: any = BattleProfile.of(st);
  if (st.kinds.tutorial === "wally") {
    // pokeemerald/src/battle_controller_wally.c:1035
    st.backPicOverride = land(battleProfile.backPics, tk(battleProfile.backPics, "wally"));
  }
  if (truthy(st.kinds.partner) && truthy(st.playerHalf)) {
    // pokeemerald/src/battle_message.c:2725
    const pinfo = lor(truthy(opts.partnerTrainerId) ? Trainers.info(opts.partnerTrainerId) : undefined, {});
    st.partner = {
      trainerId: opts.partnerTrainerId, name: pinfo.name, class: tonumber(pinfo.class),
      className: pinfo.className,
      backPic: truthy(battleProfile.backPics) ? battleProfile.backPics[lor(opts.partnerBackPic, "steven")] : battleProfile.backPics,
    };
  }
  if (battleProfile.aiVariant === "rse") {
    // pokeemerald/src/battle_ai_script_commands.c:361
    st.aiFlags = orl(
      () => opts.aiFlags,
      () => land(st.safari, BattleProfile.aiBit(battleProfile, "SAFARI")),
      () => land(st.roamer, BattleProfile.aiBit(battleProfile, "ROAMING")),
      () => land(st.kinds.firstBattle, BattleProfile.aiBit(battleProfile, "FIRST_BATTLE")),
      () => (truthy(st.kinds.twoOpponents) && truthy(st.trainerIdB))
        ? flags_or(land(trainerInfo, tk(trainerInfo, "aiFlags")), lor(Trainers.info(st.trainerIdB), {}).aiFlags)
        : undefined,
      () => land(trainerInfo, tk(trainerInfo, "aiFlags")),
      () => 0,
    );
  } else {
    // pret gTrainers[].aiFlags / items[4] — drive battle AI scripts + item use.
    st.aiFlags = orl(
      () => opts.aiFlags,
      () => land(st.safari, 0x40000000),
      () => land(st.roamer, 0x20000000),
      () => land(st.legendary, 7), // CHECK_BAD_MOVE | TRY_TO_FAINT | CHECK_VIABILITY
      () => land(st.wildScripted, 1), // CHECK_BAD_MOVE
      () => land(trainerInfo, tk(trainerInfo, "aiFlags")),
      () => (truthy(st.wild) ? 0 : 1), // wild: no scripts; fallback trainer: CHECK_BAD_MOVE
    );
  }
  st.trainerItems = orl(() => opts.trainerItems,
    () => land(trainerInfo, tk(trainerInfo, "items")),
    () => seq(0, 0, 0, 0));
  st.playerGender = playerGender;
  st.overworldWeather = !truthy(st.link) ? orNil(truthy(opts.overworldWeather) ? opts.overworldWeather : overworld_weather()) : undefined;
  {
    // pokefirered/src/battle_controllers.c:59
    // pcall(require, "src.core.game3.battle.ai") succeeds: it is linked in.
    const okAi = true;
    if (okAi && truthy(Ai) && truthy(Ai.battleStart)) Ai.battleStart(st);
  }

  // Battle BGM (if not already playing from transition start)
  {
    let song = opts.song;
    if (!truthy(song) && truthy(battleProfile.music)) {
      // pokeemerald/src/pokemon.c:6426
      song = BattleProfile.battleSong(battleProfile, Battle.songInfo(st));
    }
    if (!truthy(song)) {
      if (truthy(st.wild)) {
        const foeSpecies = land(foeMon, orl(() => tk(foeMon, "species"), () => tk(foeMon, "speciesId"), () => tk(foeMon, "id")));
        // pokefirered/src/battle_setup.c:349 StartLegendaryBattle
        song = orl(() => Audio.legendaryBattleSong(foeSpecies), () => Audio.role("battleWild"), () => 298);
      } else {
        const [role, fallback] = Trainers.getBattleMusicRole(trainerId);
        song = lor(Audio.role(role), fallback);
      }
    }
    if (truthy(song)) {
      Audio.playSong(song);
    }
  }

  // package.loaded["src.core.game3.field"]
  if (truthy(Field) && truthy(Field.lock)) Field.lock();

  const introOpts = {
    pushMsg: (text: any) => { Ui.push(text); },
    headless: opts.headless,
    trainerId: trainerId,
    trainerPicId: st.trainerPicId,
    playerGender: playerGender,
    rivalName: rivalName,
  };
  if (truthy(IntroSeq.begin(st, introOpts))) {
    // pokefirered/src/battle_message.c:1564 sText_LinkTrainerWantsToBattle
    if (truthy(st.link)) {
      const texts = seq(
        IntroSeq.introText(st),
        IntroSeq.sendOutText(st, "enemy"),
      );
      let n = 0;
      for (const [, step] of ipairs(lor(IntroSeq._steps, seq()))) {
        if (step.kind === "msg" && n < 2) {
          n = n + 1;
          step.data.text = texts[n];
        }
      }
    }
  } else {
    const ename = State.displayName(st.enemy);
    if (truthy(st.ghostBattle)) {
      for (const [, t] of ipairs(IntroSeq.headlessGhostIntro(st))) Ui.push(t);
    } else if (truthy(st.wild)) {
      Ui.push(IntroSeq.introText(st));
    } else if (truthy(st.link)) {
      // pokefirered/src/battle_message.c:1551
      Ui.push(IntroSeq.introText(st));
      Ui.push(IntroSeq.sendOutText(st, "enemy"));
      if (truthy(st.double)) Ui.push(IntroSeq.sendOutText(st, "player"));
    } else if (truthy(st.double)) {
      for (const [, t] of ipairs(D.headlessIntro(st, trainerId, rivalName))) Ui.push(t);
    } else {
      const strings = Trainers.introStrings(trainerId, ename, { rivalName: rivalName });
      Ui.push(strings.wants);
      Ui.push(strings.sentOut);
    }
    // pokefirered/src/battle_main.c:2801
    if (!truthy(st.double) && !truthy(st.safari) && !truthy(st.oldManTutorial)) {
      Ui.push(IntroSeq.sendOutText(st, "player"));
    }
    // pokefirered/src/battle_controller_oak_old_man.c:626
    if (truthy(Oak.active(st)) && !truthy(st.oakIntroDone)) {
      st.oakIntroDone = true;
      Oak.say(st, "forPetesSake");
    }
  }

  if (truthy(opts.onStarted)) opts.onStarted(st);

  if (truthy(opts.headless) && opts.autoFight !== false) {
    Battle._auto = true;
    Battle.runToEnd();
  }
  return [true];
};

// Lua: init.lua:896
function end_if_over(): boolean {
  const st = Battle._st;
  if (!truthy(st) || !truthy(st.over)) return false;
  if (!truthy(st.endReason) && !truthy(AnimSeq.ended())) return false;
  Battle._actions = seq();
  Battle._metaAct = undefined;
  Battle._pendingEnd = lor(st.result, "run");
  Battle._phase = "ending";
  return true;
}

// pokefirered/src/battle_main.c:3682
// Lua: init.lua:908
function focus_punch_prelude(): Tbl {
  const st = Battle._st, ad = Battle._adapter;
  let list = st._focusPunchSetup;
  st._focusPunchSetup = undefined;
  if (!truthy(list)) {
    list = seq();
    for (const [, a] of ipairs(lor(Battle._actions, seq()))) {
      let u = a.user;
      if (typeof u === "string") u = st[u];
      const mv = truthy(a.move) ? Moves.get(a.move) : a.move;
      if (truthy(u) && truthy(mv) && tonumber(mv.effect) === 170 && !truthy(u.expLockedMove) && !truthy(ad.hasStatus(u, "SLP"))) {
        list[len(list) + 1] = u;
      }
    }
  }
  if (len(list) === 0) return undefined;
  sort(list, (a: any, b: any) => lor(a.expTurnOrder, 9) < lor(b.expTurnOrder, 9));
  const mark = ad.eventMark();
  const prev = ad._say;
  ad._say = () => {};
  for (const [, b] of ipairs(list)) {
    if (!truthy(ad.isFainted(b))) {
      ad.playAnim("general", "FOCUS_PUNCH_SETUP", b, b);
      ad.sayText("STRINGID_PKMNTIGHTENINGFOCUS", { atk: b });
    }
  }
  ad._say = prev;
  return ad.eventsSince(mark);
}

// pokefirered/src/battle_main.c:2856
// Lua: init.lua:939
function begin_start_effects(): boolean {
  const st = Battle._st, ad = Battle._adapter;
  if (!(truthy(st) && truthy(ad) && truthy(Engine.battleStartEffects)) || truthy(st._startEffectsDone)) return false;
  st._startEffectsDone = true;
  const mark = ad.eventMark();
  const prev = ad._say;
  ad._say = () => {};
  let ok = true;
  let startErr: unknown;
  try {
    Engine.battleStartEffects(st, ad);
  } catch (e) {
    ok = false;
    startErr = e;
  }
  ad._say = prev;
  if (!ok) {
    console.log("[game3/battle] start effects failed: " + tostring(startErr));
    return false;
  }
  const evs = ad.eventsSince(mark);
  if (len(evs) === 0) return false;
  if (Battle._headless) {
    for (const [, e] of ipairs(evs)) {
      if (e.kind === "msg") Ui.push(e.text);
    }
    Anim.syncDisplayFromState(st);
    return false;
  }
  AnimSeq.beginEvents(evs, seq_push);
  Battle._phase = "startfx";
  return true;
}

// Lua: init.lua:966
function link_battle(): any {
  // package.loaded["src.core.game3.link.battle"] (link deferred: only reached
  // behind st.link / pending link state)
  return LinkBattle;
}

// pokefirered/src/battle_main.c:3226 HandleTurnActionSelectionState
// Lua: init.lua:971
function link_side_action(st: Tbl, msg: Tbl, id: number | null | undefined, side: string): Tbl {
  if (!isTable(msg)) return undefined;
  const lockedB = lor(id != null ? State.battler(st, id) : id, st[side]);
  if (truthy(lockedB) && (truthy(lockedB.expLockedMove) || truthy(lockedB.expMustRecharge))) {
    // pokefirered/src/battle_main.c:3125
    const mon = lor(lockedB.mon, {});
    const slot = lor(lockedB.expLockedSlot, 1);
    return {
      kind: "move", slot: slot, user: side, locked: true,
      move: orl(() => lockedB.expLockedMove, () => lockedB.lastMoveId, () => lockedB.lastMove, () => land(mon.moves, tk(mon.moves, slot))),
      target: (truthy(st.moveTarget) && id != null) ? orNil(st.moveTarget[id]) : undefined,
    };
  }
  if (msg.kind === "run") return { kind: "run", user: side };
  if (msg.kind === "switch") {
    return { kind: "switch", user: side, slot: tonumber(msg.slot) };
  }
  if (msg.kind === "bag" || msg.kind === "item") {
    const itemId = tonumber(msg.itemId);
    return { kind: (side === "player") ? "bag" : "item", user: side, item: itemId, itemId: itemId };
  }
  const battler = lor(id != null ? State.battler(st, id) : id, st[side]);
  const mon = land(battler, tk(battler, "mon"));
  if (msg.move === "STRUGGLE" || (msg.slot == null && msg.move == null)) {
    return { kind: "move", move: "STRUGGLE", slot: undefined, user: side };
  }
  let slot = Math.floor(tonumber(msg.slot) ?? 1);
  if (slot < 1 || slot > 4) slot = 1;
  const move = (truthy(mon) && truthy(mon.moves)) ? mon.moves[slot] : undefined;
  if (!truthy(move) || move === 0 || move === "") {
    return { kind: "move", move: "STRUGGLE", slot: undefined, user: side };
  }
  return { kind: "move", move: move, slot: slot, user: side };
}

// Lua: init.lua:1004
function link_enemy_action(st: Tbl, msg: Tbl, id?: number | null): Tbl {
  return link_side_action(st, msg, id, "enemy");
}

Battle._linkEnemyAction = link_enemy_action;

// pokefirered/src/cable_club.c:786 gLocalLinkPlayerId ^ 1
// Lua: init.lua:1011
function link_enemy_action_for(st: Tbl, msg: Tbl, id: number): Tbl {
  const act = link_enemy_action(st, msg, id);
  if (!truthy(act)) return undefined;
  act.user = undefined;
  act.battler = id;
  const target = tonumber(land(msg, tk(msg, "target")));
  if (target != null && !truthy(act.locked)) act.target = (lmod(target, 2) === 0) ? (target + 1) : (target - 1);
  return act;
}

// Lua: init.lua:1021
function link_own_action_for(st: Tbl, msg: Tbl, id: number): Tbl {
  const act = link_side_action(st, msg, id, "player");
  if (!truthy(act)) return undefined;
  act.user = undefined;
  act.battler = id;
  if (!truthy(act.locked)) act.target = tonumber(land(msg, tk(msg, "target")));
  return act;
}

// Lua: init.lua:1030
function link_pending_party(st: Tbl, side: string): Tbl {
  if (side === "player") return tk(st, "playerParty");
  return tk(st, "foeParty");
}

// pokefirered/src/battle_controllers.c:248
// Lua: init.lua:1036
function link_canon(st: Tbl, idIn: any): number | undefined {
  const id = tonumber(idIn);
  if (id == null) return undefined;
  if (truthy(st) && truthy(st.multi) && truthy(st.linkSeatOf)) return st.linkSeatOf[id];
  if (truthy(st) && st.linkMaster === false) return (lmod(id, 2) === 0) ? (id + 1) : (id - 1);
  return id;
}

// Lua: init.lua:1044
function link_local(st: Tbl, idIn: any): number | undefined {
  const id = tonumber(idIn);
  if (id == null) return undefined;
  if (truthy(st) && truthy(st.multi) && truthy(st.linkLocalOf)) return st.linkLocalOf[id];
  return link_canon(st, id);
}

// Lua: init.lua:1051
function multi_remote(st: Tbl, id: any): boolean {
  return (truthy(st) && truthy(st.multi) && (truthy(st.spectate) || id !== st.linkOwn)) ? true : false;
}

// pokefirered/data/battle_scripts_1.s:2837 switchhandleorder BS_FAINTED
// Lua: init.lua:1056
function link_replacement(st: Tbl, side: string, battler?: number | null): number | undefined {
  const LB = link_battle();
  if (!truthy(LB)) return undefined;
  let slot: any;
  if (truthy(st) && truthy(st.multi) && battler != null) {
    slot = LB.seatSwitch(st.linkSeatOf[battler]);
  } else if (side === "player") {
    slot = truthy(LB.ownSwitch) ? orNil(LB.ownSwitch()) : undefined;
  } else {
    slot = LB.peerSwitch();
  }
  if (!truthy(slot)) return undefined;
  const party = link_pending_party(st, side);
  const mon = land(party, tk(party, slot));
  if (!(truthy(mon) && (tonumber(mon.hp) ?? 0) > 0)
      || (battler != null && !truthy(State.ownsSlot(st, battler, slot)))) {
    LB.protocolError("switch");
    return undefined;
  }
  return slot;
}

// Lua: init.lua:1078
function link_wait_seat(st: Tbl, side: string, battler?: number | null): number | undefined {
  if (truthy(st) && truthy(st.multi) && battler != null) return st.linkSeatOf[battler];
  if (truthy(st) && truthy(st.spectate)) return (side === "player") ? 0 : 1;
  return undefined;
}

// Lua: init.lua:1084
function link_switch_step(): boolean {
  const pending = Battle._linkSwitch;
  if (!truthy(pending)) return true;
  const st = Battle._st;
  let slot = link_replacement(st, lor(pending.side, "enemy"), pending.battler);
  const LB = link_battle();
  if (!truthy(slot)) {
    if (truthy(LB) && truthy(LB.isActive())) {
      if (!truthy(LB.linkOpen())) {
        // pokefirered/src/cable_club.c:1002
        LB.peerDropped();
      } else if (truthy(LB.peerAhead(link_wait_seat(st, pending.side, pending.battler), tk(st, "turn")))) {
        // pokefirered/src/battle_main.c:3097
        LB.protocolError("switch");
      }
      return false;
    }
    slot = pending.fallback;
  }
  Battle._linkSwitch = undefined;
  pending.cb(slot);
  return true;
}

Battle._linkSwitchStep = link_switch_step;

// Lua: init.lua:1110
function with_link_replacement(st: Tbl, fallback: any, cb: Fn, side?: string, battler?: number | null): any {
  const LB = (truthy(st) && truthy(st.link)) ? orNil(link_battle()) : undefined;
  if (!(truthy(LB) && truthy(LB.isActive()))) return cb(fallback);
  Battle._linkSwitch = { cb: cb, fallback: fallback, side: lor(side, "enemy"), battler: battler };
  Battle._phase = "linkswitch";
  link_switch_step();
}

// pokefirered/src/battle_main.c:4287
// Lua: init.lua:1119
function link_run_result(mine: any, theirs: any): string | undefined {
  if (truthy(mine) && truthy(theirs)) return "draw";
  if (truthy(mine)) return "run";
  if (truthy(theirs)) return "win";
  return undefined;
}

// Lua: init.lua:1126
function link_run_end(st: Tbl, result: string): void {
  st.over = true;
  st.result = result;
  st.linkRan = true;
  st.endReason = "link_run";
  Battle._actions = seq();
  Battle._metaAct = undefined;
  Battle._midTurn = undefined;
  const shown = (result === "run") ? "lose" : result;
  Ui.push(Battle.linkEndText(st, shown, true));
  Battle._pendingEnd = result;
  Battle._phase = "ending";
}

// Lua: init.lua:1140
function resolve_turn(playerAct: Tbl, enemyAct: Tbl): void {
  const st = Battle._st;
  const ad = Battle._adapter;
  const planned = Engine.planTurnFromActions(st, ad, playerAct, enemyAct);
  const actions = planned[0];
  let meta = planned[1];
  const first = land(actions, tk(actions, 1));
  if (truthy(meta) && truthy(st.link) && st.linkMaster === false && truthy(first) && first.battler === 1
      && (first.kind === "switch" || first.kind === "item")) {
    // pokefirered/src/battle_main.c:3586
    insert(actions, 2, { kind: "player_meta", meta: meta, battler: 0 });
    meta = undefined;
  }
  open_turn(st, playerAct, enemyAct, undefined);
  Battle._actions = actions;
  Battle._actionI = 1;
  Battle._metaAct = meta;
  Battle._phase = "actions";
  Battle._midTurn = true;
  const evs = focus_punch_prelude();
  if (truthy(evs) && len(evs) > 0) {
    if (Battle._headless) {
      for (const [, e] of ipairs(evs)) {
        if (e.kind === "msg") Ui.push(e.text);
      }
    } else {
      AnimSeq.beginEvents(evs, seq_push);
      Battle._phase = "preturn";
    }
  }
}

// pokefirered/src/battle_main.c:3097
// Lua: init.lua:1171
function multi_turn_step(): boolean {
  const st = Battle._st;
  const LB = link_battle();
  const got: Tbl = {};
  for (let id = 0; id <= 3; id++) {
    if (truthy(State.battler(st, id)) && !truthy(State.isAbsent(st, id)) && multi_remote(st, id)) {
      const msg = LB.seatAction(st.linkSeatOf[id], st.turn);
      if (!truthy(msg)) {
        // pokefirered/src/cable_club.c:1002
        if (!truthy(LB.linkOpen())) {
          LB.peerDropped();
        } else if (truthy(LB.peerAhead(st.linkSeatOf[id], st.turn))) {
          LB.protocolError("action");
        }
        return false;
      }
      got[id] = msg;
    }
  }
  const chosen = lor(Battle._linkAct, {});
  Battle._linkAct = undefined;
  Battle._linkMulti = undefined;
  st.monToSwitchInto = lor(st.monToSwitchInto, {});
  for (let id = 0; id <= 3; id++) {
    const msg = got[id];
    if (truthy(msg)) {
      LB.forgetSeatAction(st.linkSeatOf[id], st.turn);
      // pokefirered/src/battle_main.c:3182
      if (msg.kind === "list" || msg.kind === "bag" || msg.kind === "item" || msg.actions != null) {
        LB.protocolError("action");
        return false;
      }
      const side = State.sideOf(id);
      const act = link_side_action(st, msg, id, side);
      act.user = undefined;
      act.battler = id;
      if (!truthy(act.locked)) act.target = link_local(st, msg.target);
      if (act.kind === "switch") {
        const party = link_pending_party(st, side);
        const mon = (truthy(party) && truthy(act.slot)) ? party[act.slot] : undefined;
        if (!(truthy(mon) && (tonumber(mon.hp) ?? 0) > 0 && truthy(State.ownsSlot(st, id, act.slot)))) {
          LB.protocolError("switch");
          return false;
        }
        st.monToSwitchInto[id] = act.slot;
      }
      chosen[id] = act;
    }
  }
  const ran = (a: any): boolean => a != null && a.kind === "run";
  // pokefirered/src/battle_main.c:4283
  const result = link_run_result(ran(chosen[0]) || ran(chosen[2]), ran(chosen[1]) || ran(chosen[3]));
  if (truthy(result)) {
    link_run_end(st, result as string);
    return true;
  }
  D.resolveDoubleTurn(chosen);
  return true;
}

// Lua: init.lua:1231
function link_turn_step(): boolean {
  const st = Battle._st;
  const LB = link_battle();
  if (!(truthy(st) && truthy(LB))) {
    Battle._phase = "command";
    return false;
  }
  if (truthy(Battle._linkMulti)) return multi_turn_step();
  const msg = LB.peerAction(st.turn);
  if (!truthy(msg)) {
    // pokefirered/src/cable_club.c:1002 Task_WaitForLinkPlayerConnection
    if (!truthy(LB.linkOpen())) {
      LB.peerDropped();
    } else if (truthy(LB.peerAhead(truthy(st.spectate) ? 1 : undefined, st.turn))) {
      LB.protocolError("action");
    }
    return false;
  }
  LB.forgetAction(st.turn);
  const playerAct = Battle._linkAct;
  Battle._linkAct = undefined;
  if (truthy(Battle._linkDouble)) {
    Battle._linkDouble = undefined;
    const chosen = lor(playerAct, {});
    const list = msg.actions;
    if (msg.kind !== "list" || !isTable(list) || len(list) !== 2) {
      LB.protocolError("action");
      return false;
    }
    const mineRun = (truthy(chosen[0]) && chosen[0].kind === "run") || (truthy(chosen[2]) && chosen[2].kind === "run");
    let theirRun = false;
    st.monToSwitchInto = lor(st.monToSwitchInto, {});
    // pokefirered/src/battle_main.c:3226
    for (const [i, id] of ipairs<number>(seq(1, 3))) {
      if (truthy(State.battler(st, id)) && !truthy(State.isAbsent(st, id))) {
        chosen[id] = link_enemy_action_for(st, list[i], id);
        if (truthy(chosen[id]) && chosen[id].kind === "run") theirRun = true;
        if (truthy(chosen[id]) && chosen[id].kind === "switch") st.monToSwitchInto[id] = chosen[id].slot;
      }
    }
    const ran = link_run_result(mineRun, theirRun);
    if (truthy(ran)) {
      link_run_end(st, ran as string);
      return true;
    }
    D.resolveDoubleTurn(chosen);
    return true;
  }
  if (msg.kind === "list") {
    LB.protocolError("action");
    return false;
  }
  const enemyAct = link_enemy_action(st, msg);
  const ran = link_run_result(truthy(playerAct) && playerAct.kind === "run", truthy(enemyAct) && enemyAct.kind === "run");
  if (truthy(ran)) {
    link_run_end(st, ran as string);
    return true;
  }
  resolve_turn(playerAct, enemyAct);
  return true;
}

// Lua: init.lua:1293
function spectate_turn_step(): boolean {
  const st = Battle._st;
  const LB = link_battle();
  if (!(truthy(st) && truthy(LB) && truthy(LB.ownAction))) return false;
  const turn = st.turn + 1;
  if (truthy(st.multi)) {
    for (let id = 0; id <= 3; id++) {
      if (truthy(State.battler(st, id)) && !truthy(State.isAbsent(st, id)) && !truthy(LB.seatAction(st.linkSeatOf[id], turn))) {
        if (!truthy(LB.linkOpen())) {
          LB.peerDropped();
        } else if (truthy(LB.peerAhead(st.linkSeatOf[id], turn))) {
          LB.protocolError("action");
        }
        return false;
      }
    }
    LB.beginSpectatedTurn(turn);
    st.monToSwitchInto = {};
    st.turn = turn;
    Battle._linkAct = {};
    Battle._linkMulti = true;
    Battle._phase = "linkwait";
    return link_turn_step();
  }
  const msg = LB.ownAction(turn);
  if (!truthy(msg)) {
    if (!truthy(LB.linkOpen())) {
      LB.peerDropped();
    } else if (truthy(LB.peerAhead(0, turn))) {
      LB.protocolError("action");
    }
    return false;
  }
  if (truthy(st.double)) {
    const list = msg.actions;
    if (msg.kind !== "list" || !isTable(list) || len(list) !== 2) {
      LB.protocolError("action");
      return false;
    }
    const chosen: Tbl = {};
    for (const [i, id] of ipairs<number>(seq(0, 2))) {
      if (truthy(State.battler(st, id)) && !truthy(State.isAbsent(st, id))) {
        chosen[id] = link_own_action_for(st, list[i], id);
        if (truthy(chosen[id]) && chosen[id].kind === "switch") {
          st.monToSwitchInto = lor(st.monToSwitchInto, {});
          st.monToSwitchInto[id] = chosen[id].slot;
        }
      }
    }
    st.monToSwitchInto = lor(st.monToSwitchInto, {});
    st.turn = turn;
    Battle._linkAct = chosen;
    Battle._linkDouble = true;
    Battle._phase = "linkwait";
    return link_turn_step();
  }
  if (msg.kind === "list") {
    LB.protocolError("action");
    return false;
  }
  const act = link_side_action(st, msg, 0, "player");
  st.turn = turn;
  Battle._linkAct = act;
  Battle._phase = "linkwait";
  return link_turn_step();
}

Battle._spectateTurnStep = spectate_turn_step;

Battle._linkTurnStep = link_turn_step;
Battle._linkBattle = link_battle;

// pokefirered/src/battle_main.c:3182 BattleScript_ActionSelectionItemsCantBeUsed
// Lua: init.lua:1366
function refuse_link_item(input: any): boolean {
  const st = Battle._st;
  if (!(truthy(input) && truthy(st) && truthy(st.link))) return false;
  if (Ui._mode !== "menu" || !truthy(input.wasPressed("a"))) return false;
  if ((Commands.MENU as Tbl)[lor(Ui._menuIndex, 1)] !== "BAG") return false;
  Ui.refuseItems();
  return true;
}

Battle._refuseLinkItem = refuse_link_item;

// Lua: init.lua:1377
function auto_player_action(st: Tbl): Tbl {
  if (truthy(st) && truthy(st.oldManTutorial)) {
    return { kind: "bag", itemId: 4, user: "player" };
  }
  if (truthy(Wally.active(st))) return Wally.take(st)[0];
  // pokefirered/src/battle_controller_pokedude.c:2429 PokedudeSimulateInputChooseAction
  if (truthy(st) && truthy(st.pokedude)) return Pokedude.autoPlayerAction(st);
  return Commands.playerAction(st, 1, 1);
}

// Lua: init.lua:1387
function begin_turn_with(playerActIn: Tbl): void {
  let playerAct = playerActIn;
  const st = Battle._st;
  if (truthy(st) && truthy(st.double)) { D.startSelection(); return; }
  const fac = land(st, tk(st, "facility"));
  if (truthy(fac) && truthy(fac.turnStart) && st._facilityTurn !== st.turn) {
    // pokeemerald/src/battle_main.c:4015
    st._facilityTurn = st.turn;
    fac.turnStart(st, Battle._adapter, true);
  }
  if (truthy(playerAct) && playerAct.kind === "safari" && playerAct.action === "pokeblock" && !truthy(playerAct.pokeblock)) {
    // pokeemerald/src/battle_controller_safari.c:283
    Battle._phase = "safari_pokeblock";
    const back_to_menu = (): void => {
      Battle._phase = "command";
      Ui.openMenu();
    };
    // NOT FAITHFUL: Emerald only (src.core.game3.rse.init has no file in the port).
    const found = requireMissing("src.core.game3.rse.init").call("pokeblock", "chooseForBattle",
      "safari POKeBLOCK case", undefined, st.session, (block: any) => {
        if (truthy(block)) {
          playerAct.pokeblock = block;
          return begin_turn_with(playerAct);
        }
        back_to_menu();
      })[1];
    if (!truthy(found)) back_to_menu();
    return;
  }
  if (truthy(playerAct) && playerAct.kind === "wally_throw") {
    // pokeemerald/src/battle_util.c:625
    st.turn = st.turn + 1;
    open_turn(st, playerAct, undefined, undefined);
    Battle._actions = seq();
    Battle._actionI = 1;
    Battle._metaAct = playerAct;
    Battle._phase = "actions";
    Battle._midTurn = true;
    return;
  }
  if (truthy(st) && truthy(st.link) && truthy(playerAct) && playerAct.kind === "bag") {
    // pokefirered/src/battle_main.c:3182
    Ui.refuseItems();
    Battle._phase = "command";
    return;
  }
  const LB = truthy(st.link) ? orNil(link_battle()) : undefined;
  if (truthy(LB) && truthy(LB.isActive())) {
    const pb = st.player;
    if (truthy(pb) && (truthy(pb.expLockedMove) || truthy(pb.expMustRecharge))) {
      // pokefirered/src/battle_main.c:3125
      playerAct = D.lockedAction(st, 0);
      playerAct.user = "player";
    }
  }
  st.turn = st.turn + 1;
  if (truthy(LB) && truthy(LB.isActive())) {
    LB.sendAction(st.turn, playerAct);
    if (truthy(st.over) || !Battle._active) return;
    Battle._linkAct = playerAct;
    Battle._phase = "linkwait";
    link_turn_step();
    return;
  }
  // pokefirered/src/battle_controllers.c:93
  let enemyAct = truthy(st.pokedude) ? Pokedude.enemyAction(st) : st.pokedude;
  if (!truthy(enemyAct)) enemyAct = Commands.enemyAction(st);
  // pokeemerald/src/battle_main.c:4185
  if (truthy(fac) && truthy(fac.actions)) [playerAct, enemyAct] = fac.actions(st, playerAct, enemyAct);
  resolve_turn(playerAct, enemyAct);
}

// Lua: init.lua:1456
function choice_hooks(): Tbl {
  return {
    pushMsg: (text: any, cb?: any) => { Ui.push(text, cb); },
    askYesNo: (a: any, b?: any) => { Ui.askYesNo(a, b); },
    askForget: (labels: any, cb: any, ctx?: any) => { Ui.askForget(labels, cb, ctx); },
    headless: Battle._headless,
    battleText: true,
  };
}
Battle._choiceHooksForTests = choice_hooks;

// Lua: init.lua:1467
function merge_leveled_set(set: Tbl): Tbl {
  Battle._leveledUp = lor(Battle._leveledUp, {});
  for (const [partyIndex, leveled] of pairs(lor(set, {}))) {
    if (truthy(leveled)) Battle._leveledUp[partyIndex] = true;
  }
  return Battle._leveledUp;
}

Battle._mergeLeveledSet = merge_leveled_set;

// Lua: init.lua:1477
function begin_evo_or_end(): void {
  const st = Battle._st;
  Battle._pendingEnd = lor(Battle._pendingEnd, "win");
  if (Battle._pendingEnd !== "win" || !truthy(st)) {
    Battle._phase = "ending";
    return;
  }
  const leveled = truthy(Battle._leveledUp) ? Battle._leveledUp : ExpSeq.leveledSet();
  // package.loaded["src.core.game3.runtime"]
  const session = lor(runtime_session(), tk(Battle._st, "session"));
  const pending = Evolution.pending(st.playerParty, leveled, session);
  if (Battle._headless) {
    for (const [, entry] of ipairs(pending)) {
      const fromName = Pokemon.displayMonName(entry.mon);
      const intoName = Pokemon.name(entry.toSpecies);
      // pokefirered/src/evolution_scene.c:678
      Ui.push(RomText.ascii("gText_PkmnIsEvolving", { stringVars: seq(fromName) }));
      Evolution.apply(entry.mon, entry.toSpecies, session);
      // pokefirered/src/evolution_scene.c:775
      Ui.push(RomText.ascii("gText_CongratsPkmnEvolved", { stringVars: seq(fromName, intoName) }));
    }
    Battle._phase = "ending";
    return;
  }
  const hooks = choice_hooks();
  hooks.session = session;
  const started = EvoSeq.begin(pending, hooks);
  if (truthy(started)) {
    Battle._phase = "evolving";
  } else {
    Battle._phase = "ending";
  }
}

// (Lua: `local resume_turn` forward declaration -- resume_turn is a hoisted function below.)

// Lua: init.lua:1514
function send_out_enemy_next(nextEnemyIdx: any, after?: Fn): void {
  const st = Battle._st;
  if (!truthy(st)) return;
  const pushFn = (text: any) => { Ui.push(text); };
  const onDone = (): any => {
    if (truthy(after)) return after!();
    resume_turn();
  };
  if (Battle._headless || Battle._auto) {
    SwitchSeq.beginSendOut(st, "enemy", nextEnemyIdx, {
      headless: true,
      pushMsg: pushFn,
      onDone: onDone,
    });
  } else {
    SwitchSeq.beginSendOut(st, "enemy", nextEnemyIdx, {
      headless: false,
      pushMsg: pushFn,
      onDone: onDone,
    });
    Battle._phase = "switching";
  }
}

// pokefirered/src/battle_script_commands.c:3413
// Lua: init.lua:1539
D.linkDraw = function (st: Tbl): void {
  st.over = true;
  st.result = "draw";
  Battle._actions = seq();
  Battle._pendingEnd = "draw";
  Battle._phase = "ending";
  // pokefirered/data/battle_scripts_1.s:2984
  Ui.push(Battle.linkEndText(st, "draw"));
};

// pokefirered/src/battle_main.c:3781
// Lua: init.lua:1550
D.pushBattleLost = function (st: Tbl): void {
  if (truthy(st) && truthy(st.link) && truthy(st.towerLinkMulti) && truthy(st.trainerB)) {
    // pokeemerald/data/battle_scripts_1.s:2980 BattleScript_FrontierLinkBattleLost
    if (truthy(st.victoryText) && st.victoryText !== "") Ui.push(st.victoryText);
    if (truthy(st.trainerB.victoryText) && st.trainerB.victoryText !== "") Ui.push(st.trainerB.victoryText);
    return;
  }
  if (truthy(st) && truthy(st.link)) {
    // pokefirered/data/battle_scripts_1.s:2984 BattleScript_LinkBattleWonOrLost
    Ui.push(Battle.linkEndText(st, "lose"));
    return;
  }
  if (truthy(st) && truthy(st.earlyRival)) {
    // pokefirered/data/battle_scripts_1.s:2953
    if (truthy(st.victoryText) && st.victoryText !== "") Ui.push(st.victoryText);
    // pokefirered/src/battle_controller_oak_old_man.c:1780
    Oak.say(st, "howDisappointing");
    if (truthy(st.rivalHealAfter)) return;
  }
  if (BattleProfile.rule(st, "lostText") === "rse") {
    // pokeemerald/data/battle_scripts_1.s:2949
    if (truthy(st.frontierTrainer)) {
      // pokeemerald/data/battle_scripts_1.s:2968
      if (truthy(st.victoryText) && st.victoryText !== "") Ui.push(st.victoryText);
      return;
    }
    if (truthy(st.eReader) || truthy(st.secretBase)) return;
    const fill = Adapter.fill(st);
    Ui.push(BattleText.get("STRINGID_PLAYERWHITEOUT", fill));
    Ui.push(BattleText.get("STRINGID_PLAYERWHITEOUT2", fill));
    return;
  }
  const session = tk(st, "session");
  const money = tonumber(tk(session, "money")) ?? 0;
  // pokefirered/src/battle_script_commands.c:5379
  const loss = Math.min(BattleBridge.calcMoneyLossFrlg(session), money);
  const fill = Adapter.fill(st, { buff1: tostring(loss) });
  if (truthy(st) && truthy(st.wild)) {
    // pokefirered/data/battle_scripts_1.s:2932
    Ui.push(BattleText.get("STRINGID_PLAYERWHITEOUT", fill));
    Ui.push(BattleText.get(loss > 0 ? "STRINGID_PLAYERWHITEOUT2" : "STRINGID_PLAYERWHITEDOUT", fill));
  } else {
    // pokefirered/data/battle_scripts_1.s:2940
    Ui.push(BattleText.get("STRINGID_PLAYERLOSTAGAINSTENEMYTRAINER", fill));
    Ui.push(BattleText.get(loss > 0 ? "STRINGID_PLAYERPAIDPRIZEMONEY" : "STRINGID_PLAYERWHITEDOUT", fill));
  }
};

// Lua: init.lua:1598
function handle_player_faint(optsIn?: Tbl): any {
  const opts = lor(optsIn, {});
  const st = Battle._st;
  if (!truthy(st)) return;
  if (truthy(st.player) && truthy(st.playerParty)) {
    State.syncBattlerToParty(st.player, st.playerParty);
  }
  const hasLiving = Engine.hasLivingMons(st.playerParty);
  if (!truthy(hasLiving)) {
    if (truthy(st.link) && truthy(st.enemy) && truthy(st.foeParty)) State.syncBattlerToParty(st.enemy, st.foeParty);
    if (truthy(st.link) && !truthy(Engine.hasLivingMons(st.foeParty))) return D.linkDraw(st);
    Battle._pendingEnd = "lose";
    Battle._phase = "ending";
    D.pushBattleLost(st);
    return;
  }

  const onDone = (): any => {
    if (truthy(opts.after)) return opts.after();
    resume_turn();
  };

  if (truthy(st.spectate)) {
    const nextI = lor(Engine.nextLivingMonIndex(st.playerParty, land(st.player, tk(st.player, "partyIndex"))), 1);
    return with_link_replacement(st, nextI, (slot: any) => {
      SwitchSeq.beginSendOut(st, "player", slot, {
        headless: Battle._headless,
        pushMsg: (t: any) => { Ui.push(t); },
        onDone: onDone,
      });
      if (!Battle._headless) Battle._phase = "switching";
    }, "player");
  }

  if (Battle._headless || Battle._auto) {
    const nextI = lor(Engine.nextLivingMonIndex(st.playerParty, land(st.player, tk(st.player, "partyIndex"))), 1);
    if (truthy(st.link)) {
      const LB = link_battle();
      if (truthy(LB)) LB.sendSwitch(nextI);
    }
    SwitchSeq.beginSendOut(st, "player", nextI, {
      headless: true,
      pushMsg: (t: any) => { Ui.push(t); },
      onDone: onDone,
    });
    return;
  }

  if (truthy(st.facility) && truthy(st.facility.fixedOrder)) {
    // pokeemerald/src/battle_controller_player.c:2672
    const nextI = lor(Engine.nextLivingMonIndex(st.playerParty, land(st.player, tk(st.player, "partyIndex"))), 1);
    SwitchSeq.beginSendOut(st, "player", nextI, {
      headless: false,
      pushMsg: (t: any) => { Ui.push(t); },
      onDone: onDone,
    });
    Battle._phase = "switching";
    return;
  }

  const PartyMenu: any = PartyMenuMod;
  // package.loaded["src.core.game3.runtime"]
  const session = runtime_session();
  State.syncBattlerToParty(st.player, st.playerParty);
  if (truthy(Ui.clearLinger)) Ui.clearLinger();
  Battle._phase = "switching";
  PartyMenu.show(lor(st.playerParty, tk(session, "party")), tk(session, "move_overlay"), {
    mode: "battle_faint",
    session: session,
    activeSlot: st.player.partyIndex,
    battle: true,
    validate: (slot: any) => Commands.switchError(st, slot, true),
    onSelect: (slot: any) => {
      if (truthy(st.link)) {
        // pokefirered/data/battle_scripts_1.s:2837 switchhandleorder BS_FAINTED
        const LB = link_battle();
        if (truthy(LB)) LB.sendSwitch(slot);
      }
      SwitchSeq.beginSendOut(st, "player", slot, {
        headless: false,
        pushMsg: (t: any) => { Ui.push(t); },
        onDone: onDone,
      });
      Battle._phase = "switching";
    },
  });
}

// Lua: init.lua:1686
function wild_victory_song(st: Tbl, awards: Tbl): void {
  if (!truthy(st) || !truthy(st.wild) || truthy(st.pokedude) || truthy(st.link) || truthy(st._wildVictorySong)) return;
  if (!(truthy(awards) && len(awards) > 0)) return;
  const lead = truthy(State.battler) ? lor(State.battler(st, 0), st.player) : st.player;
  if (!(truthy(lead) && truthy(lead.mon) && (tonumber(lead.mon.hp) ?? 0) > 0)) return;
  st._wildVictorySong = true;
  stop_low_hp_song();
  const bp: any = BattleProfile.of(st);
  if (truthy(bp.music)) {
    // pokeemerald/src/battle_script_commands.c:3363
    Audio.playSong(BattleProfile.victorySong(bp, Battle.songInfo(st)));
  } else {
    // pokefirered/src/battle_script_commands.c:3219
    const id = Audio.role("victoryWild");
    if (truthy(id)) Audio.playSong(id);
  }
}

// Lua: init.lua:1705
function begin_trainer_win(st: Tbl): void {
  Battle._pendingEnd = "win";
  const bp: any = BattleProfile.of(st);
  // pokeemerald/src/battle_main.c:5011
  if (truthy(st) && !truthy(st.wild)) {
    if (truthy(bp.music)) {
      // pokeemerald/src/battle_main.c:4983
      Audio.playSong(BattleProfile.victorySong(bp, Battle.songInfo(st)));
    } else if (!truthy(st.pokedude)) {
      const [role, fallback] = Trainers.getVictoryMusicRole(st.trainerId);
      Audio.playSong(lor(Audio.role(role), fallback));
    }
  }

  const pname = st.playerName;
  const twoTrainers = st.trainerB != null;
  // pokefirered/data/battle_scripts_1.s:2991 BattleScript_BattleTowerTrainerBattleWon
  const facilityTrainer = (truthy(st.trainerTower) || truthy(st.eReader) || truthy(st.frontierTrainer)) ? true : false;
  const push_defeated = (): void => {
    // pokeemerald/data/battle_scripts_1.s:2921
    if (twoTrainers) {
      Ui.push(BattleText.get("STRINGID_TWOENEMIESDEFEATED", Adapter.fill(st)));
      return;
    }
    // pokefirered/data/battle_scripts_1.s:2912
    Ui.push(BattleText.get("STRINGID_PLAYERDEFEATEDTRAINER1", Adapter.fill(st)));
  };
  const lose_text_a = (): any => {
    const dialogs = (!facilityTrainer) ? Trainers.dialogs(st.trainerId) : undefined;
    return lor(st.defeatText, land(dialogs, tk(dialogs, "defeat")));
  };
  const push_lose_text_and_money = (slidOut?: boolean): void => {
    let defeatSpeech = lose_text_a();
    if (twoTrainers && truthy(slidOut)) {
      // pokeemerald/data/battle_scripts_1.s:2935
      defeatSpeech = st.trainerB.defeatText;
    } else if (twoTrainers) {
      if (truthy(defeatSpeech) && defeatSpeech !== "") Ui.push(defeatSpeech);
      defeatSpeech = st.trainerB.defeatText;
    }
    // pokefirered/data/battle_scripts_1.s:2915
    if (truthy(defeatSpeech) && defeatSpeech !== "") {
      Ui.push(defeatSpeech);
    }
    // pokefirered/data/battle_scripts_1.s:2999 no getmoneyreward on the tower branch
    if (facilityTrainer) return;
    // package.loaded["src.core.game3.runtime"]
    const session = runtime_session();
    if (truthy(session) && bp.rules.money === "rse") {
      // pokeemerald/data/battle_scripts_1.s:2937
      const amount = Prize.rewardRse(st.trainerId, {
        double: lor(st.double, false),
        twoOpponents: land(st.kinds, tk(st.kinds, "twoOpponents")),
        trainerIdB: st.trainerIdB,
        moneyMultiplier: lor(st.moneyMultiplier, 1),
      });
      Prize.apply(session, amount);
      Ui.push(Prize.moneyMessage(lor(session.name, pname), amount));
    } else if (truthy(session)) {
      const info = Trainers.info(st.trainerId);
      let lastLevel = truthy(info) ? tonumber(info.lastLevel) : undefined;
      if (lastLevel == null || lastLevel < 1) {
        lastLevel = lor((truthy(st.enemy) && truthy(st.enemy.mon)) ? tonumber(st.enemy.mon.level) : undefined, 1);
      }
      const gained = Prize.awardTrainerWin(session, st.trainerId, {
        lastLevel: lastLevel,
        double: lor(st.double, false),
        moneyMultiplier: lor(st.moneyMultiplier, 1),
      });
      if (gained > 0) {
        Ui.push(Prize.moneyMessage(lor(session.name, pname), gained));
        // pokefirered/src/battle_controller_oak_old_man.c:1776
        Oak.say(st, "winEarnsPrize");
      }
    }
  };

  const give_payday_money_and_pickup = (): void => {
    // package.loaded["src.core.game3.runtime"]
    const session = lor(runtime_session(), st.session);
    // pokefirered/src/battle_script_commands.c:7066
    const bonus = (!(truthy(st.link) || facilityTrainer))
      // pokefirered/data/battle_scripts_1.s:2920
      ? lor(Prize.payDay(session, st.payDayCoins, { moneyMultiplier: lor(st.moneyMultiplier, 1) }), 0)
      : 0;
    if (bonus > 0) {
      Ui.push(Prize.payDayMessage(lor(tk(session, "name"), pname), bonus));
    }
    let pickupRules = bp.rules;
    if (truthy(session) && bp.family === "rse") {
      // pokeemerald/src/battle_script_commands.c:9660
      // pcall(require, "src.core.game3.rse.frontier.pike") fails: no file in the port.
      const okPike = false;
      const Pike: any = undefined;
      const inPike = okPike && truthy(Pike.inBattlePike) && Pike.inBattlePike(session);
      if (truthy(inPike) || truthy(st.pyramid)) {
        pickupRules = {};
        for (const [key, value] of pairs(lor(bp.rules, {}))) pickupRules[key] = value;
        pickupRules.noPickup = truthy(inPike) ? true : undefined;
        pickupRules.pyramidSession = truthy(st.pyramid) ? orNil(session) : undefined;
      }
    }
    Prize.pickup(lor(st.playerParty, tk(session, "party")), undefined, pickupRules);
  };

  if (truthy(st.link) && truthy(st.towerLinkMulti) && truthy(st.trainerB)) {
    // pokeemerald/data/battle_scripts_1.s:3009 BattleScript_TowerLinkBattleWon
    Ui.push(Battle.linkEndText(st, "win"));
    const lose_text_b = (): void => {
      if (truthy(st.trainerB.defeatText) && st.trainerB.defeatText !== "") Ui.push(st.trainerB.defeatText);
    };
    if (Battle._headless) {
      if (truthy(st.defeatText) && st.defeatText !== "") Ui.push(st.defeatText);
      lose_text_b();
      begin_evo_or_end();
      return;
    }
    SwitchSeq.beginTrainerSlideIn(st, {
      headless: false,
      trainerB: st.trainerB,
      loseTextA: st.defeatText,
      pushMsg: (t: any) => { Ui.push(t); },
      onDone: () => {
        lose_text_b();
        begin_evo_or_end();
      },
    });
    Battle._phase = "switching";
    return;
  }

  if (truthy(st.link)) {
    // pokefirered/data/battle_scripts_1.s:2984 BattleScript_LinkBattleWonOrLost
    Ui.push(Battle.linkEndText(st, "win"));
    begin_evo_or_end();
    return;
  }

  if (!truthy(st.wild) && truthy(st.trainerId) && !Battle._headless) {
    push_defeated();
    SwitchSeq.beginTrainerSlideIn(st, {
      headless: false,
      trainerB: st.trainerB,
      loseTextA: twoTrainers ? orNil(lose_text_a()) : undefined,
      pushMsg: (t: any) => { Ui.push(t); },
      onDone: () => {
        push_lose_text_and_money(twoTrainers);
        give_payday_money_and_pickup();
        begin_evo_or_end();
      },
    });
    Battle._phase = "switching";
  } else {
    if (!truthy(st.wild) && truthy(st.trainerId)) {
      push_defeated();
      push_lose_text_and_money();
    }
    // pokefirered/src/battle_main.c:3764
    give_payday_money_and_pickup();
    begin_evo_or_end();
  }
}

// Lua: init.lua:1871
function push_awards_headless(awards: Tbl): void {
  for (const [, entry] of ipairs(lor(awards, seq()))) {
    const r = lor(entry.result, {});
    if (lor(r.gained, 0) > 0) {
      const name = orl(() => truthy(entry.battler) ? State.displayName(entry.battler) : undefined,
        () => Pokemon.displayMonName(entry.mon));
      // pokefirered/src/battle_script_commands.c:3265
      Ui.push(BattleText.get("STRINGID_PKMNGAINEDEXP", {
        buff1: name,
        buff2: BattleText.get(truthy(entry.boosted) ? "STRINGID_ABOOSTED" : "STRINGID_EMPTYSTRING4"),
        buff3: tostring(r.gained),
      }));
      for (const [, lv] of ipairs(lor(r.levels, seq()))) {
        // pokefirered/src/battle_script_commands.c:3307
        Ui.push(BattleText.get("STRINGID_PKMNGREWTOLV", { buff1: name, buff2: tostring(lv) }));
        Battle._leveledUp[lor(entry.partyIndex, 1)] = true;
      }
      for (const [, lv] of ipairs(lor(r.levels, seq()))) {
        for (const [, mv] of ipairs(Pokemon.movesLearnedAt(
          tonumber(land(entry.mon, tk(entry.mon, "species"))), lv))) {
          if (truthy(Pokemon.teachMove(entry.mon, mv)[0])) {
            // pokefirered/data/battle_scripts_1.s:3143
            Ui.push(BattleText.get("STRINGID_PKMNLEARNEDMOVE", { buff1: name, buff2: Pokemon.moveName(mv) }));
          }
        }
      }
    }
  }
}

// Lua: init.lua:1900
function handle_enemy_faint(optsIn?: Tbl): void {
  const opts = lor(optsIn, {});
  const st = Battle._st;
  if (!truthy(st)) return;
  stop_low_hp_song();
  if (truthy(st.enemy) && truthy(st.foeParty)) {
    State.syncBattlerToParty(st.enemy, st.foeParty);
  }
  let awards: Tbl = seq();
  // pokefirered/src/battle_script_commands.c:3129
  if (truthy(st) && truthy(st.enemy) && !truthy(Kinds.noExp(st))) {
    const partIndices: Tbl = seq();
    if (truthy(st.enemy.participants)) {
      for (const [pi] of pairs(st.enemy.participants)) {
        partIndices[len(partIndices) + 1] = pi;
      }
      sort(partIndices);
    }
    awards = Experience.awardFoe(st, st.enemy, {
      trainer: !truthy(st.wild),
      partyIndices: (len(partIndices) > 0) ? partIndices : undefined,
    });
  }
  let nextEnemyIdx = (!truthy(st.wild)) ? Engine.nextLivingMonIndex(st.foeParty, land(st.enemy, tk(st.enemy, "partyIndex"))) : false;
  // pokeemerald/src/battle_ai_switch_items.c:648
  const fixedOrder = land(st.facility, tk(st.facility, "fixedOrder"));
  if (truthy(nextEnemyIdx) && !truthy(st.link) && !truthy(fixedOrder)) {
    // pokefirered/src/battle_controller_opponent.c:1416
    let okS = true;
    let pick: any;
    try {
      pick = Engine.mostSuitableMon(st, Battle._adapter, "enemy");
    } catch {
      okS = false;
    }
    if (okS && truthy(pick) && truthy(st.foeParty[pick]) && (tonumber(st.foeParty[pick].hp) ?? 0) > 0) {
      nextEnemyIdx = pick;
    }
  }

  const onAwardsFinished = (): any => {
    if (!truthy(nextEnemyIdx)) {
      begin_trainer_win(st);
    } else {
      if (truthy(opts.onFinished)) return opts.onFinished(nextEnemyIdx);
      // pcall(require, "src.core.game3.options") / pcall(require, "src.core.game3.runtime") succeed.
      const okO = true;
      const okR = true;
      const session = (okR && truthy(Runtime.getSession)) ? Runtime.getSession() : undefined;
      const battleStyle = lor((okO && truthy(session) && truthy(Options.battleStyle)) ? Options.battleStyle(session) : undefined, "shift");
      // pokefirered/data/battle_scripts_1.s:2839 a link battle never offers the shift
      if (Battle._headless || Battle._auto || truthy(opts.mutual) || truthy(st.link) || truthy(fixedOrder)
          || battleStyle === "set" || truthy(State.isFainted(st.player))) {
        with_link_replacement(st, nextEnemyIdx, send_out_enemy_next);
      } else {
        const nextMon = st.foeParty[nextEnemyIdx as number];
        const nextSp = land(nextMon, lor(tk(nextMon, "species"), tk(nextMon, "speciesId")));
        const nextName = Pokemon.name(nextSp);
        // pokefirered/data/battle_scripts_1.s:2846
        Ui.push(BattleText.get("STRINGID_ENEMYABOUTTOSWITCHPKMN", Adapter.fill(st, { buff2: nextName })));
        Battle._shiftEnemyIdx = nextEnemyIdx as number;
        Battle._shiftAsked = false;
        Battle._phase = "shift_prompt";
      }
    }
  };

  wild_victory_song(st, awards);
  const hooks = choice_hooks();
  if (truthy(st.pokedude)) {
    for (const [, entry] of ipairs(awards)) {
      if (truthy(entry.result) && lor(entry.result.gained, 0) > 0) {
        // pokefirered/src/battle_script_commands.c:3265
        Pokedude.event(st, "printstring", "player", "STRINGID_PKMNGAINEDEXP");
        break;
      }
    }
  }
  if (Battle._headless) {
    push_awards_headless(awards);
    onAwardsFinished();
    return;
  }

  const started = ExpSeq.begin(awards, hooks.pushMsg, undefined, hooks);
  if (truthy(started)) {
    merge_leveled_set(ExpSeq.leveledSet());
    Battle._onExpDone = onAwardsFinished;
    Battle._phase = "awarding";
  } else {
    onAwardsFinished();
  }
}

// Lua: init.lua:1988
function check_faints_and_end(): boolean {
  const st = Battle._st;
  const ad = Battle._adapter;
  if (!truthy(st)) return false;
  // pokefirered/src/battle_util.c:1146
  if (truthy(st.safari)) return false;

  const pFainted = State.isFainted(st.player);
  const eFainted = State.isFainted(st.enemy);

  if (truthy(pFainted) && truthy(eFainted)) {
    const playerHasLiving = Engine.hasLivingMons(st.playerParty);
    const enemyHasLiving = Engine.hasLivingMons(st.foeParty);
    if (!truthy(playerHasLiving)) {
      handle_player_faint();
      return true;
    } else if (!truthy(enemyHasLiving)) {
      handle_enemy_faint({ mutual: true });
      return true;
    } else {
      // pokefirered/src/battle_util.c:1195
      handle_enemy_faint({
        mutual: true, onFinished: (nextEnemyIdx: any): any => {
          if (truthy(st.link) && !truthy(st.linkMaster)) {
            return with_link_replacement(st, nextEnemyIdx, (slot: any) => {
              send_out_enemy_next(slot, () => { handle_player_faint(); });
            });
          }
          handle_player_faint({
            after: () => {
              with_link_replacement(st, nextEnemyIdx, send_out_enemy_next);
            },
          });
        },
      });
      return true;
    }
  } else if (truthy(eFainted)) {
    handle_enemy_faint();
    return true;
  } else if (truthy(pFainted)) {
    handle_player_faint();
    return true;
  }

  const endResult = Engine.checkEnd(st, ad);
  if (endResult === "win") {
    handle_enemy_faint();
    return true;
  } else if (endResult === "lose") {
    handle_player_faint();
    return true;
  } else if (endResult === "draw" && truthy(st.link)) {
    D.linkDraw(st);
    return true;
  }

  return false;
}

// Lua: init.lua:2044
function after_actions(): void {
  const st = Battle._st;
  const ad = Battle._adapter;
  if (truthy(st) && truthy(st.double)) { D.afterActions(); return; }
  if (end_if_over()) return;
  Battle._midTurn = undefined;
  const events = Engine.collectResidualEvents(st, ad);
  close_turn(st);
  Battle._residualEvents = events;
  Battle._residualIndex = 1;
  Battle._residualStepState = "start";

  if (Battle._headless) {
    for (const [, evt] of ipairs(lor(events, seq()))) {
      push_msgs(evt.msgs);
    }
    if (truthy(st.facility) && truthy(st.facility.endTurn) && st._facilityEndTurn !== st.turn) {
      // pokeemerald/src/battle_util.c:1856
      st._facilityEndTurn = st.turn;
      st.facility.endTurn(st, ad, true);
    }
    Ui.pump();
    if (check_faints_and_end()) {
      return;
    }
    Battle._phase = "command";
    if (Battle._auto) {
      begin_turn_with(auto_player_action(Battle._st));
    }
    return;
  }

  const stream: Tbl = seq();
  for (const [, evt] of ipairs(lor(events, seq()))) {
    for (const [, e] of ipairs(lor(evt.events, seq()))) stream[len(stream) + 1] = e;
  }
  AnimSeq.beginEvents(stream, seq_push);
  Battle._phase = "residuals";
}

// pokefirered/src/battle_main.c:4433
// Lua: init.lua:2085
function resume_turn(): void {
  const st = Battle._st;
  if (!truthy(st)) return;
  if (truthy(Battle._midTurn)) {
    // pokefirered/data/battle_scripts_1.s:2886 cancelallactions
    Battle._actions = seq();
    Battle._phase = "actions";
    return after_actions();
  }
  Battle._phase = "command";
  if (Battle._auto) {
    begin_turn_with(auto_player_action(st));
  } else {
    Ui.openMenu();
  }
}

// Lua: init.lua:2102
function battle_session(st: Tbl): any {
  if (truthy(st) && truthy(st.session)) return st.session;
  // package.loaded["src.core.game3.runtime"]
  return lor(runtime_session(), undefined);
}

// pokefirered/src/safari_zone.c:9
// Lua: init.lua:2109
function safari_sync_balls(st: Tbl): void {
  const session = battle_session(st);
  if (!(truthy(session) && truthy(st) && truthy(st.safariState))) return;
  session.safari = lor(session.safari, {});
  session.safari.balls = st.safariState.balls;
}
Battle.safariSyncBalls = safari_sync_balls;

// Lua: init.lua:2117
function resume_actions(): void {
  Battle._phase = "actions";
  if (!truthy(Battle._actions) || !truthy(Battle._actions[Battle._actionI])) {
    after_actions();
  }
}

// pokefirered/data/battle_scripts_2.s:105
// Lua: init.lua:2125
function safari_out_of_balls(st: Tbl): boolean {
  if (!(truthy(st) && truthy(st.safari) && truthy(st.safariState))) return false;
  if ((tonumber(st.safariState.balls) ?? 0) > 0) return false;
  Ui.push(BattleText.get("STRINGID_OUTOFSAFARIBALLS"));
  Battle._actions = seq();
  st.over = true;
  // pokefirered/data/battle_scripts_2.s:112
  st.result = "no_safari_balls";
  st.endReason = "no_safari_balls";
  Battle._pendingEnd = "no_safari_balls";
  Battle._phase = "ending";
  return true;
}

const SAFARI_BALL_ITEM = 5;

// pokefirered/src/battle_main.c:4371
// Lua: init.lua:2142
function step_safari_ball(): void {
  const st = Battle._st, ad = Battle._adapter;
  const sf = st.safariState;
  const session = battle_session(st);
  if (truthy(sf)) sf.balls = Math.max(0, (tonumber(sf.balls) ?? 0) - 1);
  safari_sync_balls(st);
  st.lastUsedItem = SAFARI_BALL_ITEM;
  const rng = lor((truthy(ad) && truthy(ad.rng)) ? ad.rng() : undefined, st.rng);
  const [caught, shakes] = Catching.tryCatch(SAFARI_BALL_ITEM, st.enemy, st, session, rng);
  const headless = orl(() => Battle._headless, () => land(Ui, Ui._headless), () => false);
  CatchSeq.begin(st, SAFARI_BALL_ITEM, caught, shakes, {
    pushMsg: (text: any) => { Ui.push(text); },
    headless: headless,
    session: session,
  });
  if (truthy(caught)) {
    Battle._actions = seq();
    st.over = true;
    st.result = "catch";
    Battle._pendingEnd = "catch";
    if (truthy(headless)) {
      Battle._phase = "ending";
    } else {
      Battle._phase = "catching";
    }
    return;
  }
  if (!truthy(headless)) {
    Battle._phase = "catching";
    return;
  }
  if (safari_out_of_balls(st)) return;
  return resume_actions();
}

// pokefirered/src/battle_main.c:4382
// Lua: init.lua:2179
function step_safari(meta: Tbl): void {
  const st = Battle._st, ad = Battle._adapter;
  if (meta.action === "ball") return step_safari_ball();
  const sf = st.safariState;
  const session = battle_session(st);
  const rng = lor((truthy(ad) && truthy(ad.rng)) ? ad.rng() : undefined, st.rng);
  const mark = ad.eventMark();
  const prev = ad._say;
  ad._say = () => {};
  const sfCfg = BattleProfile.of(st).safari;
  if (meta.action === "go_near") {
    // pokeemerald/data/battle_scripts_2.s:180
    const id = Rules.safari.goNear(sf, Rules.safari.rseTables(sfCfg));
    ad.sayText(id, { playerName: lor(tk(session, "name"), st.playerName), opponentMon1: st.enemy });
  } else if (meta.action === "pokeblock") {
    // pokeemerald/data/battle_scripts_2.s:185
    const block = lor(meta.pokeblock, {});
    const tables = Rules.safari.rseTables(sfCfg);
    const nature = (truthy(st.enemy) && truthy(st.enemy.mon)) ? st.enemy.mon.nature : undefined;
    const result = Rules.safari.throwPokeblock(sf, tables, Rules.safari.pokeblockGain(tables, nature, block.flavors));
    ad.sayText("STRINGID_THREWPOKEBLOCKATPKMN", {
      playerName: lor(tk(session, "name"), st.playerName),
      opponentMon1: st.enemy,
    });
    ad.playAnim("general", "POKEBLOCK_THROW", st.player, st.enemy);
    ad.sayText(Rules.safari.POKEBLOCK_RESULT[result], { opponentMon1: st.enemy, buff1: lor(block.name, "") });
  } else if (meta.action === "rock") {
    // pokefirered/src/battle_main.c:4398
    Rules.safari.throwRock(sf, rng);
    ad.sayText("STRINGID_THREWROCK", { playerName: lor(tk(session, "name"), st.playerName), opponentMon1: st.enemy });
    ad.playAnim("general", "ROCK_THROW", st.player, st.enemy);
  } else {
    Rules.safari.throwBait(sf, rng);
    ad.sayText("STRINGID_THREWBAIT", { playerName: lor(tk(session, "name"), st.playerName), opponentMon1: st.enemy });
    ad.playAnim("general", "BAIT_THROW", st.player, st.enemy);
  }
  ad._say = prev;
  const evs = ad.eventsSince(mark);
  if (Battle._headless) {
    for (const [, e] of ipairs(evs)) {
      if (e.kind === "msg") Ui.push(e.text);
    }
    return resume_actions();
  }
  AnimSeq.beginEvents(evs, seq_push);
  Battle._phase = "animating";
}

// pokefirered/src/battle_main.c:4334
// Lua: init.lua:2226
function step_safari_enemy(act: Tbl): void {
  const st = Battle._st, ad = Battle._adapter;
  const mark = ad.eventMark();
  const prev = ad._say;
  ad._say = () => {};
  if (act.kind === "run") {
    // pokefirered/src/battle_main.c:3819
    ad.sayText("STRINGID_WILDPKMNFLED", { buff1: State.displayName(st.enemy) });
    st.over = true;
    st.result = "run";
    st.endReason = "enemy_fled";
  } else {
    const reaction = Rules.safari.watchStep(st.safariState);
    if (reaction === "angry") {
      st.safariReaction = 1;
      // pokefirered/src/battle_message.c:1188
      ad.sayText("STRINGID_PKMNANGRY", { opponentMon1: st.enemy });
    } else if (reaction === "eating") {
      st.safariReaction = 2;
      ad.sayText("STRINGID_PKMNEATING", { opponentMon1: st.enemy });
    } else {
      st.safariReaction = 0;
      ad.sayText("STRINGID_PKMNWATCHINGCAREFULLY", { opponentMon1: st.enemy });
    }
    ad.playAnim("general", "SAFARI_REACTION", st.enemy, st.enemy);
  }
  ad._say = prev;
  const evs = ad.eventsSince(mark);
  if (Battle._headless) {
    for (const [, e] of ipairs(evs)) {
      if (e.kind === "msg") Ui.push(e.text);
    }
    if (end_if_over()) return;
    return resume_actions();
  }
  AnimSeq.beginEvents(evs, seq_push);
  Battle._phase = "animating";
}

// Lua: init.lua:2265
function step_enemy_flee(_act: Tbl): void {
  const st = Battle._st, ad = Battle._adapter;
  if (!truthy(st) || !truthy(st.enemy)) return;
  if (truthy(State.isFainted(st.enemy))) {
    if (!truthy(Battle._actions[Battle._actionI])) after_actions();
    return;
  }
  if (truthy(ad.hasStatus(st.enemy, "SLP")) || truthy(ad.hasStatus(st.enemy, "FRZ"))) {
    if (!truthy(Battle._actions[Battle._actionI])) after_actions();
    return;
  }
  const canEscape = Engine.canSwitch(st, ad, st.enemy)[0];
  if (!truthy(canEscape)) {
    const mark = ad.eventMark();
    const prev = ad._say;
    ad._say = () => {};
    // pokefirered/src/battle_main.c:4321, battle_message.c:909
    ad.sayText("STRINGID_ATTACKERCANTESCAPE", { atk: st.enemy });
    ad._say = prev;
    const evs = ad.eventsSince(mark);
    if (Battle._headless) {
      for (const [, e] of ipairs(evs)) {
        if (e.kind === "msg") Ui.push(e.text);
      }
      if (!truthy(Battle._actions[Battle._actionI])) after_actions();
      return;
    }
    AnimSeq.beginEvents(evs, seq_push);
    Battle._phase = "animating";
    return;
  }

  const mark = ad.eventMark();
  const prev = ad._say;
  ad._say = () => {};
  // pokefirered/src/battle_main.c:3819
  const monName = lor(State.displayName(st.enemy), "The wild Pok\xC3\xA9mon");
  ad.sayText("STRINGID_WILDPKMNFLED", { buff1: monName });
  ad._say = prev;
  const evs = ad.eventsSince(mark);
  try {
    // require("src.core.game3.se_ids") / require("src.core.game3.audio")
    if (truthy(SE) && truthy(SE.SE_FLEE)) {
      Audio.playSe(SE.SE_FLEE);
    }
  } catch { /* pcall */ }
  st.over = true;
  st.result = "fled";
  st.endReason = "enemy_fled";
  if (Battle._headless) {
    for (const [, e] of ipairs(evs)) {
      if (e.kind === "msg") Ui.push(e.text);
    }
    Battle._pendingEnd = "fled";
    Battle._phase = "ending";
    return;
  }
  AnimSeq.beginEvents(evs, seq_push);
  Battle._pendingEnd = "fled";
  Battle._phase = "ending";
}

// (Lua: `local open_pending_choice` forward declaration -- hoisted function below.)

// Lua: init.lua:2329
function step_action(): void {
  const st = Battle._st;
  const ad = Battle._adapter;
  if (truthy(st) && truthy(st.double)) { D.stepAction(); return; }
  if (end_if_over()) return;

  if (truthy(Battle._metaAct)) {
    const meta = Battle._metaAct;
    Battle._metaAct = undefined;
    if (meta.kind === "safari") {
      return step_safari(meta);
    } else if (meta.kind === "wally_throw") {
      const headless = orl(() => Battle._headless, () => land(Ui, Ui._headless), () => false);
      Battle._actions = seq();
      const started = SwitchSeq.beginWallyThrow(st, {
        headless: headless,
        backPic: st.backPicOverride,
        pushMsg: (text: any) => { Ui.push(text); },
        onDone: () => { resume_actions(); },
      });
      if (truthy(started)) Battle._phase = "switching";
      return;
    } else if (meta.kind === "run" && truthy(st.safari)) {
      // pokefirered/src/battle_main.c:4414
      try {
        Audio.playSe(SE.SE_FLEE);
      } catch { /* pcall */ }
      Battle._actions = seq();
      st.over = true;
      st.result = "run";
      st.endReason = "safari_run";
      Battle._pendingEnd = "run";
      Battle._phase = "ending";
      return;
    } else if (meta.kind === "run") {
      const mark = ad.eventMark();
      const prev = ad._say;
      ad._say = () => {};
      const fled = Commands.tryFlee(st, ad);
      ad._say = prev;
      const evs = ad.eventsSince(mark);
      if (truthy(fled)) {
        st.over = true;
        st.result = "run";
        st.endReason = "flee";
      }
      // pokefirered/src/battle_message.c:320
      const flee_push = (text: any, _w?: any, id?: any): void => {
        if (truthy(fled)) {
          try {
            Audio.playSe(SE.SE_FLEE);
          } catch { /* pcall */ }
        }
        seq_push(text, undefined, id);
      };
      if (Battle._headless) {
        for (const [, e] of ipairs(evs)) {
          if (e.kind === "msg") Ui.push(e.text);
        }
        if (truthy(fled)) {
          Battle._pendingEnd = "run";
          Battle._phase = "ending";
          return;
        }
      } else {
        AnimSeq.beginEvents(evs, flee_push);
        Battle._phase = "animating";
        return;
      }
    } else if (meta.kind === "bag") {
      // package.loaded["src.core.game3.runtime"]
      const session = runtime_session();
      const bag = land(session, tk(session, "bag"));

      if (truthy(Catching.isBall(meta.itemId)) && truthy(st.ghostBattle)) {
        // pokefirered/src/battle_script_commands.c:9473
        if (truthy(bag) && Bag.has(bag, meta.itemId, 1)) Bag.remove(bag, meta.itemId, 1);
        const pushFn = (text: any, wait?: any) => {
          if (truthy(wait)) Ui.pushTimed(text, wait); else Ui.push(text);
        };
        const headless = lor(Battle._headless, land(Ui, Ui._headless));
        CatchSeq.begin(st, meta.itemId, false, 0, {
          pushMsg: pushFn, headless: headless, session: session, ghostDodge: true,
        });
        if (!truthy(headless)) {
          Battle._phase = "catching";
          return;
        }
      } else if (truthy(Catching.isBall(meta.itemId))) {
        if (!truthy(st.wild)) {
          // pokefirered/data/battle_scripts_2.s:118
          Ui.push(BattleText.get("STRINGID_TRAINERBLOCKEDBALL"));
          Battle._actions = seq();
          Battle._phase = "command";
          Ui.openMenu();
          return;
        }
        const scriptedBall = lor(st.oldManTutorial, Wally.active(st));
        if (!truthy(scriptedBall) && (!truthy(bag) || !Bag.has(bag, meta.itemId, 1))) {
          Ui.push(Strings("You don't have that item."));
          Battle._actions = seq();
          Battle._phase = "command";
          Ui.openMenu();
          return;
        }
        if (!truthy(scriptedBall)) {
          Bag.remove(bag, meta.itemId, 1);
        }
        const rng = lor((truthy(ad) && truthy(ad.rng)) ? ad.rng() : undefined, st.rng);
        const [caught, shakes] = Catching.tryCatch(meta.itemId, st.enemy, st, session, rng);
        const pushFn = (text: any) => { Ui.push(text); };
        if (Battle._headless || (truthy(Ui) && truthy(Ui._headless))) {
          CatchSeq.begin(st, meta.itemId, caught, shakes, {
            pushMsg: pushFn,
            headless: true,
            session: session,
          });
          if (truthy(caught)) {
            Battle._actions = seq();
            st.over = true;
            st.result = "catch";
            Battle._pendingEnd = "catch";
            Battle._phase = "ending";
            return;
          }
        } else {
          CatchSeq.begin(st, meta.itemId, caught, shakes, {
            pushMsg: pushFn,
            headless: false,
            session: session,
          });
          Battle._phase = "catching";
          return;
        }
      } else if (truthy(meta.pokedudeUsed) || truthy(meta.usedInMenu)) {
        // pokefirered/data/battle_scripts_2.s:130 BattleScript_PlayerUseItem
        Anim.syncDisplayFromState(st);
        if (truthy(meta.usedInMenu)) {
          BattleItems.afterPlayerItem(st, ad, meta.itemId);
        }
      } else {
        const [result, _msgs, endsTurn, endsBattle] = BattleItems.use(
          st, ad, bag, session, meta.itemId, meta.partySlot, undefined, meta.moveSlot);
        void _msgs;
        if (truthy(endsBattle)) {
          Battle._actions = seq();
          if (result === "catch") {
            st.over = true;
            st.result = "catch";
            Battle._pendingEnd = "catch";
          } else {
            st.over = true;
            st.result = "run";
            Battle._pendingEnd = "run";
          }
          Battle._phase = "ending";
          return;
        }
        if (!truthy(endsTurn) || result === "error") {
          Battle._actions = seq();
          Battle._phase = "command";
          Ui.openMenu();
          return;
        }
        if (result === "heal" && truthy(st.player) && st.player.partyIndex === meta.partySlot) {
          const p = Anim.present("player");
          const logical = tonumber(land(st.player.mon, tk(st.player.mon, "hp"))) ?? 0;
          if (truthy(p) && p.displayHp != null && Math.abs(logical - p.displayHp) >= 1) {
            Anim.tweenHp("player", p.displayHp, logical, st.player.mon.maxHp);
          }
        }
        if (result === "heal") BattleItems.afterPlayerItem(st, ad, meta.itemId);
      }
    } else if (meta.kind === "switch") {
      const newSlot = lor(meta.slot, 1);
      const pushFn = (text: any) => { Ui.push(text); };
      const switch_out = (): boolean => {
        if (truthy(State.isFainted(st.player))) {
          Battle._actions = seq();
          handle_player_faint();
          return true;
        }
        if (Battle._headless) {
          SwitchSeq.beginPlayerSwitch(st, newSlot, {
            headless: true,
            pushMsg: pushFn,
            onDone: () => { Battle._phase = "actions"; },
          });
          return false;
        }
        SwitchSeq.beginPlayerSwitch(st, newSlot, {
          headless: false,
          pushMsg: pushFn,
          onDone: () => {
            Battle._phase = "actions";
            if (!truthy(Battle._actions) || !truthy(Battle._actions[Battle._actionI])) {
              after_actions();
            }
          },
        });
        Battle._phase = "switching";
        return true;
      };
      // pokefirered/src/battle_script_commands.c:8337
      const enemyAct = D.pursuitRow(st, 1, 0);
      if (truthy(enemyAct)) {
        for (let i = len(lor(Battle._actions, seq())); i >= 1; i--) {
          if (Battle._actions[i] === enemyAct) remove(Battle._actions, i);
        }
        enemyAct.done = true;
        const out: Tbl = {};
        Engine.resolveMove(st.enemy, st.player, enemyAct.move, enemyAct.slot, ad, st, out, { pursuitSwitch: true });
        const animMeta = out._anim;
        if (Battle._headless || !truthy(animMeta)) {
          push_msgs(out);
        } else {
          AnimSeq.begin(animMeta, seq_push);
          Battle._phase = "animating";
          Battle._singleAfterAnim = () => { switch_out(); };
          return;
        }
      }
      if (switch_out()) return;
    }
  }

  const act = truthy(Battle._actions) ? Battle._actions[Battle._actionI] : Battle._actions;
  if (!truthy(act)) {
    after_actions();
    return;
  }
  Battle._actionI = Battle._actionI + 1;

  if (act.kind === "player_meta") {
    Battle._metaAct = act.meta;
    return step_action();
  }
  if (truthy(st.safari) && (act.kind === "watch" || act.kind === "run")) {
    return step_safari_enemy(act);
  }
  if ((act.kind === "run" || act.kind === "flee") && (act.battler === 1 || act.user === "enemy" || (isTable(act.user) && act.user.side === "enemy"))) {
    return step_enemy_flee(act);
  }
  if (truthy(act.meta)) {
    if (!truthy(Battle._actions[Battle._actionI])) after_actions();
    return;
  }
  if (act.kind === "switch" && act.battler === 1) { D.singleEnemySwitch(act); return; }
  if (act.kind === "item") { D.enemyItem(act); return; }

  let uBattler = lor((typeof act.user === "string" && truthy(st)) ? st[act.user] : undefined, act.user);
  let tBattler = lor((typeof act.target === "string" && truthy(st)) ? st[act.target] : undefined, act.target);
  if (truthy(uBattler) && truthy(uBattler.side) && truthy(st) && truthy(st[uBattler.side])) uBattler = st[uBattler.side];
  if (truthy(tBattler) && truthy(tBattler.side) && truthy(st) && truthy(st[tBattler.side])) tBattler = st[tBattler.side];

  if (truthy(State.isFainted(uBattler)) || truthy(State.isFainted(tBattler))) {
    if (!truthy(Battle._actions[Battle._actionI])) after_actions();
    return;
  }

  const out: Tbl = {};
  st.interactiveChoices = truthy(st.link) ? st.link : !(Battle._headless || Battle._auto);
  st.pdActor = lor(isTable(act.user) ? act.user.side : undefined, act.user);
  if (truthy(st.facility) && truthy(st.facility.resolveMove)) {
    // pokeemerald/src/battle_util.c:263
    st.facility.resolveMove(st, ad, act, out, act.user, act.target);
  } else {
    Engine.resolveMove(act.user, act.target, act.move, act.slot, ad, st, out);
  }
  st.interactiveChoices = undefined;
  Battle._pendingChoice = out.pendingChoice;
  const animMeta = out._anim;
  if (Battle._headless || !truthy(animMeta)) {
    if (truthy(st.pokedude) && truthy(animMeta) && truthy(animMeta.events)) {
      for (const [, e] of ipairs(animMeta.events)) {
        if (e.kind === "msg") seq_push(e.text, e.wait, e.id);
      }
    } else {
      push_msgs(out);
    }
    if (truthy(Battle._pendingChoice)) { open_pending_choice(); return; }
    if (end_if_over()) return;
  } else {
    AnimSeq.begin(animMeta, seq_push);
    Battle._phase = "animating";
    return;
  }

  if (check_faints_and_end()) {
    return;
  }
  if (!truthy(Battle._actions[Battle._actionI])) {
    after_actions();
  }
}

// pokefirered/src/battle_script_commands.c:4626
// Lua: init.lua:2629
function open_pending_choice(): any {
  const st = Battle._st, ad = Battle._adapter;
  const req = Battle._pendingChoice;
  Battle._pendingChoice = undefined;
  const pc = st.pendingChoice;
  const uid = orl(() => (truthy(pc) && truthy(pc.M) && truthy(pc.M.user)) ? pc.M.user.id : undefined, () => 0);
  let resume = (slot: any): void => {
    st.interactiveChoices = true;
    const out = Engine.resumeChoice(st, ad, slot);
    st.interactiveChoices = undefined;
    Battle._pendingChoice = land(out, tk(out, "pendingChoice"));
    if (truthy(out) && truthy(out._anim) && !Battle._headless) {
      AnimSeq.begin(out._anim, seq_push);
      Battle._phase = "animating";
    } else {
      for (const [, t] of ipairs(lor(out, seq()))) Ui.push(t);
      Battle._phase = "actions";
      if (truthy(st.double) && !truthy(Battle._pendingChoice)) D.afterEach();
    }
  };
  const LB = truthy(st.link) ? orNil(link_battle()) : undefined;
  if (truthy(LB) && truthy(LB.isActive()) && truthy(req) && req.kind === "baton_pass") {
    const cands = lor(req.candidates, seq());
    const bpId = tonumber(req.battler) ?? uid;
    if (truthy(st.multi) && multi_remote(st, bpId)) {
      return with_link_replacement(st, cands[1], resume, State.sideOf(bpId), bpId);
    }
    if (req.side === "enemy" || truthy(st.spectate)) {
      return with_link_replacement(st, cands[1], resume, req.side === "enemy" ? "enemy" : "player");
    }
    if (Battle._headless || Battle._auto) {
      LB.sendSwitch(cands[1]);
      return resume(cands[1]);
    }
    const chosen = resume;
    resume = (slot: any): void => {
      LB.sendSwitch(slot);
      return chosen(slot);
    };
  }
  if (Battle._headless || Battle._auto || !(truthy(req) && req.kind === "baton_pass")) {
    resume((truthy(req) && truthy(req.candidates)) ? req.candidates[1] : undefined);
    return;
  }
  const PartyMenu: any = PartyMenuMod;
  // package.loaded["src.core.game3.runtime"]
  const session = runtime_session();
  State.syncBattlerToParty(st.player, st.playerParty);
  if (truthy(Ui.clearLinger)) Ui.clearLinger();
  Battle._phase = "switching";
  if (truthy(st.double) && truthy(Ui.openPartyMenu)) {
    return Ui.openPartyMenu(st, uid, {
      forced: true,
      validate: (slot: any) => Commands.switchError(st, slot, true, uid),
      onSelect: (slot: any) => { resume(slot); },
    });
  }
  PartyMenu.show(lor(st.playerParty, tk(session, "party")), tk(session, "move_overlay"), {
    mode: "battle_faint",
    session: session,
    activeSlot: st.player.partyIndex,
    activeSlots: truthy(st.double) ? orNil(D.activeSlots(st)) : undefined,
    battlerId: truthy(st.double) ? orNil(uid) : undefined,
    battle: true,
    validate: (slot: any) => Commands.switchError(st, slot, true, truthy(st.double) ? orNil(uid) : undefined),
    onSelect: (slot: any) => { resume(slot); },
  });
}
Battle._openPendingChoiceForTests = open_pending_choice;

// Lua: init.lua:2699
function after_anim_sequence(): void {
  if (truthy(Battle._pendingChoice)) {
    open_pending_choice();
    return;
  }
  if (truthy(Battle._singleAfterAnim)) {
    const scont = Battle._singleAfterAnim!;
    Battle._singleAfterAnim = undefined;
    if (end_if_over()) return;
    scont();
    return;
  }
  if (truthy(Battle._st) && truthy(Battle._st.double)) {
    const cont = Battle._dblAfterAnim;
    Battle._dblAfterAnim = undefined;
    if (truthy(cont)) { cont!(); return; }
    if (end_if_over()) return;
    D.afterEach();
    return;
  }
  if (end_if_over()) return;
  if (check_faints_and_end()) {
    return;
  }
  Battle._phase = "actions";
  if (!truthy(Battle._actions) || !truthy(Battle._actions[Battle._actionI])) {
    after_actions();
  }
}

const SEL_ORDER = seq(0, 2);

// Lua: init.lua:2729
function has_flag(t: any, f: number): boolean {
  return lmod(Math.floor((tonumber(t) ?? 0) / f), 2) === 1;
}

// Lua: init.lua:2733
D.reset = function (): void {
  Battle._leveledUp = undefined;
  Battle._dblSel = undefined;
  Battle._dblFaint = undefined;
  Battle._dblSwitch = undefined;
  Battle._dblAfterAnim = undefined;
  Battle._dblLeveled = undefined;
  Battle._singleAfterAnim = undefined;
  Battle._midTurn = undefined;
  Battle._linkAct = undefined;
  Battle._linkDouble = undefined;
  Battle._linkMulti = undefined;
  Battle._linkSwitch = undefined;
};

// Lua: init.lua:2748
D.activeSlots = function (st: Tbl): Tbl {
  const out: Tbl = seq();
  for (const [, id] of ipairs<number>(SEL_ORDER)) {
    const b = State.battler(st, id);
    if (truthy(b) && !truthy(State.isAbsent(st, id))) out[len(out) + 1] = b.partyIndex;
  }
  return out;
};

// Lua: init.lua:2757
D.capture = function (fn: Fn): Tbl {
  const ad = Battle._adapter;
  if (!truthy(ad)) return seq();
  const mark = ad.eventMark();
  const prev = ad._say;
  ad._say = () => {};
  try {
    fn();
  } catch { /* pcall */ }
  ad._say = prev;
  return ad.eventsSince(mark);
};

// pokefirered/src/battle_message.c:1591
// Lua: init.lua:2769
D.headlessIntro = function (st: Tbl, trainerId: any, rivalName: any): Tbl {
  const strings = Trainers.introStrings(trainerId, State.displayName(st.enemy), { rivalName: rivalName });
  const out: Tbl = seq(strings.wants);
  if (!truthy(State.isAbsent(st, 3))) {
    out[len(out) + 1] = IntroSeq.sendOutText(st, "enemy");
  } else {
    out[len(out) + 1] = strings.sentOut;
  }
  out[len(out) + 1] = IntroSeq.sendOutText(st, "player");
  return out;
};

// pokefirered/src/battle_main.c:3125
// Lua: init.lua:2782
D.lockedAction = function (st: Tbl, id: number): Tbl {
  const b = State.battler(st, id);
  if (!truthy(b) || !(truthy(b.expLockedMove) || truthy(b.expMustRecharge))) return undefined;
  const mon = lor(b.mon, {});
  const slot = lor(b.expLockedSlot, 1);
  const mv = orl(() => b.expLockedMove, () => b.lastMoveId, () => b.lastMove, () => land(mon.moves, tk(mon.moves, slot)));
  return { kind: "move", battler: id, move: mv, slot: slot, target: land(st.moveTarget, tk(st.moveTarget, id)) };
};

// Lua: init.lua:2791
D.autoAction = function (st: Tbl, id: number): Tbl {
  const act = Commands.fightShortcut(st, id)[0];
  if (truthy(act)) {
    act.battler = id;
    return act;
  }
  for (let slot = 1; slot <= 4; slot++) {
    if (Commands.moveUsable(st, slot, id)) return Commands.playerAction(st, 1, slot, id);
  }
  return Commands.playerAction(st, 1, 1, id);
};

// pokefirered/src/battle_controller_player.c:447
// Lua: init.lua:2804
D.targetPlan = function (st: Tbl, id: number, cmd: Tbl): [boolean, number, number, number] {
  const b = State.battler(st, id);
  const mv = Moves.get(cmd.move);
  let tt = tonumber(land(mv, tk(mv, "target"))) ?? 0;
  const num = tonumber(cmd.move) ?? tonumber(land(mv, tk(mv, "id")));
  if (num === 174) {
    // require("src.core.game3.battle.types")
    const ad = Battle._adapter;
    const ghost = (truthy(ad) && truthy(b) && truthy(Types.ID) && truthy(Types.ID.GHOST)) ? ad.hasType(b, Types.ID.GHOST) : false;
    tt = truthy(ghost) ? 0 : 0x10;
  }
  const opposing = (lmod(id, 2) === 0) ? 1 : 0;
  let cursor = has_flag(tt, 0x10) ? id : opposing;
  let can = !(has_flag(tt, 0x04) || has_flag(tt, 0x08) || has_flag(tt, 0x01)
    || has_flag(tt, 0x20) || has_flag(tt, 0x40) || has_flag(tt, 0x10));
  const pp = (truthy(b) && truthy(b.mon) && truthy(b.mon.pp) && truthy(cmd.slot)) ? tonumber(b.mon.pp[cmd.slot]) : undefined;
  if (pp === 0) {
    can = false;
  } else if (!(has_flag(tt, 0x10) || has_flag(tt, 0x02))) {
    let others = 0;
    for (let oid = 0; oid <= 3; oid++) {
      if (oid !== id && truthy(State.isPresent(st, oid))) others = others + 1;
    }
    if (others <= 1) {
      // pokefirered/src/pokemon.c:2700
      cursor = truthy(State.isAbsent(st, opposing)) ? State.PARTNER(opposing) : opposing;
      can = false;
    }
  }
  let start = cursor;
  if (can) {
    if (has_flag(tt, 0x10) || has_flag(tt, 0x02)) {
      start = id;
    } else if (truthy(State.isAbsent(st, opposing))) {
      start = State.PARTNER(opposing);
    } else {
      start = opposing;
    }
  }
  return [can, cursor, start, tt];
};

// Lua: init.lua:2846
D.startSelection = function (): any {
  const st = Battle._st;
  st.monToSwitchInto = {};
  Battle._phase = "command";
  if (truthy(st.spectate)) {
    Battle._dblSel = undefined;
    return;
  }
  Battle._dblSel = { chosen: {}, pos: 1 };
  return D.advanceSelection();
};

// pokefirered/src/battle_main.c:3097
// Lua: init.lua:2859
D.advanceSelection = function (): any {
  const st = Battle._st, sel = Battle._dblSel;
  if (!truthy(sel)) return;
  while (sel.pos <= len(SEL_ORDER)) {
    const id = SEL_ORDER[sel.pos] as number;
    const b = State.battler(st, id);
    // pokefirered/src/battle_controllers.c:231
    if (!truthy(b) || truthy(State.isAbsent(st, id)) || multi_remote(st, id)) {
      sel.pos = sel.pos + 1;
    } else {
      const locked = D.lockedAction(st, id);
      if (truthy(locked)) {
        sel.chosen[id] = locked;
        sel.pos = sel.pos + 1;
      } else if (Kinds.controllerOf(st, id) === "aiPartner") {
        // pokeemerald/src/battle_controller_player_partner.c:1512
        const act = orl(() => Ai.chooseAction(st, id), () => D.autoAction(st, id));
        act.battler = id;
        act.user = "player";
        sel.chosen[id] = act;
        sel.pos = sel.pos + 1;
      } else if (Battle._auto) {
        sel.chosen[id] = D.autoAction(st, id);
        sel.pos = sel.pos + 1;
      } else {
        sel.active = id;
        st.activeBattler = id;
        return D.openMenu(id);
      }
    }
  }
  return D.finishSelection();
};

// pokefirered/src/battle_controller_player.c:286
// Lua: init.lua:2893
D.cancelPartner = function (): any {
  const st = Battle._st, sel = Battle._dblSel;
  const c0 = land(sel, sel?.chosen[0]);
  if (truthy(c0) && c0.kind === "bag") {
    if (!truthy(Catching.isBall(c0.itemId))) return;
  }
  try {
    Audio.playSe(SE.SE_SELECT);
  } catch { /* pcall */ }
  sel.chosen[0] = undefined;
  if (truthy(st.monToSwitchInto)) st.monToSwitchInto[0] = undefined;
  sel.pos = 1;
  return D.advanceSelection();
};

// Lua: init.lua:2909
D.openMenu = function (id: number): any {
  const sel = Battle._dblSel;
  const st = Battle._st;
  const partner = (id === 2 && truthy(sel) && !(truthy(st) && truthy(st.multi))) ? orNil(sel.chosen[0]) : undefined;
  return Ui.openMenu(id, { partnerAction: partner });
};

// Lua: init.lua:2916
D.commit = function (cmd: Tbl): any {
  const sel = Battle._dblSel;
  if (!truthy(sel)) return;
  sel.chosen[cmd.battler] = cmd;
  sel.pos = sel.pos + 1;
  return D.advanceSelection();
};

// Lua: init.lua:2924
D.onCommand = function (cmd: Tbl): any {
  const st = Battle._st, sel = Battle._dblSel;
  if (!truthy(sel) || !truthy(sel.active)) return;
  const id = sel.active;
  if (cmd.kind === "cancel_partner") {
    if (id === 2 && !truthy(State.isAbsent(st, 0)) && !truthy(st.multi)) return D.cancelPartner();
    return D.openMenu(id);
  }
  const b = State.battler(st, id);
  if (cmd.battler !== id) {
    if (cmd.kind === "move" && truthy(cmd.slot) && truthy(b) && truthy(b.mon) && truthy(b.mon.moves) && truthy(b.mon.moves[cmd.slot])) {
      cmd.move = b.mon.moves[cmd.slot];
    }
    cmd.battler = id;
  }
  if (cmd.kind === "move") {
    if (cmd.target == null && cmd.move !== "STRUGGLE") {
      const [can, cursor, start] = D.targetPlan(st, id, cmd);
      if (!can) {
        cmd.target = cursor;
      } else if (truthy(Ui.chooseTarget)) {
        sel.targeting = true;
        Ui.chooseTarget(st, id, cmd.slot, (targetId: any): any => {
          sel.targeting = false;
          if (targetId == null) {
            if (truthy(Ui.openMoveMenu)) return Ui.openMoveMenu(id);
            return D.openMenu(id);
          }
          cmd.target = targetId;
          return D.commit(cmd);
        });
        return;
      } else {
        cmd.target = start;
      }
    }
  } else if (cmd.kind === "switch") {
    const err = truthy(cmd.slot) ? Commands.switchError(st, cmd.slot, false, id) : cmd.slot;
    if (truthy(err) || !truthy(cmd.slot)) {
      if (truthy(err)) Ui.push(err, () => { D.openMenu(id); }); else D.openMenu(id);
      return;
    }
    st.monToSwitchInto[id] = cmd.slot;
  }
  return D.commit(cmd);
};

// Lua: init.lua:2971
D.commandUpdate = function (input: any): any {
  const sel = Battle._dblSel;
  if (!truthy(sel)) return D.startSelection();
  if (truthy(sel.targeting)) {
    if (truthy(input)) Ui.handleInput(input);
    return;
  }
  if (Battle._refuseLinkItem(input)) return;
  const PartyMenu: any = PartyMenuMod;
  if (truthy(PartyMenu.isOpen) && truthy(PartyMenu.isOpen())) {
    if (truthy(input)) party_menu_input(PartyMenu, input);
    return;
  }
  const BagMenu: any = BagMenuMod;
  if (truthy(BagMenu.isOpen) && truthy(BagMenu.isOpen())) {
    if (truthy(input)) Screens.handleInput("bag", BagMenu, input);
    return;
  }
  if (Ui._mode === "bag" || Ui._mode === "party") {
    Ui._mode = "menu";
  }
  if (truthy(Ui.selectionPump())) {
    const scmd = Ui.takeCommand();
    if (truthy(scmd)) D.onCommand(scmd);
    return;
  }
  if (truthy(input)) Ui.handleInput(input);
  const cmd = Ui.takeCommand();
  if (truthy(cmd)) D.onCommand(cmd);
};

// pokefirered/src/battle_main.c:3532
// Lua: init.lua:3003
D.finishSelection = function (): any {
  const st = Battle._st;
  const sel = Battle._dblSel;
  const chosen = (truthy(sel) && truthy(sel.chosen)) ? sel.chosen : {};
  Battle._dblSel = undefined;
  st.activeBattler = undefined;
  const LB = truthy(st.link) ? orNil(Battle._linkBattle()) : undefined;
  if (truthy(st.multi) && truthy(LB) && truthy(LB.isActive())) {
    // pokefirered/src/battle_main.c:3097
    st.turn = st.turn + 1;
    const own = st.linkOwn;
    const act = own != null ? orNil(chosen[own]) : undefined;
    LB.sendMultiAction(st.turn, act, truthy(act) ? orNil(link_canon(st, act.target)) : undefined);
    if (truthy(st.over) || !Battle._active) return;
    Battle._linkAct = chosen;
    Battle._linkMulti = true;
    Battle._phase = "linkwait";
    Battle._linkTurnStep();
    return;
  }
  if (truthy(LB) && truthy(LB.isActive())) {
    // pokefirered/src/battle_main.c:3226 both of this machine's actions go out together
    st.turn = st.turn + 1;
    LB.sendActionList(st.turn, seq(chosen[0], chosen[2]));
    if (truthy(st.over) || !Battle._active) return;
    Battle._linkAct = chosen;
    Battle._linkDouble = true;
    Battle._phase = "linkwait";
    Battle._linkTurnStep();
    return;
  }
  for (const [, id] of ipairs<number>(seq(1, 3))) {
    if (truthy(State.battler(st, id)) && !truthy(State.isAbsent(st, id))) {
      chosen[id] = Commands.enemyAction(st, id);
    }
  }
  const fac = st.facility;
  if (truthy(fac) && truthy(fac.turnStart) && st._facilityTurn !== st.turn) {
    // pokeemerald/src/battle_main.c:4015
    st._facilityTurn = st.turn;
    fac.turnStart(st, Battle._adapter, true);
  }
  // pokeemerald/src/battle_main.c:4185
  if (truthy(fac) && truthy(fac.doubleActions)) fac.doubleActions(st, chosen);
  st.turn = st.turn + 1;
  D.resolveDoubleTurn(chosen);
};

// Lua: init.lua:3051
D.resolveDoubleTurn = function (chosen: Tbl): void {
  const st = Battle._st, ad = Battle._adapter;
  Battle._actions = Engine.planTurnActions(st, ad, chosen)[0];
  open_turn(st, chosen[0], chosen[1], chosen);
  Battle._actionI = 1;
  Battle._metaAct = undefined;
  Battle._phase = "actions";
  const evs = focus_punch_prelude();
  if (truthy(evs) && len(evs) > 0) {
    if (Battle._headless) {
      for (const [, e] of ipairs(evs)) {
        if (e.kind === "msg") Ui.push(e.text);
      }
    } else {
      AnimSeq.beginEvents(evs, seq_push);
      Battle._phase = "preturn";
    }
  }
};

// pokefirered/src/battle_main.c:3704
// Lua: init.lua:3072
D.stepAction = function (): any {
  const st = Battle._st, ad = Battle._adapter;
  if (end_if_over()) return;
  const acts = lor(Battle._actions, seq());
  let act: Tbl;
  while (true) {
    act = acts[Battle._actionI];
    if (!truthy(act)) return D.afterActions();
    Battle._actionI = Battle._actionI + 1;
    if (truthy(Engine.actionRunnable(st, act))) break;
  }
  act.done = true;
  const user = State.battler(st, act.battler);
  if (act.kind === "move") {
    if (!truthy(user) || truthy(State.isFainted(user))) return D.afterEach();
    const out: Tbl = {};
    st.interactiveChoices = truthy(st.link) ? st.link : !(Battle._headless || Battle._auto);
    if (truthy(st.facility) && truthy(st.facility.resolveMove)) {
      // pokeemerald/src/battle_util.c:263
      st.facility.resolveMove(st, ad, act, out, act.battler, act.target);
    } else {
      Engine.resolveMove(act.battler, act.target, act.move, act.slot, ad, st, out);
    }
    st.interactiveChoices = undefined;
    Battle._pendingChoice = out.pendingChoice;
    if (Battle._headless || !truthy(out._anim)) {
      push_msgs(out);
      if (truthy(Battle._pendingChoice)) return open_pending_choice();
      return D.afterEach();
    }
    AnimSeq.begin(out._anim, seq_push);
    Battle._phase = "animating";
    return;
  } else if (act.kind === "switch") {
    return D.beginSwitch(act);
  } else if (act.kind === "bag") {
    return D.useBag(act);
  } else if (act.kind === "run") {
    return D.run(act);
  } else if (act.kind === "item") {
    return D.enemyItem(act);
  }
  return D.afterEach();
};

// pokefirered/src/battle_main.c:4433
// Lua: init.lua:3118
D.afterEach = function (): any {
  if (end_if_over()) return;
  return D.faintFlow(() => {
    Battle._phase = "actions";
  });
};

// pokefirered/src/battle_main.c:2953
// Lua: init.lua:3126
D.afterActions = function (): any {
  const st = Battle._st, ad = Battle._adapter;
  if (end_if_over()) return;
  const events = Engine.collectResidualEvents(st, ad);
  close_turn(st);
  if (Battle._headless) {
    for (const [, evt] of ipairs(lor(events, seq()))) push_msgs(evt.msgs);
    Ui.pump();
    return D.endTurn();
  }
  const stream: Tbl = seq();
  for (const [, evt] of ipairs(lor(events, seq()))) {
    for (const [, e] of ipairs(lor(evt.events, seq()))) stream[len(stream) + 1] = e;
  }
  AnimSeq.beginEvents(stream, seq_push);
  Battle._phase = "residuals";
};

// Lua: init.lua:3144
D.endTurn = function (): any {
  return D.faintFlow(() => {
    Battle._st.monToSwitchInto = {};
    return D.startSelection();
  });
};

// pokefirered/src/battle_util.c:1144
// Lua: init.lua:3152
D.faintFlow = function (onDone: Fn): any {
  Engine.refreshAbsent(Battle._st);
  Battle._dblFaint = { stage: "exp", onDone: onDone };
  return D.faintStep();
};

// Lua: init.lua:3158
D.presentAwards = function (awards: Tbl): boolean {
  if (!truthy(awards) || len(awards) === 0) return false;
  Battle._dblLeveled = lor(Battle._dblLeveled, {});
  Battle._leveledUp = Battle._dblLeveled;
  if (Battle._headless) {
    push_awards_headless(awards);
    return false;
  }
  const hooks = choice_hooks();
  hooks.double = true;
  if (!truthy(ExpSeq.begin(awards, hooks.pushMsg, undefined, hooks))) return false;
  Battle._onExpDone = (): any => {
    for (const [k, v] of pairs(lor(ExpSeq.leveledSet(), {}))) Battle._dblLeveled[k] = v;
    Battle._leveledUp = Battle._dblLeveled;
    Battle._phase = "actions";
    return D.faintStep();
  };
  Battle._phase = "awarding";
  return true;
};

// Lua: init.lua:3179
D.faintStep = function (): any {
  const st = Battle._st, ad = Battle._adapter;
  const F = Battle._dblFaint;
  if (!truthy(F) || !truthy(st)) return;
  if (F.stage === "exp") {
    for (const [, id] of ipairs(Engine.expAwardOrder(st))) {
      const foe = State.battler(st, id);
      if (truthy(foe) && !truthy(foe._expGiven)) {
        foe._expGiven = true;
        if (truthy(st.foeParty)) State.syncBattlerToParty(foe, st.foeParty);
        // pokefirered/src/battle_script_commands.c:3129
        const awards = lor(!truthy(Kinds.noExp(st))
          ? Experience.awardFoe(st, foe, { trainer: !truthy(st.wild) }) : false, seq());
        // pokefirered/src/battle_util.c:1181
        State.opponentSwitchInResetSentPokes(st, foe);
        wild_victory_song(st, awards);
        if (D.presentAwards(awards)) return;
      }
    }
    F.stage = "check";
  }
  if (F.stage === "check") {
    // pokefirered/data/battle_scripts_1.s:2825
    const res = Engine.checkEnd(st, ad);
    if (res === "draw" && truthy(st.link)) {
      Battle._dblFaint = undefined;
      stop_low_hp_song();
      return D.linkDraw(st);
    }
    if (res === "win" || res === "lose") {
      Battle._dblFaint = undefined;
      Battle._actions = seq();
      stop_low_hp_song();
      if (res === "win") {
        Battle._leveledUp = lor(Battle._dblLeveled, {});
        return begin_trainer_win(st);
      }
      return D.lose();
    }
    F.stage = "repl";
  }
  if (F.stage === "repl") {
    for (const [, id] of ipairs(State.battlerOrder(st))) {
      const b = State.battler(st, id);
      if (truthy(b) && !truthy(State.isAbsent(st, id)) && truthy(State.isFainted(b))) {
        const cands = Engine.replacementCandidates(st, id);
        if (len(cands) === 0) {
          // pokefirered/src/battle_script_commands.c:4870
          Engine.markAbsent(st, id);
        } else {
          return D.pickReplacement(id, cands);
        }
      }
    }
    F.stage = "after";
  }
  Battle._dblFaint = undefined;
  // pokefirered/src/battle_util.c:1208
  const evs = D.capture(() => { Engine.afterAction(st, ad); });
  if (len(evs) > 0 && !Battle._headless) {
    AnimSeq.beginEvents(evs, seq_push);
    Battle._phase = "animating";
    Battle._dblAfterAnim = F.onDone;
    return;
  }
  for (const [, e] of ipairs(evs)) {
    if (e.kind === "msg") Ui.push(e.text);
  }
  if (truthy(F.onDone)) return F.onDone();
};

// Lua: init.lua:3250
D.lose = function (): void {
  Battle._pendingEnd = "lose";
  Battle._phase = "ending";
  D.pushBattleLost(Battle._st);
};

// pokefirered/src/battle_script_commands.c:4855
// Lua: init.lua:3257
D.pickReplacement = function (id: number, cands: Tbl): any {
  const st = Battle._st, ad = Battle._adapter;
  let go = (slot: any): any => {
    st.monToSwitchInto[id] = slot;
    return D.sendOut(id, slot);
  };
  const LB = truthy(st.link) ? orNil(Battle._linkBattle()) : undefined;
  if (truthy(LB) && truthy(LB.isActive()) && truthy(st.multi) && multi_remote(st, id)) {
    return with_link_replacement(st, cands[1], go, State.sideOf(id), id);
  }
  if (truthy(LB) && truthy(LB.isActive())) {
    if (State.sideOf(id) === "enemy") {
      return with_link_replacement(st, cands[1], go, "enemy");
    }
    if (truthy(st.spectate)) {
      return with_link_replacement(st, cands[1], go, "player");
    }
    if (Battle._headless || Battle._auto) {
      LB.sendSwitch(cands[1]);
      return go(cands[1]);
    }
    const sendOut = go;
    go = (slot: any): any => {
      LB.sendSwitch(slot);
      return sendOut(slot);
    };
  }
  if (State.sideOf(id) === "enemy" || Kinds.controllerOf(st, id) === "aiPartner") {
    // pokefirered/src/battle_controller_opponent.c:1410
    // pokeemerald/src/battle_controller_player_partner.c:1539
    let ok = true;
    let pick: any;
    try {
      pick = Engine.mostSuitableMon(st, ad, id);
    } catch {
      ok = false;
    }
    for (const [, c] of ipairs(cands)) {
      if (ok && c === pick) return go(pick);
    }
    return go(cands[1]);
  }
  if (Battle._headless || Battle._auto) return go(cands[1]);
  const PartyMenu: any = PartyMenuMod;
  // package.loaded["src.core.game3.runtime"]
  const session = runtime_session();
  for (const [, pid] of ipairs<number>(SEL_ORDER)) {
    const pb = State.battler(st, pid);
    if (truthy(pb)) State.syncBattlerToParty(pb, st.playerParty);
  }
  if (truthy(Ui.clearLinger)) Ui.clearLinger();
  Battle._phase = "switching";
  if (truthy(Ui.openPartyMenu)) {
    return Ui.openPartyMenu(st, id, {
      forced: true,
      validate: (slot: any) => Commands.switchError(st, slot, true, id),
      onSelect: (slot: any): any => {
        if (slot == null) return D.pickReplacement(id, cands);
        return go(slot);
      },
    });
  }
  const b0 = State.battler(st, 0);
  PartyMenu.show(lor(st.playerParty, tk(session, "party")), tk(session, "move_overlay"), {
    mode: "battle_faint",
    session: session,
    activeSlot: land(b0, tk(b0, "partyIndex")),
    activeSlots: D.activeSlots(st),
    battlerId: id,
    battle: true,
    validate: (slot: any) => Commands.switchError(st, slot, true, id),
    onSelect: (slot: any): any => {
      if (slot == null) return D.pickReplacement(id, cands);
      return go(slot);
    },
  });
};

// Lua: init.lua:3329
D.sendOut = function (id: number, slot: any): void {
  const started = SwitchSeq.beginDoubleSwitch(Battle._st, id, slot, {
    headless: Battle._headless || Battle._auto,
    reason: "replace",
    pushMsg: (t: any) => { Ui.push(t); },
    onDone: () => D.faintStep(),
  });
  if (truthy(started)) Battle._phase = "switching";
};

// pokefirered/data/battle_scripts_1.s:3046
// Lua: init.lua:3340
D.beginSwitch = function (act: Tbl): any {
  const st = Battle._st;
  const id = act.battler;
  const slot = lor(act.slot, land(st.monToSwitchInto, tk(st.monToSwitchInto, id)));
  if (!truthy(slot)) return D.afterEach();
  Ui.push(SwitchSeq.returnText(st, id));
  Battle._dblSwitch = { id: id, slot: slot, pursuers: (State.sideOf(id) === "player") ? seq(3, 1) : seq(2, 0), i: 1 };
  return D.switchStep();
};

// pokefirered/src/battle_script_commands.c:8337
// Lua: init.lua:3351
D.pursuitRow = function (st: Tbl, pid: number, targetId: number): Tbl {
  if (truthy(State.isAbsent(st, pid))) return undefined;
  const ad = Battle._adapter;
  const user = State.battler(st, pid);
  const target = State.battler(st, targetId);
  if (!truthy(user) || truthy(State.isFainted(user)) || !truthy(target) || truthy(State.isFainted(target))) return undefined;
  for (const [, row] of ipairs(lor(st.turnActions, seq()))) {
    if (row.battler === pid && row.kind === "move" && !truthy(row.done) && !truthy(row.finished)
        && truthy(Engine.isPursuit(row.move))) {
      let tgt = row.target;
      if (isTable(tgt)) tgt = tgt.id;
      if (tgt == null && truthy(st.moveTarget)) tgt = st.moveTarget[pid];
      if (tgt === targetId && !truthy(ad.hasStatus(user, "SLP")) && !truthy(ad.hasStatus(user, "FRZ"))
          && (tonumber(user.expTruantCounter) ?? 0) === 0) {
        return row;
      }
    }
  }
  return undefined;
};

// Lua: init.lua:3372
D.switchStep = function (): any {
  const st = Battle._st, ad = Battle._adapter;
  const sw = Battle._dblSwitch;
  if (!truthy(sw)) return;
  while (sw.i <= len(sw.pursuers)) {
    const pid = sw.pursuers[sw.i];
    sw.i = sw.i + 1;
    const row = D.pursuitRow(st, pid, sw.id);
    if (truthy(row)) {
      row.done = true;
      const out: Tbl = {};
      Engine.resolveMove(pid, sw.id, row.move, row.slot, ad, st, out, { pursuitSwitch: true });
      if (Battle._headless || !truthy(out._anim)) {
        push_msgs(out);
      } else {
        AnimSeq.begin(out._anim, seq_push);
        Battle._phase = "animating";
        Battle._dblAfterAnim = D.switchStep;
        return;
      }
    }
  }
  Battle._dblSwitch = undefined;
  const b = State.battler(st, sw.id);
  if (!truthy(b) || truthy(State.isFainted(b))) {
    if (truthy(st.monToSwitchInto)) st.monToSwitchInto[sw.id] = undefined;
    return D.afterEach();
  }
  const started = SwitchSeq.beginDoubleSwitch(st, sw.id, sw.slot, {
    withdraw: true,
    noWithdrawMsg: true,
    reason: "switch",
    headless: Battle._headless,
    pushMsg: (t: any) => { Ui.push(t); },
    onDone: () => D.afterEach(),
  });
  if (truthy(started)) Battle._phase = "switching";
};

// pokefirered/data/battle_scripts_2.s:134
// Lua: init.lua:3412
D.enemyItem = function (act: Tbl): any {
  const st = Battle._st, ad = Battle._adapter;
  const evs = D.capture(() => { Engine.performEnemyItem(st, ad, act); });
  if (Battle._headless || len(evs) === 0) {
    for (const [, e] of ipairs(evs)) {
      if (e.kind === "msg") Ui.push(e.text);
    }
    Anim.syncDisplayFromState(st);
    if (truthy(st.double)) return D.afterEach();
    Battle._phase = "actions";
    if (!truthy(Battle._actions[Battle._actionI])) after_actions();
    return;
  }
  AnimSeq.beginEvents(evs, seq_push);
  Battle._phase = "animating";
};

// pokefirered/data/battle_scripts_1.s:3046
// Lua: init.lua:3430
D.singleEnemySwitch = function (act: Tbl): any {
  const st = Battle._st, ad = Battle._adapter;
  const slot = lor(act.slot, land(st.monToSwitchInto, tk(st.monToSwitchInto, 1)));
  const cont = (): void => {
    Battle._phase = "actions";
    if (!(truthy(Battle._actions) && truthy(Battle._actions[Battle._actionI]))) after_actions();
  };
  if (!truthy(slot) || truthy(State.isFainted(st.enemy))) return cont();
  Ui.push(SwitchSeq.returnText(st, 1));
  const do_switch = (): void => {
    if (truthy(State.isFainted(st.enemy))) {
      if (truthy(st.monToSwitchInto)) st.monToSwitchInto[1] = undefined;
      if (check_faints_and_end()) return;
      return cont();
    }
    const started = SwitchSeq.beginDoubleSwitch(st, 1, slot, {
      withdraw: true,
      noWithdrawMsg: true,
      reason: "switch",
      headless: Battle._headless,
      pushMsg: (t: any) => { Ui.push(t); },
      onDone: cont,
    });
    if (truthy(started)) Battle._phase = "switching";
  };
  const prow = D.pursuitRow(st, 0, 1);
  if (!truthy(prow)) return do_switch();
  for (let i = len(lor(Battle._actions, seq())); i >= 1; i--) {
    if (Battle._actions[i] === prow) remove(Battle._actions, i);
  }
  prow.done = true;
  const out: Tbl = {};
  Engine.resolveMove(st.player, st.enemy, prow.move, prow.slot, ad, st, out, { pursuitSwitch: true });
  if (Battle._headless || !truthy(out._anim)) {
    push_msgs(out);
    return do_switch();
  }
  AnimSeq.begin(out._anim, seq_push);
  Battle._phase = "animating";
  Battle._singleAfterAnim = do_switch;
};

// Lua: init.lua:3472
D.useBag = function (act: Tbl): any {
  const st = Battle._st, ad = Battle._adapter;
  if (State.sideOf(act.battler) !== "player") return D.afterEach();
  // package.loaded["src.core.game3.runtime"]
  const session = runtime_session();
  const bag = land(session, tk(session, "bag"));
  if (truthy(Catching.isBall(act.itemId))) {
    if (truthy(bag) && Bag.has(bag, act.itemId, 1)) Bag.remove(bag, act.itemId, 1);
    const fill = Adapter.fill(st, { lastItem: act.itemId });
    // pokefirered/data/battle_scripts_2.s:57
    Ui.push(BattleText.get("STRINGID_PLAYERUSEDITEM", fill));
    // pokefirered/data/battle_scripts_2.s:116
    Ui.push(BattleText.get("STRINGID_TRAINERBLOCKEDBALL", fill));
    Ui.push(BattleText.get("STRINGID_DONTBEATHIEF", fill));
    return D.afterEach();
  }
  if (truthy(act.usedInMenu)) {
    // pokefirered/data/battle_scripts_2.s:130 BattleScript_PlayerUseItem
    Anim.syncDisplayFromState(st);
    return D.afterEach();
  }
  const result = BattleItems.use(st, ad, bag, session, act.itemId, act.partySlot, act.battler, act.moveSlot)[0];
  if (result === "heal") {
    for (const [, id] of ipairs<number>(SEL_ORDER)) {
      const b = State.battler(st, id);
      if (truthy(b) && b.partyIndex === act.partySlot && !truthy(State.isAbsent(st, id))) {
        const p = Anim.present(id);
        const logical = tonumber(land(b.mon, tk(b.mon, "hp"))) ?? 0;
        if (truthy(p) && p.displayHp != null && Math.abs(logical - p.displayHp) >= 1) {
          Anim.tweenHp(id, p.displayHp, logical, b.mon.maxHp);
        }
      }
    }
  }
  return D.afterEach();
};

// Lua: init.lua:3512
D.run = function (act: Tbl): any {
  const st = Battle._st, ad = Battle._adapter;
  if (truthy(act) && truthy(act.forfeit)) {
    // pokeemerald/data/battle_scripts_1.s:4547
    // pokeemerald/src/battle_main.c:5061-5067
    st.over = true;
    st.result = "forfeited";
    st.endReason = "forfeit";
    Ui.push(BattleText.get("STRINGID_FORFEITEDMATCH"));
    Battle._pendingEnd = "forfeited";
    Battle._phase = "ending";
    return;
  }
  let fled = false;
  const evs = D.capture(() => {
    fled = truthy(Engine.tryFlee(st, ad, State.battler(st, act.battler))[0]) ? true : false;
  });
  for (const [, e] of ipairs(evs)) {
    if (e.kind === "msg") Ui.push(e.text);
  }
  if (fled) {
    st.over = true;
    st.result = "run";
    st.endReason = "flee";
    Battle._pendingEnd = "run";
    Battle._phase = "ending";
    return;
  }
  return D.afterEach();
};

// pokefirered/data/battle_scripts_2.s:87
// Lua: init.lua:3544
function finish_catch_flow(catchRes: Tbl, ename: any, nicknamed?: boolean): void {
  if (truthy(catchRes) && catchRes.location === "pc") {
    // package.loaded["src.core.game3.runtime"]
    const session = runtime_session();
    Catching.givePending(session, catchRes);
    // pokefirered/src/battle_script_commands.c:9617
    const page = Storage.pcTransferMessage(session, ename);
    if (!truthy(nicknamed)) {
      Battle._phase = "catch_pc_msg";
      Ui.push(page);
      return;
    }
  }
  Ui.clearCaughtDexScene();
  Battle._actions = seq();
  Battle._pendingEnd = "catch";
  Battle._phase = "ending";
}

// Lua: init.lua:3564
function start_post_catch_flow(catchRes: Tbl): void {
  Ui.clearCaughtDexScene();
  Battle._catchDexReturn = undefined;
  // pokefirered/data/battle_scripts_2.s:99 BattleScript_OldMan_Pokedude_CaughtMessage
  if (Battle._headless || (truthy(Battle._st) && (truthy(Battle._st.oldManTutorial) || truthy(Battle._st.pokedude)
      || truthy(Wally.active(Battle._st))))) {
    if (truthy(catchRes) && truthy(catchRes.pending)) {
      // package.loaded["src.core.game3.runtime"]
      Catching.givePending(runtime_session(), catchRes);
    }
    Battle._actions = seq();
    Battle._pendingEnd = "catch";
    Battle._phase = "ending";
    return;
  }

  const enemy = land(Battle._st, tk(Battle._st, "enemy"));
  const mon = lor(land(catchRes, tk(catchRes, "mon")), land(enemy, tk(enemy, "mon")));
  const sp = orl(
    () => (truthy(enemy) && truthy(enemy.mon)) ? lor(enemy.mon.species, enemy.mon.speciesId) : undefined,
    () => (truthy(catchRes) && truthy(catchRes.mon)) ? lor(catchRes.mon.species, catchRes.mon.speciesId) : undefined,
    () => land(enemy, tk(enemy, "species")),
    () => 1,
  );
  const ename = orl(
    () => truthy(mon) ? ((mon.nickname !== "" && truthy(mon.nickname)) ? mon.nickname : mon.name) : mon,
    () => Pokemon.name(sp),
  );
  const gender = orl(
    () => truthy(mon) ? lor(mon.gender, land(mon.isFemale, 1)) : mon,
    () => land(enemy, tk(enemy, "gender")),
    () => 0,
  );
  const personality = lor(land(mon, tk(mon, "personality")), 0);
  const caughtState = Battle._st;

  const prompt_nickname = (): void => {
    Battle._phase = "catch_nickname_prompt";
    // pokefirered/src/battle_message.c:477
    Ui.askYesNo(BattleText.get("STRINGID_GIVENICKNAMECAPTURED", { opponentMon1: ename }), (yes: any) => {
      if (!Battle._active || Battle._st !== caughtState || Battle._phase !== "catch_nickname_prompt") return;
      if (truthy(yes)) {
        // pcall(require, "src.ui.game3.naming") succeeds: it is linked in.
        const okN = true;
        if (okN && truthy(Naming) && truthy(Naming.open)) {
          Ui.clearCaughtDexScene();
          Battle._phase = "catch_naming";
          Naming.open({
            template: "CAUGHT_MON",
            maxLen: 10,
            species: sp,
            gender: gender,
            personality: personality,
            seed: ename,
            // pokefirered/src/naming_screen.c:696
            sentToPc: (truthy(catchRes) && catchRes.location === "pc") || false,
            // pret naming_screen.c:1712 DrawMonTextEntryBox: gSpeciesNames[mon]
            // + gText_PkmnsNickname. The hand-written "YOUR POKEMON'S NICKNAME?"
            // was 141px wide and spilled over the frame's right edge.
            title: Naming.monTitle(Pokemon.name(sp)),
            onDone: (nick: any) => {
              if (!Battle._active || Battle._st !== caughtState || Battle._phase !== "catch_naming") return;
              if (truthy(nick) && nick !== "" && nick !== ename) {
                if (truthy(mon)) mon.nickname = nick;
              }
              // pokefirered/src/battle_script_commands.c:9853
              finish_catch_flow(catchRes, ename, true);
            },
          });
          return;
        }
      }
      finish_catch_flow(catchRes, ename);
    });
  };

  if (truthy(catchRes) && truthy(catchRes.firstTimeCaught) && truthy(sp) && BattleProfile.of(Battle._st).family === "rse") {
    // pokeemerald/src/battle_script_commands.c:10115
    Battle._phase = "pokedex_reg";
    Battle._rseDex = true;
    // pokeemerald/src/battle_script_commands.c:10115
    const dexMon = lor(land(enemy, tk(enemy, "mon")), mon);
    // NOT FAITHFUL: Emerald only (src.ui.game3.rse.pokedex has no file in the port).
    requireMissing("src.ui.game3.rse.pokedex").showCaughtMon(sp, {
      session: runtime_session(),
      personality: lor(land(dexMon, tk(dexMon, "personality")), personality),
      otId: land(dexMon, tk(dexMon, "otId")),
      otSecretId: land(dexMon, tk(dexMon, "otSecretId")),
      shiny: Pokemon.isShiny(dexMon),
      onDone: (caught: any) => {
        if (!Battle._active || Battle._st !== caughtState || Battle._phase !== "pokedex_reg") return;
        Battle._rseDex = undefined;
        Ui.beginCaughtDexScene(caught);
        Battle._phase = "catch_dex_return";
        Battle._catchDexReturn = prompt_nickname;
      },
    });
    return;
  }
  if (truthy(catchRes) && truthy(catchRes.firstTimeCaught) && truthy(sp)) {
    // pcall(require, "src.ui.game3.pokedex") succeeds: it is linked in.
    const okP = true;
    if (okP && truthy(Pokedex) && truthy(Pokedex.showRegistration)) {
      Battle._phase = "pokedex_reg";
      // package.loaded["src.core.game3.runtime"]
      const session = runtime_session();
      Pokedex.showRegistration(sp, {
        session: session,
        onDone: () => {
          if (!Battle._active || Battle._st !== caughtState || Battle._phase !== "pokedex_reg") return;
          // pokefirered/src/battle_script_commands.c:9699
          const target = lor(land(enemy, tk(enemy, "mon")), mon);
          const pid = lor(land(target, tk(target, "personality")), personality);
          const shiny = Pokemon.isShiny(target);
          const pic: any = Pokemon.frontPic(Pokemon.picSpecies(sp, pid), undefined, shiny, pid);
          Ui.beginCaughtDexScene({
            family: "frlg", personality: pid,
            otId: land(target, tk(target, "otId")), otSecretId: land(target, tk(target, "otSecretId")),
            shiny: shiny, sprite: { img: pic.image, x: 120, y: 64 },
          });
          Battle._phase = "catch_dex_return";
          Battle._catchDexReturn = prompt_nickname;
        },
      });
      return;
    }
  }

  prompt_nickname();
}

Battle.startPostCatchFlow = start_post_catch_flow;
Battle.finishCatchFlow = finish_catch_flow;

// pokefirered/src/battle_main.c:1455
// pokefirered/src/party_menu.c:2063 PartyMenuHandlePokedudeCancel
// Lua: init.lua:3690
Battle.quitPokedude = function (): boolean {
  const pst = Battle._st;
  if (!(truthy(pst) && truthy(pst.pokedude)) || Battle._phase === "fade_out") return false;
  pst.over = true;
  pst.result = "draw";
  pst.pdEnded = true;
  Battle._phase = "fade_out";
  if (Battle._headless) {
    finish("draw");
    return true;
  }
  Fade.begin(Fade.MODE.TO_BLACK, 1, () => { finish("draw"); });
  return true;
};

// (Lua: `local update_body` forward declaration -- hoisted function below.)

// Lua: init.lua:3707
Battle.update = function (dt?: number | null, game?: Tbl): void {
  if (!Battle._active) return;
  const st = Battle._st;
  if (!(truthy(st) && truthy(st.link))) return update_body(dt, game);
  let ok = true;
  let err: string | undefined;
  try {
    update_body(dt, game);
  } catch (e) {
    ok = false;
    // xpcall(..., debug.traceback): the JS stack stands in for the traceback.
    err = (e instanceof Error && e.stack) ? e.stack : tostring(e);
  }
  if (ok) return;
  console.log("[game3/battle] link battle step failed: " + tostring(err));
  const again = Battle._linkFault;
  Battle._linkFault = true;
  const LB = link_battle();
  const where = Guard.tripped;
  Guard.tripped = null;
  if (!truthy(again) && truthy(LB) && truthy(LB.desync)) {
    LB.desync(orl(() => LB._turn, () => st.turn, () => 0), truthy(where) ? ("rng:" + tostring(where)) : "engine");
  }
  if (Battle._active && (truthy(again) || Battle._phase !== "ending")) {
    finish("draw");
  }
};

// Lua: init.lua:3728
function update_body(dt: number | null | undefined, game: Tbl): void {
  if (!Battle._active) return;

  // A stat window whose phase can no longer dismiss it must not linger (#2324).
  if (!Battle.statWindowPhase()) {
    // package.loaded["src.ui.game3.stat_growth"]
    const StatGrowth = statGrowthLoaded();
    if (probeOpen(StatGrowth)) {
      StatGrowth.close({ silent: true });
    }
  }

  const input = land(game, tk(game, "input"));
  const pst = Battle._st;
  // pokefirered/src/battle_main.c:1455 JOY_HELD(B_BUTTON)
  if (truthy(pst) && truthy(pst.pokedude) && !Battle._headless && truthy(input) && truthy(input.isDown("b"))
      && Battle._phase !== "fade_out" && !(truthy(pst.pd) && truthy(pst.pd.menu))) {
    Battle.quitPokedude();
    return;
  }
  // package.loaded["src.ui.game3.pokedex"]
  if (probeOpen(Pokedex)) {
    if (truthy(input)) Pokedex.handleInput(input);
    return;
  }

  // pokeemerald/src/battle_pyramid_bag.c:379
  // package.loaded["src.ui.game3.rse.pyramid_bag"]
  const PyramidBag = PyramidBagLoaded;
  if (probeOpen(PyramidBag)) return;

  // package.loaded["src.ui.game3.naming"]
  if (probeOpen(Naming)) {
    // Runtime ticks Hud after Battle; the naming stack entry owns this input.
    return;
  }

  if (!Battle._headless) {
    Anim.update(lor(dt, 0));
    // pcall(require, "src.core.game3.audio") succeeds: it is linked in.
    if (truthy(Audio) && truthy(Audio.tickCry)) Audio.tickCry(lor(dt, 1 / 60));
    update_low_hp_music();
    // package.loaded["src.ui.game3.party_menu"]
    const PartyMenu: any = PartyMenuMod;
    if (probeOpen(PartyMenu) && truthy(PartyMenu.update)) {
      PartyMenu.update(lor(dt, 1 / 60));
    }
  }

  // pokeemerald/src/battle_main.c:4015
  if (Battle._phase === "facility") {
    const fst = Battle._st;
    const fac = land(fst, tk(fst, "facility"));
    if (truthy(fac) && truthy(fac.update) && !truthy(fac.update(fst, input, dt))) return;
    const resume = Battle._facilityResume;
    Battle._facilityResume = undefined;
    if (truthy(resume)) resume!();
    return;
  }

  if (Battle._phase === "command" && truthy(Battle._st) && truthy(Battle._st.facility) && truthy(Battle._st.facility.turnStart)
      && Battle._st._facilityTurn !== Battle._st.turn && !truthy(Battle._st.spectate)) {
    const fst = Battle._st;
    fst._facilityTurn = fst.turn;
    if (truthy(fst.facility.turnStart(fst, Battle._adapter, Battle._auto || Battle._headless))) {
      Ui._mode = "none";
      Battle._phase = "facility";
      Battle._facilityResume = (): any => {
        Battle._phase = "command";
        if (Battle._auto) return begin_turn_with(auto_player_action(fst));
        if (truthy(fst.double)) return D.startSelection();
        Ui.openMenu();
      };
      return;
    }
  }

  if (Battle._phase === "linkwait") {
    link_turn_step();
    return;
  }

  if (Battle._phase === "linkswitch") {
    link_switch_step();
    return;
  }

  if (Battle._phase === "command" && truthy(Battle._st) && truthy(Battle._st.spectate)) {
    spectate_turn_step();
    return;
  }

  if (Battle._phase === "command" && !Battle._auto && truthy(Battle._st) && truthy(Battle._st.double)) {
    D.commandUpdate(input);
    return;
  }

  if (Battle._phase === "command" && !Battle._auto && truthy(Battle._st) && truthy(Battle._st.pokedude)) {
    const cmd = Pokedude.commandStep(Battle._st, Ui, input);
    if (truthy(cmd)) begin_turn_with(cmd);
    return;
  }

  if (Battle._phase === "command" && !Battle._auto) {
    if (refuse_link_item(input)) return;
    const PartyMenu: any = PartyMenuMod;
    if (truthy(PartyMenu.isOpen) && truthy(PartyMenu.isOpen())) {
      if (truthy(input)) party_menu_input(PartyMenu, input);
      return;
    }
    const BagMenu: any = BagMenuMod;
    if (truthy(BagMenu.isOpen) && truthy(BagMenu.isOpen())) {
      if (truthy(input)) Screens.handleInput("bag", BagMenu, input);
      return;
    }
    if (Ui._mode === "bag" || Ui._mode === "party") {
      Ui._mode = "menu";
    }
    if (truthy(Ui.selectionPump())) {
      const scmd = Ui.takeCommand();
      if (truthy(scmd)) begin_turn_with(scmd);
      return;
    }
    if (truthy(input)) Ui.handleInput(input);
    const cmd = Ui.takeCommand();
    if (truthy(cmd)) {
      begin_turn_with(cmd);
    }
    return;
  }

  if (Battle._phase === "preturn") {
    if (truthy(Anim.busy())) return;
    if (!truthy(Ui.pump())) return;
    if (truthy(AnimSeq.update())) {
      Battle._phase = "actions";
    }
    return;
  }

  // Choice input during award / shift prompt / evolution learn-move prompts / catch nickname prompt / evolving
  if (Battle.statWindowPhase()
      && !Battle._auto && truthy(game) && truthy(game.input)) {
    // package.loaded["src.ui.game3.evolution_scene"]
    if (probeOpen(EvolutionScene)) {
      // package.loaded["src.ui.game3.summary_menu"]
      const EvoSummary = SummaryMenu;
      if (probeOpen(EvoSummary)) {
        EvoSummary.handleInput(game.input);
      }
      return;
    }
    // package.loaded["src.ui.game3.stat_growth"]
    const StatGrowth = statGrowthLoaded();
    if (probeOpen(StatGrowth)) {
      if (truthy(StatGrowth.handleInput(game.input))) {
        return;
      }
    }
    // package.loaded["src.ui.game3.summary_menu"] / ["src.ui.game3.party_menu"]
    if ((Battle._phase === "awarding" || Battle._phase === "evolving")
        && probeOpen(SummaryMenu)
        && !probeOpen(PartyMenuMod)) {
      SummaryMenu.handleInput(game.input);
      return;
    }
    if (truthy(Ui.choiceActive) && truthy(Ui.choiceActive())) {
      Ui.handleInput(game.input);
      return;
    }
  }

  // Intro: pump dialogs even while slide tweens run
  if (Battle._phase === "intro") {
    if (!truthy(Ui.pump())) return;
    if (truthy(IntroSeq.update())) {
      // pokefirered/src/battle_controller_oak_old_man.c:626
      const stIntro = Battle._st;
      if (truthy(stIntro) && truthy(Oak.active(stIntro)) && !truthy(stIntro.oakIntroDone)) {
        stIntro.oakIntroDone = true;
        if (truthy(Oak.say(stIntro, "forPetesSake"))) return;
      }
      if (begin_start_effects()) return;
      Battle._phase = "command";
      if (Battle._auto) {
        begin_turn_with(auto_player_action(Battle._st));
      } else {
        Ui.openMenu();
      }
    }
    return;
  }

  if (Battle._phase === "startfx") {
    if (truthy(Anim.busy())) return;
    if (!truthy(Ui.pump())) return;
    if (truthy(AnimSeq.update())) {
      Battle._phase = "command";
      if (Battle._auto) {
        begin_turn_with(auto_player_action(Battle._st));
      } else {
        Ui.openMenu();
      }
    }
    return;
  }

  // Mid-turn switch-in during faint / pursuit
  if (Battle._phase === "faint_switch") {
    // package.loaded["src.ui.game3.party_menu"]
    if (probeOpen(PartyMenuMod)) {
      if (truthy(input)) party_menu_input(PartyMenuMod, input);
      return;
    }
    if (truthy(Anim.busy())) return;
    if (truthy(Ui.choiceActive) && truthy(Ui.choiceActive())) {
      return;
    }
    if (!truthy(Ui.pump())) return;
    if (truthy(SwitchSeq.update())) {
      Battle._phase = "actions";
      if (!truthy(Battle._actions) || !truthy(Battle._actions[Battle._actionI])) {
        after_actions();
      }
    }
    return;
  }

  // Shift prompt: after dialog dismissed, open Yes/No box
  if (Battle._phase === "shift_prompt") {
    if (!truthy(Ui.pump())) return;
    if (truthy(Ui.choiceActive) && truthy(Ui.choiceActive())) {
      if (truthy(input)) Ui.handleInput(input);
      return;
    }
    if (!Battle._shiftAsked) {
      Battle._shiftAsked = true;
      Ui.askYesNo((yes: any) => {
        Battle._shiftAsked = false;
        const nextEnemyIdx = Battle._shiftEnemyIdx;
        Battle._shiftEnemyIdx = undefined;
        const st = Battle._st;
        if (truthy(yes) && truthy(st)) {
          const PartyMenu: any = PartyMenuMod;
          // package.loaded["src.core.game3.runtime"]
          const session = runtime_session();
          State.syncBattlerToParty(st.player, st.playerParty);
          PartyMenu.show(lor(st.playerParty, tk(session, "party")), tk(session, "move_overlay"), {
            mode: "battle_switch",
            session: session,
            activeSlot: st.player.partyIndex,
            battle: true,
            validate: (slot: any): any => {
              if (slot === st.player.partyIndex) return undefined;
              return Commands.switchError(st, slot, true);
            },
            onSelect: (pSlot: any) => {
              if (pSlot == null || pSlot === st.player.partyIndex) {
                send_out_enemy_next(nextEnemyIdx);
              } else {
                SwitchSeq.beginShiftSwitch(st, pSlot, nextEnemyIdx, {
                  headless: false,
                  pushMsg: (t: any) => { Ui.push(t); },
                  onDone: resume_turn,
                });
                Battle._phase = "switching";
              }
            },
            onClose: () => {
              send_out_enemy_next(nextEnemyIdx);
            },
          });
          Battle._phase = "switching";
        } else {
          send_out_enemy_next(nextEnemyIdx);
        }
      });
    }
    return;
  }

  // Switch / send-out presentation
  if (Battle._phase === "switching") {
    // package.loaded["src.ui.game3.party_menu"]
    if (probeOpen(PartyMenuMod)) {
      if (truthy(input)) party_menu_input(PartyMenuMod, input);
      return;
    }
    if (truthy(Anim.busy())) return;
    if (truthy(Ui.choiceActive) && truthy(Ui.choiceActive())) {
      return;
    }
    if (!truthy(Ui.pump())) return;
    SwitchSeq.update();
    return;
  }

  // Anim sequence owns presentation pacing
  if (Battle._phase === "animating") {
    if (truthy(Anim.busy())) return;
    if (!truthy(Ui.pump())) return;
    const done = AnimSeq.update();
    if (truthy(done)) {
      after_anim_sequence();
    }
    return;
  }

  // Poké Ball catch presentation
  if (Battle._phase === "catching") {
    if (truthy(Anim.busy())) return;
    if (!truthy(Ui.pump())) return;
    const done = CatchSeq.update();
    if (truthy(done)) {
      const res = CatchSeq.result();
      if (res === "catch") {
        const catchRes = truthy(CatchSeq.catchResult) ? CatchSeq.catchResult() : CatchSeq.catchResult;
        start_post_catch_flow(catchRes);
      } else if (safari_out_of_balls(Battle._st)) {
        return;
      } else {
        Battle._phase = "actions";
        if (!truthy(Battle._actions) || !truthy(Battle._actions[Battle._actionI])) {
          after_actions();
        }
      }
    }
    return;
  }

  if (Battle._phase === "pokedex_reg") {
    // NOT FAITHFUL: Emerald only (src.ui.game3.rse.pokedex has no file in the port).
    if (truthy(Battle._rseDex) && truthy(input)) requireMissing("src.ui.game3.rse.pokedex").Host.handleInput(input);
    return;
  }

  if (Battle._phase === "catch_nickname_prompt") {
    if (!truthy(Ui.pump())) return;
    return;
  }

  if (Battle._phase === "catch_dex_return") {
    if (truthy(Ui.updateCaughtDexScene())) {
      const cb = Battle._catchDexReturn;
      Battle._catchDexReturn = undefined;
      if (truthy(cb)) cb!();
    }
    return;
  }

  if (Battle._phase === "catch_naming") {
    return;
  }

  if (Battle._phase === "catch_pc_msg") {
    if (!truthy(Ui.pump())) return;
    Battle._actions = seq();
    Battle._pendingEnd = "catch";
    Battle._phase = "ending";
    return;
  }

  // EXP award / level-up / learn-move
  if (Battle._phase === "awarding") {
    if (truthy(Anim.busy())) return;
    if (truthy(Ui.choiceActive) && truthy(Ui.choiceActive())) return;
    if (!truthy(Ui.pump())) return;
    const done = ExpSeq.update();
    if (truthy(done)) {
      merge_leveled_set(ExpSeq.leveledSet());
      const cb = Battle._onExpDone;
      Battle._onExpDone = undefined;
      if (truthy(cb)) {
        cb!();
      } else {
        begin_evo_or_end();
      }
    }
    return;
  }

  // Post-battle evolution (EVO_LEVEL)
  if (Battle._phase === "evolving") {
    // package.loaded["src.ui.game3.evolution_scene"]
    if (probeOpen(EvolutionScene)) {
      return;
    }
    if (truthy(Ui.choiceActive) && truthy(Ui.choiceActive())) return;
    if (!truthy(Ui.pump())) return;
    const done = EvoSeq.update();
    if (truthy(done)) {
      Battle._phase = "ending";
    }
    return;
  }

  if (Battle._phase === "residuals") {
    if (truthy(Anim.busy())) return;
    if (!truthy(Ui.pump())) return;
    if (!truthy(AnimSeq.update())) return;
    const rst = Battle._st;
    if (truthy(rst) && truthy(rst.facility) && truthy(rst.facility.endTurn) && rst._facilityEndTurn !== rst.turn) {
      // pokeemerald/src/battle_util.c:1856
      rst._facilityEndTurn = rst.turn;
      if (truthy(rst.facility.endTurn(rst, Battle._adapter, false))) {
        Battle._phase = "facility";
        Battle._facilityResume = () => { Battle._phase = "residuals"; };
        return;
      }
    }
    Battle._residualEvents = undefined;
    Battle._residualIndex = 1;
    Battle._residualStepState = undefined;
    if (truthy(Battle._st) && truthy(Battle._st.double)) {
      D.endTurn();
      return;
    }
    if (check_faints_and_end()) {
      return;
    }
    Battle._phase = "command";
    if (Battle._auto) {
      begin_turn_with(auto_player_action(Battle._st));
    } else {
      Ui.openMenu();
    }
    return;
  }

  if (truthy(Anim.busy())) return;
  if (!truthy(Ui.pump())) return;

  if (Battle._phase === "actions") {
    step_action();
    // (step_action moves the phase; the cast stops TS narrowing it to "actions")
    if ((Battle._headless || !Battle._fade) && (Battle._phase as string) === "ending") {
      finish(lor(Battle._pendingEnd, "win"));
    }
    return;
  }

  if (Battle._phase === "ending") {
    const est = Battle._st;
    if (truthy(est) && truthy(est.pokedude) && !truthy(est.pdEnded)) {
      est.pdEnded = true;
      // pokefirered/data/battle_scripts_2.s:102 endlinkbattle
      if (truthy(Pokedude.event(est, "endlinkbattle", "player")) && !Battle._headless) return;
    }
    if (Battle._headless || !Battle._fade) {
      finish(lor(Battle._pendingEnd, "win"));
    } else {
      Battle._phase = "fade_out";
      // pcall(require, "src.core.game3.audio") succeeds: it is linked in.
      if (truthy(Audio) && truthy(Audio.fadeOutBgm)) {
        Audio.fadeOutBgm(5);
      }
      // pcall(require, "src.ui.game3.fade") succeeds: it is linked in.
      if (truthy(Fade) && truthy(Fade.begin)) {
        Fade.begin(Fade.MODE.TO_BLACK, 1, () => {
          finish(lor(Battle._pendingEnd, "win"));
        });
      } else {
        finish(lor(Battle._pendingEnd, "win"));
      }
    }
    return;
  }

  if (Battle._phase === "fade_out") {
    return;
  }

  if (Battle._phase === "command" && Battle._auto) {
    begin_turn_with(auto_player_action(Battle._st));
  }
}

// Lua: init.lua:4199
Battle.runToEnd = function (): any {
  if (!Battle._active) return Battle.getResult();
  Battle._auto = true;
  Battle._headless = true;
  const savedLog = lor(truthy(Ui.log) ? Ui.log() : undefined, seq());
  Ui.reset({ headless: true });
  Ui.bindState(Battle._st);
  if (truthy(savedLog) && len(savedLog) > 0) {
    for (const [, t] of ipairs(savedLog)) {
      Ui._log[len(Ui._log) + 1] = t;
    }
  }
  Anim.reset({ headless: true, double: land(Battle._st, tk(Battle._st, "double")) });
  AnimSeq.reset();
  CatchSeq.reset();
  ExpSeq.reset();
  EvoSeq.reset();
  IntroSeq.reset();
  LearnMove.reset();
  let guard = 0;
  while (Battle._active && guard < 800) {
    guard = guard + 1;
    Battle.update(0, undefined);
  }
  return Battle.getResult();
};

// Lua: init.lua:4226
Battle.draw = function (_game: any, w?: number, h?: number): void {
  if (!Battle._active) return;
  Ui.draw(w, h);
  const st = Battle._st;
  if (truthy(st) && truthy(st.facility) && truthy(st.facility.draw)) st.facility.draw(st);
};

// Lua: init.lua:4233
Battle.abort = function (result?: string | null): void {
  if (Battle._active) finish(lor(result, "run"));
};

// pokefirered/src/main.c:480
// Lua: init.lua:4238
Battle.reset = function (): void {
  Ui.clearCaughtDexScene();
  Battle._catchDexReturn = undefined;
  // NOT FAITHFUL: Emerald only (src.ui.game3.rse.pokedex has no file in the port).
  if (truthy(Battle._rseDex)) requireMissing("src.ui.game3.rse.pokedex").reset();
  Battle._rseDex = undefined;
  stop_low_hp_song();
  Guard.disarm();
  Battle._active = false;
  Battle._st = undefined;
  Battle._adapter = undefined;
  Battle._phase = undefined;
  Battle._onDone = undefined;
  Battle._onExpDone = undefined;
  Battle._pendingEnd = undefined;
  Battle._pendingChoice = undefined;
  Battle._actions = undefined;
  Battle._actionI = 1;
  Battle._metaAct = undefined;
  Battle._auto = false;
  Battle._headless = false;
  Battle._fade = true;
  Battle._residualEvents = undefined;
  Battle._residualIndex = 1;
  Battle._residualStepState = undefined;
  D.reset();
  AnimSeq.reset();
  CatchSeq.reset();
  ExpSeq.reset();
  EvoSeq.reset();
  IntroSeq.reset();
  LearnMove.reset();
  SwitchSeq.reset();
  Anim.reset({ headless: true });
  if (truthy(Ui.clearLinger)) Ui.clearLinger();
};

// Lua: init.lua:4274
Battle.linkEnd = function (resultIn?: string | null, text?: string | null, reason?: string | null): boolean {
  if (!Battle._active) return false;
  const st = Battle._st;
  if (!truthy(st)) return false;
  const result = lor(resultIn, "draw") as string;
  st.over = true;
  st.result = result;
  st.endReason = lor(reason, "link");
  D.reset();
  Battle._dblFaint = undefined;
  Battle._actions = seq();
  Battle._actionI = 1;
  Battle._metaAct = undefined;
  Battle._residualEvents = undefined;
  Battle._pendingChoice = undefined;
  AnimSeq.reset();
  SwitchSeq.reset();
  // package.loaded["src.ui.game3.party_menu" / "bag_menu" / "summary_menu"]
  for (const M of [PartyMenuMod, BagMenuMod, SummaryMenu] as any[]) {
    if (probeOpen(M) && truthy(M.close)) {
      try { M.close(); } catch { /* pcall */ }
    }
  }
  if (truthy(Ui.clearLinger)) Ui.clearLinger();
  if (truthy(text) && text !== "") Ui.push(text);
  Battle._pendingEnd = result;
  Battle._phase = "ending";
  if (Battle._headless) finish(result);
  return true;
};

export default Battle;
