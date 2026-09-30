// Yellow's map scripts: the entries that differ from Red and Blue, laid over
// MAP_SCRIPTS when the dataset is Yellow (gen1recomp data/scripts/init.lua's
// Yellow overlays: talk keys merge per map, a hook given here replaces
// Red's). Every script cites the upstream file it follows, which cites the
// pokeyellow script it ports; text arguments are extracted labels, never
// prose, so nothing ROM-derived is committed (docs/VOXEL.md §1).
//
// Built by a function over Red's table rather than at load, so this module
// and mapscripts.ts can import each other without an evaluation-order trap.

import type { MapScript } from "./mapscripts.ts";
import type { ScriptRow } from "./script.ts";
import type { Dir } from "./collision.ts";

const MEET_RIVAL = "Music_MeetRival";

/** Red's rows with some text labels swapped for Yellow's. */
function relabel(rows: ScriptRow[], swaps: Record<string, string>): ScriptRow[] {
  return rows.map((r) =>
    r[0] === "show_text" && typeof r[1] === "string" && swaps[r[1]]
      ? (["show_text", swaps[r[1]], ...r.slice(2)] as unknown as ScriptRow)
      : r,
  );
}

/**
 * story2.lua PALLET_TOWN onStep, Yellow branch (pokeyellow
 * PalletTownOakHeyWaitScript..PalletTownAfterPikachuBattleScript): the stop
 * fires on row 0, Oak walks up from (10,4), says it was close, turns to the
 * grass and catches the wild Pikachu himself (BATTLE_TYPE_PIKACHU, the
 * old-man demo under PROF.OAK's name), then walks the player to the lab.
 * RLEList_ProfOakWalkToLab's first DOWN is x6 here, Oak starting a row
 * farther north than Red's.
 */
function palletOnStep(ow: any, save: any): ScriptRow[] | null {
  const f = save?.flags ?? {};
  if (f.EVENT_FOLLOWED_OAK_INTO_LAB || f.EVENT_GOT_STARTER) return null;
  const p = ow?.player as { cellX?: number; cellY?: number } | undefined;
  if (p?.cellY !== 0) return null;
  const px = p.cellX ?? 10;
  const OAK_STEPS: Dir[] = [
    ...Array<Dir>(Math.max(0, px - 10)).fill("left"),
    ...Array<Dir>(6).fill("down"),
    "left",
    ...Array<Dir>(5).fill("down"),
    "right", "right", "right",
    "up",
  ];
  return [
    ["play_music", "Music_MeetProfOak"],
    ["show_text", "_PalletTownOakHeyWaitDontGoOutText"],
    ["emote", "player", "shock", 50],
    ["place_npc", "SPRITE_OAK", 10, 4, "up"],
    ["move_npc_to", "SPRITE_OAK", px, 1],
    ["face_object", "SPRITE_OAK", "up"],
    ["show_text", "_PalletTownOakThatWasCloseText"],
    // the grass beside the exit: the left exit looks right, the right left
    ["face_object", "SPRITE_OAK", px === 10 ? "right" : "left"],
    ["old_man_demo", "PIKACHU", 5, "PROF.OAK"],
    ["face_object", "SPRITE_OAK", "up"],
    ["show_text", "_PalletTownOakWhewText"],
    ["show_text", "_PalletTownOakComeWithMe"],
    ["escort_steps", "SPRITE_OAK", OAK_STEPS],
    ["warp", "OAKS_LAB", 5, 11, "up"],
    ["place_npc", "SPRITE_OAK", 5, 2, "down"],
    ["move_player", "up", 8],
    ["set_flag", "EVENT_FOLLOWED_OAK_INTO_LAB"],
    ["set_flag", "EVENT_FOLLOWED_OAK_INTO_LAB_2"],
    ["show_text", "_OaksLabRivalFedUpWithWaitingText"],
    ["show_text", "_OaksLabOakChooseMonText"],
    ["show_text", "_OaksLabRivalWhatAboutMeText"],
    ["show_text", "_OaksLabOakBePatientText"],
    ["set_flag", "EVENT_OAK_ASKED_TO_CHOOSE_MON"],
  ] as ScriptRow[];
}

/**
 * oaks_lab_yellow.lua TEXT_OAKSLAB_EEVEE_POKE_BALL (pokeyellow
 * OaksLabRivalExclamationScript..OaksLabPlayerReceivesPikachuScript): before
 * Oak's speech the ball is flavour; after it the rival "!"s, shoves the
 * player off the table and takes the Eevee, and Oak hands the player the
 * Pikachu he caught -- no nickname prompt, it keeps its species name.
 * wRivalStarter starts at JOLTEON (1) with the snatch.
 */
function eeveeBall(ow: any, save: any): ScriptRow[] | null {
  const f = save?.flags ?? {};
  if (f.EVENT_GOT_STARTER) return null;
  if (!f.EVENT_OAK_ASKED_TO_CHOOSE_MON) return [["show_text", "_OaksLabThatsAPokeball"]] as ScriptRow[];
  const below = (ow?.player?.cellY ?? 4) === 4;
  return [
    ["emote", "SPRITE_BLUE", "shock"],
    // .RivalPushesPlayerAwayFromEeveeBall: round the table, then the shove
    // lands as he takes the last step onto the player's cell
    ...(below
      ? ([
          ["walk_npc", "SPRITE_BLUE", ["down", "right", "right"]],
          ["move_player", "right", 2],
          ["walk_npc", "SPRITE_BLUE", ["right"]],
        ] as ScriptRow[])
      : ([["move_npc_to", "SPRITE_BLUE", 7, 4]] as ScriptRow[])),
    ["face_object", "SPRITE_BLUE", "up"],
    ["hide_object", "OAKS_LAB", "OAKSLAB_EEVEE_POKE_BALL"],
    ["set_field", "rivalStarter", 1],
    ["show_text", "_OaksLabRivalTakesText1"],
    ["play_sound", "Get_Key_Item"],
    ["show_text", "_OaksLabRivalTakesText2"],
    ["show_text", "_OaksLabRivalTakesText3"],
    ["show_text", "_OaksLabRivalTakesText4"],
    ["show_text", "_OaksLabRivalTakesText5"],
    // OaksLabRLE_PlayerWalksToOak, played back to front: from the shove spot
    // (9,4) round the bottom of the table to (5,3), under Oak
    below
      ? ["walk_npc", "player", ["left", "down", "left", "left", "left", "up", "up"]]
      : ["walk_npc", "player", ["left"]],
    ["face_object", "player", "up"],
    ["face_object", "SPRITE_OAK", "down"],
    ["show_text", "_OaksLabOakGivesText"],
    ["play_sound", "Get_Key_Item"],
    ["show_text", "_OaksLabReceivedText", { "RAM:wNameBuffer": ow?.data?.pokemon?.PIKACHU?.name ?? "PIKACHU" }],
    ["give_pokemon", "PIKACHU", 5, true],
    ["set_flag", "EVENT_GOT_STARTER"],
    ["set_flag", "EVENT_CHOSE_PIKACHU"],
  ] as ScriptRow[];
}

/**
 * oaks_lab_yellow.lua onStep (pokeyellow OaksLabRivalChallengesPlayerScript
 * ..OaksLabPikachuDislikesPokeballsScript): heading for the door with
 * Pikachu, the rival stops you with his Eevee (party 1). A win decides his
 * Eevee becomes FLAREON (2), a loss VAPOREON (3); then he leaves and
 * Pikachu pops out of its ball.
 */
function labOnStep(ow: any, save: any): ScriptRow[] | null {
  const f = save?.flags ?? {};
  const p = ow?.player;
  const x: number = p?.cellX ?? 5;
  const y: number = p?.cellY ?? 0;
  if (y < 6) return null;
  if (f.EVENT_FOLLOWED_OAK_INTO_LAB && !f.EVENT_GOT_STARTER) {
    return [
      ["face_object", "SPRITE_OAK", "down"],
      ["face_object", "SPRITE_BLUE", "down"],
      ["show_text", "_OaksLabOakDontGoAwayYetText"],
      ["move_player", "up", 1],
    ] as ScriptRow[];
  }
  if (!f.EVENT_GOT_STARTER || f.EVENT_BATTLED_RIVAL_IN_OAKS_LAB) return null;
  const free = ([cx, cy]: [number, number]) => {
    try { return ow.map.isWalkableCell(cx, cy) && !ow.npcAtCell?.(cx, cy); } catch { return false; }
  };
  const target = ([[x, y - 1], [x - 1, y], [x + 1, y], [x, y + 1]] as [number, number][]).find(free);
  const facing = !target ? "up"
    : target[1] < y ? "down" : target[1] > y ? "up" : target[0] < x ? "right" : "left";
  return [
    ["face_object", "player", "up"],
    ["play_music", MEET_RIVAL],
    ["show_text", "_OaksLabRivalIllTakeYouOnText"],
    ...(target ? [["move_npc_to", "SPRITE_BLUE", target[0], target[1]] as ScriptRow] : []),
    ["face_object", "SPRITE_BLUE", facing],
    ["start_battle", "trainer", "OPP_RIVAL1", 1, { loseable: true }],
    ["heal_party"],
    ["set_flag", "EVENT_BATTLED_RIVAL_IN_OAKS_LAB"],
    ["jump_if_false", "lost"],
    ["set_field", "rivalStarter", 2],
    ["jump", "leave"],
    ["label", "lost"],
    ["set_field", "rivalStarter", 3],
    ["label", "leave"],
    ["wait", 20],
    ["show_text", "_OaksLabRivalSmellYouLaterText"],
    ["play_music", MEET_RIVAL],
    ["move_npc_to", "SPRITE_BLUE", 4, 11],
    ["hide_object", "OAKS_LAB", "SPRITE_BLUE"],
    ["play_cry", "PIKACHU"],
    ["show_text", "_OaksLabPikachuDislikesPokeballsText1"],
    ["show_text", "_OaksLabPikachuDislikesPokeballsText2"],
  ] as ScriptRow[];
}

/** The Yellow entries, over Red's table (`base`). */
export function yellowScripts(base: Record<string, MapScript>): Record<string, MapScript> {
  const redOak = (base.OAKS_LAB?.talk?.TEXT_OAKSLAB_OAK1 ?? []) as ScriptRow[];
  return {
    PALLET_TOWN: { onStep: palletOnStep },
    OAKS_LAB_ONSTEP_HOST: { onStep: labOnStep },
    OAKS_LAB: {
      talk: {
        // oaks_lab_yellow.lua TEXT_OAKSLAB_OAK1: Red's branches, with
        // Yellow's lines where its Oak says something else
        TEXT_OAKSLAB_OAK1: relabel(redOak, {
          _OaksLabRivalWhatDidYouCallMeForText: "_OaksLabRivalMyPokemonHasGrownStrongerText",
          _OaksLabOak1RaiseYourYoungPokemonText: "_OaksLabOak1YouShouldTalkToIt",
          _OaksLabOak1WhichPokemonDoYouWantText: "_OaksLabOak1GoAheadItsYours",
        }),
        TEXT_OAKSLAB_EEVEE_POKE_BALL: eeveeBall,
        TEXT_OAKSLAB_RIVAL: [
          ["face_player"],
          ["check_flag", "EVENT_GOT_STARTER"],
          ["jump_if_false", "pre_starter"],
          ["show_text", "_OaksLabRivalMyPokemonLooksStrongerText"],
          ["jump", "end"],
          ["label", "pre_starter"],
          ["check_flag", "EVENT_FOLLOWED_OAK_INTO_LAB_2"],
          ["jump_if_false", "gramps_gone"],
          ["show_text", "_OaksLabRivalIllGetABetterPokemonThanYou"],
          ["jump", "end"],
          ["label", "gramps_gone"],
          ["show_text", "_OaksLabRivalGrampsIsntAroundText"],
        ] as ScriptRow[],
      },
    },
  };
}
