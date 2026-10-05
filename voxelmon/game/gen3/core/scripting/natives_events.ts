// Port of gen1recomp src/core/game3/scripting/natives_events.lua (GPLv3 + additional terms; see LICENSE.md).
// Field event specials (map view, event mons, safari, bike/surf, sticker
// man, trainer card icons, Seafoam, Deoxys, dolls) and the message-box
// walk-away poll.
//
// Port notes:
// - Handlers return Lua's multiple returns as a 0-based tuple (see natives.ts).
// - require / package.loaded / pcall(require) are static imports used as
//   Brian guards them. src.core.game3.link.init has no file in the port: its
//   pcall(require) is a failed require (lazyReqMissing below).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { seq, len, ipairs, type LuaTable } from "../../platform/lt.ts";
import { truthy, tonumber, mod } from "../../../../import/gen3/lua.ts";
import { notPorted } from "../../notported.ts";
import Std from "./stdscripts.ts";
import Flags from "./flags.ts";
import Runtime from "../runtime.ts";
import Space from "./space.ts";
import MapMod from "../map.ts";
import FieldView from "../field_view.ts";
import Encounters from "../encounters.ts";
import Safari from "../safari.ts";
import Field from "../field.ts";
import Player from "../player.ts";
import Audio from "../audio.ts";
import Task from "../task.ts";
import Roamer from "../roamer.ts";
import Rng from "../rng.ts";
import Pokemon from "../pokemon.ts";
import Deoxys from "../deoxys.ts";
import Hud from "../../ui/hud.ts";
import Natives, { type Handler } from "./natives.ts";

/** Lua's `a or b`. */
function lor<A, B>(a: A, b: B): A | B {
  return truthy(a) ? a : b;
}

// Lua's require of a module that has no file in the port: it fails.
function lazyReqMissing(name: string): any {
  return notPorted(`require("${name}") (no such module in the port yet)`);
}

const VAR_RESULT = 0x800D; // pokefirered/include/constants/vars.h:328
const VAR_0x8004 = 0x8004; // pokefirered/include/constants/vars.h:319
const VAR_0x8005 = 0x8005; // pokefirered/include/constants/vars.h:320
const VAR_0x8006 = 0x8006; // pokefirered/include/constants/vars.h:321
const VAR_FACING = 0x800C;

// pokefirered/src/field_tasks.c:51
const ICEFALL_CAVE_ICE_COORDS: LuaTable = seq(
  seq(8, 3), seq(10, 5), seq(15, 5),
  seq(8, 9), seq(9, 9), seq(16, 9),
  seq(8, 10), seq(9, 10), seq(8, 14),
);

// pokefirered/include/constants/metatile_labels.h:188
const METATILE_SEAFOAM_CRACKED_ICE = 0x35A;
const METATILE_SEAFOAM_ICE_HOLE = 0x35B;

// pokefirered/include/save_location.h:9
const CHAMPION_SAVEWARP = 0x80;

// Lua: natives_events.lua:25
function flagsMod(): typeof Flags {
  return Flags;
}

// Lua: natives_events.lua:29
function sessionOf(ctx?: any): any {
  // package.loaded["src.core.game3.runtime"]
  const rt = Runtime;
  return lor(lor(rt && rt.getSession && rt.getSession(), ctx && ctx.session), undefined);
}

// Lua: natives_events.lua:36
function scriptStore(ctx: any): any {
  // package.loaded["src.core.game3.scripting.space"]
  const session = sessionOf(ctx);
  return lor(lor(lor(Space && Space.store,
    session && lor(session.store, session)),
    ctx && lor(lor(ctx.store, ctx.session), ctx.vars && ctx)),
    undefined);
}

// Lua: natives_events.lua:45
function varGet(ctx: any, id: any): number {
  return tonumber(flagsMod().getVar(scriptStore(ctx), ctx, id)) ?? 0;
}

// Lua: natives_events.lua:50
// pokefirered/src/scrcmd.c:99
function setResult(ctx: any, value: any): void {
  flagsMod().setVar(scriptStore(ctx), ctx, VAR_RESULT, tonumber(value) ?? 0);
}

// Lua: natives_events.lua:54
function currentMapId(ctx: any): any {
  const session = sessionOf(ctx);
  if (truthy(session) && truthy(session.map)) return session.map;
  // package.loaded["src.core.game3.map"]
  const M = MapMod;
  return M && M.current;
}

// Lua: natives_events.lua:61
function partyOf(ctx: any): [LuaTable, any] {
  const session = sessionOf(ctx);
  return [lor(lor(session && session.party, ctx && ctx.party), {}), session];
}

const BY_NAME: Record<string, Handler> = {
  // Lua: natives_events.lua:76
  // pokefirered/src/field_camera.c:93
  DrawWholeMapView: () => {
    // package.loaded["src.core.game3.field_view"]
    if (FieldView) FieldView._nativeDirty = true;
    return [false];
  },
  // Lua: natives_events.lua:82
  // pokefirered/src/pokemon.c:6215
  CreateEnemyEventMon: (ctx) => {
    // pcall(require, "src.core.game3.encounters")
    const okE = true;
    const Enc: any = Encounters;
    if (!(okE && Enc && truthy(Enc.setWildBattle))) return [false];
    const item = varGet(ctx, VAR_0x8006);
    Enc.setWildBattle(varGet(ctx, VAR_0x8004), varGet(ctx, VAR_0x8005),
      item !== 0 ? item : undefined);
    // pokefirered/src/pokemon.c:2026
    const pending = Enc._pendingWild;
    if (truthy(pending)) pending.fatefulEncounter = true;
    return [false];
  },
  // Lua: natives_events.lua:94
  // pokefirered/src/safari_zone.c:27
  EnterSafariMode: () => {
    try { Safari.enter(); } catch (_e) { /* pcall */ }
    return [false];
  },
  // Lua: natives_events.lua:99
  // pokefirered/src/safari_zone.c:35
  ExitSafariMode: () => {
    try { Safari.exit(); } catch (_e) { /* pcall */ }
    return [false];
  },
  // Lua: natives_events.lua:104
  // pokefirered/src/field_tasks.c:152
  SetIcefallCaveCrackedIceMetatiles: (ctx) => {
    // pcall(require, "src.core.game3.field")
    const okF = true;
    if (!(okF && Field && truthy(Field.setMetatile))) return [false];
    const F = flagsMod();
    const store = scriptStore(ctx);
    for (let i = 1; i <= len(ICEFALL_CAVE_ICE_COORDS); i++) {
      if (F.getFlag(store, ctx, i)) {
        const c = ICEFALL_CAVE_ICE_COORDS[i];
        Field.setMetatile(c[1], c[2], METATILE_SEAFOAM_CRACKED_ICE, false);
      }
    }
    return [false];
  },
  // Lua: natives_events.lua:118
  // pokefirered/src/field_specials.c:97
  ForcePlayerOntoBike: () => {
    // pcall(require, "src.core.game3.player")
    const okP = true;
    if (okP && Player && !truthy(Player.surfing)) {
      Player.biking = true;
      Player.surfHopping = false;
      const game = Runtime && Runtime._game;
      Player.syncSavePosition(game);
    }
    Audio.bikeMusic(true, true);
    return [false];
  },
  // Lua: natives_events.lua:130
  // pokefirered/src/field_specials.c:1513
  ForcePlayerToStartSurfing: () => {
    const okP = true;
    if (okP && Player) {
      Player.surfing = true;
      Player.biking = false;
      Player.surfHopping = false;
      const game = Runtime && Runtime._game;
      Player.syncSavePosition(game);
    }
    return [false];
  },
  // Lua: natives_events.lua:142
  // pokefirered/src/wild_encounter.c:446
  RockSmashWildEncounter: (ctx, adapters) => {
    // pcall(require, "src.core.game3.encounters")
    const okE = true;
    const Enc: any = Encounters;
    let foe: any;
    if (okE && Enc && typeof Enc.rollRocks === "function") {
      foe = Enc.rollRocks(currentMapId(ctx));
    }
    if (!(truthy(foe) && adapters && truthy(adapters.startWildBattle))) {
      setResult(ctx, 0);
      return [false];
    }
    foe.wildScripted = true;
    setResult(ctx, 1);
    return [Natives.yieldHost(ctx, adapters, (done) => {
      adapters.startWildBattle(foe, (result: any) => {
        const code = Natives.outcome_to_code(result);
        if (ctx) ctx.lastBattleOutcome = code;
        done();
      }, { wildScripted: true });
    })];
  },
  // Lua: natives_events.lua:164
  // pokefirered/src/save_location.c:105
  SetPostgameFlags: (ctx) => {
    const session = sessionOf(ctx);
    if (!truthy(session)) return [false];
    session.gcnLinkFlags = (tonumber(session.gcnLinkFlags) ?? 0) | 0x800E;
    session.specialSaveWarpFlags =
      (tonumber(session.specialSaveWarpFlags) ?? 0) | CHAMPION_SAVEWARP;
    return [false];
  },
  // Lua: natives_events.lua:174
  // pokefirered/src/field_specials.c:120 ShowFieldMessageStringVar4
  ShowFieldMessageStringVar4: (ctx, adapters) => {
    const text = lor(ctx && ctx.stringVars && ctx.stringVars[4], "");
    if (ctx) ctx.messageOpen = true;
    const openStay = adapters && lor(adapters.openMessageStay, adapters.openMessageAsync);
    if (truthy(openStay)) {
      openStay(text, undefined);
    } else if (adapters && truthy(adapters.openMessage)) {
      adapters.openMessage(text);
    }
    return [false];
  },
  // Lua: natives_events.lua:186
  // pokefirered/src/script.c:260 SetWalkingIntoSignVars
  SetWalkingIntoSignVars: (ctx) => {
    if (ctx) {
      ctx.walkAwayFromSignInhibitTimer = 6;
      ctx.msgBoxIsCancelable = true;
      ctx.canWalkAway = true;
    }
    const session = sessionOf(ctx);
    if (truthy(session)) {
      session.walkAwayFromSignInhibitTimer = 6;
      session.msgBoxIsCancelable = true;
    }
    return [false];
  },
  // Lua: natives_events.lua:200
  // pokefirered/src/field_specials.c:1733 StickerManGetBragFlags
  StickerManGetBragFlags: (ctx) => {
    const session = sessionOf(ctx);
    const F = flagsMod();
    const store = scriptStore(ctx);
    const stats = lor(session && lor(session.gameStats, session.stats), {} as any);

    // field_specials.c:1737, include/constants/game_stat.h:14
    let hof: any = lor(lor(lor(stats[10], stats.enteredHof),
      session && lor(session.hofClears, session.hallOfFameCount)),
      F.getFlag(store, ctx, "FLAG_SYS_GAME_CLEAR") ? 1 : 0);
    hof = tonumber(hof) ?? 0;

    // game_stat.h:17
    let eggs: any = lor(lor(lor(stats[13], stats.hatchedEggs),
      session && session.eggsHatched), 0);
    eggs = tonumber(eggs) ?? 0;
    const eggsClamped = Math.min(0xFFFF, eggs);

    // game_stat.h:27
    let linkWins: any = lor(lor(lor(stats[23], stats.linkBattleWins),
      session && lor(session.linkWins, session.linkBattleWins)), 0);
    linkWins = tonumber(linkWins) ?? 0;

    F.setVar(store, ctx, VAR_0x8004, hof);
    F.setVar(store, ctx, VAR_0x8005, eggsClamped);
    F.setVar(store, ctx, VAR_0x8006, linkWins);

    let result = 0;
    if (hof !== 0) result = result + 1;
    if (eggsClamped !== 0) result = result + 2;
    if (linkWins !== 0) result = result + 4;

    F.setVar(store, ctx, 0x8008, result);
    setResult(ctx, result);
    return [false, result];
  },
  // Lua: natives_events.lua:237
  // pokefirered/src/field_specials.c:1710 UpdateTrainerCardPhotoIcons
  UpdateTrainerCardPhotoIcons: (ctx) => {
    const [party] = partyOf(ctx);
    const F = flagsMod();
    const store = scriptStore(ctx);
    const partyCount = truthy(party) ? len(party) : 0;

    const VAR_TRAINER_CARD_MON_ICON_1 = 0x4043;
    const VAR_TRAINER_CARD_MON_ICON_TINT_IDX = 0x4042;

    for (let i = 1; i <= 6; i++) {
      let iconSpecies = 0;
      if (truthy(party) && i <= partyCount && truthy(party[i])) {
        const mon = party[i];
        if (truthy(mon.isEgg)) {
          iconSpecies = 412; // SPECIES_EGG
        } else {
          iconSpecies = tonumber(lor(mon.speciesId, mon.species)) ?? 0;
        }
      }
      F.setVar(store, ctx, VAR_TRAINER_CARD_MON_ICON_1 + i - 1, iconSpecies);
    }

    const tint = varGet(ctx, VAR_0x8004);
    F.setVar(store, ctx, VAR_TRAINER_CARD_MON_ICON_TINT_IDX, tint);
    return [false];
  },
  // Lua: natives_events.lua:264
  // pokefirered/src/field_player_avatar.c:1603 SeafoamIslandsB4F_CurrentDumpsPlayerOnLand
  SeafoamIslandsB4F_CurrentDumpsPlayerOnLand: (ctx, adapters) => {
    const finishDismount = (): void => {
      const session = sessionOf(ctx);
      if (truthy(session)) {
        session.surfing = false;
        if (truthy(session.player)) {
          session.player.surfing = false;
          session.player.state = "walk";
          session.player.facing = "up";
        }
        session.facing = "up";
      }
      // package.loaded["src.core.game3.runtime"]
      const rt = Runtime;
      if (rt && truthy(rt.player)) {
        rt.player.surfing = false;
        rt.player.state = "walk";
        rt.player.facing = "up";
      }
      // pcall(require, "src.core.game3.player")
      const okP = true;
      if (okP && Player) {
        Player.surfing = false;
        Player.state = "walk";
        Player.facing = "up";
      }
      // package.loaded["src.core.game3.field"]
      const Fld: any = Field;
      if (Fld && truthy(Fld.stopSurfing)) {
        try { Fld.stopSurfing(); } catch (_e) { /* pcall */ }
      }
    };

    if (adapters && truthy(adapters.applyMovement)) {
      return [Natives.yieldHost(ctx, adapters, (done) => {
        // 0xA7 = MOVEMENT_ACTION_JUMP_SPECIAL_WITH_EFFECT_UP (jump 1 cell up onto stairs)
        adapters.applyMovement(255, seq(0xA7, 0xFE), () => {
          finishDismount();
          done();
        });
      })];
    } else {
      const okP = true;
      if (okP && Player && truthy(Player.cellY)) {
        Player.cellY = Player.cellY - 1;
        Player.targetY = Player.cellY;
        Player.py = Player.cellY * 16;
      }
      finishDismount();
      return [false];
    }
  },
  // Lua: natives_events.lua:315
  // pokefirered/src/start_menu.c:620 Field_AskSaveTheGame
  Field_AskSaveTheGame: (ctx, _adapters) => {
    // pcall(require, "src.core.game3.link.init"): no such module in the port,
    // so the require fails (okL = false), as in Lua.
    let okL = false;
    let Link: any;
    try { Link = lazyReqMissing("src.core.game3.link.init"); okL = true; } catch (_e) { okL = false; }
    if (okL && Link && truthy(Link.askSaveTheGame)) {
      return Link.askSaveTheGame(ctx, _adapters);
    }
    setResult(ctx, 0);
    return [false];
  },
  // Lua: natives_events.lua:324
  // pokefirered/src/load_save.c:208 LoadPlayerBag
  LoadPlayerBag: () => {
    // pcall(require, "src.core.game3.link.init"): no such module in the port.
    let okL = false;
    let Link: any;
    try { Link = lazyReqMissing("src.core.game3.link.init"); okL = true; } catch (_e) { okL = false; }
    if (okL && Link && truthy(Link.loadPlayerBag)) {
      Link.loadPlayerBag();
    }
    return [false];
  },
  // Lua: natives_events.lua:333
  // pokefirered/src/field_specials.c:461
  // src/field_specials.c:461-493, include/constants/songs.h:212
  ShakeScreen: (ctx) => {
    const x = varGet(ctx, VAR_0x8005);
    const y = varGet(ctx, VAR_0x8004);
    const iters = varGet(ctx, VAR_0x8006);
    const dur = varGet(ctx, 0x8007);
    if ((x === 0 && y === 0) || iters < 1 || dur < 1) return [false];
    // package.loaded["src.core.game3.field_view"]
    const FV = FieldView;
    // pcall(require, "src.core.game3.task")
    const okT = true;
    if (!(okT && Task && Task.spawn)) return [false];
    try { Audio.playSe("SE_M_STRENGTH"); } catch (_e) { /* pcall */ }
    let frame = 0;
    let left = iters;
    let cx = x;
    let cy = y;
    Task.spawn(() => {
      frame = frame + 1;
      if (mod(frame, dur) === 0) {
        left = left - 1;
        cx = -cx;
        cy = -cy;
        if (FV) {
          FV.cameraPanX = cx;
          FV.cameraPanY = cy;
        }
        if (left === 0) {
          if (FV) {
            FV.cameraPanX = 0;
            FV.cameraPanY = 0;
          }
          return true;
        }
      }
      return false;
    });
    return [false];
  },
  // Lua: natives_events.lua:366
  // src/roamer.c:120
  InitRoamer: (ctx) => {
    const session = sessionOf(ctx);
    const VAR_STARTER_MON = 0x4031; // pokefirered/include/constants/vars.h:98
    const starter = varGet(ctx, VAR_STARTER_MON);
    // pcall(require, "src.core.game3.roamer")
    const okR = true;
    if (okR && Roamer && truthy(Roamer.init)) {
      Roamer.init(session, starter);
    }
    return [false];
  },
  // Lua: natives_events.lua:377
  // src/field_specials.c:679-690
  SampleResortGorgeousMonAndReward: (ctx, adapters) => {
    const session = sessionOf(ctx);
    if (!truthy(session)) return [false];
    const VAR_REQ = 0x4036; // include/constants/vars.h:104
    const VAR_REWARD = 0x403B; // vars.h:109
    const VAR_STEP = 0x4035; // vars.h:103
    const requested = varGet(ctx, VAR_REQ);
    const store = scriptStore(ctx);
    const F = flagsMod();
    if (requested === 0 || requested === 0xFFFF) {
      const ownedT = lor(session.dex && lor(session.dex.owned, session.dex.caught), {} as any);
      const NUM = 411; // species.h:423
      let sp = 1;
      let found = false;
      for (let n = 1; n <= 100; n++) {
        sp = mod(Rng.Random(), NUM) + 1;
        if (truthy(ownedT[sp])) { found = true; break; }
      }
      if (!found) {
        for (let n = 1; n <= 500; n++) {
          if (truthy(ownedT[sp])) { found = true; break; }
          if (sp === 1) sp = NUM; else sp = sp - 1;
        }
      }
      F.setVar(store, ctx, VAR_REQ, sp);
      // items.h:72,110-114
      const rewards: LuaTable = seq(107, 106, 108, 109, 110, 68);
      let reward = 11;
      if (mod(Rng.Random(), 100) < 30) {
        reward = rewards[mod(Rng.Random(), len(rewards)) + 1];
      }
      F.setVar(store, ctx, VAR_REWARD, reward);
      F.setVar(store, ctx, VAR_STEP, 0);
    }
    // pokefirered/src/field_specials.c:688
    // package.loaded["src.core.game3.pokemon"] or require(...)
    const nameOf = Pokemon;
    const name = lor(nameOf.name && nameOf.name(varGet(ctx, VAR_REQ)), "");
    if (adapters && truthy(adapters.setStringVar)) adapters.setStringVar(1, name);
    if (ctx && truthy(ctx.stringVars)) ctx.stringVars[1] = name;
    return [false];
  },
  // Lua: natives_events.lua:420
  // pokefirered/src/script.c:245
  DisableMsgBoxWalkaway: (ctx) => {
    if (ctx) {
      ctx.canWalkAway = false;
    }
    const session = sessionOf(ctx);
    if (truthy(session)) {
      session.canWalkAway = false;
    }
    return [false];
  },
  // Lua: natives_events.lua:431
  // pokefirered/src/field_specials.c:2319
  DoDeoxysTriangleInteraction: (ctx) => {
    const session = sessionOf();
    if (!truthy(session)) return [false];
    // The script does `waitstate` then `switch VAR_RESULT`; the rock animation
    // runs on in the background exactly as pret's Task_WaitDeoxysFieldEffect does.
    setResult(ctx, Deoxys.interact(session));
    return [false];
  },
  // Lua: natives_events.lua:441
  // pokefirered/src/field_specials.c:2451
  SetDeoxysTrianglePalette: (ctx) => {
    const session = sessionOf();
    let num = truthy(session) ? Deoxys.getVar(session, Deoxys.VAR_DEOXYS_INTERACTION_NUM) : session;
    if (num == null) num = varGet(ctx, Deoxys.VAR_DEOXYS_INTERACTION_NUM);
    Deoxys.applyRockPalette(lor(num, 0));
    return [false];
  },
  // Lua: natives_events.lua:451
  // pokefirered/src/field_specials.c:2512
  // src/field_specials.c:2512-2531, game_stat.h:14
  UpdateLoreleiDollCollection: (ctx) => {
    const session = sessionOf(ctx);
    const stats = lor(session && lor(session.gameStats, session.stats), {} as any);
    const n = tonumber(stats[10]) ?? 0;
    const F = flagsMod();
    const store = scriptStore(ctx);
    const dolls: LuaTable = seq<any>(
      seq<any>(25, "FLAG_HIDE_LORELEI_HOUSE_MEOWTH_DOLL"),
      seq<any>(50, "FLAG_HIDE_LORELEI_HOUSE_CHANSEY_DOLL"),
      seq<any>(75, "FLAG_HIDE_LORELEIS_HOUSE_NIDORAN_F_DOLL"),
      seq<any>(100, "FLAG_HIDE_LORELEI_HOUSE_JIGGLYPUFF_DOLL"),
      seq<any>(125, "FLAG_HIDE_LORELEIS_HOUSE_NIDORAN_M_DOLL"),
      seq<any>(150, "FLAG_HIDE_LORELEIS_HOUSE_FEAROW_DOLL"),
      seq<any>(175, "FLAG_HIDE_LORELEIS_HOUSE_PIDGEOT_DOLL"),
      seq<any>(200, "FLAG_HIDE_LORELEIS_HOUSE_LAPRAS_DOLL"),
    );
    for (const [, d] of ipairs<any>(dolls)) {
      if (n >= d[1]) F.setFlag(store, ctx, d[2], false);
    }
    return [false];
  },
};

// pokefirered/include/constants/global.h
const DIR_BY_NAME: Record<string, number> = { down: 1, up: 2, left: 3, right: 4 };
const WALKAWAY_ORDER: LuaTable = seq("up", "down", "left", "right");

export const Events = {
  ICEFALL_CAVE_ICE_COORDS,
  METATILE_SEAFOAM_CRACKED_ICE,
  METATILE_SEAFOAM_ICE_HOLE,

  BY_NAME,
  /** Set by Std.legacyHandlers (stdscripts.lua:262): special id -> handler. */
  HANDLERS: undefined as Record<number, Handler> | undefined,

  // Lua: natives_events.lua:480
  // pokefirered/src/field_control_avatar.c:301, overworld.c:1402, data/event_scripts.s:1166
  pollWalkaway(vm: any, input: any): void {
    if (!truthy(vm) || !truthy(vm.ctx)) return;
    const ctx = vm.ctx;
    const session = sessionOf(ctx);

    const clearWalkaway = (): void => {
      ctx.walkAwayFromSignInhibitTimer = undefined;
      ctx.msgBoxIsCancelable = undefined;
      ctx.canWalkAway = undefined;
      if (truthy(session)) {
        session.walkAwayFromSignInhibitTimer = undefined;
        session.msgBoxIsCancelable = undefined;
        session.canWalkAway = undefined;
      }
    };

    // script.c:349
    if (!(truthy(vm.isRunning) && truthy(vm.isRunning()))) {
      if (ctx.walkAwayFromSignInhibitTimer != null
        || ctx.msgBoxIsCancelable != null
        || ctx.canWalkAway != null) {
        clearWalkaway();
      }
      return;
    }

    const timer = tonumber(ctx.walkAwayFromSignInhibitTimer);
    if (timer == null) return;
    if (timer > 0) {
      ctx.walkAwayFromSignInhibitTimer = timer - 1;
      if (truthy(session)) {
        session.walkAwayFromSignInhibitTimer = Math.max(0, timer - 1);
      }
      return;
    }

    let cancelable = ctx.msgBoxIsCancelable;
    let canWalk = ctx.canWalkAway;
    if (truthy(session)) {
      if (cancelable == null) cancelable = session.msgBoxIsCancelable;
      if (canWalk == null) canWalk = session.canWalkAway;
    }
    if (cancelable !== true) return;
    if (ctx.messageOpen !== true) return;

    let dir: string | undefined;
    if (truthy(input) && truthy(input.isDown)) {
      // pokefirered/src/field_control_avatar.c:147
      for (const [, d] of ipairs<string>(WALKAWAY_ORDER)) {
        if (truthy(input.isDown(d))) {
          dir = d;
          break;
        }
      }
    }
    let facing: any = ctx.specialVars ? tonumber(ctx.specialVars[VAR_FACING]) : undefined;
    if (facing == null) {
      // package.loaded["src.core.game3.player"]
      const P = Player;
      facing = (P && P.facing != null) ? DIR_BY_NAME[P.facing] : undefined;
    }
    const walked = dir != null && facing != null && facing !== DIR_BY_NAME[dir];
    // pokefirered/src/field_control_avatar.c:311
    if (walked && canWalk !== true) return;
    // pokefirered/src/field_control_avatar.c:324
    const started = !walked && truthy(input) && truthy(input.wasPressed) && truthy(input.wasPressed("start"));
    if (!walked && !started) return;

    // data/event_scripts.s:1166
    if (truthy(vm.adapters) && truthy(vm.adapters.closeMessage)) {
      vm.adapters.closeMessage();
    }
    ctx.messageOpen = false;
    if (truthy(ctx.frozen)) {
      // pcall(require, "src.core.game3.field")
      const okF = true;
      if (okF && Field && truthy(Field.unlock)) Field.unlock();
    }
    clearWalkaway();
    // pokefirered/src/script.c:353
    // package.loaded["src.ui.game3.hud"]
    const HudW: any = Hud;
    if (HudW && truthy(HudW.clearWaitButton)) HudW.clearWaitButton();
    vm.halt(true);
    if (started) {
      // pokefirered/src/field_control_avatar.c:329
      // package.loaded["src.core.game3.runtime"]
      const Rt = Runtime;
      if (Rt && truthy(Rt.defer)) {
        Rt.defer(() => {
          // package.loaded["src.ui.game3.hud"] / ["src.core.game3.field"]
          const H: any = Hud;
          const Fld = Field;
          if (H && truthy(H.openStartMenu) && Fld) {
            H.openStartMenu(Fld._game, Fld._session);
          }
        });
      }
    }
  },
};
// Lua: natives_events.lua:473
Std.legacyHandlers(Events);

export default Events;
