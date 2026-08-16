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

export interface MapScript {
  /** Keyed by the object's TEXT_* constant, the way MapScripts.talk does. */
  talk?: Record<string, ScriptRow[]>;
  /** story2.lua onStep: a land-trigger that returns rows to run, or null. */
  onStep?: (ow: any, save: any) => ScriptRow[] | null;
}

export const MAP_SCRIPTS: Record<string, MapScript> = {
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
        ["start_battle", "trainer", "OPP_RIVAL1", party],
        ["set_flag", "EVENT_BATTLED_RIVAL_IN_OAKS_LAB"],
        ["show_text", "_OaksLabRivalSmellYouLaterText"],
        ["move_npc_to", "SPRITE_BLUE", 4, 3],
      ] as ScriptRow[];
    },
  },

  // story2.lua PALLET_TOWN onStep: Oak stops the player at the north grass
  // and walks them to the lab, then OaksLabOakChooseMonSpeechScript runs.
  // The object-movement rungs (Oak's own walk, the OAK1/OAK2 swap) are still
  // deferred; the escort itself and every flag it sets are faithful.
  PALLET_TOWN_ONSTEP_HOST: {
    onStep: (ow: any, save: any) => {
      const f = save?.flags ?? {};
      if (f.EVENT_FOLLOWED_OAK_INTO_LAB || f.EVENT_GOT_STARTER) return null;
      // tile coords are cellX/cellY (px/py are pixels)
      const cy = (ow?.player as any)?.cellY;
      if (cy !== 1) return null;
      // Object indices follow pokered's object order for these maps; if the
      // wrong NPC animates, these are the numbers to adjust.
      const LAB_DOOR_X = 12, LAB_DOOR_Y = 11;   // maps.json warp -> OAKS_LAB
      const px = (ow?.player as any)?.cellX ?? 0;
      const py = (ow?.player as any)?.cellY ?? 0;
      return [
        // Oak comes up from the lab side, stops behind the player.
        ["place_npc", "SPRITE_OAK", px, py + 4, "up"],
        ["move_npc_to", "SPRITE_OAK", px, py + 1],
        ["face_object", "SPRITE_OAK", "up"],
        ["show_text", "_PalletTownOakHeyWaitDontGoOutText"],
        ["show_text", "_PalletTownOakItsUnsafeText"],
        // He leads, the player follows, then both enter the lab.
        // Pathfinding routes around the buildings now, so go straight for
        // the door; the old midpoint sent both of them east into a pillar.
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

  // data/scripts/oaks_lab.lua talk rung: the three Poke Ball objects.
  // The onEnter/onStep cutscene (Oak's escort) is still deferred; these
  // rows are the real selection and set the same flags upstream does.
  OAKS_LAB: {
    talk: {
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
  },
};

/**
 * MapScripts.lua:239 talkScript — the script for an object's TEXT_* constant
 * on a map, or null when nothing is registered and the plain extracted text
 * is what the player should see.
 */
export function talkScript(mapLabel: string, textConst: string): ScriptRow[] | null {
  return MAP_SCRIPTS[mapLabel]?.talk?.[textConst] ?? null;
}
