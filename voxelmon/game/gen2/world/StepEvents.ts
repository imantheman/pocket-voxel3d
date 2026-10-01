// CountStep (engine/overworld/events.asm), the block that runs on every
// overworld footfall, and the four routines it calls.
// A port of gen1recomp src/world/gen2/StepEvents.lua at bdfac727 (MIT).
//
// Without it `Happiness.step` and `Breeding.step` are never called: eggs never
// hatch and scripted phone calls never fire, both main quest.
//
// CheckTileEvent runs it between the coord events and the wild encounter roll,
// and a CARRY out of it means a player event is queued -- which is why a step
// that hatches an egg or drops a poisoned mon never also starts a battle.
//
//   CountStep:
//       ret if wLinkMode                    ; not modelled: no link overworld
//       CheckSpecialPhoneCall -> c: .doscript
//       DoRepelStep           -> c: .doscript
//       inc wPoisonStepCount
//       inc wStepCount        -> z (the wrap): StepHappiness
//       wStepCount == $80   : DoEggStep -> nz: .hatch
//       DayCareStep
//       wPoisonStepCount >= 4 : reset, DoPoisonStep -> c: .doscript
//       DoBikeStep
//
// Everything here is love-free and takes its state as arguments.

import { FieldMoves } from "./FieldMoves.ts";
import { Breeding } from "../core/Breeding.ts";
import { Happiness } from "../core/Happiness.ts";
import { Phone } from "../core/Phone.ts";
import { mod, truthy } from "../platform/lua.ts";

/** What CountStep hands its caller; `blocks` is CountStep's CARRY. */
export interface StepEvent {
  kind: "phoneCall" | "repel" | "hatch" | "poisonFaint" | "poisonHurt";
  blocks: boolean;
  call?: any;
  /** 1-based party slots, as the Lua collected them. */
  fainted?: number[];
  hurt?: number[];
  whiteout?: boolean;
}

// Lua: StepEvents.lua:33-40 -- constants/pokemon_data_constants.asm: `1 <<
// PSN`. The port stores a status as a lowercase name on the mon; the battle
// writes "poison"/"toxic", older saves may carry "psn"/"tox".
function isPoisoned(mon: any): boolean {
  const status = mon ? mon.status : undefined;
  return status === "psn" || status === "tox" || status === "poison"
      || status === "toxic";
}

// Lua: StepEvents.lua:106-125 -- wStatusFlags2's BIKE_SHOP_CALL bit: the
// Goldenrod bike shop clerk's `setflag ENGINE_BIKE_SHOP_CALL_ENABLED` is what
// turns it on, and Vm's setflag lands it on save.engineFlags under the
// ENGINE_* id. save.bikeShopCall is the fallback for a save written before
// that was wired up, and is cleared alongside the flag.
function bikeShopCallEnabled(save: any): boolean {
  const flags = save.engineFlags;
  if (flags !== null && typeof flags === "object") {
    const set = flags[FieldMoves.BIKE_SHOP_CALL_FLAG];
    if (set != null) return set === true;
  }
  return save.bikeShopCall === true;
}

export const StepEvents = {
  // Lua: StepEvents.lua:42-45 -- .DamageMonIfPoisoned's two answers, kept as
  // the cart's own bit pair.
  POISON_HURT: 1,
  POISON_FAINTED: 2,

  // Lua: StepEvents.lua:47-48 -- every 4 steps (wPoisonStepCount `cp 4 / jr c`).
  POISON_PERIOD: 4,

  // Lua: StepEvents.lua:50-53 -- DoBikeStep's threshold is `cp HIGH(1024)` on
  // the counter's HIGH byte, so it is 1024 steps and the counter saturates at
  // $ffff rather than wrapping.
  BIKE_CALL_STEPS: 1024,
  BIKE_STEP_MAX: 0xffff,

  // Lua: StepEvents.lua:55-86 -- DoPoisonStep. One HP off every poisoned mon
  // that is still standing, and the mon that runs out has its status CLEARED
  // on the way down -- so a party wiped by poison walks into the Pokemon
  // Center with no status left to cure. The two flags are collected across the
  // WHOLE party before either branch is taken (wPoisonStepFlagSum), which is
  // why one faint anywhere outranks five mons merely taking damage.
  poisonStep(party: any[] | undefined): StepEvent | undefined {
    party = party ?? [];
    const hurt: number[] = [];
    const fainted: number[] = [];
    for (let i = 0; i < party.length; i++) {
      const mon = party[i];
      const index = i + 1;
      if (isPoisoned(mon) && (mon.hp ?? 0) > 0) {
        mon.hp = mon.hp - 1;
        if (mon.hp <= 0) {
          mon.hp = 0;
          delete mon.status;
          fainted.push(index);
        } else {
          hurt.push(index);
        }
      }
    }
    if (fainted.length > 0) {
      return { kind: "poisonFaint", fainted, hurt, blocks: true };
    }
    if (hurt.length > 0) {
      // .PlayPoisonSFX and the four-frame BG flash, then `xor a`: no carry, so
      // the step still counts and the wild roll still happens.
      return { kind: "poisonHurt", hurt, blocks: false };
    }
    return undefined;
  },

  // Lua: StepEvents.lua:88-94 -- .CheckWhitedOut's tail: `predef
  // CheckPlayerPartyForFitMon`. An egg is not a fit mon (DayCare_GiveEgg
  // zeroes its HP), which Breeding.healthyCount already says out loud.
  whitedOut(party: any[] | undefined): boolean {
    return Breeding.healthyCount(party) === 0;
  },

  // Lua: StepEvents.lua:96-104 -- DoRepelStep. `dec a / ret nz`: the wear-off
  // lands on the step that takes the counter to zero, and that step is NOT
  // counted -- so the last repel step never ticks the egg or the day care.
  repelStep(save: any): boolean {
    const left = save.repelSteps ?? 0;
    if (left <= 0) return false;
    save.repelSteps = left - 1;
    return save.repelSteps === 0;
  },

  // Lua: StepEvents.lua:106-144 -- DoBikeStep. Four gates before the counter
  // even moves, and then a quirk worth keeping: `scf` at the end is thrown
  // away by CountStep's `.done` (`xor a / ret`). So queueing the bike shop's
  // call does NOT stop the step being counted and does NOT produce a player
  // event -- the call goes out on the NEXT footfall, through
  // CheckSpecialPhoneCall at the top of this same block.
  bikeStep(save: any, opts?: any): boolean {
    opts = opts ?? {};
    if (!bikeShopCallEnabled(save)) return false;
    if (opts.playerState !== "bike") return false;
    if (opts.phoneService === false) return false;
    const steps = Math.min((save.bikeStep ?? 0) + 1, StepEvents.BIKE_STEP_MAX);
    save.bikeStep = steps;
    if (steps < StepEvents.BIKE_CALL_STEPS) return false;
    // "If a call has already been queued, don't overwrite that call."
    if (Phone.hasSpecialCall(save)) return false;
    Phone.queueSpecialCall(save, Phone.SPECIALCALL.SPECIALCALL_BIKESHOP);
    // `res STATUSFLAGS2_BIKE_SHOP_CALL_F`: one call, ever.
    if (save.engineFlags !== null && typeof save.engineFlags === "object") {
      delete save.engineFlags[FieldMoves.BIKE_SHOP_CALL_FLAG];
    }
    save.bikeShopCall = false;
    return true;
  },

  // Lua: StepEvents.lua:146-198 -- the whole block, in the cart's order.
  //
  // `ctx` carries what the routines need from outside the save: `data` for the
  // day care's species lookups, `rng` for its egg roll, `phone` for
  // CheckSpecialPhoneCall's map/time context, `playerState` and `phoneService`
  // for DoBikeStep.
  //
  // The event's `blocks` field is CountStep's CARRY: the caller owes the
  // matching player-event script and must not roll a wild encounter on that
  // step. Only `poisonHurt` reports an event without one.
  //
  // The Lua also returned a second value, whether the step was COUNTED; its
  // one caller (World:countStep) reads only the event, so the port returns the
  // event alone.
  count(save: any, ctx?: any): StepEvent | undefined {
    ctx = ctx ?? {};
    if (save === null || typeof save !== "object") return undefined;
    if (truthy(ctx.linkMode)) return undefined;

    // Neither of the next two counts the step.
    const call = Phone.checkSpecialCall(save, ctx.phone);
    if (call) return { kind: "phoneCall", call, blocks: true };
    if (StepEvents.repelStep(save)) {
      return { kind: "repel", blocks: true };
    }

    save.poisonStepCount = mod((save.poisonStepCount ?? 0) + 1, 256);

    // Breeding.step owns wStepCount: it increments, ticks the eggs at $80 and
    // runs DayCareStep, all in the cart's order. StepHappiness sits between
    // the increment and the egg tick on the cart and is called after both
    // here, which is safe: the wrap ($00) and the egg phase ($80) can never be
    // the same step.
    const bred = Breeding.step(ctx.data, save, ctx.rng);
    Happiness.step(save);
    if (bred === "hatch") return { kind: "hatch", blocks: true };

    if (save.poisonStepCount >= StepEvents.POISON_PERIOD) {
      save.poisonStepCount = 0;
      const poison = StepEvents.poisonStep(save.party);
      if (poison && poison.kind === "poisonFaint") {
        poison.whiteout = StepEvents.whitedOut(save.party);
        return poison;
      }
      if (poison) {
        // .PlayPoisonSFX only: no carry, so the caller plays the sound and the
        // step carries on into the wild roll.
        StepEvents.bikeStep(save, ctx);
        return poison;
      }
    }

    StepEvents.bikeStep(save, ctx);
    return undefined;
  },
};

export default StepEvents;
