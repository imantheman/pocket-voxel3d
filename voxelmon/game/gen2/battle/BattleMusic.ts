// Which song a battle plays, and which one its win plays: a port of
// gen1recomp src/battle/gen2/BattleMusic.lua (bdfac727, MIT).
//
// engine/battle/start_battle.asm PlayBattleMusic and engine/battle/core.asm
// PlayVictoryMusic, as pure lookups: the caller hands over the trainer class,
// the region and the time of day, and gets a song label back.  Keeping it out
// of World is what lets a test assert the whole ladder -- Falkner's theme,
// the Kanto split, the RIVAL2 cut-off -- without a window or an audio device.
//
// Both routines start with `ld de, MUSIC_NONE / call PlayMusic`, i.e. the map
// theme is stopped first; the port's Music.play replaces whatever is current,
// so that step needs nothing here.

import { truthy } from "../platform/lua.ts";

export interface BattleSongOpts {
  class?: string;
  landmark?: number;
  battleTheme?: string;
  crystal?: boolean;
  battleType?: number;
  daytime?: string;
  /** the class's member ids, in party-table order */
  members?: string[];
  member?: string;
  [k: string]: any;
}

export interface VictorySongOpts {
  class?: string;
  participantsFainted?: boolean;
  [k: string]: any;
}

export const BattleMusic = {
  // data/trainers/leaders.asm.  The two lists are contiguous in the ROM and
  // IsGymLeader reads BOTH (GymLeaders falls through into KantoGymLeaders),
  // while IsKantoGymLeader starts at the second -- so a Kanto leader is in each
  // list and a Johto one only in the first.
  KANTO_GYM_LEADERS: {
    BROCK: true,
    MISTY: true,
    LT_SURGE: true,
    ERIKA: true,
    JANINE: true,
    SABRINA: true,
    BLAINE: true,
    BLUE: true,
  } as Record<string, boolean>,
  JOHTO_GYM_LEADERS: {
    FALKNER: true,
    WHITNEY: true,
    BUGSY: true,
    MORTY: true,
    PRYCE: true,
    JASMINE: true,
    CHUCK: true,
    CLAIR: true,
    WILL: true,
    BRUNO: true,
    KAREN: true,
    KOGA: true,
    // The list carries these two as well; PlayBattleMusic never reaches them
    // because it tests for them first, but PlayVictoryMusic's IsGymLeader call
    // does, which is why the Champion's defeat plays the gym jingle.
    CHAMPION: true,
    RED: true,
  } as Record<string, boolean>,

  // RegionCheck (engine/overworld/landmarks.asm) compares the map's landmark
  // against KANTO_LANDMARK; the Victory Road block above it counts as Johto
  // again, and so does the S.S. Aqua.  Indices into constants' `landmarkOrder`.
  KANTO_LANDMARK: 46,
  LANDMARK_VICTORY_ROAD: 87,
  LANDMARK_FAST_SHIP: 94,

  // The rival's theme becomes the Champion's from RIVAL2_2 onward (the Indigo
  // Plateau rematch): `cp RIVAL2_2_CHIKORITA / jr c, .done`, a comparison
  // against the MEMBER id inside the class.
  RIVAL2_CHAMPION_MEMBER: "RIVAL2_2_CHIKORITA",

  // ../pokecrystal/constants/battle_constants.asm:96
  BATTLETYPE_ROAMING: 5,
  BATTLETYPE_SUICUNE: 12,

  // Lua: BattleMusic.lua:34 -- IsGymLeader searches GymLeaders, which runs on
  // into KantoGymLeaders.
  isGymLeader(cls: string | undefined | null): boolean {
    if (!truthy(cls)) return false;
    return BattleMusic.JOHTO_GYM_LEADERS[cls!] === true || BattleMusic.KANTO_GYM_LEADERS[cls!] === true;
  },

  // Lua: BattleMusic.lua:40
  isKantoGymLeader(cls: string | undefined | null): boolean {
    return cls != null && BattleMusic.KANTO_GYM_LEADERS[cls] === true;
  },

  // Lua: BattleMusic.lua:52
  isKanto(landmark: number | undefined | null): boolean {
    const index = landmark ?? 0;
    if (index === BattleMusic.LANDMARK_FAST_SHIP) return false;
    if (index < BattleMusic.KANTO_LANDMARK) return false;
    return index < BattleMusic.LANDMARK_VICTORY_ROAD;
  },

  // Lua: BattleMusic.lua:68
  battleSong(opts?: BattleSongOpts): string {
    const o = opts ?? {};
    const cls = o.class;
    const kanto = BattleMusic.isKanto(o.landmark);

    if (truthy(o.battleTheme)) return o.battleTheme!;

    // ../pokecrystal/engine/battle/start_battle.asm:60-66
    if (
      truthy(o.crystal) &&
      (o.battleType === BattleMusic.BATTLETYPE_SUICUNE || o.battleType === BattleMusic.BATTLETYPE_ROAMING)
    ) {
      return "Music_SuicuneBattle";
    }

    if (!truthy(cls)) {
      if (kanto) return "Music_KantoWildBattle";
      // Only NITE has its own wild theme; DARK (an unlit cave) is a palette
      // state, not a time of day, and keeps the day theme.
      if (o.daytime === "NITE") return "Music_JohtoWildBattleNight";
      return "Music_JohtoWildBattle";
    }

    if (cls === "CHAMPION" || cls === "RED") {
      return "Music_ChampionBattle";
    }
    // The cart's own bug, kept: only the two GRUNT classes get the Rocket
    // theme, so an EXECUTIVE or SCIENTIST fights to the ordinary trainer song
    // (docs/bugs_and_glitches.md).
    if (cls === "GRUNTM" || cls === "GRUNTF") {
      return "Music_RocketBattle";
    }
    if (BattleMusic.isKantoGymLeader(cls)) {
      return "Music_KantoGymBattle";
    }
    if (BattleMusic.isGymLeader(cls)) {
      return "Music_JohtoGymBattle";
    }
    if (cls === "RIVAL1") return "Music_RivalBattle";
    if (cls === "RIVAL2") {
      let cutoff: number | undefined;
      let index: number | undefined;
      const members = o.members ?? [];
      for (let i = 0; i < members.length; i++) {
        const id = members[i];
        if (id == null) break;
        if (id === BattleMusic.RIVAL2_CHAMPION_MEMBER) cutoff = i + 1;
        if (id === o.member) index = i + 1;
      }
      if (cutoff !== undefined && index !== undefined && index >= cutoff) {
        return "Music_ChampionBattle";
      }
      return "Music_RivalBattle";
    }
    if (kanto) return "Music_KantoTrainerBattle";
    return "Music_JohtoTrainerBattle";
  },

  // Lua: BattleMusic.lua:125 -- PlayVictoryMusic.  A wild win is SILENT unless
  // the player still has a participant standing (or an Exp. Share, or Pay Day
  // money) -- `wBattleParticipantsNotFainted` zero falls through to `.lost`
  // with no PlayMusic at all, which is why a battle won by a mon that fainted
  // to recoil ends on the map theme.  Returns nil for that case.
  victorySong(opts?: VictorySongOpts): string | undefined {
    const o = opts ?? {};
    if (!truthy(o.class)) {
      if (truthy(o.participantsFainted)) return undefined;
      return "Music_WildPokemonVictory";
    }
    if (BattleMusic.isGymLeader(o.class)) {
      return "Music_GymLeaderVictory";
    }
    return "Music_TrainerVictory";
  },
};

export default BattleMusic;
