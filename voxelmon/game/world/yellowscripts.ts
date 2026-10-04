// Yellow's map scripts: the entries that differ from Red and Blue, laid over
// MAP_SCRIPTS when the dataset is Yellow (gen1recomp data/scripts/init.lua's
// Yellow overlays: talk keys merge per map, a hook given here replaces
// Red's). Every script cites the upstream file it follows, which cites the
// pokeyellow script it ports; text arguments are extracted labels, never
// prose, so nothing ROM-derived is committed (docs/VOXEL.md §1).
//
// Built by a function over Red's table rather than at load, so this module
// and mapscripts.ts can import each other without an evaluation-order trap.

import {
  gameCornerRocketRows,
  hasSevenBadges,
  liftKeyRocketRows,
  lockedDoorStep,
  pewterGymGuide,
  type MapScript,
} from "./mapscripts.ts";
import { coinClerkRows, coinGiverRows, YELLOW_COIN_GIVERS } from "./gamecorner.ts";
import { SAFARI_JOIN_CELLS, safariJoinRows, safariLeavingRows } from "./safari.ts";
import { gymGateFlag } from "./toggleblocks.ts";
import { PIKA_MAP_PAUSE_IGT, PIKA_MAP_SURF_SELECT, type ScriptRow } from "./script.ts";
import { surfingPikachuInParty } from "../ui/surfingstate.ts";
import * as Pikachu from "./pikachu.ts";
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
    ["pika_clip", 2], // OaksLab.asm:1096 PikachuCry2
    ["show_text", "_OaksLabPikachuDislikesPokeballsText1"],
    ["show_text", "_OaksLabPikachuDislikesPokeballsText2"],
  ] as ScriptRow[];
}

/** A yes/no question and its two answers (YesNoChoice: YES is item 0). */
function askThen(question: string, yes: string, no: string): ScriptRow[] {
  return [
    ["face_player"],
    ["ask", question],
    ["jump_if_false", "no"],
    ["show_text", yes],
    ["jump", "end"],
    ["label", "no"],
    ["show_text", no],
    ["label", "end"],
  ] as ScriptRow[];
}

/**
 * CeladonMansion1FGrannyText: her line; with your own Pikachu along, her
 * reading of it by its happiness (PikachuHappinessThresholds_f1eb9: under
 * 51, 101, 131, 161, 201, 255), and at 251 or more it answers her after 50
 * frames with its PikachuCry23.
 */
function grannyTalk(_ow: any, save: any): ScriptRow[] {
  const rows: ScriptRow[] = [["face_player"], ["show_text", "_CeladonMansion1Text2"]] as ScriptRow[];
  if (!Pikachu.starterInParty(save ?? {}, true)) return rows;
  const h = Pikachu.happiness(save);
  const reading = [51, 101, 131, 161, 201, 255].findIndex((t) => h < t);
  rows.push(["show_text", "_CeladonMansion1Text6"] as ScriptRow);
  rows.push(["show_text", `_CeladonMansion1Text${reading < 0 ? 12 : 7 + reading}`] as ScriptRow);
  if (h >= 251) rows.push(["wait", 50] as ScriptRow, ["pika_clip", 23] as ScriptRow);
  return rows;
}

/** Bill-as-Pokemon's rows with Pikachu's beats laid in: watching as he
 * walks round the player, and following him up to the machine. */
function withBillsBeats(rows: unknown): ScriptRow[] | undefined {
  if (!Array.isArray(rows)) return undefined;
  const out: ScriptRow[] = [];
  for (const r of rows as ScriptRow[]) {
    if (r[0] === "move_npc_to") out.push(["pikachu_bills", "watch"] as ScriptRow);
    out.push(r);
    if (r[0] === "hide_object") out.push(["pikachu_bills", "enter"] as ScriptRow);
  }
  return out;
}

/**
 * SummerBeachHouseSurfinDudeText. Only a Pikachu that knows SURF gets a
 * word about surfing (BIT_PIKACHU_SPAWN_SURFING); the long pitch is the
 * first ask each visit (BIT_PIKACHU_MAP_PAUSE_IGT, set as it is asked), the
 * short one after.
 */
function surfinDude(ow: any, save: any): ScriptRow[] {
  if (!surfingPikachuInParty(save ?? {})) {
    return [["face_player"], ["show_text", "_SummerBeachHouseSurfinDudeText4"]] as ScriptRow[];
  }
  const asked = ((ow?.pikachuMapFlags ?? 0) & PIKA_MAP_PAUSE_IGT) !== 0;
  if (ow) ow.pikachuMapFlags = (ow.pikachuMapFlags ?? 0) | PIKA_MAP_PAUSE_IGT;
  return [
    ["face_player"],
    ["ask", asked ? "_SummerBeachHouseSurfinDudeText3" : "_SummerBeachHouseSurfinDudeText1"],
    ["jump_if_false", "no"],
    ["surfing_minigame"],
    ["jump", "end"],
    ["label", "no"],
    ["show_text", "_SummerBeachHouseSurfinDudeText2"],
    ["label", "end"],
  ] as ScriptRow[];
}

/** SummerBeachHousePoster1-3Text: the surf-capable line once a surfing
 * Pikachu is along. */
function beachPoster(n: number) {
  return (_ow: any, save: any): ScriptRow[] =>
    [["show_text", `_SummerBeachHousePoster${n}Text${surfingPikachuInParty(save ?? {}) ? 1 : 2}`]] as ScriptRow[];
}

/**
 * SummerBeachHousePrinterText. With a surfing Pikachu it is the SUMMER
 * BEACH HOUSE PRINTER, and once this visit has had a run it offers the
 * Hi-Score. YES prints (Func_f23d0) -- there is no Game Boy Printer on the
 * link port, so the cartridge's own "PRINT error!" answers; NO shows the
 * card (Printer_PrepareSurfingMinigameHighScoreTileMap), here as its words:
 * the header, the player's Hi-Score and the points, since the card's own
 * tiles (SurfingPikachu2Graphics) are not in the manifest.
 */
function beachPrinter(ow: any, save: any): ScriptRow[] {
  if (!surfingPikachuInParty(save ?? {})) return [["show_text", "_SummerBeachHousePrinterText1"]] as ScriptRow[];
  const rows: ScriptRow[] = [["show_text", "_SummerBeachHousePrinterText2"]] as ScriptRow[];
  if (((ow?.pikachuMapFlags ?? 0) & PIKA_MAP_SURF_SELECT) === 0) return rows;
  const bcd = save?.surfingHighScore ?? 0;
  const score = String(Number.parseInt(bcd.toString(16), 10) || 0);
  const name = save?.player?.name ?? "";
  return [
    ...rows,
    ["ask", "_SummerBeachHousePrinterText3"],
    ["jump_if_false", "card"],
    ["show_text", "_SummerBeachHousePrinterText6"],
    ["jump", "end"],
    ["label", "card"],
    ["show_text", `Pikachu's Beach\x0c${name}'s Hi-Score\n${score.padStart(4, " ")} Points`],
    ["label", "end"],
  ] as ScriptRow[];
}

/**
 * The Viridian old man, Yellow's way (yellow_viridian_old_man.lua; pokeyellow
 * scripts/ViridianCity.asm, ViridianCity_2.asm). The Pokédex swaps the
 * sleeper for OLD_MAN2 on the sleeper's own cell (Red's walker at (17,5)
 * never appears); stepping into the gap east of him, or talking to him,
 * runs the apology and a demo he FAILS -- three shakes and the ball breaks
 * -- then "losing my touch", and he walks off: down the corridor if you
 * stand in the gap, a step right otherwise.
 */
const OLD_MAN2 = "VIRIDIANCITY_OLD_MAN2";

function oldMan2Rows(ow: any): ScriptRow[] {
  const inGap = ow?.player?.cellX === 19;
  return [
    ["show_text", "_ViridianCityOldManHadMyCoffeeNowText"],
    ["old_man_demo", "fail"],
    ["set_flag", "EVENT_COMPLETED_CATCH_TRAINING"],
    ["show_text", "_ViridianCityOldManLosingMyTouchText"],
    ["walk_npc", OLD_MAN2, inGap ? ["down", "down", "down", "down", "down", "down"] : ["right"]],
    ["hide_object", "VIRIDIAN_CITY", OLD_MAN2],
  ] as ScriptRow[];
}

function viridianOnStep(ow: any, save: any): ScriptRow[] | null {
  const gym = lockedDoorStep(ow, [[32, 8]], !hasSevenBadges(save), "_ViridianCityGymLockedText");
  if (gym) return gym;
  const f = save?.flags ?? {};
  const x = ow?.player?.cellX;
  const y = ow?.player?.cellY;
  if (f.EVENT_GOT_POKEDEX) {
    // OaksLabOakGivesPokedexScript's toggles, re-derived on every visit
    const t = ((save.objectToggles ??= {}).VIRIDIAN_CITY ??= {});
    if (t.VIRIDIANCITY_OLD_MAN_SLEEPY !== false || t.VIRIDIANCITY_OLD_MAN !== false) {
      t.VIRIDIANCITY_OLD_MAN_SLEEPY = false;
      t.VIRIDIANCITY_OLD_MAN = false;
      ow.setObjectHidden?.("VIRIDIANCITY_OLD_MAN_SLEEPY", true);
      ow.setObjectHidden?.("VIRIDIANCITY_OLD_MAN", true);
      if (!f.EVENT_COMPLETED_CATCH_TRAINING) {
        t[OLD_MAN2] = true;
        ow.setObjectHidden?.(OLD_MAN2, false);
      }
    }
    // ViridianCityCheckWaitingOldMan
    if (!f.EVENT_COMPLETED_CATCH_TRAINING && x === 19 && y === 9 && ow.findNpc?.(OLD_MAN2)) {
      return [
        ["face_object", OLD_MAN2, "right"],
        ["face_object", "player", "left"],
        ...oldMan2Rows(ow),
      ] as ScriptRow[];
    }
    return null;
  }
  if (x === 19 && y === 9) {
    return [
      ["show_text", "_ViridianCityOldManSleepyPrivatePropertyText"],
      ["move_player", "down", 1],
    ] as ScriptRow[];
  }
  return null;
}

// ---------------------------------------------------------------------------
// the starter gifts (yellow_gifts.lua; pokeyellow CeruleanMelaniesHouse.asm,
// Route24.asm, VermilionCity_2.asm)
// ---------------------------------------------------------------------------

/** A gift mon: ask, room check, the mon (with the nickname prompt every gift
 * gets), the flag, the thanks; or the "no" line. */
function giftRows(o: {
  ask: string; species: string; level: number; flag: string; received: string; declined: string;
  hide?: [string, string];
}): ScriptRow[] {
  return [
    ["ask", o.ask],
    ["jump_if_false", "declined"],
    ["check_party_room"],
    ["jump_if_false", "full"],
    ["play_sound", "Get_Key_Item"],
    ["give_pokemon", o.species, o.level],
    ["set_flag", o.flag],
    ...(o.hide ? [["hide_object", o.hide[0], o.hide[1]] as ScriptRow] : []),
    ["show_text", o.received],
    ["jump", "end"],
    ["label", "declined"],
    ["show_text", o.declined],
    ["jump", "end"],
    ["label", "full"],
    ["show_text", "You have no room\nfor it!"],
  ] as ScriptRow[];
}

/** Melanie's Bulbasaur waits for a Pikachu that trusts you (happiness 147+,
 * the follower's; 90 until it is there). */
function melanieTalk(_ow: any, save: any): ScriptRow[] {
  const f = save?.flags ?? {};
  if (f.EVENT_GOT_BULBASAUR_IN_CERULEAN) return [["face_player"], ["show_text", "MelanieText4"]] as ScriptRow[];
  if ((save?.pikachuHappiness ?? 90) < 147) return [["face_player"], ["show_text", "MelanieText1"]] as ScriptRow[];
  return [
    ["face_player"],
    ["show_text", "MelanieText1"],
    ...giftRows({
      ask: "MelanieText2", species: "BULBASAUR", level: 10, flag: "EVENT_GOT_BULBASAUR_IN_CERULEAN",
      received: "MelanieText3", declined: "MelanieText5",
      hide: ["CERULEAN_MELANIES_HOUSE", "CERULEANMELANIESHOUSE_BULBASAUR"],
    }),
  ] as ScriptRow[];
}

/** Officer Jenny keeps her Squirtle until you carry the THUNDERBADGE. */
function jennyTalk(_ow: any, save: any): ScriptRow[] {
  const f = save?.flags ?? {};
  if (f.EVENT_GOT_SQUIRTLE_FROM_OFFICER_JENNY) return [["face_player"], ["show_text", "_OfficerJennyText5"]] as ScriptRow[];
  if (!(save?.inventory?.THUNDERBADGE > 0)) return [["face_player"], ["show_text", "_OfficerJennyText1"]] as ScriptRow[];
  return [
    ["face_player"],
    ...giftRows({
      ask: "_OfficerJennyText2", species: "SQUIRTLE", level: 10, flag: "EVENT_GOT_SQUIRTLE_FROM_OFFICER_JENNY",
      received: "_OfficerJennyText3", declined: "_OfficerJennyText4",
    }),
  ] as ScriptRow[];
}

// ---------------------------------------------------------------------------
// Jessie & James (yellow_jessie_james.lua; pokeyellow MtMoonB2F.asm,
// RocketHideoutB4F.asm, PokemonTower7F.asm, SilphCo11F.asm). Every site is
// one shape: their theme, the motto, the two close in, one battle against
// the shared OPP_ROCKET party, their parting lines, and they are gone.
// ---------------------------------------------------------------------------

interface JessieJames {
  map: string;
  jessie: string;
  james: string;
  text: string; // the "_…JessieJamesText" stem, 1..4
  party: number;
  flag: string;
  /** Show them before the motto (they were hidden until now). */
  popIn: boolean;
  /** Which way the player faces while they come. */
  face: Dir;
  /** Who walks first, their steps and their final facing. */
  walks: [string, Dir[], Dir][];
  /** A player step before they move (Mt Moon's simulated UP). */
  playerStep?: Dir;
  /** On a loss, put them away so the trigger re-arms clean (the hideout). */
  hideOnLoss?: boolean;
}

function jessieJamesRows(j: JessieJames): ScriptRow[] {
  const T = (n: number) => `${j.text}${n}`;
  return [
    ["play_music", "Music_MeetJessieJames"],
    ...(j.popIn ? [["show_object", j.map, j.jessie], ["show_object", j.map, j.james]] as ScriptRow[] : []),
    ["show_text", T(1)],
    ["face_object", "player", j.face],
    ["emote", "player", "shock", 30],
    ...(j.popIn ? [] : [["show_object", j.map, j.james], ["show_object", j.map, j.jessie]] as ScriptRow[]),
    ...(j.playerStep ? [["walk_npc", "player", [j.playerStep]] as ScriptRow] : []),
    ...j.walks.flatMap(([who, steps, facing]) => [
      ["walk_npc", who, steps] as ScriptRow,
      ["face_object", who, facing] as ScriptRow,
    ]),
    ["show_text", T(2)],
    ["start_battle", "trainer", "OPP_ROCKET", j.party],
    ["jump_if_false", "lost"],
    // their loss line prints on the battle screen in the original
    // (SaveEndBattleTextPointers); here it is the first thing after it
    ["show_text", T(3)],
    ["show_text", T(4)],
    ["play_music", "Music_MeetJessieJames"],
    ["fade", "out"],
    ["hide_object", j.map, j.jessie],
    ["hide_object", j.map, j.james],
    ["fade", "in"],
    ["set_flag", j.flag],
    ["jump", "end"],
    ["label", "lost"],
    ...(j.hideOnLoss ? [["hide_object", j.map, j.jessie], ["hide_object", j.map, j.james]] as ScriptRow[] : []),
  ] as ScriptRow[];
}

const D = (n: number, d: Dir): Dir[] => Array<Dir>(n).fill(d);

function mtMoonJJ(ow: any, save: any): ScriptRow[] | null {
  const f = save?.flags ?? {};
  const p = ow?.player;
  if (p?.cellX !== 3 || p?.cellY !== 5 || f.EVENT_BEAT_MT_MOON_3_JESSIE_JAMES) return null;
  if (!(f.EVENT_GOT_DOME_FOSSIL || f.EVENT_GOT_HELIX_FOSSIL)) return null;
  return jessieJamesRows({
    map: "MT_MOON_B2F", jessie: "MTMOONB2F_JESSIE", james: "MTMOONB2F_JAMES",
    text: "_MtMoonJessieJamesText", party: 42, flag: "EVENT_BEAT_MT_MOON_3_JESSIE_JAMES",
    popIn: true, face: "up", playerStep: "up",
    walks: [["MTMOONB2F_JESSIE", D(6, "left"), "down"], ["MTMOONB2F_JAMES", D(5, "left"), "left"]],
  });
}

function hideoutJJ(ow: any, save: any): ScriptRow[] | null {
  const f = save?.flags ?? {};
  const p = ow?.player;
  if (p?.cellY !== 14 || (p.cellX !== 24 && p.cellX !== 25) || f.EVENT_BEAT_ROCKET_HIDEOUT_4_JESSIE_JAMES) return null;
  const onLeft = p.cellX === 25; // under James's column: he walks three
  return jessieJamesRows({
    map: "ROCKET_HIDEOUT_B4F", jessie: "ROCKETHIDEOUTB4F_JESSIE", james: "ROCKETHIDEOUTB4F_JAMES",
    text: "_RocketHideoutJessieJamesText", party: 43, flag: "EVENT_BEAT_ROCKET_HIDEOUT_4_JESSIE_JAMES",
    popIn: false, face: "up", hideOnLoss: true,
    walks: [
      ["ROCKETHIDEOUTB4F_JAMES", D(onLeft ? 3 : 4, "down"), onLeft ? "down" : "left"],
      ["ROCKETHIDEOUTB4F_JESSIE", D(onLeft ? 4 : 3, "down"), onLeft ? "right" : "down"],
    ],
  });
}

function towerJJ(ow: any, save: any): ScriptRow[] | null {
  const f = save?.flags ?? {};
  const p = ow?.player;
  if (p?.cellY !== 12 || (p.cellX !== 10 && p.cellX !== 11) || f.EVENT_BEAT_POKEMONTOWER_7_JESSIE_JAMES) return null;
  const onLeft = p.cellX === 11;
  return jessieJamesRows({
    map: "POKEMON_TOWER_7F", jessie: "POKEMONTOWER7F_JESSIE", james: "POKEMONTOWER7F_JAMES",
    text: "_PokemonTowerJessieJamesText", party: 44, flag: "EVENT_BEAT_POKEMONTOWER_7_JESSIE_JAMES",
    popIn: true, face: "up",
    walks: [
      ["POKEMONTOWER7F_JESSIE", D(onLeft ? 4 : 3, "down"), onLeft ? "right" : "down"],
      ["POKEMONTOWER7F_JAMES", D(onLeft ? 3 : 4, "down"), onLeft ? "down" : "left"],
    ],
  });
}

function silphJJ(ow: any, save: any): ScriptRow[] | null {
  const f = save?.flags ?? {};
  const p = ow?.player;
  if (p?.cellY !== 3 || p.cellX > 3 || f.EVENT_BEAT_SILPH_CO_11F_JESSIE_JAMES) return null;
  const x = p.cellX;
  const [jamesSteps, jamesFace, jessieSteps, jessieFace]: [Dir[], Dir, Dir[], Dir] =
    x === 3 ? [D(5, "up"), "right", D(4, "up"), "up"]
    : x === 2 ? [D(4, "up"), "up", D(5, "up"), "left"]
    : [["up", "up", "left", "up", "up"], "up", ["up", "up", "up", "left", "up", "up"], "left"];
  return jessieJamesRows({
    map: "SILPH_CO_11F", jessie: "SILPHCO11F_JESSIE", james: "SILPHCO11F_JAMES",
    text: "_SilphCoJessieJamesText", party: 45, flag: "EVENT_BEAT_SILPH_CO_11F_JESSIE_JAMES",
    popIn: false, face: "down",
    walks: [["SILPHCO11F_JAMES", jamesSteps, jamesFace], ["SILPHCO11F_JESSIE", jessieSteps, jessieFace]],
  });
}

/** Their talk line before an ambush: the motto. */
function mottoTalk(textId: string): ScriptRow[] {
  return [["face_player"], ["show_text", textId]] as ScriptRow[];
}

/** The Yellow entries, over Red's table (`base`). */
export function yellowScripts(base: Record<string, MapScript>): Record<string, MapScript> {
  // Red's Oak rows with Yellow's lines, and the Pokédex swapping in
  // OLD_MAN2 rather than Red's walker
  const redOak = ((base.OAKS_LAB?.talk?.TEXT_OAKSLAB_OAK1 ?? []) as ScriptRow[]).map((r) =>
    r[0] === "show_object" && r[1] === "VIRIDIAN_CITY" && r[2] === "VIRIDIANCITY_OLD_MAN"
      ? (["show_object", "VIRIDIAN_CITY", OLD_MAN2] as unknown as ScriptRow)
      : r,
  );
  return {
    VIRIDIAN_CITY: {
      onStep: viridianOnStep,
      talk: {
        TEXT_VIRIDIANCITY_OLD_MAN2: (ow: any, save: any): ScriptRow[] =>
          save?.flags?.EVENT_COMPLETED_CATCH_TRAINING
            ? [["show_text", "_ViridianCityOldManLosingMyTouchText"]] as ScriptRow[]
            : [["face_player"], ...oldMan2Rows(ow)] as ScriptRow[],
        // ViridianCity_2.asm: the youngster's bug lesson (the answers are
        // text_far'd without the underscore) and the girl on grandpa
        TEXT_VIRIDIANCITY_YOUNGSTER2: askThen(
          "_ViridianCityYoungster2YouWantToKnowAboutText",
          "ViridianCityYoungster2CaterpieAndWeedleDescriptionText",
          "ViridianCityYoungster2OkThenText",
        ),
        TEXT_VIRIDIANCITY_GIRL: (_ow: any, save: any): ScriptRow[] => [
          ["face_player"],
          ["show_text", save?.flags?.EVENT_GOT_POKEDEX
            ? "_ViridianCityGirlWhenIGoShopText" : "_ViridianCityGirlHasntHadHisCoffeeYetText"],
        ] as ScriptRow[],
      },
    },
    // RedsHouse1F_2.asm: the TV shows a film only from the front
    REDS_HOUSE_1F: {
      talk: {
        TEXT_REDSHOUSE1F_TV: (ow: any): ScriptRow[] => [
          ["show_text", ow?.player?.facing === "up"
            ? "_RedsHouse1FTVStandByMeMovieText" : "_RedsHouse1FTVWrongSideText"],
        ] as ScriptRow[],
      },
    },
    // CeladonMansion1F_2.asm: the granny reads your Pikachu's heart, and a
    // devoted one answers her (PikachuCry23)
    CELADON_MANSION_1F: {
      talk: { TEXT_CELADONMANSION1F_GRANNY: grannyTalk },
    },
    // Route18Gate2F.asm: Yellow's trader is the cook (TRADE_FOR_SPIKE, the
    // same table place as Red's)
    ROUTE_18_GATE_2F: {
      talk: {
        TEXT_ROUTE18GATE2F_COOK: [["face_player"], ["trade", 6, "EVENT_TRADED_SLOWBRO_FOR_LICKITUNG"]] as ScriptRow[],
      },
    },
    // pokeyellow scripts/GameCorner.asm: the same counter and giveaways,
    // under Yellow's names for the people
    GAME_CORNER: {
      talk: {
        TEXT_GAMECORNER_CLERK: coinClerkRows("_GameCornerClerk"),
        TEXT_GAMECORNER_FISHING_GURU1: coinGiverRows(YELLOW_COIN_GIVERS.FISHING_GURU1),
        TEXT_GAMECORNER_MIDDLE_AGED_MAN2: coinGiverRows(YELLOW_COIN_GIVERS.MIDDLE_AGED_MAN2),
        TEXT_GAMECORNER_FISHING_GURU2: coinGiverRows(YELLOW_COIN_GIVERS.FISHING_GURU2),
        // GameCorner_2.asm: Pikachu steps out of the grunt's way
        TEXT_GAMECORNER_ROCKET: gameCornerRocketRows(true),
      },
    },
    // pokeyellow scripts/PokemonFanClub.asm: the boasting fan's pet is a
    // CLEFAIRY now (your own PIKACHU is the famous one), same boast war
    POKEMON_FAN_CLUB: {
      talk: {
        TEXT_POKEMONFANCLUB_CLEFAIRY_FAN: [
          ["face_player"],
          ["check_flag", "EVENT_PIKACHU_FAN_BOAST"],
          ["jump_if_true", "better"],
          ["show_text", "_PokemonFanClubClefairyFanNormalText"],
          ["set_flag", "EVENT_SEEL_FAN_BOAST"],
          ["jump", "end"],
          ["label", "better"],
          ["show_text", "_PokemonFanClubClefairyFanBetterText"],
          ["clear_flag", "EVENT_PIKACHU_FAN_BOAST"],
        ] as ScriptRow[],
        TEXT_POKEMONFANCLUB_CLEFAIRY: [
          ["play_cry", "CLEFAIRY"],
          ["show_text", "_PokemonFanClubClefairyText"],
        ] as ScriptRow[],
      },
    },
    // CeruleanCity.asm: the trainer by the water drills an ELECTRODE
    CERULEAN_CITY: {
      talk: {
        TEXT_CERULEANCITY_COOLTRAINER_F1: [
          ["face_player"],
          ["random_text", [
            [180, "_CeruleanCityCooltrainerF1ElectrodeUseSonicboomText"],
            [100, "_CeruleanCityCooltrainerF1ElectrodePunchText"],
            [0, "_CeruleanCityCooltrainerF1ElectrodeWithdrawText"],
          ]],
        ] as ScriptRow[],
        TEXT_CERULEANCITY_ELECTRODE: [
          ["random_text", [
            [180, "_CeruleanCityElectrodeTookASnoozeText"],
            [120, "_CeruleanCityElectrodeIsLoafingAroundText"],
            [60, "_CeruleanCityElectrodeTurnedAwayText"],
            [0, "_CeruleanCityElectrodeIgnoredOrdersText"],
          ]],
        ] as ScriptRow[],
      },
    },
    // RocketHideoutB4F.asm: one unnumbered grunt has the LIFT KEY; and
    // Jessie & James ambush the corridor on row 14
    ROCKET_HIDEOUT_B4F: {
      talk: {
        TEXT_ROCKETHIDEOUTB4F_ROCKET: liftKeyRocketRows("ROCKETHIDEOUTB4F_ROCKET",
          "_RocketHideoutB4FRocketAfterBattleText"),
        TEXT_ROCKETHIDEOUTB4F_JESSIE: mottoTalk("_RocketHideoutJessieJamesText1"),
        TEXT_ROCKETHIDEOUTB4F_JAMES: mottoTalk("_RocketHideoutJessieJamesText1"),
      },
      onStep: (ow: any, save: any) => base.ROCKET_HIDEOUT_B4F?.onStep?.(ow, save) ?? hideoutJJ(ow, save),
    },
    MT_MOON_B2F: {
      talk: {
        TEXT_MTMOONB2F_JESSIE: mottoTalk("_MtMoonJessieJamesText1"),
        TEXT_MTMOONB2F_JAMES: mottoTalk("_MtMoonJessieJamesText1"),
      },
      onStep: (ow: any, save: any) => base.MT_MOON_B2F?.onStep?.(ow, save) ?? mtMoonJJ(ow, save),
    },
    POKEMON_TOWER_7F: {
      talk: {
        TEXT_POKEMONTOWER7F_JESSIE: mottoTalk("_PokemonTowerJessieJamesText1"),
        TEXT_POKEMONTOWER7F_JAMES: mottoTalk("_PokemonTowerJessieJamesText1"),
      },
      onStep: (ow: any, save: any) => base.POKEMON_TOWER_7F?.onStep?.(ow, save) ?? towerJJ(ow, save),
    },
    SILPH_CO_11F: {
      talk: {
        TEXT_SILPHCO11F_JESSIE: mottoTalk("_SilphCoJessieJamesText1"),
        TEXT_SILPHCO11F_JAMES: mottoTalk("_SilphCoJessieJamesText1"),
      },
      onStep: (ow: any, save: any) => base.SILPH_CO_11F?.onStep?.(ow, save) ?? silphJJ(ow, save),
    },
    // the starter gifts
    CERULEAN_MELANIES_HOUSE: {
      talk: {
        TEXT_CERULEANMELANIESHOUSE_MELANIE: melanieTalk,
        TEXT_CERULEANMELANIESHOUSE_BULBASAUR: [["play_cry", "BULBASAUR"], ["show_text", "MelanieBulbasaurText"]] as ScriptRow[],
        TEXT_CERULEANMELANIESHOUSE_ODDISH: [["play_cry", "ODDISH"], ["show_text", "MelanieOddishText"]] as ScriptRow[],
        TEXT_CERULEANMELANIESHOUSE_SANDSHREW: [["play_cry", "SANDSHREW"], ["show_text", "MelanieSandshrewText"]] as ScriptRow[],
      },
    },
    ROUTE_24: {
      talk: {
        // Damian gives away the CHARMANDER he thinks is too weak (EVENT_54F)
        TEXT_ROUTE24_COOLTRAINER_M4: (_ow: any, save: any): ScriptRow[] =>
          save?.flags?.EVENT_54F
            ? [["face_player"], ["show_text", "_Route24DamianText4"]] as ScriptRow[]
            : [["face_player"], ...giftRows({
                ask: "_Route24DamianText1", species: "CHARMANDER", level: 10, flag: "EVENT_54F",
                received: "_Route24DamianText2", declined: "_Route24DamianText3",
              })] as ScriptRow[],
      },
    },
    VERMILION_CITY: {
      talk: { TEXT_VERMILIONCITY_OFFICER_JENNY: jennyTalk },
    },
    // CinnabarGym.asm (Yellow): a gate's trainer will not fight until his
    // quiz has been tried -- talked to first, he gives the room's lecture
    CINNABAR_GYM: {
      talk: {
        // CinnabarGym_3.asm CinnabarGymPrintGymGuideText
        TEXT_CINNABARGYM_GYM_GUIDE: (_ow: any, save: any): ScriptRow[] => [
          ["face_player"],
          ["show_text", save?.flags?.EVENT_BEAT_BLAINE
            ? "_CinnabarGymGymGuideBeatBlaineText" : "_CinnabarGymGymGuideChampInMakingText"],
        ] as ScriptRow[],
        ...Object.fromEntries([0, 1, 2, 3, 4, 5].map((i) => [
        `TEXT_CINNABARGYM_SUPER_NERD${i + 2}`,
        (ow: any, save: any): ScriptRow[] => {
          const name = `CINNABARGYM_SUPER_NERD${i + 2}`;
          const npc = ow?.findNpc?.(name);
          const beaten = !!npc && ow.trainerDefeated?.(npc);
          if (!beaten && !save?.flags?.[gymGateFlag(i)]) {
            return [["face_player"], ["show_text", `_CinnabarGymText_${i + 1}`]] as ScriptRow[];
          }
          if (!beaten) return [["face_player"], ["engage_trainer", name]] as ScriptRow[];
          const after = ow.trainerHeader?.(npc)?.after;
          return [["face_player"], ["show_text", after ?? "..."]] as ScriptRow[];
        },
      ])),
      },
    },
    // PewterGym.asm: the guide has a word about your Pikachu
    PEWTER_GYM: {
      talk: { TEXT_PEWTERGYM_GYM_GUIDE: pewterGymGuide(true) },
    },
    // PewterPokecenter.asm: Yellow's CooltrainerF, and the lullaby
    PEWTER_POKECENTER: {
      talk: {
        TEXT_PEWTERPOKECENTER_JIGGLYPUFF: [
          ...((base.PEWTER_POKECENTER?.talk?.TEXT_PEWTERPOKECENTER_JIGGLYPUFF ?? []) as ScriptRow[]),
          ["pikachu_bills", "park"],
        ] as ScriptRow[],
        TEXT_PEWTERPOKECENTER_COOLTRAINER_F: [["face_player"], ["show_text", "_PewterPokecenterText3"]] as ScriptRow[],
      },
    },
    // BillsHouse.asm: Pikachu's beats round the cell separator
    BILLS_HOUSE: {
      talk: {
        TEXT_BILLSHOUSE_BILL_POKEMON: withBillsBeats(base.BILLS_HOUSE?.talk?.TEXT_BILLSHOUSE_BILL_POKEMON) ?? [],
        TEXT_BILLSHOUSE_PC: (ow: any, save: any): ScriptRow[] => {
          const pc = base.BILLS_HOUSE?.talk?.TEXT_BILLSHOUSE_PC;
          const rows = (typeof pc === "function" ? pc(ow, save) : pc ?? []) as ScriptRow[];
          // Bill steps out of the machine at the end of the separation
          return rows.some((r) => r[0] === "show_object") ? [...rows, ["pikachu_bills", "exit"] as ScriptRow] : rows;
        },
      },
      onEnter: (ow: any) => Pikachu.enterBillsHouse(ow),
    },
    // SummerBeachHouse.asm: Route 19's surf shack
    SUMMER_BEACH_HOUSE: {
      talk: {
        TEXT_SUMMERBEACHHOUSE_SURFINDUDE: surfinDude,
        TEXT_SUMMERBEACHHOUSE_PIKACHU: [
          ["face_player"],
          ["show_text", "_SummerBeachHousePikachuText"],
          ["play_cry", "PIKACHU"],
        ] as ScriptRow[],
        TEXT_SUMMERBEACHHOUSE_POSTER1: beachPoster(1),
        TEXT_SUMMERBEACHHOUSE_POSTER2: beachPoster(2),
        TEXT_SUMMERBEACHHOUSE_POSTER3: beachPoster(3),
        TEXT_SUMMERBEACHHOUSE_PRINTER: beachPrinter,
      },
    },
    // SafariZoneGate_2.asm: Yellow lets the short and the broke in anyway
    SAFARI_ZONE_GATE: {
      talk: {
        // SafariZoneGatePrintSafariZoneWorker2Text: first time? then the rules
        TEXT_SAFARIZONEGATE_SAFARI_ZONE_WORKER2: askThen(
          "_SafariZoneGateSafariZoneWorker2FirstTimeHereText",
          "_SafariZoneGateSafariZoneWorker2SafariZoneExplanationText",
          "_SafariZoneGateSafariZoneWorker2YoureARegularHereText",
        ),
        TEXT_SAFARIZONEGATE_SAFARI_ZONE_WORKER1: (_ow: any, save: any): ScriptRow[] =>
          save?.safari
            ? [["show_text", "_SafariZoneGateSafariZoneWorker1GoodLuckText"]] as ScriptRow[]
            : [["face_player"], ["show_text", "_SafariZoneGateSafariZoneWorker1Text"], ...safariJoinRows(true)] as ScriptRow[],
      },
      onStep: (ow: any, save: any) => {
        const x = ow?.player?.cellX;
        const y = ow?.player?.cellY;
        if (save?.safari) return y !== undefined && y <= 1 ? safariLeavingRows(x !== 3) : null;
        return SAFARI_JOIN_CELLS.some(([cx, cy]) => cx === x && cy === y) ? safariJoinRows(true) : null;
      },
    },
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
