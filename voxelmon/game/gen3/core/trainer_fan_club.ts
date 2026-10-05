// Port of gen1recomp src/core/game3/trainer_fan_club.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG Trainer Fan Club system (pokefirered/src/trainer_fan_club.c).
// Manages fan states, Saffron fan club house members, playtime decay, and link battle updates.
//
// Return shapes: unpack / getFanClubData -> [timer, gotInitialFans, fanFlags].

import { sub, tonumber } from "../../../import/gen3/lua.ts";
import { seq } from "../platform/lt.ts";
import { RomText } from "./rom_text.ts";
import { Flags } from "./scripting/flags.ts";
import { Space as SpaceMod } from "./scripting/space.ts";
import { Runtime } from "./runtime.ts";
import { Rng } from "./rng.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Lua: trainer_fan_club.lua:34 -- pokefirered/src/trainer_fan_club.c:74
const sCounterIncrements: Record<number, number> = { 0: 2, 1: 1, 2: 2, 3: 1 };

// Lua: trainer_fan_club.lua:38 -- pokefirered/src/trainer_fan_club.c:100
const sGainOrder = seq(1, 3, 5, 0, 7, 6, 4, 2) as (number | null)[];

// Lua: trainer_fan_club.lua:42 -- pokefirered/src/trainer_fan_club.c:133
const sLoseOrder = seq(5, 6, 3, 7, 4, 1, 0, 2) as (number | null)[];

// Lua: trainer_fan_club.lua:94
function flagsMod(): typeof Flags {
  return Flags;
}

// Lua: trainer_fan_club.lua:106
function scriptStore(session: any, ctx: any): any {
  const Space: any = SpaceMod;
  return (Space && Space.store) || (ctx && ctx.session) || (session && session.store) || session || null;
}

export const TrainerFanClub = {
  // Lua: trainer_fan_club.lua:10 -- pokefirered/include/constants/trainer_fan_club.h
  MEMBER: {
    MEMBER1: 0, // Crush Girl (Battle Girl)
    MEMBER2: 1, // Youngster
    MEMBER3: 2, // Gentleman
    MEMBER4: 3, // Little Girl
    MEMBER5: 4, // Rocker
    MEMBER6: 5, // Woman
    MEMBER7: 6, // Beauty
    MEMBER8: 7, // Black Belt
  },

  NUM_MEMBERS: 8,

  // Lua: trainer_fan_club.lua:24 -- pokefirered/include/constants/vars.h, flags.h
  VAR_FANCLUB_FAN_COUNTER: 0x4038,
  VAR_FANCLUB_LOSE_FAN_TIMER: 0x4039,
  VAR_MAP_SCENE_SAFFRON_CITY_POKEMON_TRAINER_FAN_CLUB: 0x4073,

  FLAG_HIDE_SAFFRON_FAN_CLUB_BLACK_BELT: 0x6C,
  FLAG_HIDE_SAFFRON_FAN_CLUB_ROCKER: 0x6D,
  FLAG_HIDE_SAFFRON_FAN_CLUB_WOMAN: 0x6E,
  FLAG_HIDE_SAFFRON_FAN_CLUB_BEAUTY: 0x6F,

  COUNTER_INCREMENTS: sCounterIncrements,
  GAIN_ORDER: sGainOrder,
  LOSE_ORDER: sLoseOrder,

  // Lua: trainer_fan_club.lua:49
  unpack(rawIn: unknown): [number, boolean, number] {
    const raw = (tonumber(rawIn) ?? 0) & 0xFFFF;
    const timer = raw & 0x7F;
    const gotInitialFans = (raw & 0x80) !== 0;
    const fanFlags = (raw >>> 8) & 0xFF;
    return [timer, gotInitialFans, fanFlags];
  },

  // Lua: trainer_fan_club.lua:58
  pack(timerIn: unknown, gotInitialFans: unknown, fanFlags: unknown): number {
    const timer = Math.max(0, Math.min(127, tonumber(timerIn) ?? 0)) & 0x7F;
    const initialBit = gotInitialFans ? 0x80 : 0;
    const flagsByte = (tonumber(fanFlags) ?? 0) & 0xFF;
    return (timer | initialBit | (flagsByte << 8)) & 0xFFFF;
  },

  // Lua: trainer_fan_club.lua:65
  getFanFlag(fanFlags: number, memberIdIn: unknown): boolean {
    const memberId = tonumber(memberIdIn) ?? 0;
    if (memberId < 0 || memberId >= 8) return false;
    return ((fanFlags >>> memberId) & 1) === 1;
  },

  // Lua: trainer_fan_club.lua:71
  setFanFlag(fanFlags: number, memberIdIn: unknown): number {
    const memberId = tonumber(memberIdIn) ?? 0;
    if (memberId < 0 || memberId >= 8) return fanFlags;
    return (fanFlags | (1 << memberId)) & 0xFF;
  },

  // Lua: trainer_fan_club.lua:77
  flipFanFlag(fanFlags: number, memberIdIn: unknown): number {
    const memberId = tonumber(memberIdIn) ?? 0;
    if (memberId < 0 || memberId >= 8) return fanFlags;
    return (fanFlags ^ (1 << memberId)) & 0xFF;
  },

  // Lua: trainer_fan_club.lua:83
  countFans(fanFlagsIn: unknown): number {
    let count = 0;
    const fanFlags = (tonumber(fanFlagsIn) ?? 0) & 0xFF;
    for (let i = 0; i <= TrainerFanClub.NUM_MEMBERS - 1; i++) {
      if (((fanFlags >>> i) & 1) === 1) {
        count = count + 1;
      }
    }
    return count;
  },

  // Lua: trainer_fan_club.lua:98
  sessionOf(ctx?: any): any {
    if (ctx && ctx.session) return ctx.session;
    const Space: any = SpaceMod;
    if (Space && Space.store && Space.store.flags) return Space.store;
    return Runtime && Runtime.getSession ? Runtime.getSession() ?? null : null;
  },

  // Lua: trainer_fan_club.lua:111
  getVar(session: any, ctx: any, varId: number): number {
    session = session ?? TrainerFanClub.sessionOf(ctx);
    return tonumber(flagsMod().getVar(scriptStore(session, ctx), ctx, varId)) ?? 0;
  },

  // Lua: trainer_fan_club.lua:116
  setVar(session: any, ctx: any, varId: number, value: unknown): void {
    session = session ?? TrainerFanClub.sessionOf(ctx);
    flagsMod().setVar(scriptStore(session, ctx), ctx, varId, (tonumber(value) ?? 0) & 0xFFFF);
  },

  // Lua: trainer_fan_club.lua:121
  getFlag(session: any, ctx: any, flagId: number): boolean {
    session = session ?? TrainerFanClub.sessionOf(ctx);
    return flagsMod().getFlag(scriptStore(session, ctx), ctx, flagId);
  },

  // Lua: trainer_fan_club.lua:126
  setFlag(session: any, ctx: any, flagId: number, value: unknown): void {
    session = session ?? TrainerFanClub.sessionOf(ctx);
    flagsMod().setFlag(scriptStore(session, ctx), ctx, flagId, value);
  },

  // Lua: trainer_fan_club.lua:131
  clearFlag(session: any, ctx: any, flagId: number): void {
    TrainerFanClub.setFlag(session, ctx, flagId, false);
  },

  // Lua: trainer_fan_club.lua:135
  getFanClubData(session: any, ctx: any): [number, boolean, number] {
    const raw = TrainerFanClub.getVar(session, ctx, TrainerFanClub.VAR_FANCLUB_FAN_COUNTER);
    return TrainerFanClub.unpack(raw);
  },

  // Lua: trainer_fan_club.lua:140
  setFanClubData(session: any, ctx: any, timer: number, gotInitialFans: boolean, fanFlags: number): void {
    const packed = TrainerFanClub.pack(timer, gotInitialFans, fanFlags);
    TrainerFanClub.setVar(session, ctx, TrainerFanClub.VAR_FANCLUB_FAN_COUNTER, packed);
  },

  // Lua: trainer_fan_club.lua:145
  getPlayTimeHours(session: any, ctx?: any): number {
    session = session ?? TrainerFanClub.sessionOf(ctx);
    if (!session) return 0;
    const pt = session.playtime ?? session.playTime;
    if (pt != null && typeof pt === "object" && pt.hours != null) {
      return tonumber(pt.hours) ?? 0;
    }
    if (session.playTimeHours != null) {
      return tonumber(session.playTimeHours) ?? 0;
    }
    return 0;
  },

  // Lua: trainer_fan_club.lua:158
  setStringVar(ctx: any, adapters: any, index: number, text: string): void {
    if (adapters && adapters.setStringVar) adapters.setStringVar(index, text);
    if (ctx && ctx.stringVars) ctx.stringVars[index] = text;
  },

  // Lua: trainer_fan_club.lua:164 -- pokefirered/src/trainer_fan_club.c:34 ResetTrainerFanClub
  reset(session: any, ctx: any): void {
    TrainerFanClub.setVar(session, ctx, TrainerFanClub.VAR_FANCLUB_FAN_COUNTER, 0);
    TrainerFanClub.setVar(session, ctx, TrainerFanClub.VAR_FANCLUB_LOSE_FAN_TIMER, 0);
  },

  // Lua: trainer_fan_club.lua:170 -- pokefirered/src/trainer_fan_club.c:228 IsFanClubMemberFanOfPlayer
  isFanClubMemberFanOfPlayer(session: any, ctx: any, memberId: unknown): boolean {
    const [, , fanFlags] = TrainerFanClub.getFanClubData(session, ctx);
    return TrainerFanClub.getFanFlag(fanFlags, memberId);
  },

  // Lua: trainer_fan_club.lua:176 -- pokefirered/src/trainer_fan_club.c:175
  getNumFansOfPlayerInTrainerFanClub(session: any, ctx: any): number {
    const [, , fanFlags] = TrainerFanClub.getFanClubData(session, ctx);
    return TrainerFanClub.countFans(fanFlags);
  },

  // Lua: trainer_fan_club.lua:182 -- pokefirered/src/trainer_fan_club.c:98 PlayerGainRandomTrainerFan
  playerGainRandomTrainerFan(session: any, ctx: any): number {
    let [timer, gotInitialFans, fanFlags] = TrainerFanClub.getFanClubData(session, ctx);
    let idx = 1;

    for (let i = 1; i <= TrainerFanClub.NUM_MEMBERS; i++) {
      const memberId = sGainOrder[i]!;
      if (!TrainerFanClub.getFanFlag(fanFlags, memberId)) {
        idx = i;
        if ((Rng.Random() % 2) !== 0) {
          fanFlags = TrainerFanClub.setFanFlag(fanFlags, memberId);
          TrainerFanClub.setFanClubData(session, ctx, timer, gotInitialFans, fanFlags);
          return memberId;
        }
      }
    }

    const fallbackMember = sGainOrder[idx]!;
    fanFlags = TrainerFanClub.setFanFlag(fanFlags, fallbackMember);
    TrainerFanClub.setFanClubData(session, ctx, timer, gotInitialFans, fanFlags);
    return fallbackMember;
  },

  // Lua: trainer_fan_club.lua:206 -- pokefirered/src/trainer_fan_club.c:131 PlayerLoseRandomTrainerFan
  playerLoseRandomTrainerFan(session: any, ctx: any): number {
    let [timer, gotInitialFans, fanFlags] = TrainerFanClub.getFanClubData(session, ctx);
    if (TrainerFanClub.countFans(fanFlags) === 1) {
      return 0;
    }

    let idx = 1;

    for (let i = 1; i <= TrainerFanClub.NUM_MEMBERS; i++) {
      const memberId = sLoseOrder[i]!;
      if (TrainerFanClub.getFanFlag(fanFlags, memberId)) {
        idx = i;
        if ((Rng.Random() % 2) !== 0) {
          fanFlags = TrainerFanClub.flipFanFlag(fanFlags, memberId);
          TrainerFanClub.setFanClubData(session, ctx, timer, gotInitialFans, fanFlags);
          return memberId;
        }
      }
    }

    const fallbackMember = sLoseOrder[idx]!;
    if (TrainerFanClub.getFanFlag(fanFlags, fallbackMember)) {
      fanFlags = TrainerFanClub.flipFanFlag(fanFlags, fallbackMember);
    }
    TrainerFanClub.setFanClubData(session, ctx, timer, gotInitialFans, fanFlags);
    return fallbackMember;
  },

  // Lua: trainer_fan_club.lua:236 -- pokefirered/src/trainer_fan_club.c:194 TryLoseFansFromPlayTime
  tryLoseFansFromPlayTime(session: any, ctx: any): void {
    const hours = TrainerFanClub.getPlayTimeHours(session);
    if (hours < 999) {
      let i = 0;
      while (true) {
        const [, , fanFlags] = TrainerFanClub.getFanClubData(session, ctx);
        if (TrainerFanClub.countFans(fanFlags) < 5) {
          TrainerFanClub.setVar(session, ctx, TrainerFanClub.VAR_FANCLUB_LOSE_FAN_TIMER, hours);
          break;
        }
        if (i === TrainerFanClub.NUM_MEMBERS) {
          break;
        }

        let loseTimer = TrainerFanClub.getVar(session, ctx, TrainerFanClub.VAR_FANCLUB_LOSE_FAN_TIMER);
        if ((hours - loseTimer) < 12) {
          break;
        }

        TrainerFanClub.playerLoseRandomTrainerFan(session, ctx);
        loseTimer = TrainerFanClub.getVar(session, ctx, TrainerFanClub.VAR_FANCLUB_LOSE_FAN_TIMER);
        TrainerFanClub.setVar(session, ctx, TrainerFanClub.VAR_FANCLUB_LOSE_FAN_TIMER, (loseTimer + 12) & 0xFFFF);
        i = i + 1;
      }
    }
  },

  // Lua: trainer_fan_club.lua:264 -- pokefirered/src/trainer_fan_club.c:45
  tryLoseFansFromPlayTimeAfterLinkBattle(session: any, ctx: any): void {
    const [, gotInitialFans] = TrainerFanClub.getFanClubData(session, ctx);
    if (gotInitialFans) {
      TrainerFanClub.tryLoseFansFromPlayTime(session, ctx);
      const hours = TrainerFanClub.getPlayTimeHours(session);
      TrainerFanClub.setVar(session, ctx, TrainerFanClub.VAR_FANCLUB_LOSE_FAN_TIMER, hours);
    }
  },

  // Lua: trainer_fan_club.lua:274 -- pokefirered/src/trainer_fan_club.c:59 UpdateTrainerFanClubGameClear
  updateTrainerFanClubGameClear(session: any, ctx: any): void {
    let [timer, gotInitialFans, fanFlags] = TrainerFanClub.getFanClubData(session, ctx);
    if (!gotInitialFans) {
      gotInitialFans = true;
      fanFlags = TrainerFanClub.setFanFlag(fanFlags, TrainerFanClub.MEMBER.MEMBER1);
      fanFlags = TrainerFanClub.setFanFlag(fanFlags, TrainerFanClub.MEMBER.MEMBER2);
      fanFlags = TrainerFanClub.setFanFlag(fanFlags, TrainerFanClub.MEMBER.MEMBER3);
      TrainerFanClub.setFanClubData(session, ctx, timer, gotInitialFans, fanFlags);

      const hours = TrainerFanClub.getPlayTimeHours(session);
      TrainerFanClub.setVar(session, ctx, TrainerFanClub.VAR_FANCLUB_LOSE_FAN_TIMER, hours);

      TrainerFanClub.clearFlag(session, ctx, TrainerFanClub.FLAG_HIDE_SAFFRON_FAN_CLUB_BLACK_BELT);
      TrainerFanClub.clearFlag(session, ctx, TrainerFanClub.FLAG_HIDE_SAFFRON_FAN_CLUB_ROCKER);
      TrainerFanClub.clearFlag(session, ctx, TrainerFanClub.FLAG_HIDE_SAFFRON_FAN_CLUB_WOMAN);
      TrainerFanClub.clearFlag(session, ctx, TrainerFanClub.FLAG_HIDE_SAFFRON_FAN_CLUB_BEAUTY);

      TrainerFanClub.setVar(session, ctx, TrainerFanClub.VAR_MAP_SCENE_SAFFRON_CITY_POKEMON_TRAINER_FAN_CLUB, 1);
    }
  },

  // Lua: trainer_fan_club.lua:296 -- pokefirered/src/trainer_fan_club.c:76 TryGainNewFanFromCounter
  tryGainNewFanFromCounter(session: any, ctx: any, counterIdxIn: unknown): number {
    let [timer, gotInitialFans, fanFlags] = TrainerFanClub.getFanClubData(session, ctx);
    const counterIdx = tonumber(counterIdxIn) ?? 0;
    const inc = sCounterIncrements[counterIdx] ?? 0;
    const scene = TrainerFanClub.getVar(session, ctx, TrainerFanClub.VAR_MAP_SCENE_SAFFRON_CITY_POKEMON_TRAINER_FAN_CLUB);

    if (scene === 2) {
      if (timer + inc >= 20) {
        if (TrainerFanClub.countFans(fanFlags) < 3) {
          TrainerFanClub.playerGainRandomTrainerFan(session, ctx);
          const [, newGotInitial, newFanFlags] = TrainerFanClub.getFanClubData(session, ctx);
          gotInitialFans = newGotInitial;
          fanFlags = newFanFlags;
          timer = 0;
        } else {
          timer = 20;
        }
      } else {
        timer = Math.min(127, timer + inc);
      }
      TrainerFanClub.setFanClubData(session, ctx, timer, gotInitialFans, fanFlags);
    }

    return timer;
  },

  // Lua: trainer_fan_club.lua:323 -- pokefirered/src/trainer_fan_club.c:240 BufferFanClubTrainerName
  bufferFanClubTrainerName(session: any, ctx: any, adapters: any, memberIdIn: unknown): string {
    const memberId = tonumber(memberIdIn) ?? 0;
    let whichNPCTrainer = 0;
    let whichLinkTrainer = 0;

    if (memberId === TrainerFanClub.MEMBER.MEMBER1) {
      whichNPCTrainer = 0;
      whichLinkTrainer = 0;
    } else if (memberId === TrainerFanClub.MEMBER.MEMBER5) {
      whichNPCTrainer = 1;
      whichLinkTrainer = 0;
    } else if (memberId === TrainerFanClub.MEMBER.MEMBER6) {
      whichNPCTrainer = 0;
      whichLinkTrainer = 1;
    } else if (memberId === TrainerFanClub.MEMBER.MEMBER7) {
      whichNPCTrainer = 2;
      whichLinkTrainer = 1;
    } else {
      whichNPCTrainer = 0;
      whichLinkTrainer = 0;
    }

    session = session ?? TrainerFanClub.sessionOf();
    const linkRecords = session ? (session.linkBattleRecords ?? (session.linkRecords ? session.linkRecords.entries : undefined)) : undefined;
    const entry = linkRecords != null && typeof linkRecords === "object" ? linkRecords[whichLinkTrainer + 1] ?? null : null;
    const linkName = (entry && typeof entry.name === "string" && entry.name) || "";

    let resultName: string;
    if (linkName === "") {
      if (whichNPCTrainer === 1) {
        resultName = RomText.plain("gText_LtSurge");
      } else if (whichNPCTrainer === 2) {
        resultName = RomText.plain("gText_Koga");
      } else {
        resultName = (session && session.rivalName) || "BLUE";
      }
    } else {
      resultName = sub(linkName, 1, 7);
    }

    TrainerFanClub.setStringVar(ctx, adapters, 1, resultName);
    return resultName;
  },

  // Lua: trainer_fan_club.lua:368 -- pokefirered/src/trainer_fan_club.c:317 UpdateTrainerFansAfterLinkBattle
  updateTrainerFansAfterLinkBattle(session: any, ctx: any, outcome: unknown): void {
    const scene = TrainerFanClub.getVar(session, ctx, TrainerFanClub.VAR_MAP_SCENE_SAFFRON_CITY_POKEMON_TRAINER_FAN_CLUB);
    if (scene === 2) {
      TrainerFanClub.tryLoseFansFromPlayTimeAfterLinkBattle(session, ctx);
      if (outcome === "won" || outcome === 1 || outcome === 0x01) { // B_OUTCOME_WON
        TrainerFanClub.playerGainRandomTrainerFan(session, ctx);
      } else {
        TrainerFanClub.playerLoseRandomTrainerFan(session, ctx);
      }
    }
  },

  // Lua: trainer_fan_club.lua:381 -- pokefirered/src/trainer_fan_club.c:340 SetPlayerGotFirstFans
  setPlayerGotFirstFans(session: any, ctx: any): void {
    const [timer, , fanFlags] = TrainerFanClub.getFanClubData(session, ctx);
    TrainerFanClub.setFanClubData(session, ctx, timer, true, fanFlags);
  },
};

export default TrainerFanClub;
