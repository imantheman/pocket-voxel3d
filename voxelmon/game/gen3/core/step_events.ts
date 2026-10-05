// Port of gen1recomp src/core/game3/step_events.lua (GPLv3 + additional terms; see LICENSE.md).
// Game3 Overworld Step Events Engine (pret field_control_avatar.c / wild_encounter.c).
// Features:
// 1. Lockstep Event Queue: Prevents simultaneous tick collisions; flushes on party white-out.
// 2. Happiness Step Counter (128 steps): +1 friendship to all party Pokemon.
// 3. VS Seeker Battery (100 steps): Increments while the VS SEEKER is in the bag.
// 4. Overworld Poison (4 steps): 4-frame reddish screen flash, SE_FIELD_POISON, lethal faint at 0 HP.
// 5. Egg Cycles & Daycare (daycare stepCounter == 255): Decrements egg cycles -> EggHatch; +1 EXP per step in Daycare.
// 6. Repel Counter: Decrements steps -> Text_RepelWoreOff on expiration.
//
// Emerald branches (rse.init, frontier, match call, SS Tidal, Regice) are
// Emerald only and throw; FireRed's profile family is "frlg", so they never run.

import { tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { ipairs, len, remove, seq, type LuaTable } from "../platform/lt.ts";
import { G } from "../platform/graphics.ts";
import { NotPortedError } from "../notported.ts";
import { Pokemon } from "./pokemon.ts";
import { RomText } from "./rom_text.ts";
import { Sem } from "./field_semantics.ts";
import { FieldModules } from "./field_modules.ts";
import { Audio } from "./audio.ts";
import { M as ForcedMovement } from "./forced_movement.ts";
import { Player as PlayerMod } from "./player.ts";
import { Collision as CollisionMod } from "./collision.ts";
import { Field as FieldMod } from "./field.ts";
import { BattleBridge } from "./battle_bridge.ts";
import { Hud } from "../ui/hud.ts";
import { Fade } from "../ui/fade.ts";
import { Profile } from "./profile.ts";
import { MysteryGift } from "./mystery_gift.ts";
import { Deoxys } from "./deoxys.ts";
import { RenewableHiddenItems } from "./renewable_hidden_items.ts";
import { VsSeeker } from "./vs_seeker.ts";
import { SE } from "./se_ids.ts";
import { Daycare } from "./daycare.ts";
import { EggHatch } from "../ui/egg_hatch.ts";
import { Safari } from "./safari.ts";
import { Renderer } from "../shared/render/Renderer.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface StepEvent { type?: string; run: (onDone: () => void) => void; tick?: (dt?: number, game?: any) => void; [k: string]: any }

// Lua: step_events.lua:22
function se(id: any): void {
  try {
    if (Audio && Audio.playSe) Audio.playSe(id);
  } catch { /* pcall */ }
}

// NOT FAITHFUL: Emerald only -- src.core.game3.rse.* (init, frontier, match
// call, special_scene_rse) are not ported; only reached on an "rse" profile.
function emeraldOnly(what: string): never {
  throw new Error("NOT FAITHFUL: Emerald only: " + what);
}

// Lua: step_events.lua:47
function push_event(event: StepEvent | (() => void)): void {
  StepEvents.queueEvent(event);
}

// Lua: step_events.lua:50 -- pokefirered/src/field_control_avatar.c:658
function forced_step(): boolean {
  if (ForcedMovement.isForced()) return true;
  const Player: any = PlayerMod;
  const Collision: any = CollisionMod;
  if (!(Player && Collision && Collision.behavior)) return false;
  let mb: number | undefined;
  try { mb = tonumber(Collision.behavior(Player.cellX, Player.cellY)); } catch { mb = undefined; }
  if (mb == null) return false;
  return ForcedMovement.isForcedMovementTile(mb);
}

// Lua: step_events.lua:63
function party_is_wiped(party: LuaTable): boolean {
  if (!party || len(party) === 0) return false;
  let hasAlive = false;
  for (const [, mon] of ipairs<any>(party)) {
    const isEgg = truthy(mon.isEgg) || (typeof mon.egg === "boolean" && mon.egg);
    const hp = tonumber(mon.hp) ?? 0;
    if (!isEgg && hp > 0) {
      hasAlive = true;
      break;
    }
  }
  return !hasAlive;
}

// Lua: step_events.lua:78 -- data/scripts/white_out.inc:43
function field_white_out_event(session: any, game: any): StepEvent {
  const ev: any = { type: "poison_white_out" };
  ev.run = (onDone: () => void) => {
    if (!party_is_wiped(session.party)) {
      onDone();
      return;
    }
    const Field: any = FieldMod;
    Field.lock();
    // Rse.isRse(session) is the profile family test.
    if (Profile.family(session) === "rse") {
      // pokeemerald/data/scripts/field_poison.inc:23
      emeraldOnly("src.core.game3.rse.frontier (field white-out)");
    }
    const save = game ? game.save : undefined;
    const name = session.name ?? session.playerName ?? "";
    const money = tonumber(session.money) ?? 0;
    let msg: string;
    if (money >= 1) {
      // pokefirered/src/overworld.c:260
      const loss = Math.min(BattleBridge.calcMoneyLossFrlg(session, save), money);
      // data/scripts/white_out.inc:56
      msg = RomText.box("Text_WhitedOutLostMoney", { playerName: name, stringVars: seq(tostring(loss)) });
    } else {
      // data/scripts/white_out.inc:50
      msg = RomText.box("Text_WhitedOut", { playerName: name });
    }
    ev.whiteOutText = msg;
    Hud.openMessage(game, msg, {
      done: () => {
        // pokefirered/src/field_screen_effect.c:214
        Audio.fadeOutBgm(4);
        ev.phase = "music";
      },
    });
  };
  ev.tick = () => {
    if (ev.phase !== "music") return;
    if ((Audio as any)._fadeOut) return;
    ev.phase = "fade";
    const F: any = Fade;
    // data/scripts/white_out.inc:63
    F.begin(F.MODE.TO_BLACK, 1, () => {
      StepEvents.flush();
      // pokefirered/src/overworld.c:253
      BattleBridge.applyFrlgMoneyLoss(session, game ? game.save : undefined);
      const Field: any = FieldMod;
      Field.respawnAtHeal();
    });
  };
  return ev;
}

export const StepEvents = {
  // Lua: step_events.lua:17
  _queue: [null] as (StepEvent | null)[],
  _activeEvent: null as StepEvent | null,
  _poisonFlashTimer: 0,
  _totalSteps: 0,

  // Lua: step_events.lua:29
  busy(): boolean {
    return StepEvents._activeEvent != null || len(StepEvents._queue) > 0 || StepEvents._poisonFlashTimer > 0;
  },

  // Lua: step_events.lua:33
  flush(): void {
    StepEvents._queue = [null];
    StepEvents._activeEvent = null;
    StepEvents._poisonFlashTimer = 0;
  },

  // Lua: step_events.lua:39
  queueEvent(event: StepEvent | (() => void)): void {
    let ev: StepEvent;
    if (typeof event === "function") {
      const fn = event;
      ev = { run: (onDone: () => void) => { fn(); if (onDone) onDone(); } };
    } else {
      ev = event;
    }
    StepEvents._queue[len(StepEvents._queue) + 1] = ev;
  },

  // Lua: step_events.lua:151
  onStepTaken(session: any, game?: any): void {
    if (!session) return;
    session.vars = session.vars ?? {};
    const party = session.party ?? [null];
    StepEvents._totalSteps = StepEvents._totalSteps + 1;

    // 1. Happiness Counter (VAR_HAPPINESS_STEP_COUNTER % 128)
    // pokefirered/src/field_control_avatar.c:687 UpdateHappinessStepCounter
    const hapVar: any = Sem.var(session, "happinessSteps");
    let hapSteps = (tonumber(session.vars[hapVar] ?? session.happinessSteps) ?? 0) + 1;
    if (hapSteps >= 128) {
      hapSteps = 0;
      // pokefirered/src/field_control_avatar.c:699
      const ctx = { mapSec: Pokemon.currentMapSec(session) };
      for (const [, mon] of ipairs<any>(party)) {
        Pokemon.adjustFriendship(mon, Pokemon.FRIENDSHIP_EVENT_WALKING, ctx);
      }
    }
    session.vars[hapVar] = hapSteps;
    session.happinessSteps = hapSteps;

    const isRse = Profile.family(session) === "rse";
    const mcOn = false; // isRse and Capabilities.gate(session, "match_call")
    if (isRse) {
      // pokeemerald/src/field_control_avatar.c:543
      emeraldOnly("src.core.game3.rse.match_call");
    }

    // pokefirered/src/field_control_avatar.c:217
    // NOT FAITHFUL: mystery gift deferred -- its stub throws; the news step
    // counter is skipped until MysteryGift is ported.
    try {
      MysteryGift.incrementNewsStepCounter(session);
    } catch (e) {
      if (!(e instanceof NotPortedError)) throw e;
    }

    // pokefirered/src/field_specials.c:2068
    const massageVar: any = Sem.var(session, "massageSteps");
    if (massageVar != null) {
      const massage = tonumber(session.vars[massageVar]) ?? 0;
      if (massage < 500) session.vars[massageVar] = massage + 1;
    }

    // pokefirered/src/field_specials.c:2433 IncrementBirthIslandRockStepCount
    if (FieldModules.enabled("deoxys", session)) {
      Deoxys.incrementStepCount(session);
    }

    // pokefirered/src/field_control_avatar.c:219 IncrementRenewableHiddenItemStepCounter
    let okRen = false;
    let Renewable: any = null;
    if (FieldModules.enabled("renewableHiddenItems", session)) {
      okRen = true;
      Renewable = RenewableHiddenItems;
    }
    if (okRen && Renewable && Renewable.onStep) {
      Renewable.onStep(session, session.mapGroup, session.mapNum, session.map);
    }

    // pokefirered/src/field_control_avatar.c:658
    const forced = forced_step();
    let poisonFainted = false;
    let vsChargeDone = false;
    if (!forced && FieldModules.enabled("vsSeeker", session)) {
      if (VsSeeker.onStep(session)) {
        vsChargeDone = true;
        push_event(VsSeeker.chargingDoneEvent());
      }
    }
    if (vsChargeDone) {
      StepEvents.onRepelStep(session, game);
      return;
    }

    // 3. Overworld Poison Counter (every 4 steps, pret field_poison.c)
    const psnVar: any = Sem.var(session, "poisonSteps");
    let psnSteps = (tonumber(session.vars[psnVar] ?? session.poisonSteps) ?? 0) + 1;
    if (psnSteps >= 4) {
      psnSteps = 0;
      let anyPoisonDamage = false;
      const faintedMons: any[] = [null];

      for (const [slotIdx, mon] of ipairs<any>(party)) {
        const isEgg = truthy(mon.isEgg) || (typeof mon.egg === "boolean" && mon.egg);
        const st = tostring(mon.status ?? "").toUpperCase();
        const isPsn = (st === "PSN" || st === "POISON" || st === "TOXIC" || (tonumber(mon.statusNum) ?? 0) === 8);
        const hp = tonumber(mon.hp) ?? 0;

        if (!isEgg && isPsn && hp > 0) {
          anyPoisonDamage = true;
          mon.hp = Math.max(0, hp - 1);
          if (mon.hp === 0) {
            // pokefirered/src/field_poison.c:36
            Pokemon.adjustFriendship(mon, Pokemon.FRIENDSHIP_EVENT_FAINT_OUTSIDE_BATTLE,
              { mapSec: Pokemon.currentMapSec(session) });
            mon.status = null;
            mon.statusNum = 0;
            faintedMons[len(faintedMons) + 1] = {
              slot: slotIdx,
              mon,
              name: Pokemon.displayMonName(mon),
            };
          }
        }
      }

      if (anyPoisonDamage) {
        // Trigger 4-frame reddish screen flash and poison SE
        StepEvents._poisonFlashTimer = 4 / 60;
        se(SE.SE_FIELD_POISON);

        // pokefirered/src/field_control_avatar.c:727 FLDPSN_FNT
        poisonFainted = len(faintedMons) > 0;
        for (const [, fainted] of ipairs<any>(faintedMons)) {
          push_event({
            type: "poison_faint",
            name: fainted.name,
            mon: fainted.mon,
            run: (onDone: () => void) => {
              // pokefirered/src/field_poison.c:64
              const P: any = Profile.forSession(session);
              Hud.openMessage(game, RomText.box((P.field && P.field.poisonFaintText) || "gText_PkmnFainted3",
                { stringVars: seq(fainted.name) }),
              { done: onDone });
            },
          });
        }
        // pokefirered/src/field_poison.c:76
        if (poisonFainted) push_event(field_white_out_event(session, game));
      }
    }
    session.vars[psnVar] = psnSteps;
    session.poisonSteps = psnSteps;

    // pokefirered/src/field_control_avatar.c:670 ShouldEggHatch
    if (!forced && !poisonFainted) {
      const [, hatchSlot] = Daycare.step(session);
      const hatching = hatchSlot != null ? party[hatchSlot] : null;
      if (hatching) {
        // pokefirered/src/field_control_avatar.c:673 EventScript_EggHatch
        push_event({
          type: "egg_hatch",
          mon: hatching,
          slot: hatchSlot,
          run: (onDone: () => void) => {
            const P: any = Profile.forSession(session);
            // pokefirered/data/scripts/day_care.inc:112 DayCare_Text_Huh
            Hud.openMessage(game, RomText.box((P.field && P.field.eggHatchText) || "DayCare_Text_Huh"), {
              done: () => {
                // pokefirered/data/scripts/day_care.inc:113 special EggHatch
                EggHatch.start(hatching, {
                  session,
                  slot: hatchSlot,
                  savedSong: Audio._mapSong,
                  onDone,
                });
              },
            });
          },
        });
        // pokefirered/src/field_control_avatar.c:672 IncrementGameStat(GAME_STAT_HATCHED_EGGS)
        if (session.gameStats == null || typeof session.gameStats !== "object") session.gameStats = {};
        // pokefirered/include/constants/game_stat.h:17
        const hatched = Math.floor(tonumber(session.gameStats[13]) ?? 0);
        session.gameStats[13] = Math.min(0xFFFFFF, hatched + 1);
        // pokefirered/src/field_control_avatar.c:674 return TRUE
        StepEvents.onRepelStep(session, game);
        return;
      }
      if (isRse) {
        // pokeemerald/src/field_control_avatar.c:570 (braille_field Regice)
        emeraldOnly("braille_field.shouldDoRegicePuzzle step check");
      }
      if (mcOn) {
        // pokeemerald/src/field_control_avatar.c:575
        emeraldOnly("src.core.game3.rse.match_call");
      }
    }

    // pokefirered/src/safari_zone.c:60 CB2_EndSafariBattle
    const Field: any = FieldMod;
    if (Field && Field.pollSafariBalls && Field.pollSafariBalls(game)) {
      return;
    }

    // pokefirered/src/field_control_avatar.c:677
    if (Safari && Safari.takeStep && Safari.takeStep(session, game)) {
      return;
    }

    if (isRse) {
      // pokeemerald/src/field_control_avatar.c:599
      emeraldOnly("src.core.game3.special_scene_rse");
    }

    StepEvents.onRepelStep(session, game);
  },

  // Lua: step_events.lua:377
  onRepelStep(session: any, game?: any): void {
    // 5. Repel Step Counter (VAR_REPEL_STEP_COUNT)
    // package.loaded["src.core.game3.rse.frontier.pike" / ".pyramid"] are
    // never loaded here (Emerald only), so the Pike / Pyramid test is false.
    const repelVar: any = Sem.var(session, "repelSteps");
    let repelSteps = tonumber(session.repelSteps ?? session.vars[repelVar]) ?? 0;
    if (repelSteps > 0) {
      repelSteps = repelSteps - 1;
      session.repelSteps = repelSteps;
      session.vars[repelVar] = repelSteps;

      if (repelSteps === 0) {
        push_event({
          type: "repel_wore_off",
          run: (onDone: () => void) => {
            // data/scripts/repel.inc:2
            Hud.openMessage(game, RomText.box("Text_RepelWoreOff"), {
              done: onDone,
            });
          },
        });
      }
    }
  },

  // Lua: step_events.lua:406
  update(dt?: number, game?: any): void {
    if (StepEvents._poisonFlashTimer > 0) {
      StepEvents._poisonFlashTimer = Math.max(0, StepEvents._poisonFlashTimer - (dt ?? 1 / 60));
    }

    if (StepEvents._activeEvent) {
      const active = StepEvents._activeEvent;
      if (active.tick) active.tick(dt, game);
      return;
    }
    if (len(StepEvents._queue) === 0) return;

    const ev = remove<StepEvent>(StepEvents._queue, 1)!;
    StepEvents._activeEvent = ev;
    ev.run(() => {
      StepEvents._activeEvent = null;
    });
  },

  // Lua: step_events.lua:426
  draw(): void {
    if (StepEvents._poisonFlashTimer > 0) {
      const R: any = Renderer;
      if (R && R.canvas) {
        R.screenVeil = seq(0.85, 0.15, 0.15, 0.45);
        return;
      }
      G.setColor(0.85, 0.15, 0.15, 0.45);
      let w = 240, h = 160;
      const curCanvas: any = G.getCanvas();
      if (curCanvas) {
        try {
          const cw = curCanvas.getWidth(), ch = curCanvas.getHeight();
          if (cw && ch) { w = cw; h = ch; }
        } catch { /* pcall */ }
      } else if (G.getDimensions) {
        const [gw, gh] = G.getDimensions();
        if (gw && gh && gw > 0 && gh > 0) { w = gw; h = gh; }
      }
      G.rectangle("fill", 0, 0, w, h);
      G.setColor(1, 1, 1, 1);
    }
  },

  // Lua: step_events.lua:448
  onStep: null as any,
};

StepEvents.onStep = StepEvents.onStepTaken;

export default StepEvents;
