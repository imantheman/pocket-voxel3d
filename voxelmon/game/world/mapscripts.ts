// The hand-ported map scripts, the registry half of gen1recomp
// data/scripts/init.lua + src/script/MapScripts.lua: map-specific behavior
// lives HERE, never in the world classes.
//
// Each entry is { talk: { TEXT_CONST: ScriptRow[] } } — the shape
// MapScripts.attachBase takes and ScriptRunner executes. Every script cites
// the upstream file it was transcribed from, which in turn cites the pokered
// script it ports; text arguments are the extracted labels (`_Label`), never
// prose typed in here, so nothing ROM-derived is committed (docs/VOXEL.md §1).
//
// Scope: the maps this build cooks (cook/cli.ts DEFAULT_MAPS). Two upstream
// scripts for those maps are NOT here, both needing rungs docs/VOXEL.md §10
// defers: data/scripts/oaks_lab.lua (the starter-choice cutscene — object
// visibility, a forced walk, and the rival battle) and story2.lua's
// PALLET_TOWN onStep (Oak stopping the player at the grass and walking them
// to the lab, which this build's newGame has already happened — the starter
// is in the party from the first frame, so the flag branches below resolve
// the way upstream's do once that cutscene is over).

import type { ScriptRow } from "./script.ts";

/** A talk handler that builds its rows from live state, or null for none. */
export type TalkFn = (ow: any, save: any) => ScriptRow[] | null;

export interface MapScript {
  /** Keyed by the object's TEXT_* constant, the way MapScripts.talk does. A
   * function entry computes its rows from live state (player cell, flags) —
   * the shape gen1recomp's story-script talk handlers take. */
  talk?: Record<string, ScriptRow[] | TalkFn>;
  /** story2.lua onStep: a land-trigger that returns rows to run, or null. */
  onStep?: (ow: any, save: any) => ScriptRow[] | null;
  /**
   * Declarative tile triggers (pokered data/maps/objects coord_event): step
   * onto (x,y) with the flag gates satisfied and the rows run. This is the
   * data form of an onStep hook — most story steps (a guard stopping you, an
   * officer moving aside) are one of these instead of hand-written logic.
   */
  coord?: CoordTrigger[];
}

export interface CoordTrigger {
  x: number;
  y: number;
  /** Fires only while this flag is unset — the event's own "done" gate. */
  unlessFlag?: string;
  /** Fires only once this flag is set — a prerequisite/stage gate. */
  ifFlag?: string;
  /** The script to run, same rows as a talk entry. */
  rows: ScriptRow[];
}

interface GymLeaderOpts {
  trainerClass: string; // "OPP_BROCK"
  beatFlag: string; // "EVENT_BEAT_BROCK"
  preText: string; // pre-battle challenge line
  deactivate?: string[]; // gym-trainer beat flags to set
  badge: string; // "BOULDERBADGE"
  badgeText: string[]; // received-badge + info lines
  tmPre: string; // "here, take this" line before the TM
  tm: string; // "TM_BIDE"
  gotFlag: string; // "EVENT_GOT_TM34"
  tmText: string[]; // received-TM + explanation lines
  advice: string; // post-battle advice, shown once beaten
}

/**
 * scripts/*Gym.asm leader text + data/scripts/victories.lua reward, folded
 * into one talk script (gyms.lua leaderTalk + afterBattle): beaten-gate ->
 * pre-battle text -> start_battle -> (on win) beat flag + badge + TM + speech.
 * start_battle records the win in lastCheck, so jump_if_false skips the reward
 * on a loss. give_item with `false` suppresses its own "got" box so the
 * leader's received-badge/TM lines read cleanly, and its halt-on-full-bag
 * leaves EVENT_GOT_TM* unset so re-talking retries the TM (#797).
 */
function gymLeader(o: GymLeaderOpts): ScriptRow[] {
  const rows: ScriptRow[] = [
    ["check_flag", o.beatFlag],
    ["jump_if_true", "beaten"],
    ["show_text", o.preText],
    ["start_battle", "trainer", o.trainerClass, 1],
    ["jump_if_false", "end"], // lost -> no reward
    ["set_flag", o.beatFlag],
  ];
  for (const d of o.deactivate ?? []) rows.push(["set_flag", d]);
  rows.push(["give_item", o.badge, 1, false]); // silent add
  for (const t of o.badgeText) rows.push(["show_text", t]);
  rows.push(["label", "give_tm"]);
  rows.push(["show_text", o.tmPre]);
  rows.push(["give_item", o.tm, 1, false]); // halts on a full bag; retried below
  rows.push(["set_flag", o.gotFlag]);
  for (const t of o.tmText) rows.push(["show_text", t]);
  rows.push(["jump", "end"]);
  rows.push(["label", "beaten"]);
  rows.push(["check_flag", o.gotFlag]);
  rows.push(["jump_if_false", "give_tm"]); // beaten but bag was full -> retry
  rows.push(["show_text", o.advice]);
  return rows;
}

// story2.lua mtMoonNerdWalk (MtMoonB2FMoveSuperNerdScript): the nerd walks
// RIGHT-then-UP from a dome-side grab, UP-only from a helix-side grab; a grab
// from elsewhere falls back on which fossil was taken.
function mtMoonNerdWalk(px: number, py: number, itemId: string): string[] {
  if ((px === 12 && py === 7) || (px === 11 && py === 6) || (px === 12 && py === 5)) {
    return ["right", "up"];
  }
  if ((px === 13 && py === 7) || (px === 14 && py === 6) || (px === 14 && py === 5)) {
    return ["up"];
  }
  return itemId === "DOME_FOSSIL" ? ["right", "up"] : ["up"];
}

// story2.lua mtMoonFossil: the fossil pick. Unbeaten -> the nerd's battle
// intercepts. Beaten -> "You want the X?" (ask); on yes, take it (give_item
// halts on a full bag), hide it, then the nerd marches to the other, claims
// it, and it is hidden too.
function mtMoonFossil(
  itemId: string,
  selfName: string,
  otherName: string,
  gotFlag: string,
): TalkFn {
  return (ow: any, save: any) => {
    const f = save?.flags ?? {};
    if (f.EVENT_GOT_DOME_FOSSIL || f.EVENT_GOT_HELIX_FOSSIL) return null;
    const nerd = ow.findNpc?.(1);
    if (nerd && !ow.trainerDefeated?.(nerd)) return [["engage_trainer", 1]];
    const dirs = mtMoonNerdWalk(ow?.player?.cellX ?? 0, ow?.player?.cellY ?? 0, itemId);
    const wantText =
      itemId === "DOME_FOSSIL"
        ? "_MtMoonB2FDomeFossilYouWantText"
        : "_MtMoonB2FHelixFossilYouWantText";
    return [
      ["ask", wantText],
      ["jump_if_false", "end"],
      ["play_sound", "Get_Key_Item"],
      ["give_item", itemId, 1, "_MtMoonB2FReceivedFossilText"],
      ["hide_object", "MT_MOON_B2F", selfName],
      ["set_flag", gotFlag],
      ["walk_npc", 1, dirs],
      ["show_text", "_MtMoonB2FSuperNerdThenThisIsMineText"],
      ["play_sound", "Get_Key_Item"],
      ["hide_object", "MT_MOON_B2F", otherName],
    ];
  };
}

// story5.lua M.PEWTER_CITY / pewterGymEscort (scripts/PewterCity.asm
// PewterCityYoungsterShowsPlayerGymScript): the gym guide blocks the west
// exit and walks you to Brock's gym until you hold the BOULDERBADGE. gen1recomp
// replays the exact RLEList_PewterGymGuy/Player lockstep; this port uses the
// same pathfind-rows idiom its Oak escort already uses (move_npc_to +
// move_player_to) — identical outcome, and it doesn't depend on a tween with
// no collision test (upstream #241). The guide ends by the gym, then snaps
// home to his spawn (35,16) the way walkHome does, his exit pocket being a
// dead end. Referenced by object name PEWTERCITY_YOUNGSTER.
function pewterEscortRows(): ScriptRow[] {
  return [
    ["show_text", "_PewterCityYoungsterYoureATrainerFollowMeText"],
    // walked to the gym entrance (11,18)/(12,18), not through the building
    ["move_player_to", 11, 18],
    ["move_npc_to", "PEWTERCITY_YOUNGSTER", 12, 18],
    ["face_object", "PEWTERCITY_YOUNGSTER", "left"],
    ["show_text", "_PewterCityYoungsterGoTakeOnBrockText"],
    // walkHome: no honest route back, so snap him to his object_event spawn
    ["place_npc", "PEWTERCITY_YOUNGSTER", 35, 16, "down"],
  ];
}

export const MAP_SCRIPTS: Record<string, MapScript> = {
  PEWTER_CITY: {
    // PewterGuys trigger tiles on the west-leaving path; fires until Brock is
    // beaten, running BEFORE the warp check so it pulls you back to the gym.
    onStep: (ow: any, save: any) => {
      const f = save?.flags ?? {};
      if (f.EVENT_BEAT_BROCK) return null;
      const p = ow?.player;
      const x = p?.cellX;
      const y = p?.cellY;
      if (
        !(
          (x === 35 && y === 17) ||
          (x === 36 && y === 17) ||
          (x === 37 && y === 18) ||
          (x === 37 && y === 19)
        )
      ) {
        return null;
      }
      return pewterEscortRows();
    },
    // Talking to the guide arms the same escort (PewterCityYoungsterText).
    talk: {
      TEXT_PEWTERCITY_YOUNGSTER: (_ow: any, save: any) =>
        save?.flags?.EVENT_BEAT_BROCK ? null : pewterEscortRows(),
    },
  },

  // story2.lua M.MT_MOON_B2F (scripts/MtMoonB2F.asm): the Super Nerd (object
  // 1) force-battles when you step onto (13,8), the chokepoint beside him, or
  // when you reach for a fossil unbeaten. Once beaten, taking one fossil hides
  // it, walks the nerd to the other, "All right. Then this is mine!", and
  // hides the other. mtMoonNerdWalk's path depends on where you grabbed from,
  // so the talk entries are function-form. give_item halts on a full bag
  // (leaving the flag/hide unset), matching MtMoonB2FYouHaveNoRoom.
  MT_MOON_B2F: {
    onStep: (ow: any, save: any) => {
      const p = ow?.player;
      if (p?.cellX === 13 && p?.cellY === 8) {
        const nerd = ow.findNpc?.(1);
        if (nerd && !ow.trainerDefeated?.(nerd)) return [["engage_trainer", 1]] as ScriptRow[];
      }
      return null;
    },
    talk: {
      TEXT_MTMOONB2F_DOME_FOSSIL: mtMoonFossil(
        "DOME_FOSSIL", "MTMOONB2F_DOME_FOSSIL", "MTMOONB2F_HELIX_FOSSIL", "EVENT_GOT_DOME_FOSSIL",
      ),
      TEXT_MTMOONB2F_HELIX_FOSSIL: mtMoonFossil(
        "HELIX_FOSSIL", "MTMOONB2F_HELIX_FOSSIL", "MTMOONB2F_DOME_FOSSIL", "EVENT_GOT_HELIX_FOSSIL",
      ),
    },
  },

  // story5.lua M.ROUTE_22 + route22Scene(1,...) (scripts/Route22.asm): the
  // optional early rival ambush after the parcel drop-off. Coord trigger at
  // (29,4)/(29,5), gated on the Pokédex in hand, Brock not yet beaten, and
  // this battle not yet won. runAmbush's player-facing + Music_MeetRival are
  // the onStep's side effects (play_music is a runner no-op in the audio
  // slice); the RETURNED rows are route22Scene(1,...) verbatim, so its numeric
  // jump_if_false 11 (skip the reward on a loss, straight to hide) still
  // lands. Rival is referenced by its object name ROUTE22_RIVAL1 so it
  // resolves distinctly from RIVAL2; show_object reveals the spawn-hidden
  // object (setObjectHidden reveal). Only the 1st battle is wired — the 2nd is
  // post-Giovanni content, left behind EVENT_BEAT_GIOVANNI.
  ROUTE_22: {
    onStep: (ow: any, save: any) => {
      const p = ow?.player;
      const x = p?.cellX;
      const y = p?.cellY;
      // inCoords({{29,4},{29,5}})
      if (!((x === 29 && y === 4) || (x === 29 && y === 5))) return null;
      const f = save?.flags ?? {};
      if (
        !(f.EVENT_GOT_POKEDEX && !f.EVENT_BEAT_BROCK && !f.EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE)
      ) {
        return null;
      }
      // runAmbush side effects: face the rival; Music_MeetRival is a no-op here
      if (ow.player) ow.player.facing = y === 4 ? "down" : "left";
      // route22Scene: rival walks right along row 5 and stops below (29,5) /
      // left of (28,5) the player; faces up on the top tile, right otherwise.
      const rx = y === 4 ? 29 : 28;
      const rivalFacing = y === 4 ? "up" : "right";
      const exit =
        y === 4
          ? ["right", "right", "down", "down", "down", "down", "down"]
          : ["up", "right", "right", "right", "down", "down", "down", "down", "down", "down"];
      return [
        ["show_object", "ROUTE_22", "ROUTE22_RIVAL1"], // 1
        ["move_npc_to", "ROUTE22_RIVAL1", rx, 5], //      2
        ["face_object", "ROUTE22_RIVAL1", rivalFacing], // 3
        ["show_text", "_Route22RivalBeforeBattleText1"], // 4
        ["rival_battle", "OPP_RIVAL1", 4, { loseable: true }], // 5 (loseable: no blackout)
        ["jump_if_false", 11], //                         6  loss -> hide, no reward
        ["set_flag", "EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE"], // 7
        ["show_text", "_Route22Rival1DefeatedText"], //   8
        ["show_text", "_Route22RivalAfterBattleText1"], // 9
        ["walk_npc", "ROUTE22_RIVAL1", exit], //          10
        ["hide_object", "ROUTE_22", "ROUTE22_RIVAL1"], // 11
      ] as ScriptRow[];
    },
  },

  // story.lua M.VIRIDIAN_MART (scripts/ViridianMart.asm ViridianMartDefault-
  // Script): the parcel hand-off is the map's DEFAULT script, not a talk —
  // entering with a starter and no parcel, the clerk calls you to the counter
  // (StartSimulatingJoypadStates walks you there) and ViridianMartOaksParcel-
  // Script hands over OAK's PARCEL; the player never presses A. gen1recomp
  // runs this from onEnter; the port has no onEnter dispatch, so it is the
  // map's onStep gate, the same idiom PALLET_TOWN's escort and OAKS_LAB's
  // rival challenge use (fires on the entry step). The clerk keeps no talk
  // script, so after the parcel he is just the shopkeeper (martGreetScript).
  VIRIDIAN_MART: {
    onStep: (_ow: any, save: any) => {
      const f = save?.flags ?? {};
      if (!f.EVENT_GOT_STARTER) return null;
      if (f.EVENT_GOT_OAKS_PARCEL || f.EVENT_OAK_GOT_PARCEL) return null;
      return [
        ["show_text", "_ViridianMartClerkYouCameFromPalletTownText"],
        // the simulated joypad walk (door 3,7 -> counter 2,5): up 2, left 1
        ["move_player", "up", 2],
        ["move_player", "left", 1],
        // the quest text's last page is "{PLAYER} got\nOAK's PARCEL!"
        ["give_item", "OAKS_PARCEL", 1, "_ViridianMartClerkParcelQuestText"],
        ["set_flag", "EVENT_GOT_OAKS_PARCEL"],
      ] as ScriptRow[];
    },
  },

  // oaks_lab.lua onStep: Blue cuts you off on the way out for the first
  // rival battle. His party counters the starter you took (parties 1/2/3 in
  // trainers.json are SQUIRTLE/BULBASAUR/CHARMANDER).
  OAKS_LAB_ONSTEP_HOST: {
    onStep: (ow: any, save: any) => {
      const f = save?.flags ?? {};
      if (!f.EVENT_GOT_STARTER) return null;
      if (f.EVENT_BATTLED_RIVAL_IN_OAKS_LAB) return null;
      const py = ow?.player?.cellY;
      if (py !== 9) return null;
      const px = ow?.player?.cellX ?? 5;
      const party = f.EVENT_CHOSE_BULBASAUR ? 3 : f.EVENT_CHOSE_SQUIRTLE ? 1 : 2;
      return [
        ["move_npc_to", "SPRITE_BLUE", px, 10],
        ["face_object", "SPRITE_BLUE", "up"],
        ["show_text", "_OaksLabRivalIllTakeYouOnText"],
        ["start_battle", "trainer", "OPP_RIVAL1", party, { loseable: true }],
        ["set_flag", "EVENT_BATTLED_RIVAL_IN_OAKS_LAB"],
        ["show_text", "_OaksLabRivalSmellYouLaterText"],
        // He leaves through the lab door (warps at 4,11 / 5,11).
        ["move_npc_to", "SPRITE_BLUE", 4, 11],
        ["hide_object", "OAKS_LAB", "SPRITE_BLUE"],
      ] as ScriptRow[];
    },
  },

  // data/scripts/oaks_lab.lua talk rung: the three Poke Ball objects.
  // The onEnter/onStep cutscene (Oak's escort) is still deferred; these
  // rows are the real selection and set the same flags upstream does.
  OAKS_LAB: {
    // Oak's overworld sprite is HideObject'd in the ROM until the intro's
    // ShowObject (scripts/OaksLab.asm). The port only reveals him transiently
    // during the Pallet escort, so on a later visit (returning with the
    // parcel) he is filtered out at spawn and there is no one to talk to.
    // Re-place the real Oak object at his desk on entry once the intro has
    // run; placeNpc reuses the hidden map object, so he keeps his
    // TEXT_OAKSLAB_OAK1 talk dispatch. A side effect only -- returns null so
    // the rival-battle host onStep (OAKS_LAB_ONSTEP_HOST) still runs this step.
    onStep: (ow: any, save: any) => {
      const f = save?.flags ?? {};
      if (f.EVENT_FOLLOWED_OAK_INTO_LAB || f.EVENT_GOT_STARTER) {
        if (!ow.findNpc?.("SPRITE_OAK")) ow.placeNpc?.("SPRITE_OAK", 5, 2, "down");
      }
      return null;
    },
    talk: {
      // data/scripts/oaks_lab.lua TEXT_OAKSLAB_OAK1 (scripts/OaksLab.asm
      // OaksLabOak1Text). Talking to Oak; the got_parcel branch is the
      // Pokédex cutscene — deliver OAK's PARCEL, the rival walks in, both
      // get the Pokédex, the rival leaves, and Route 22 is armed. The final
      // set_flag EVENT_GOT_POKEDEX is what lights up the POKéDEX menu
      // (startmenu.ts). Reached only when carrying OAKS_PARCEL after the lab
      // rival battle AND holding no POKE_BALL (upstream gates poke_ball ->
      // "come see me" ahead of the parcel, so empty the bag when testing).
      //
      // Ref adaptation (as the starter-ball entries below already do): Bryan's
      // numeric object refs 1/5 -> the port's sprite ids SPRITE_BLUE (rival) /
      // SPRITE_OAK (Oak); his `show_object OAKSLAB_RIVAL` + `place_npc 1` -> a
      // single place_npc that reveals/spawns the rival actor (the escort's
      // idiom). Cross-map toggles (VIRIDIAN_CITY old man, ROUTE_22 rival) are
      // kept verbatim; the port only resolves current-map objects, so they are
      // harmless no-ops until off-map object state persists.
      TEXT_OAKSLAB_OAK1: [
        ["face_player"],
        ["check_flag", "EVENT_PALLET_AFTER_GETTING_POKEBALLS"],
        ["jump_if_true", "dex_rating"],
        ["check_dex_owned", 2],
        ["jump_if_false", "no_rating"],
        ["check_flag", "EVENT_GOT_POKEDEX"],
        ["jump_if_true", "dex_rating"],
        ["label", "no_rating"],
        ["check_item", "POKE_BALL"],
        ["jump_if_true", "come_see"],
        ["check_flag", "EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE"],
        ["jump_if_true", "give_balls"],
        ["check_flag", "EVENT_GOT_POKEDEX"],
        ["jump_if_true", "around_world"],
        ["check_flag", "EVENT_BATTLED_RIVAL_IN_OAKS_LAB"],
        ["jump_if_false", "pre_lab_battle"],
        ["check_item", "OAKS_PARCEL"],
        ["jump_if_false", "raise_young"],
        // got_parcel -> RivalArrives + OakGivesPokedex
        ["show_text", "_OaksLabOak1DeliverParcelText"],
        ["play_sound", "Get_Key_Item"],
        ["show_text", "_OaksLabOak1ParcelThanksText"],
        ["take_item", "OAKS_PARCEL", 1],
        ["stop_music"],
        ["play_music", "Music_MeetRival"],
        ["show_text", "_OaksLabRivalGrampsText"],
        // Bryan: show_object OAKSLAB_RIVAL; place_npc 1 4 7 up (map 8,11 ->
        // cell 4,7). place_npc reveals/spawns SPRITE_BLUE in the port.
        ["place_npc", "SPRITE_BLUE", 4, 7, "up"],
        ["move_npc_to", "SPRITE_BLUE", 4, 3],
        ["play_music", "Music_OaksLab"],
        ["face_object", "SPRITE_BLUE", "up"],
        ["face_object", "SPRITE_OAK", "down"],
        ["show_text", "_OaksLabRivalWhatDidYouCallMeForText"],
        ["face_object", "SPRITE_BLUE", "up"],
        ["face_object", "SPRITE_OAK", "down"],
        ["show_text", "_OaksLabOakIHaveARequestText"],
        ["face_object", "SPRITE_BLUE", "up"],
        ["face_object", "SPRITE_OAK", "down"],
        ["show_text", "_OaksLabOakMyInventionPokedexText"],
        ["show_text", "_OaksLabOakGotPokedexText"],
        ["play_sound", "Get_Key_Item"],
        ["hide_object", "OAKS_LAB", "OAKSLAB_POKEDEX1"],
        ["hide_object", "OAKS_LAB", "OAKSLAB_POKEDEX2"],
        ["face_object", "SPRITE_BLUE", "up"],
        ["face_object", "SPRITE_OAK", "down"],
        ["show_text", "_OaksLabOakThatWasMyDreamText"],
        ["face_object", "SPRITE_BLUE", "right"],
        ["show_text", "_OaksLabRivalLeaveItAllToMeText"],
        ["set_flag", "EVENT_GOT_POKEDEX"],
        ["set_flag", "EVENT_OAK_GOT_PARCEL"],
        ["hide_object", "VIRIDIAN_CITY", "VIRIDIANCITY_OLD_MAN_SLEEPY"],
        ["show_object", "VIRIDIAN_CITY", "VIRIDIANCITY_OLD_MAN"],
        ["stop_music"],
        ["play_music", "Music_MeetRival"],
        ["move_npc_to", "SPRITE_BLUE", 4, 7],
        // Bryan: hide_object OAKSLAB_RIVAL -> the placed SPRITE_BLUE actor
        ["hide_object", "OAKS_LAB", "SPRITE_BLUE"],
        ["play_music", "Music_OaksLab"],
        ["set_flag", "EVENT_1ST_ROUTE22_RIVAL_BATTLE"],
        ["clear_flag", "EVENT_2ND_ROUTE22_RIVAL_BATTLE"],
        ["set_flag", "EVENT_ROUTE22_RIVAL_WANTS_BATTLE"],
        ["show_object", "ROUTE_22", "ROUTE22_RIVAL1"],
        ["jump", "end"],

        ["label", "raise_young"],
        ["show_text", "_OaksLabOak1RaiseYourYoungPokemonText"],
        ["jump", "end"],

        ["label", "pre_lab_battle"],
        ["check_flag", "EVENT_GOT_STARTER"],
        ["jump_if_true", "can_fight"],
        ["show_text", "_OaksLabOak1WhichPokemonDoYouWantText"],
        ["jump", "end"],
        ["label", "can_fight"],
        ["show_text", "_OaksLabOak1YourPokemonCanFightText"],
        ["jump", "end"],

        ["label", "around_world"],
        ["show_text", "_OaksLabOak1PokemonAroundTheWorldText"],
        ["jump", "end"],

        ["label", "give_balls"],
        ["check_flag", "EVENT_GOT_POKEBALLS_FROM_OAK"],
        ["jump_if_true", "come_see"],
        ["set_flag", "EVENT_GOT_POKEBALLS_FROM_OAK"],
        ["give_item", "POKE_BALL", 5, false],
        ["show_text", "_OaksLabOak1ReceivedPokeballsText"],
        ["show_text", "_OaksLabGivePokeballsExplanationText"],
        ["jump", "end"],

        ["label", "come_see"],
        ["show_text", "_OaksLabOak1ComeSeeMeSometimesText"],
        ["jump", "end"],

        ["label", "dex_rating"],
        ["show_text", "_OaksLabOak1HowIsYourPokedexComingText"],
        ["dex_rating"],
      ],

      TEXT_OAKSLAB_BULBASAUR_POKE_BALL: [
        ["check_flag", "EVENT_GOT_STARTER"],
        ["jump_if_true", "end"],
        ["ask", "_OaksLabYouWantBulbasaurText"],
        ["jump_if_false", "end"],
        ["play_sound", "Get_Key_Item"],
        ["show_text", "_OaksLabReceivedMonText"],
        ["give_pokemon", "BULBASAUR", 5],
        ["set_flag", "EVENT_GOT_STARTER"],
        ["set_flag", "EVENT_CHOSE_BULBASAUR"],
        ["hide_object", "OAKS_LAB", "OAKSLAB_BULBASAUR_POKE_BALL"],
        // Blue steps to the ball that counters yours, then claims it.
        ["move_npc_to", "SPRITE_BLUE", 6, 4],
        ["face_object", "SPRITE_BLUE", "up"],
        ["show_text", "_OaksLabRivalIllTakeThisOneText"],
        ["hide_object", "OAKS_LAB", "OAKSLAB_CHARMANDER_POKE_BALL"],
        ["show_text", "_OaksLabRivalReceivedMonText"],
      ],
      TEXT_OAKSLAB_CHARMANDER_POKE_BALL: [
        ["check_flag", "EVENT_GOT_STARTER"],
        ["jump_if_true", "end"],
        ["ask", "_OaksLabYouWantCharmanderText"],
        ["jump_if_false", "end"],
        ["play_sound", "Get_Key_Item"],
        ["show_text", "_OaksLabReceivedMonText"],
        ["give_pokemon", "CHARMANDER", 5],
        ["set_flag", "EVENT_GOT_STARTER"],
        ["set_flag", "EVENT_CHOSE_CHARMANDER"],
        ["hide_object", "OAKS_LAB", "OAKSLAB_CHARMANDER_POKE_BALL"],
        // Blue steps to the ball that counters yours, then claims it.
        ["move_npc_to", "SPRITE_BLUE", 7, 4],
        ["face_object", "SPRITE_BLUE", "up"],
        ["show_text", "_OaksLabRivalIllTakeThisOneText"],
        ["hide_object", "OAKS_LAB", "OAKSLAB_SQUIRTLE_POKE_BALL"],
        ["show_text", "_OaksLabRivalReceivedMonText"],
      ],
      TEXT_OAKSLAB_SQUIRTLE_POKE_BALL: [
        ["check_flag", "EVENT_GOT_STARTER"],
        ["jump_if_true", "end"],
        ["ask", "_OaksLabYouWantSquirtleText"],
        ["jump_if_false", "end"],
        ["play_sound", "Get_Key_Item"],
        ["show_text", "_OaksLabReceivedMonText"],
        ["give_pokemon", "SQUIRTLE", 5],
        ["set_flag", "EVENT_GOT_STARTER"],
        ["set_flag", "EVENT_CHOSE_SQUIRTLE"],
        ["hide_object", "OAKS_LAB", "OAKSLAB_SQUIRTLE_POKE_BALL"],
        // Blue steps to the ball that counters yours, then claims it.
        ["move_npc_to", "SPRITE_BLUE", 8, 4],
        ["face_object", "SPRITE_BLUE", "up"],
        ["show_text", "_OaksLabRivalIllTakeThisOneText"],
        ["hide_object", "OAKS_LAB", "OAKSLAB_BULBASAUR_POKE_BALL"],
        ["show_text", "_OaksLabRivalReceivedMonText"],
      ],
    },
  },

  // data/scripts/reds_house.lua (pokered scripts/RedsHouse1F.asm). Mom:
  // pre-starter shows the wake-up / Oak tip; after EVENT_GOT_STARTER,
  // RedsHouse1FMomHealScript fades to white, heals, plays MUSIC_PKMN_HEALED,
  // fades back, then "looking great".
  REDS_HOUSE_1F: {
    talk: {
      TEXT_REDSHOUSE1F_MOM: [
        ["face_player"], //                                        1
        ["check_flag", "EVENT_GOT_STARTER"], //                     2
        ["jump_if_true", 6], //                                     3
        ["show_text", "_RedsHouse1FMomWakeUpText"], //              4
        ["jump", "end"], //                                         5
        // RedsHouse1FMomHealScript
        ["show_text", "_RedsHouse1FMomYouShouldRestText"], //       6
        ["fade", "out", "white"], //                                7  GBFadeOutToWhite
        ["heal_party"], //                                          8
        ["play_once", "Music_PkmnHealed"], //                       9
        ["fade", "in", "white"], //                                10  GBFadeInFromWhite
        ["show_text", "_RedsHouse1FMomLookingGreatText"], //       11
      ],
    },
  },

  // data/scripts/pallet_town.lua (pokered scripts/PalletTown.asm).
  // PalletTownOakText is a text_asm branch on wOakWalkedToPlayer showing
  // either _PalletTownOakHeyWaitDontGoOutText or _PalletTownOakItsUnsafeText;
  // upstream branches on the starter flag, which tracks it. The champion
  // rematch rows (upstream 2-19) need a trainer battle and are left out with
  // the rest of §10's trainer rung — the branch that survives is the one v1
  // content can reach.
  PALLET_TOWN: {
    talk: {
      TEXT_PALLETTOWN_OAK: [
        ["face_player"], //                                         1
        ["check_flag", "EVENT_GOT_STARTER"], //                      2
        ["jump_if_true", 6], //                                      3
        ["show_text", "_PalletTownOakHeyWaitDontGoOutText"], //      4
        ["jump", "end"], //                                          5
        ["show_text", "_PalletTownOakItsUnsafeText"], //             6
      ],
    },
    // story2.lua PALLET_TOWN onStep (migrated off the old special-cased
    // _ONSTEP_HOST now that onStepComplete dispatches onStep for every map):
    // Oak stops the player at the north grass and escorts them to the lab.
    // Stays an onStep function (not a coord entry) because Oak spawns relative
    // to the player's column — a coord trigger's rows are static.
    onStep: (ow: any, save: any) => {
      const f = save?.flags ?? {};
      if (f.EVENT_FOLLOWED_OAK_INTO_LAB || f.EVENT_GOT_STARTER) return null;
      const cy = (ow?.player as any)?.cellY;
      if (cy !== 1) return null;
      const LAB_DOOR_X = 12, LAB_DOOR_Y = 11; // maps.json warp -> OAKS_LAB
      const px = (ow?.player as any)?.cellX ?? 0;
      const py = (ow?.player as any)?.cellY ?? 0;
      return [
        ["place_npc", "SPRITE_OAK", px, py + 4, "up"],
        ["move_npc_to", "SPRITE_OAK", px, py + 1],
        ["face_object", "SPRITE_OAK", "up"],
        ["show_text", "_PalletTownOakHeyWaitDontGoOutText"],
        ["show_text", "_PalletTownOakItsUnsafeText"],
        ["move_npc_to", "SPRITE_OAK", LAB_DOOR_X, LAB_DOOR_Y],
        ["move_player_to", LAB_DOOR_X, LAB_DOOR_Y + 1],
        ["warp", "OAKS_LAB", 5, 11, "up"],
        ["place_npc", "SPRITE_OAK", 5, 2, "down"],
        ["move_player", "up", 8],
        ["set_flag", "EVENT_FOLLOWED_OAK_INTO_LAB"],
        ["show_text", "_OaksLabRivalFedUpWithWaitingText"],
        ["show_text", "_OaksLabOakChooseMonText"],
        ["show_text", "_OaksLabRivalWhatAboutMeText"],
        ["show_text", "_OaksLabOakBePatientText"],
        ["set_flag", "EVENT_OAK_ASKED_TO_CHOOSE_MON"],
      ] as ScriptRow[];
    },
  },

  // scripts/PewterGym.asm + victories.lua OPP_BROCK#1 (via gymLeader).
  PEWTER_GYM: {
    talk: {
      TEXT_PEWTERGYM_BROCK: gymLeader({
        trainerClass: "OPP_BROCK",
        beatFlag: "EVENT_BEAT_BROCK",
        preText: "_PewterGymBrockPreBattleText",
        deactivate: ["EVENT_BEAT_PEWTER_GYM_TRAINER_0"],
        badge: "BOULDERBADGE",
        badgeText: [
          "_PewterGymBrockReceivedBoulderBadgeText",
          "_PewterGymBrockBoulderBadgeInfoText",
        ],
        tmPre: "_PewterGymBrockWaitTakeThisText",
        tm: "TM_BIDE",
        gotFlag: "EVENT_GOT_TM34",
        tmText: ["_PewterGymReceivedTM34Text", "_TM34ExplanationText"],
        advice: "_PewterGymBrockPostBattleAdviceText",
      }),
    },
  },
};

/**
 * MapScripts.lua:239 talkScript — the script for an object's TEXT_* constant
 * on a map, or null when nothing is registered and the plain extracted text
 * is what the player should see.
 */
export function talkScript(mapLabel: string, textConst: string): ScriptRow[] | TalkFn | null {
  return MAP_SCRIPTS[mapLabel]?.talk?.[textConst] ?? null;
}

// Item balls (pokered engine/overworld/ItemUseOverworld + the shared
// PickupItem/ItemBallScript path): any map object carrying an `item` field is
// a ground pickup, so it needs no per-map talk entry — the object data IS the
// script. The event flag below is the missable-object flag pokered sets to
// hide a collected ball (data/events/... EVENT_GOT_*): once set, the ball is
// gone and re-talking is a no-op. Text const is globally unique per ball, but
// the map id is folded in so nothing collides.
export function itemBallFlag(mapLabel: string, textConst: string): string {
  return `EVENT_ITEMBALL_${mapLabel}_${textConst}`;
}

/**
 * Synthesise the pickup script for an item-ball object. Mirrors the starter
 * Poke Ball rows above: gate on the flag, add the item, then (only if the bag
 * had room) set the flag and hide the ball. give_item halts the script when
 * the bag is full (AddItemToInventory's `jr nc, .full`), so a full bag leaves
 * both the flag and the ball untouched and the player can come back for it.
 * Returns null for any object without an item field.
 */
export function itemBallScript(
  mapLabel: string,
  obj: { text?: string; item?: string } | undefined,
): ScriptRow[] | null {
  const item = obj?.item;
  const textConst = obj?.text;
  if (!item || !textConst) return null;
  const flag = itemBallFlag(mapLabel, textConst);
  return [
    ["check_flag", flag],
    ["jump_if_true", "end"],
    ["play_sound", "Get_Item_1"],
    ["give_item", item],
    ["set_flag", flag],
    ["hide_object", mapLabel, textConst],
  ] as ScriptRow[];
}
