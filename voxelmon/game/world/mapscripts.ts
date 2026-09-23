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
import type { Dir } from "./collision.ts";
import { coinClerkRows, coinGiftRows, prizeCounterRows } from "./gamecorner.ts";
import { floorsOf, seedExit } from "./elevator.ts";
import { SAFARI_JOIN_CELLS, safariJoinRows, safariLeavingRows } from "./safari.ts";
import { thirstyGirlRows, vendingRows } from "./vending.ts";
import { SAFFRON_GATES, saffronGateScript } from "./saffrongate.ts";

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
  /** Runs on every load of the map, the way a pokered map script's first
   * lines do (CinnabarIsland_Script resetting the fossil revival). */
  onEnter?: (ow: any, save: any) => void;
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
  /** 1-based roster. Every leader's gym team is their first EXCEPT Giovanni,
   * whose first two are the Rocket Hideout and Silph Co. */
  party?: number;
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
  /** Rows appended after the advice — Giovanni leaves the gym for good. */
  afterAdvice?: ScriptRow[];
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
    ["start_battle", "trainer", o.trainerClass, o.party ?? 1],
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
  for (const r of o.afterAdvice ?? []) rows.push(r);
  return rows;
}

/** EVENT_BEAT_<GYM>_TRAINER_0..n — the roster a leader's win deactivates. */
function gymTrainerFlags(prefix: string, last: number): string[] {
  return Array.from({ length: last + 1 }, (_, i) => `${prefix}${i}`);
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

/**
 * The static encounters (flavor/power_plant.lua ballMon + the legendaries):
 * the cry line, then -- unless already settled -- a wild battle, and on any
 * non-blackout end (win, catch, flee) the beat flag and the object is gone.
 */
function staticMon(
  map: string,
  object: string,
  text: string,
  species: string,
  level: number,
  flag: string,
): ScriptRow[] {
  return [
    ["show_text", text],
    ["check_flag", flag],
    ["jump_if_true", "end"],
    ["static_battle", species, level],
    ["jump_if_false", "end"],
    ["set_flag", flag],
    ["hide_object", map, object],
    ["label", "end"],
  ];
}

/** An in-game trader: face the player, then the trade verb. */
function tradeRows(index: number, flag: string): ScriptRow[] {
  return [["face_player"], ["trade", index, flag]];
}

// story6.lua E4_RESET_FLAGS: event_constants.asm INDIGO_PLATEAU_EVENTS_START
// .. EVENT_LANCES_ROOM_LOCK_DOOR, plus the port's run-scoped champion gate
// (EVENT_BEAT_CHAMPION_RIVAL itself stays set, like pokered's).
const E4_RESET_FLAGS = [
  "EVENT_BEAT_LORELEIS_ROOM_TRAINER_0",
  "EVENT_AUTOWALKED_INTO_LORELEIS_ROOM",
  "EVENT_BEAT_BRUNOS_ROOM_TRAINER_0",
  "EVENT_AUTOWALKED_INTO_BRUNOS_ROOM",
  "EVENT_BEAT_AGATHAS_ROOM_TRAINER_0",
  "EVENT_AUTOWALKED_INTO_AGATHAS_ROOM",
  "EVENT_BEAT_LANCES_ROOM_TRAINER_0",
  "EVENT_BEAT_LANCE",
  "EVENT_LANCES_ROOM_LOCK_DOOR",
  "EVENT_BEAT_CHAMPION_RIVAL_THIS_RUN",
];
/** The four's win records by object id (npc.ts `${map}_obj_${index}`). */
const E4_TRAINER_KEYS = [
  "LORELEIS_ROOM_obj_1",
  "BRUNOS_ROOM_obj_1",
  "AGATHAS_ROOM_obj_1",
  "LANCES_ROOM_obj_1",
];

// story2.lua FOSSIL_MONS / FOSSIL_ORDER (CinnabarLabFossilRoom.asm FossilsList)
const FOSSIL_MONS: Record<string, string> = {
  DOME_FOSSIL: "KABUTO",
  HELIX_FOSSIL: "OMANYTE",
  OLD_AMBER: "AERODACTYL",
};
const FOSSIL_ORDER = ["DOME_FOSSIL", "HELIX_FOSSIL", "OLD_AMBER"];

/**
 * story2.lua TEXT_CINNABARLABFOSSILROOM_SCIENTIST1: nothing deposited ->
 * offer each carried fossil (the ROM's fossil menu, asked one at a time in
 * FossilsList order); deposited -> "go for a walk" until the island has been
 * reloaded, then the revived mon at L30. A full party leaves it waiting
 * instead of losing it (GivePokemon's `jr nc`).
 */
function fossilScientistRows(ow: any, save: any): ScriptRow[] {
  const f = save?.flags ?? {};
  const data = ow?.data ?? ow?.shell?.data;
  const monName = (sp: string) => data?.pokemon?.[sp]?.name ?? sp;
  const itemName = (id: string) => data?.items?.[id]?.name ?? id;
  const L = "_CinnabarLabFossilRoomScientist1";

  if (f.EVENT_GAVE_FOSSIL_TO_LAB) {
    if (f.EVENT_LAB_STILL_REVIVING_FOSSIL) {
      return [["face_player"], ["show_text", `${L}GoForAWalkText`]];
    }
    const species: string | undefined = save.labFossilMon;
    const rows: ScriptRow[] = [["face_player"]];
    if (!species) {
      // an old save that deposited before the species was kept: nothing to
      // hand back, so let a new fossil in
      return [
        ...rows,
        ["clear_flag", "EVENT_GAVE_FOSSIL_TO_LAB"],
        ["show_text", `${L}Text`],
      ];
    }
    return [
      ...rows,
      ["show_text", `${L}FossilIsBackToLifeText`, { "RAM:wStringBuffer": monName(species) }],
      ["check_party_room"],
      ["jump_if_false", "full"],
      ["play_sound", "Get_Key_Item"],
      ["give_pokemon", species, 30],
      ["show_text", `{PLAYER} got\n${monName(species)}!`],
      ["lab_fossil"],
      ["clear_flag", "EVENT_GAVE_FOSSIL_TO_LAB"],
      ["clear_flag", "EVENT_LAB_STILL_REVIVING_FOSSIL"],
      ["jump", "end"],
      ["label", "full"],
      ["show_text", "You have no room\nfor it!\fCome back when\nyou do!"],
      ["label", "end"],
    ];
  }

  const carried = FOSSIL_ORDER.filter((id) => (save?.inventory?.[id] ?? 0) > 0);
  const rows: ScriptRow[] = [["face_player"], ["show_text", `${L}Text`]];
  if (carried.length === 0) return [...rows, ["show_text", `${L}NoFossilsText`]];
  carried.forEach((id, i) => {
    rows.push(
      [
        "ask",
        `${L}SeesFossilText`,
        { "RAM:wNameBuffer": itemName(id), "RAM:wStringBuffer": monName(FOSSIL_MONS[id]!) },
      ],
      ["jump_if_true", `give${i}`],
    );
  });
  rows.push(["show_text", `${L}ComeAgainText`], ["jump", "end"]);
  carried.forEach((id, i) => {
    rows.push(
      ["label", `give${i}`],
      ["take_item", id, 1],
      ["lab_fossil", FOSSIL_MONS[id]],
      ["set_flag", "EVENT_GAVE_FOSSIL_TO_LAB"],
      ["set_flag", "EVENT_LAB_STILL_REVIVING_FOSSIL"],
      ["show_text", `${L}TakesFossilText`, { "RAM:wNameBuffer": itemName(id) }],
      ["show_text", `${L}GoForAWalkText2`],
      ["jump", "end"],
    );
  });
  rows.push(["label", "end"]);
  return rows;
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

// story4.lua M.ROUTE_24 (scripts/Route24.asm): the Nugget Bridge recruiter,
// object index 1 — he has no trainer_headers entry (checked directly: he's
// the one gen1recomp cites as such, and the imported data agrees, unlike
// every other Route 24 trainer), so sight never engages him and his
// talkScript entry doubles as the forced onStep trigger below. Both YES and
// NO at the "join TEAM ROCKET?" ask lead to the same fight (pokered's own
// joke — there is no way out of this one), so the ask is flavour only, not
// a branch. give_item's own text carries {RAM:wStringBuffer} -> the item
// name, matching the reference's `("%s received\na NUGGET!"):format(...)`.
function route24RecruiterScript(_ow: any, save: any): ScriptRow[] {
  const f = (save as { flags?: Record<string, boolean> } | undefined)?.flags ?? {};
  const rows: ScriptRow[] = [];
  if (!f.EVENT_GOT_NUGGET) {
    rows.push(
      ["show_text", "Congratulations!\nYou beat our 5\ncontest trainers!\fYou just earned a\nfabulous prize!"],
      ["give_item", "NUGGET", 1, "{PLAYER} received\na NUGGET!"],
      ["set_flag", "EVENT_GOT_NUGGET"],
      ["ask", "By the way, would\nyou like to join\nTEAM ROCKET?"],
      ["show_text", "Arrgh! You are\nnot convinced?\fThen I'll show\nyou my power!"],
    );
  }
  rows.push(["engage_trainer", 1]);
  return rows;
}

// story5.lua M.CERULEAN_CITY ceruleanRivalScene: the Nugget Bridge rival
// ambush, fired by onStep below at the coord pair (CeruleanCityCoords2) just
// south of the Route 24 gate. move_npc_to pathfinds around the player itself
// (this port's moveNpcTo, unlike the walk-list the reference needs), so one
// call covers both of upstream's px==20/else exit-direction branches.
function ceruleanRivalRows(px: number): ScriptRow[] {
  return sceneWithTheme(MEET_RIVAL, [
    ["show_object", "CERULEAN_CITY", "CERULEANCITY_RIVAL"],
    ["move_npc_to", "CERULEANCITY_RIVAL", px, 5],
    ["face_object", "CERULEANCITY_RIVAL", "down"],
    ["show_text", "_CeruleanCityRivalPreBattleText"],
    ["rival_battle", "OPP_RIVAL1", 7],
    ["jump_if_false", "end"],
    ["set_flag", "EVENT_BEAT_CERULEAN_RIVAL"],
    ["show_text", "_CeruleanCityRivalDefeatedText"],
    ["show_text", "_CeruleanCityRivalIWentToBillsText"],
    ["move_npc_to", "CERULEANCITY_RIVAL", px, 12],
    ["hide_object", "CERULEAN_CITY", "CERULEANCITY_RIVAL"],
  ]);
}

// story5.lua rocketRows (scripts/CeruleanCity.asm CeruleanCityRocketText):
// the TM28 (DIG) thief blocking the mart-side path. CeruleanHideRocket's
// GUARD1/GUARD2 swap reconnects the city the same way Bill's ticket does —
// either route is enough, so this one alone doesn't need Bill's SS-ticket
// branch to also work.
const ceruleanRocketRows: ScriptRow[] = [
  ["face_player"],
  ["check_flag", "EVENT_GOT_TM28"],
  ["jump_if_true", "hide"],
  ["check_flag", "EVENT_BEAT_CERULEAN_ROCKET_THIEF"],
  ["jump_if_true", "retry_tm"],
  ["show_text", "_CeruleanCityRocketText"],
  ["start_battle", "trainer", "OPP_ROCKET", 5],
  ["jump_if_false", "end"],
  ["label", "retry_tm"],
  ["show_text", "_CeruleanCityRocketIllReturnTheTMText"],
  ["set_flag", "EVENT_BEAT_CERULEAN_ROCKET_THIEF"],
  ["give_item", "TM_DIG", 1, false],
  ["set_flag", "EVENT_GOT_TM28"],
  ["show_text", "_CeruleanCityRocketReceivedTM28Text"],
  ["show_text", "_CeruleanCityRocketIBetterGetMovingText"],
  ["label", "hide"],
  ["show_object", "CERULEAN_CITY", "CERULEANCITY_GUARD1"],
  ["hide_object", "CERULEAN_CITY", "CERULEANCITY_GUARD2"],
  ["hide_object", "CERULEAN_CITY", "CERULEANCITY_ROCKET"],
];

// gyms.lua leaderTalk + victories.lua OPP_MISTY#1 (scripts/CeruleanGym.asm
// CeruleanGymMistyText): Misty has no separate advice label, her repeat
// dialogue after the badge IS the TM11 explanation, so both `advice` and
// the last `tmText` line point at the same key (matches the reference's
// `leaderTalk(..., "_CeruleanGymMistyTM11ExplanationText", ...)`).
const MISTY_GYM = gymLeader({
  trainerClass: "OPP_MISTY",
  beatFlag: "EVENT_BEAT_MISTY",
  preText: "_CeruleanGymMistyPreBattleText",
  deactivate: ["EVENT_BEAT_CERULEAN_GYM_TRAINER_0", "EVENT_BEAT_CERULEAN_GYM_TRAINER_1"],
  badge: "CASCADEBADGE",
  badgeText: ["_CeruleanGymMistyReceivedCascadeBadgeText"],
  tmPre: "_CeruleanGymMistyCascadeBadgeInfoText",
  tm: "TM_BUBBLEBEAM",
  gotFlag: "EVENT_GOT_TM11",
  tmText: ["_CeruleanGymMistyReceivedTM11Text"],
  advice: "_CeruleanGymMistyTM11ExplanationText",
});

// story.lua M.BILLS_HOUSE (scripts/BillsHouse.asm): the cell-separation
// cutscene, compressed the same way the reference compresses it — into the
// dialogue rather than a real teleporter animation. moveNpcTo's pathfinder
// covers both of upstream's "player standing in the way" / "clear path"
// walk branches with one call, same as the Cerulean rival above.
const billsHousePokemonRows: ScriptRow[] = [
  ["ask", "_BillsHouseBillImNotAPokemonText"],
  ["jump_if_true", "toMachine"],
  ["show_text", "_BillsHouseBillNoYouGottaHelpText"],
  ["label", "toMachine"],
  ["show_text", "_BillsHouseBillUseSeparationSystemText"],
  ["move_npc_to", "BILLSHOUSE_BILL_POKEMON", 6, 2],
  ["hide_object", "BILLS_HOUSE", "BILLSHOUSE_BILL_POKEMON"],
  ["set_flag", "EVENT_BILL_SAID_USE_CELL_SEPARATOR"],
];

const billsHouseSsTicketRows: ScriptRow[] = [
  ["face_player"],
  ["check_flag", "EVENT_GOT_SS_TICKET"],
  ["jump_if_true", "repeat"],
  ["show_text", "_BillsHouseBillThankYouText"],
  ["give_item", "S_S_TICKET", 1, false],
  ["show_text", "_SSTicketReceivedText"],
  ["set_flag", "EVENT_GOT_SS_TICKET"],
  // The Cerulean guards are a swap pair, not scenery: (27,12) is the only
  // walkable neighbour of the trashed house's south door, one of just two
  // ways through the fence splitting the city in half (the TM28 Rocket
  // thief opens the other). Leaving GUARD2 up severs the city permanently.
  ["show_object", "CERULEAN_CITY", "CERULEANCITY_GUARD1"],
  ["hide_object", "CERULEAN_CITY", "CERULEANCITY_GUARD2"],
  ["show_text", "_BillsHouseBillWhyDontYouGoInsteadOfMeText"],
  ["jump", "end"],
  ["label", "repeat"],
  ["show_text", "_BillsHouseBillWhyDontYouGoInsteadOfMeText"],
];

const billsHouseRarePokemonRows: ScriptRow[] = [
  ["face_player"],
  ["show_text", "_BillsHouseBillCheckOutMyRarePokemonText"],
];

// OverworldController.lua:2248 billsHousePC (data/events/hidden_events.asm
// hidden_event 1,4 BillsHousePC): the separator machine's own PC, a hidden
// tile (not an NPC) at (1,4) facing up — wired into Overworld.interact()
// rather than sight/coord, same as the generic Pokémon Center PCs in
// pctiles.ts. Registered under a synthetic TEXT_* key (there's no real ROM
// text pointer for a hidden-event tile) purely so it can reuse showMapText/
// talkScript's existing script dispatch instead of a bespoke path.
// v1 simplification: the post-ticket Eevee-evolution showcase list
// (BillsHousePokemonList, a DexEntryMenu picker) needs a list-menu UI this
// port doesn't have yet, so that branch shows its own opening line as plain
// flavour text instead of opening a menu — an honest simplification, not a
// silent gap, matching how give_pokemon already treats the nickname prompt.
export const TEXT_BILLSHOUSE_PC = "TEXT_BILLSHOUSE_PC";
function billsHousePcScript(_ow: any, save: any): ScriptRow[] {
  const f = (save as { flags?: Record<string, boolean> } | undefined)?.flags ?? {};
  if (f.EVENT_LEFT_BILLS_HOUSE_AFTER_HELPING) {
    return [["show_text", "_BillsHousePokemonListText1"]];
  }
  if (f.EVENT_USED_CELL_SEPARATOR_ON_BILL || !f.EVENT_BILL_SAID_USE_CELL_SEPARATOR) {
    return [["show_text", "_BillsHouseMonitorText"]];
  }
  return [
    ["show_text", "_BillsHouseInitiatedText"],
    ["set_flag", "EVENT_USED_CELL_SEPARATOR_ON_BILL"],
    ["play_sound", "Switch"],
    ["wait", 32],
    ["play_sound", "Tink"],
    ["wait", 80],
    ["play_sound", "Shrink"],
    ["wait", 48],
    ["play_sound", "Tink"],
    ["wait", 32],
    ["play_sound", "Get_Item1"],
    ["wait", 30],
    ["show_object", "BILLS_HOUSE", "BILLSHOUSE_BILL1"],
    ["move_npc_to", "BILLSHOUSE_BILL1", 4, 4],
  ];
}

// gyms.lua leaderTalk + victories.lua OPP_LT_SURGE#1 (scripts/VermilionGym.asm
// VermilionGymLTSurgeText .got_tm24_already).
const LT_SURGE_GYM = gymLeader({
  trainerClass: "OPP_LT_SURGE",
  beatFlag: "EVENT_BEAT_LT_SURGE",
  preText: "_VermilionGymLTSurgePreBattleText",
  deactivate: [
    "EVENT_BEAT_VERMILION_GYM_TRAINER_0",
    "EVENT_BEAT_VERMILION_GYM_TRAINER_1",
    "EVENT_BEAT_VERMILION_GYM_TRAINER_2",
  ],
  badge: "THUNDERBADGE",
  badgeText: ["_VermilionGymLTSurgeReceivedThunderBadgeText"],
  tmPre: "_VermilionGymLTSurgeThunderBadgeInfoText",
  tm: "TM_THUNDERBOLT",
  gotFlag: "EVENT_GOT_TM24",
  tmText: ["_VermilionGymLTSurgeReceivedTM24Text", "_TM24ExplanationText"],
  advice: "_VermilionGymLTSurgePostBattleAdviceText",
});

// scripts/CeruleanTrashedHouse.asm CeruleanTrashedHouseFishingGuruText: pure
// flavor branching on whether the player still carries the stolen TM_DIG —
// no flags change either way.
const trashedHouseFishingGuruRows: ScriptRow[] = [
  ["check_item", "TM_DIG"],
  ["jump_if_true", "has_tm"],
  ["show_text", "_CeruleanTrashedHouseFishingGuruTheyStoleATMText"],
  ["jump", "end"],
  ["label", "has_tm"],
  ["show_text", "_CeruleanTrashedHouseFishingGuruWhatsLostIsLostText"],
];

// story.lua M.VERMILION_CITY (scripts/VermilionCity.asm
// VermilionCityDefaultScript's SSAnneTicketCheckCoords): the sailor guarding
// the dock gangway at (18,30). Faithfully ported as onStep (the per-frame
// coord check) with a matching talk entry for walking up and interacting
// directly — same dual-trigger shape as the Route 24 recruiter above. He
// never hides; once the ship has sailed he only reports it gone.
function vermilionSailorRows(save: any): ScriptRow[] {
  const f = (save as { flags?: Record<string, boolean> } | undefined)?.flags ?? {};
  if (f.EVENT_SS_ANNE_LEFT) {
    return [["show_text", "_VermilionCitySailor1ShipSetSailText"]];
  }
  return [
    ["show_text", "_VermilionCitySailor1DoYouHaveATicketText"],
    ["check_item", "S_S_TICKET"],
    ["jump_if_false", "no_ticket"],
    ["show_text", "_VermilionCitySailor1FlashedTicketText"],
    ["jump", "end"],
    ["label", "no_ticket"],
    ["show_text", "_VermilionCitySailor1YouNeedATicketText"],
  ];
}

/**
 * Every ROCKET and rocket-aligned SCIENTIST on Silph's floors, by the object
 * names data/maps/toggleable_objects.asm uses.
 *
 * SilphCo11FTeamRocketLeavesScript hides all of them the moment Giovanni
 * falls. The item balls, the rescued workers on 2F and 10F and the 7F rival
 * keep theirs.
 */
const SILPH_ROCKET_OBJECTS: [string, string[]][] = [
  ["SILPH_CO_2F", ["SILPHCO2F_SCIENTIST1", "SILPHCO2F_SCIENTIST2",
                   "SILPHCO2F_ROCKET1", "SILPHCO2F_ROCKET2"]],
  ["SILPH_CO_3F", ["SILPHCO3F_ROCKET", "SILPHCO3F_SCIENTIST"]],
  ["SILPH_CO_4F", ["SILPHCO4F_ROCKET1", "SILPHCO4F_SCIENTIST", "SILPHCO4F_ROCKET2"]],
  ["SILPH_CO_5F", ["SILPHCO5F_ROCKET1", "SILPHCO5F_SCIENTIST",
                   "SILPHCO5F_ROCKER", "SILPHCO5F_ROCKET2"]],
  ["SILPH_CO_6F", ["SILPHCO6F_ROCKET1", "SILPHCO6F_SCIENTIST", "SILPHCO6F_ROCKET2"]],
  ["SILPH_CO_7F", ["SILPHCO7F_ROCKET1", "SILPHCO7F_SCIENTIST",
                   "SILPHCO7F_ROCKET2", "SILPHCO7F_ROCKET3"]],
  ["SILPH_CO_8F", ["SILPHCO8F_ROCKET1", "SILPHCO8F_SCIENTIST", "SILPHCO8F_ROCKET2"]],
  ["SILPH_CO_9F", ["SILPHCO9F_ROCKET1", "SILPHCO9F_SCIENTIST", "SILPHCO9F_ROCKET2"]],
  ["SILPH_CO_10F", ["SILPHCO10F_ROCKET", "SILPHCO10F_SCIENTIST"]],
  ["SILPH_CO_11F", ["SILPHCO11F_ROCKET1", "SILPHCO11F_ROCKET2"]],
];

/** The nine grunts holding the Saffron streets, and the people they displaced. */
const SAFFRON_ROCKETS = [
  "SAFFRONCITY_ROCKET1", "SAFFRONCITY_ROCKET2", "SAFFRONCITY_ROCKET3",
  "SAFFRONCITY_ROCKET4", "SAFFRONCITY_ROCKET5", "SAFFRONCITY_ROCKET6",
  "SAFFRONCITY_ROCKET7", "SAFFRONCITY_ROCKET8", "SAFFRONCITY_ROCKET9",
];
const SAFFRON_CIVILIANS = [
  "SAFFRONCITY_SCIENTIST", "SAFFRONCITY_SILPH_WORKER_M",
  "SAFFRONCITY_SILPH_WORKER_F", "SAFFRONCITY_GENTLEMAN",
  "SAFFRONCITY_PIDGEOT", "SAFFRONCITY_ROCKER",
];

/**
 * SilphCo11FGiovanniAfterBattleScript: the speech, then every rocket in the
 * building and in the streets outside leaves, behind a fade so it does not
 * happen in front of the player.
 *
 * hide_object / show_object write save.objectToggles, which setMap replays
 * when a map is next entered -- so this single pass covers the floors and the
 * city the player is not standing on, and there is no onEnter hook needed for
 * any of it.
 */
export function silphAftermathRows(): ScriptRow[] {
  const rows: ScriptRow[] = [
    ["show_text", "_SilphCo11FGiovanniYouRuinedOurPlansText"],
    ["fade", "out"],
  ];
  for (const [map, names] of SILPH_ROCKET_OBJECTS) {
    for (const n of names) rows.push(["hide_object", map, n]);
  }
  rows.push(["hide_object", "SILPH_CO_11F", "SILPHCO11F_GIOVANNI"]);
  for (const n of SAFFRON_ROCKETS) rows.push(["hide_object", "SAFFRON_CITY", n]);
  for (const n of SAFFRON_CIVILIANS) rows.push(["show_object", "SAFFRON_CITY", n]);
  rows.push(["wait", 3]); // Delay3
  rows.push(["fade", "in"]);
  return rows;
}

/**
 * The seven badges Viridian Gym checks before it will open
 * (scripts/ViridianCity.asm: badges == ~EARTHBADGE).
 */
export const SEVEN_BADGES = [
  "BOULDERBADGE", "CASCADEBADGE", "THUNDERBADGE", "RAINBOWBADGE",
  "SOULBADGE", "MARSHBADGE", "VOLCANOBADGE",
];

/** True once all seven are in the bag. */
export function hasSevenBadges(save: any): boolean {
  const inv = save?.inventory ?? {};
  return SEVEN_BADGES.every((b) => (inv[b] ?? 0) > 0);
}

/**
 * A locked door you are shoved back off, the shape pokered gives both of
 * these (a coord script that prints and then walks the player one tile back).
 *
 * Returns the rows for the step, or null when the door is open or the player
 * is somewhere else.
 */
function lockedDoorStep(
  ow: any,
  at: [number, number][],
  locked: boolean,
  textId: string,
): ScriptRow[] | null {
  if (!locked) return null;
  const x = ow?.player?.cellX;
  const y = ow?.player?.cellY;
  if (!at.some(([dx, dy]) => dx === x && dy === y)) return null;
  return [["show_text", textId], ["move_player", "down", 1]];
}

/**
 * Route22Rival{1,2} (scripts/Route22.asm), the one scene both battles share.
 *
 * Route22MoveRivalRightScript walks him RIGHT along his own row from the spawn
 * at (25,5): four RIGHTs on coord index 1 (player on (29,4)) stop him BELOW
 * the player on (29,5); `inc de` drops one on index 2 (player on (29,5)),
 * stopping him LEFT of them on (28,5). He never leaves row 5.
 * Route22Rival{1,2}StartBattleScript then faces him UP on index 1, RIGHT
 * otherwise.
 *
 * `n` is 1 for the early ambush, 2 for the post-Giovanni rematch. Parties are
 * OPP_RIVAL1 base 4 and OPP_RIVAL2 base 10 (data/trainers/parties.asm);
 * rival_battle adds the starter counterpick offset itself.
 *
 * The numeric `jump_if_false 11` is route22Scene's own: a loss skips the
 * reward rows and lands on the hide, so he leaves either way.
 */
function route22Scene(n: 1 | 2, py: number): ScriptRow[] {
  const obj = `ROUTE22_RIVAL${n}`;
  const rx = py === 4 ? 29 : 28;
  const rivalFacing = py === 4 ? "up" : "right";
  // Route22Rival1ExitMovementData1/2: from (29,5) he cuts right then south;
  // from (28,5) he steps up onto row 4 first, then right and south.
  const exit =
    py === 4
      ? ["right", "right", "down", "down", "down", "down", "down"]
      : ["up", "right", "right", "right", "down", "down", "down", "down", "down", "down"];
  return sceneWithTheme(MEET_RIVAL, [
    ["show_object", "ROUTE_22", obj], //                        1
    ["move_npc_to", obj, rx, 5], //                             2
    ["face_object", obj, rivalFacing], //                       3
    ["show_text", `_Route22RivalBeforeBattleText${n}`], //      4
    // loseable on the first only: pokered's early ambush heals you and lets
    // you walk on; the rematch blacks you out like any other loss
    [
      "rival_battle",
      n === 1 ? "OPP_RIVAL1" : "OPP_RIVAL2",
      n === 1 ? 4 : 10,
      n === 1 ? { loseable: true } : {},
    ], //                                                       5
    ["jump_if_false", 11], //                                   6  loss -> hide
    [
      "set_flag",
      n === 1 ? "EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE" : "EVENT_BEAT_ROUTE22_RIVAL_2ND_BATTLE",
    ], //                                                       7
    ["show_text", `_Route22Rival${n}DefeatedText`], //          8
    ["show_text", `_Route22RivalAfterBattleText${n}`], //       9
    ["walk_npc", obj, exit], //                                10
    ["hide_object", "ROUTE_22", obj], //                       11
  ] as ScriptRow[]);
}

/**
 * PokemonTower2FDefeatedRivalScript's exit: which way he leaves depends on
 * which side of him you came up. EVENT_POKEMON_TOWER_RIVAL_ON_LEFT — the
 * (15,5) tile — takes DownThenRight, the other takes RightThenDown.
 */
const TOWER_RIVAL_EXIT_RIGHT_THEN_DOWN: Dir[] =
  ["right", "down", "down", "right", "down", "down", "right", "right"];
const TOWER_RIVAL_EXIT_DOWN_THEN_RIGHT: Dir[] =
  ["down", "down", "right", "right", "right", "right", "down", "down"];

/**
 * PokemonTower2F.asm: the rival stops you on the stairs landing on the way up
 * to Mr. Fuji. He does not wait to be spoken to — PokemonTower2FDefaultScript
 * fires on (15,5)/(14,6) — but talking to him afterwards still works, which is
 * why the same rows serve as his talk script.
 *
 * OPP_RIVAL2 party 4 is the Tower set (parties.asm). A loss halts at row 6, so
 * he is still standing there to try again; only a win walks him out.
 */
function towerRivalScript(playerX: number): ScriptRow[] {
  const exit =
    playerX === 15 ? TOWER_RIVAL_EXIT_DOWN_THEN_RIGHT : TOWER_RIVAL_EXIT_RIGHT_THEN_DOWN;
  return sceneWithTheme(MEET_RIVAL, [
    ["face_player"], //                                            1
    ["check_flag", "EVENT_BEAT_POKEMON_TOWER_RIVAL"], //           2
    ["jump_if_true", 12], //                                       3  beaten: just talk
    ["show_text", "_PokemonTower2FRivalWhatBringsYouHereText"], //  4
    ["rival_battle", "OPP_RIVAL2", 4], //                          5
    ["jump_if_false", "end"], //                                   6  loss: he stays
    ["set_flag", "EVENT_BEAT_POKEMON_TOWER_RIVAL"], //             7
    ["show_text", "_PokemonTower2FRivalDefeatedText"], //          8
    ["walk_npc", "POKEMONTOWER2F_RIVAL", exit], //                 9
    ["hide_object", "POKEMON_TOWER_2F", "POKEMONTOWER2F_RIVAL"], // 10
    ["jump", "end"], //                                           11
    ["show_text", "_PokemonTower2FRivalHowsYourDexText"], //      12
  ] as ScriptRow[]);
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

  // story4.lua M.MT_MOON_POKECENTER (scripts/MtMoonPokecenter.asm): the
  // MAGIKARP salesman, ¥500 for a level 5 one, once ever.
  //
  // pokered hands the fish to GivePokemon, which boxes it when the party is
  // full. This port has no POKéMON boxes yet, so a full party is refused
  // BEFORE the money moves -- paying ¥500 for nothing would be worse than
  // waiting until there is room.
  MT_MOON_POKECENTER: {
    talk: {
      TEXT_MTMOONPOKECENTER_MAGIKARP_SALESMAN: (_ow: any, save: any) => {
        if (save?.flags?.EVENT_BOUGHT_MAGIKARP) {
          // .alreadyBought: he is not taking it back
          return [
            ["show_text", "_MtMoonPokecenterMagikarpSalesmanNoRefundsText"],
          ] as ScriptRow[];
        }
        return [
          ["face_player"], //                                                  1
          ["ask", "_MtMoonPokecenterMagikarpSalesmanIGotADealText"], //        2
          ["jump_if_false", "no"], //                                          3
          ["check_money", MAGIKARP_PRICE], //                                  4
          ["jump_if_false", "broke"], //                                       5
          ["check_party_room"], //                                             6
          ["jump_if_false", "full"], //                                        7
          ["take_money", MAGIKARP_PRICE], //                                   8
          ["set_flag", "EVENT_BOUGHT_MAGIKARP"], //                            9
          // give_pokemon marks it owned and offers the nickname prompt, the
          // way every gift mon in the port does.
          ["give_pokemon", "MAGIKARP", 5], //                                 10
          ["jump", "end"], //                                                 11
          ["label", "no"], //                                                 12
          ["show_text", "_MtMoonPokecenterMagikarpSalesmanNoText"], //        13
          ["jump", "end"], //                                                 14
          ["label", "broke"], //                                              15
          ["show_text", "_MtMoonPokecenterMagikarpSalesmanNoMoneyText"], //   16
          ["jump", "end"], //                                                 17
          ["label", "full"], //                                               18
          ["show_text", "_BoxIsFullText"], //                                 19
        ] as ScriptRow[];
      },
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
  // object (setObjectHidden reveal).
  //
  // BOTH battles run through route22Scene now: the early ambush (Pokédex in
  // hand, Brock not yet beaten) and the rematch on the way to the League,
  // gated on EVENT_BEAT_GIOVANNI — the Viridian Gym win. They use different
  // objects (ROUTE22_RIVAL1/2) and different parties; the scene is the same.
  ROUTE_22: {
    onStep: (ow: any, save: any) => {
      const p = ow?.player;
      const x = p?.cellX;
      const y = p?.cellY;
      // inCoords({{29,4},{29,5}})
      if (!((x === 29 && y === 4) || (x === 29 && y === 5))) return null;
      const f = save?.flags ?? {};
      const first =
        f.EVENT_GOT_POKEDEX && !f.EVENT_BEAT_BROCK && !f.EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE;
      const second =
        !first && f.EVENT_BEAT_GIOVANNI && !f.EVENT_BEAT_ROUTE22_RIVAL_2ND_BATTLE;
      if (!first && !second) return null;
      // runAmbush side effects: face the rival; Music_MeetRival is a no-op here
      if (ow.player) ow.player.facing = y === 4 ? "down" : "left";
      return route22Scene(first ? 1 : 2, y);
    },
  },

  // scripts/Route12.asm / Route16.asm: the sleeping line, and only that.
  // Talking to a Snorlax with the POKé FLUTE in your bag does nothing in the
  // original either -- Route12DefaultScript special-cases
  // EVENT_FIGHT_ROUTE12_SNORLAX, and nothing but USING the flute sets it.
  // The waking itself is game.ts playPokeFlute (world/snorlax.ts).
  ROUTE_12: {
    talk: { TEXT_ROUTE12_SNORLAX: [["show_text", "_Route12SnorlaxText"]] as ScriptRow[] },
  },
  ROUTE_16: {
    talk: { TEXT_ROUTE16_SNORLAX: [["show_text", "_Route16Text7"]] as ScriptRow[] },
  },

  // scripts/Route16FlyHouse.asm: the brunette girl hands over HM02 FLY, the
  // only source of it in the game. Nothing gave it before, so FLY could not
  // be obtained at all.
  ROUTE_16_FLY_HOUSE: {
    talk: {
      TEXT_ROUTE16FLYHOUSE_BRUNETTE_GIRL: [
        ["face_player"], //                                            1
        ["check_flag", "EVENT_GOT_HM02"], //                           2
        ["jump_if_true", 9], //                                        3  already got: just the advice
        ["show_text", "_Route16FlyHouseBrunetteGirlText"], //          4
        ["give_item", "HM_FLY", 1, "_Route16FlyHouseBrunetteGirlReceivedHM02Text"], // 5
        ["set_flag", "EVENT_GOT_HM02"], //                             6
        ["show_text", "_Route16FlyHouseBrunetteGirlHM02ExplanationText"], // 7
        ["jump", "end"], //                                            8
        ["show_text", "_Route16FlyHouseBrunetteGirlHM02ExplanationText"], // 9
      ] as ScriptRow[],
    },
  },

  // flavor/power_plant.lua: Zapdos, and the item balls that are Voltorbs.
  POWER_PLANT: {
    talk: {
      TEXT_POWERPLANT_VOLTORB1: staticMon("POWER_PLANT", "POWERPLANT_VOLTORB1", "_PowerPlantVoltorbBattleText", "VOLTORB", 40, "EVENT_BEAT_POWER_PLANT_VOLTORB_0"),
      TEXT_POWERPLANT_VOLTORB2: staticMon("POWER_PLANT", "POWERPLANT_VOLTORB2", "_PowerPlantVoltorbBattleText", "VOLTORB", 40, "EVENT_BEAT_POWER_PLANT_VOLTORB_1"),
      TEXT_POWERPLANT_VOLTORB3: staticMon("POWER_PLANT", "POWERPLANT_VOLTORB3", "_PowerPlantVoltorbBattleText", "VOLTORB", 40, "EVENT_BEAT_POWER_PLANT_VOLTORB_2"),
      TEXT_POWERPLANT_ELECTRODE1: staticMon("POWER_PLANT", "POWERPLANT_ELECTRODE1", "_PowerPlantVoltorbBattleText", "ELECTRODE", 43, "EVENT_BEAT_POWER_PLANT_VOLTORB_3"),
      TEXT_POWERPLANT_VOLTORB4: staticMon("POWER_PLANT", "POWERPLANT_VOLTORB4", "_PowerPlantVoltorbBattleText", "VOLTORB", 40, "EVENT_BEAT_POWER_PLANT_VOLTORB_4"),
      TEXT_POWERPLANT_VOLTORB5: staticMon("POWER_PLANT", "POWERPLANT_VOLTORB5", "_PowerPlantVoltorbBattleText", "VOLTORB", 40, "EVENT_BEAT_POWER_PLANT_VOLTORB_5"),
      TEXT_POWERPLANT_ELECTRODE2: staticMon("POWER_PLANT", "POWERPLANT_ELECTRODE2", "_PowerPlantVoltorbBattleText", "ELECTRODE", 43, "EVENT_BEAT_POWER_PLANT_VOLTORB_6"),
      TEXT_POWERPLANT_VOLTORB6: staticMon("POWER_PLANT", "POWERPLANT_VOLTORB6", "_PowerPlantVoltorbBattleText", "VOLTORB", 40, "EVENT_BEAT_POWER_PLANT_VOLTORB_7"),
      TEXT_POWERPLANT_ZAPDOS: staticMon("POWER_PLANT", "POWERPLANT_ZAPDOS", "_PowerPlantZapdosBattleText", "ZAPDOS", 50, "EVENT_BEAT_ZAPDOS"),
    },
  },
  // flavor/seafoam_islands_b4f.lua
  SEAFOAM_ISLANDS_B4F: {
    talk: {
      TEXT_SEAFOAMISLANDSB4F_ARTICUNO: staticMon("SEAFOAM_ISLANDS_B4F", "SEAFOAMISLANDSB4F_ARTICUNO", "_SeafoamIslandsB4FArticunoBattleText", "ARTICUNO", 50, "EVENT_BEAT_ARTICUNO"),
    },
  },
  // flavor/victory_road_2f.lua
  VICTORY_ROAD_2F: {
    talk: {
      TEXT_VICTORYROAD2F_MOLTRES: staticMon("VICTORY_ROAD_2F", "VICTORYROAD2F_MOLTRES", "_VictoryRoad2FMoltresBattleText", "MOLTRES", 50, "EVENT_BEAT_MOLTRES"),
    },
  },
  // flavor/cerulean_cave_b1f.lua
  CERULEAN_CAVE_B1F: {
    talk: {
      TEXT_CERULEANCAVEB1F_MEWTWO: staticMon("CERULEAN_CAVE_B1F", "CERULEANCAVEB1F_MEWTWO", "_MewtwoBattleText", "MEWTWO", 70, "EVENT_BEAT_MEWTWO"),
    },
  },

  // story6.lua M.INDIGO_PLATEAU_LOBBY (scripts/IndigoPlateauLobby.asm): the
  // Elite Four rematch. Walking into the lobby after a run into the League
  // (BIT_STARTED_ELITE_4) clears every League event, so all four and the
  // Champion can be fought again. Old saves with no started flag derive it
  // from the run's own flags, as upstream does.
  INDIGO_PLATEAU_LOBBY: {
    onEnter: (_ow: any, save: any) => {
      const f = save?.flags;
      if (!f) return;
      let started = !!f.EVENT_STARTED_ELITE_4;
      if (!started) started = E4_RESET_FLAGS.some((flag) => f[flag]);
      if (!started) return;
      delete f.EVENT_STARTED_ELITE_4;
      for (const flag of E4_RESET_FLAGS) delete f[flag];
      for (const key of E4_TRAINER_KEYS) delete save.defeatedTrainers?.[key];
    },
  },

  /**
   * story4.lua M.LANCES_ROOM (scripts/LancesRoom.asm). Lance's room gates
   * its ENTRANCE rather than its exit, and the way in is a cutscene: coming
   * up the stairs from Agatha's puts the player on (24,16), and
   * LancesRoomDefaultScript's trigger there runs WalkToLance -- an auto-walk
   * that ends on the doorway cell (6,11), which then seals behind them.
   *
   * Vanilla's WalkToLance_RLEList (up 12 / left 12 / down 7 / left 6) walks
   * THROUGH the void the flat game never draws; a camera that follows the
   * player literally would pan across an empty upper chamber on the way.
   * Same landing cell, routed along the open floor corridor instead.
   */
  LANCES_ROOM: {
    onEnter: (ow: any, save: any) => {
      if (save?.flags?.EVENT_BEAT_LANCE) return;
      const p = ow?.player;
      // The warp from Agatha's lands ON the trigger, and a warp arrival is
      // not a step -- so the walk starts from the map load, the way
      // Lorelei's does.
      if (p?.cellX !== LANCE_STAIRS[0] || p?.cellY !== LANCE_STAIRS[1]) return;
      startLanceWalkIn(ow);
    },
    onStep: (ow: any, save: any) => {
      if (save?.flags?.EVENT_BEAT_LANCE) return null;
      const p = ow?.player;
      if (p?.cellX === LANCE_STAIRS[0] && p?.cellY === LANCE_STAIRS[1]) {
        startLanceWalkIn(ow);
      }
      return null;
    },
  },

  // story6.lua M.LORELEIS_ROOM: loading her room marks the run started.
  LORELEIS_ROOM: {
    onEnter: (_ow: any, save: any) => {
      if (save?.flags) save.flags.EVENT_STARTED_ELITE_4 = true;
    },
  },

  // story.lua M.CHAMPIONS_ROOM (scripts/ChampionsRoom.asm). The last fight and
  // the scene that follows it. Like the Viridian Mart parcel this runs off the
  // map's onStep rather than an onEnter the port does not have, so it opens on
  // the first step into the room instead of the instant the warp lands.
  //
  // ChampionsRoomRivalDefeatedScript re-displays the rival's text_asm, which
  // on the EVENT_BEAT_CHAMPION_RIVAL branch is the after-battle line; the
  // in-battle "defeated" line is the engine's own.
  //
  // Oak's entrance is Music_Cities1AlternateTempo in the original — a fade,
  // 100 frames, then Cities1 restarted at tempo 232. play_music is a no-op in
  // this port's audio slice, so the scene plays without it rather than with
  // the wrong theme.
  CHAMPIONS_ROOM: {
    onStep: (ow: any, save: any) => {
      const f = save?.flags ?? {};
      if (f.EVENT_BEAT_CHAMPION_RIVAL_THIS_RUN) return null;
      if (ow?.runner?.isRunning?.()) return null;
      return [
        // RivalEntrance_RLEMovement: he cuts you off before you reach him
        ["face_object", "CHAMPIONSROOM_RIVAL", "down"], //                 1
        ["show_text", "_ChampionsRoomRivalIntroText"], //                  2
        ["rival_battle", "OPP_RIVAL3", 1], //                             3
        ["jump_if_false", "end"], //                                       4  a loss ends it
        ["set_flag", "EVENT_BEAT_CHAMPION_RIVAL_THIS_RUN"], //             5
        ["set_flag", "EVENT_BEAT_CHAMPION_RIVAL"], //                      6
        ["show_text", "_ChampionsRoomRivalAfterBattleText"], //            7
        // ChampionsRoomOakArrivesScript
        ["show_text", "_ChampionsRoomOakText"], //                         8
        ["show_object", "CHAMPIONS_ROOM", "CHAMPIONSROOM_OAK"], //         9
        ["walk_npc", "CHAMPIONSROOM_OAK", ["up", "up", "up", "up", "up"]], // 10
        // OakCongratulatesPlayerScript: rival faces left, Oak faces down
        ["face_object", "CHAMPIONSROOM_RIVAL", "left"], //                11
        ["face_object", "CHAMPIONSROOM_OAK", "down"], //                  12
        ["show_text", "_ChampionsRoomOakCongratulatesPlayerText"], //     13
        // OakDisappointedWithRivalScript: Oak turns on the rival
        ["face_object", "CHAMPIONSROOM_OAK", "right"], //                 14
        ["show_text", "_ChampionsRoomOakDisappointedWithRivalText"], //   15
        // OakComeWithMeScript: back to the player, then out the north door
        ["face_object", "CHAMPIONSROOM_OAK", "down"], //                  16
        ["show_text", "_ChampionsRoomOakComeWithMeText"], //              17
        ["walk_npc", "CHAMPIONSROOM_OAK", ["up", "up"]], //               18
        ["hide_object", "CHAMPIONS_ROOM", "CHAMPIONSROOM_OAK"], //        19
        // ChampionsRoomPlayerFollowsOakScript, then the north warp. The
        // induction is the ROOM's job, not this script's, so hand it the
        // marker and let HALL_OF_FAME's own step pick it up.
        ["set_flag", "EVENT_HALL_OF_FAME_PENDING"], //                    20
        ["move_player", "up", 3], //                                      21
        ["warp", "HALL_OF_FAME", 4, 7, "up"], //                          22
      ] as ScriptRow[];
    },
  },

  // story.lua M.HALL_OF_FAME (scripts/HallOfFame.asm). The induction's entry
  // point is the ROOM: HallOfFameDefaultScript walks the player up into Oak,
  // HallOfFameOakCongratulationsScript turns them face to face and shows his
  // line, and HallOfFameResetEventsAndSaveScript runs predef HallOfFamePC.
  //
  // EVENT_HALL_OF_FAME_PENDING is the one-shot the Champion's Room sets and
  // this clears, so walking back in later does not replay the induction --
  // the room is still there to visit, it just does not crown you twice.
  HALL_OF_FAME: {
    onStep: (ow: any, save: any) => {
      if (!save?.flags?.EVENT_HALL_OF_FAME_PENDING) return null;
      if (ow?.runner?.isRunning?.()) return null;
      return [
        ["clear_flag", "EVENT_HALL_OF_FAME_PENDING"], //         1  before, not after:
        //                                                          record_hall_of_fame
        //                                                          warps away and never
        //                                                          comes back to row 5
        ["move_player", "up", 5], //                             2  (4,7) -> (4,2), beside Oak
        ["face_object", "HALLOFFAME_OAK", "left"], //            3
        ["show_text", "_HallOfFameOakText"], //                  4
        ["record_hall_of_fame"], //                              5  induction, credits, home
      ] as ScriptRow[];
    },
  },

  // story.lua M.POKEMON_TOWER_2F (scripts/PokemonTower2F.asm). He is a coord
  // trigger, not a doorstop: walking onto the landing starts it.
  POKEMON_TOWER_2F: {
    talk: {
      TEXT_POKEMONTOWER2F_RIVAL: (ow: any) => towerRivalScript(ow?.player?.cellX ?? 0),
    },
    onStep: (ow: any, save: any) => {
      if (save?.flags?.EVENT_BEAT_POKEMON_TOWER_RIVAL) return null;
      const p = ow?.player;
      const x = p?.cellX;
      const y = p?.cellY;
      // PokemonTower2FDefaultScript's ArePlayerCoordsInArray
      if (!((x === 15 && y === 5) || (x === 14 && y === 6))) return null;
      // runAmbush's side effect: turn to face him as he rounds on you.
      if (p) p.facing = x === 15 ? "left" : "up";
      return towerRivalScript(x);
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

  // data/scripts/story.lua M.VIRIDIAN_CITY (scripts/ViridianCity.asm): the two
  // old men. The GAMBLER_ASLEEP at (18,9) only ever grumbles and shoves you
  // back down; the coffee ask + catch tutorial belong to the walking GAMBLER
  // at (17,5), swapped in by the Pokédex (data/scripts/oaks_lab.lua), not by
  // talking to either. The north corridor is gated on EVENT_GOT_POKEDEX.
  VIRIDIAN_CITY: {
    talk: {
      // story5.lua TEXT_VIRIDIANCITY_FISHER (scripts/ViridianCity.asm): the
      // dozing fisher's TM42 DREAM EATER. His YouCanHaveThis label has no
      // leading underscore in the ROM and sits outside the extractor's
      // symbol set, so the line rides along as a literal, as the reference
      // carries it too.
      TEXT_VIRIDIANCITY_FISHER: giftRows({
        flag: "EVENT_GOT_TM42",
        item: "TM_DREAM_EATER",
        pre:
          "Yawn!\nI must have dozed\voff in the sun." +
          "\fI had this dream\nabout a DROWZEE\veating my dream." +
          "\vWhat's this?\vWhere did this TM\vcome from?" +
          "\fThis is spooky!\nHere, you can\vhave this TM.",
        received: "_ViridianCityFisherReceivedTM42Text",
        explain: "_ViridianCityFisherTM42ExplanationText",
        already: "_ViridianCityFisherTM42ExplanationText",
      }),
      // flavor/viridian_city.lua TEXT_VIRIDIANCITY_GAMBLER1: he wonders who
      // the leader is until the seventh badge is in, then reports that the
      // leader is back -- and goes back to wondering once Giovanni is beaten
      // and the gym is empty again.
      TEXT_VIRIDIANCITY_GAMBLER1: (_ow: any, save: any): ScriptRow[] => [
        ["face_player"],
        [
          "show_text",
          hasSevenBadges(save) && !save?.flags?.EVENT_BEAT_GIOVANNI
            ? "_ViridianCityGambler1GymLeaderReturnedText"
            : "_ViridianCityGambler1GymAlwaysClosedText",
        ],
      ],
      // story.lua TEXT_VIRIDIANCITY_OLD_MAN_SLEEPY: grumble, then shove the
      // player one tile south. He never wakes, moves or hides.
      TEXT_VIRIDIANCITY_OLD_MAN_SLEEPY: [
        ["show_text", "_ViridianCityOldManSleepyPrivatePropertyText"], // 1
        ["move_player", "down", 1], //                                    2
      ],
      // story.lua TEXT_VIRIDIANCITY_OLD_MAN (the walker, shown once the
      // Pokédex swaps him in). "Are you in a hurry?" — YES (jump 8) brushes
      // you off with TimeIsMoney; NO leads into the catch tutorial: explain,
      // demo a catch on a wild WEEDLE (old_man_demo, BATTLE_TYPE_OLD_MAN),
      // then the YouNeedToWeakenTheTarget comment AFTER the demo
      // (ViridianCityOldManEndCatchTrainingScript), row 9 = end.
      TEXT_VIRIDIANCITY_OLD_MAN: [
        ["face_player"], //                                                 1
        ["ask", "_ViridianCityOldManHadMyCoffeeNowText"], //                2
        ["jump_if_true", 8], //                                             3 (yes = in a hurry)
        ["show_text", "_ViridianCityOldManKnowHowToCatchPokemonText"], //   4
        ["old_man_demo"], //                                                5
        ["show_text", "_ViridianCityOldManYouNeedToWeakenTheTargetText"], //6
        ["jump", 9], //                                                     7
        ["show_text", "_ViridianCityOldManTimeIsMoneyText"], //             8 (9 = end)
      ],
    },
    // story.lua VIRIDIAN_CITY.onEnter (#234) folded into onStep (the port has
    // no onEnter dispatch, the same adaptation VIRIDIAN_MART/OAKS_LAB use):
    // OaksLabOakGivesPokedexScript sets EVENT_GOT_POKEDEX and, with no branch
    // between, HideObject TOGGLE_LYING_OLD_MAN + ShowObject TOGGLE_OLD_MAN, so
    // the one flag settles both toggles. Re-deriving it on entry fixes a save
    // that holds the flag but was never standing here when it fired (an
    // imported .sav, whose codec leaves objectToggles empty). Side effect
    // only — returns null so the north-corridor block below still runs.
    onStep: (ow: any, save: any) => {
      // story5.lua chains the gym lock ahead of the sleeper logic, because
      // the registry keeps one onStep per map. VIRIDIAN GYM stays shut until
      // the other seven badges are in (scripts/ViridianCity.asm).
      const gym = lockedDoorStep(
        ow,
        [[32, 8]],
        !hasSevenBadges(save),
        "_ViridianCityGymLockedText",
      );
      if (gym) return gym;
      const f = save?.flags ?? {};
      if (f.EVENT_GOT_POKEDEX) {
        const w = ow as any;
        const s = w.save as { objectToggles?: Record<string, Record<string, boolean>> };
        s.objectToggles = s.objectToggles ?? {};
        const t = (s.objectToggles.VIRIDIAN_CITY = s.objectToggles.VIRIDIAN_CITY ?? {});
        if (t.VIRIDIANCITY_OLD_MAN_SLEEPY !== false || t.VIRIDIANCITY_OLD_MAN !== true) {
          t.VIRIDIANCITY_OLD_MAN_SLEEPY = false; // hidden
          t.VIRIDIANCITY_OLD_MAN = true; //        shown
          w.setObjectHidden?.("VIRIDIANCITY_OLD_MAN_SLEEPY", true);
          w.setObjectHidden?.("VIRIDIANCITY_OLD_MAN", false);
        }
        return null;
      }
      // ViridianCityCheckGotPokedexScript: without the Pokédex the block fires
      // on exactly (19,9) — the gap east of the sleeper (18,9) that leads
      // north — printing the private-property line and shoving you back down.
      const px = ow?.player?.cellX;
      const py = ow?.player?.cellY;
      if (px === 19 && py === 9) {
        return [
          ["show_text", "_ViridianCityOldManSleepyPrivatePropertyText"],
          ["move_player", "down", 1],
        ] as ScriptRow[];
      }
      return null;
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
      return sceneWithTheme(MEET_RIVAL, [
        ["move_npc_to", "SPRITE_BLUE", px, 10],
        ["face_object", "SPRITE_BLUE", "up"],
        ["show_text", "_OaksLabRivalIllTakeYouOnText"],
        ["start_battle", "trainer", "OPP_RIVAL1", party, { loseable: true }],
        ["set_flag", "EVENT_BATTLED_RIVAL_IN_OAKS_LAB"],
        ["show_text", "_OaksLabRivalSmellYouLaterText"],
        // He leaves through the lab door (warps at 4,11 / 5,11).
        ["move_npc_to", "SPRITE_BLUE", 4, 11],
        ["hide_object", "OAKS_LAB", "SPRITE_BLUE"],
      ] as ScriptRow[]);
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
  // story.lua M.BLUES_HOUSE (scripts/BluesHouse.asm BluesHouseDaisySittingText):
  // Blue's sister hands over the TOWN MAP once Oak has sent you on the errand
  // — which is EVENT_GOT_STARTER, the flag that gates every "run along now"
  // line in Pallet. Before that she only mentions where her brother is; after,
  // she repeats the "use the TOWN MAP" line forever.
  //
  // give_item halts the script on a full bag (pokered's `jr nc, .bag_full`),
  // so the set_flag below it cannot burn the gift.
  BLUES_HOUSE: {
    talk: {
      TEXT_BLUESHOUSE_DAISY_SITTING: [
        ["face_player"], //                                       1
        ["check_flag", "EVENT_GOT_TOWN_MAP"], //                   2
        ["jump_if_true", 10], //                                   3
        ["check_flag", "EVENT_GOT_STARTER"], //                    4
        ["jump_if_false", 12], //                                  5
        ["show_text", "_BluesHouseDaisyOfferMapText"], //           6
        // _GotMapText is "{PLAYER} got a\n{RAM:wStringBuffer}!" — give_item
        // fills the buffer slot with the item's name, as pokered does.
        ["give_item", "TOWN_MAP", 1, "_GotMapText"], //             7
        ["set_flag", "EVENT_GOT_TOWN_MAP"], //                      8
        ["jump", "end"], //                                         9
        ["show_text", "_BluesHouseDaisyUseMapText"], //            10
        ["jump", "end"], //                                        11
        ["show_text", "_BluesHouseDaisyRivalAtLabText"], //        12
      ],
    },
  },

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

  // story2.lua's four Saffron gates (scripts/Route5Gate.asm and siblings):
  // each guard is thirsty, and one drink opens all four.
  ROUTE_5_GATE: saffronGateScript(SAFFRON_GATES.ROUTE_5_GATE!),
  ROUTE_6_GATE: saffronGateScript(SAFFRON_GATES.ROUTE_6_GATE!),
  ROUTE_7_GATE: saffronGateScript(SAFFRON_GATES.ROUTE_7_GATE!),
  ROUTE_8_GATE: saffronGateScript(SAFFRON_GATES.ROUTE_8_GATE!),

  // safari.lua M.SAFARI_ZONE_GATE (scripts/SafariZoneGate.asm). The worker
  // is both a talk entry and a coord trigger: stepping onto the two cells in
  // front of him arms the join prompt, which is what stops a player walking
  // straight through to the north warps without paying.
  //
  // Coming BACK through those warps mid-game is the "Leaving early?" prompt.
  // The port has no onEnter hook, so it rides the same onStep the join does —
  // the arriving warp lands the player on row 0 or 1, above the trigger cells,
  // and a game already being open is what tells the two apart.
  SAFARI_ZONE_GATE: {
    talk: {
      TEXT_SAFARIZONEGATE_SAFARI_ZONE_WORKER1: (_ow: any, save: any) => {
        if (save?.safari) {
          return [["show_text", "_SafariZoneGateSafariZoneWorker1GoodLuckText"]] as ScriptRow[];
        }
        return [
          ["face_player"],
          ["show_text", "_SafariZoneGateSafariZoneWorker1Text"],
          ...safariJoinRows(),
        ] as ScriptRow[];
      },
    },
    onStep: (ow: any, save: any) => {
      const p = ow?.player;
      const x = p?.cellX;
      const y = p?.cellY;
      if (save?.safari) {
        // Back from the zone. The original hangs this on map ENTRY; this port
        // has no onEnter, so it lands on the first step after the arrival —
        // one step later, still before the player can reach the counter.
        return y !== undefined && y <= 1 ? safariLeavingRows(x !== 3) : null;
      }
      const at = SAFARI_JOIN_CELLS.some(([cx, cy]) => cx === x && cy === y);
      return at ? safariJoinRows() : null;
    },
  },

  // scripts/CeruleanGym.asm + victories.lua OPP_MISTY#1 (via gymLeader).
  CERULEAN_GYM: {
    talk: {
      TEXT_CERULEANGYM_MISTY: MISTY_GYM,
    },
  },

  // The remaining five leaders, same shape: scripts/<City>Gym.asm for the
  // dialogue, data/scripts/victories.lua for the badge/TM reward and the
  // gym-trainer flags the win deactivates.
  //
  // Their pre-battle labels do NOT follow one naming pattern — Koga's is
  // ...BeforeBattleText and Sabrina's is just _SaffronGymSabrinaText — so
  // each is the label the text table actually carries, not a guess.
  CELADON_GYM: {
    talk: {
      TEXT_CELADONGYM_ERIKA: gymLeader({
        trainerClass: "OPP_ERIKA",
        beatFlag: "EVENT_BEAT_ERIKA",
        preText: "_CeladonGymErikaPreBattleText",
        deactivate: gymTrainerFlags("EVENT_BEAT_CELADON_GYM_TRAINER_", 6),
        badge: "RAINBOWBADGE",
        badgeText: ["_CeladonGymErikaReceivedRainbowBadgeText"],
        tmPre: "_CeladonGymRainbowBadgeInfoText",
        tm: "TM_MEGA_DRAIN",
        gotFlag: "EVENT_GOT_TM21",
        tmText: ["_CeladonGymReceivedTM21Text", "_TM21ExplanationText"],
        advice: "_CeladonGymErikaPostBattleAdviceText",
      }),
    },
  },

  FUCHSIA_GYM: {
    talk: {
      TEXT_FUCHSIAGYM_KOGA: gymLeader({
        trainerClass: "OPP_KOGA",
        beatFlag: "EVENT_BEAT_KOGA",
        preText: "_FuchsiaGymKogaBeforeBattleText",
        deactivate: gymTrainerFlags("EVENT_BEAT_FUCHSIA_GYM_TRAINER_", 5),
        badge: "SOULBADGE",
        badgeText: ["_FuchsiaGymKogaReceivedSoulBadgeText"],
        tmPre: "_FuchsiaGymKogaSoulBadgeInfoText",
        tm: "TM_TOXIC",
        gotFlag: "EVENT_GOT_TM06",
        tmText: ["_FuchsiaGymKogaReceivedTM06Text", "_FuchsiaGymKogaTM06ExplanationText"],
        advice: "_FuchsiaGymKogaPostBattleAdviceText",
      }),
    },
  },

  SAFFRON_GYM: {
    talk: {
      TEXT_SAFFRONGYM_SABRINA: gymLeader({
        trainerClass: "OPP_SABRINA",
        beatFlag: "EVENT_BEAT_SABRINA",
        preText: "_SaffronGymSabrinaText",
        deactivate: gymTrainerFlags("EVENT_BEAT_SAFFRON_GYM_TRAINER_", 6),
        badge: "MARSHBADGE",
        badgeText: ["_SaffronGymSabrinaReceivedMarshBadgeText"],
        tmPre: "_SaffronGymSabrinaMarshBadgeInfoText",
        tm: "TM_PSYWAVE",
        gotFlag: "EVENT_GOT_TM46",
        tmText: ["_SaffronGymSabrinaReceivedTM46Text", "_TM46ExplanationText"],
        advice: "_SaffronGymSabrinaPostBattleAdviceText",
      }),
    },
  },

  CINNABAR_GYM: {
    talk: {
      TEXT_CINNABARGYM_BLAINE: gymLeader({
        trainerClass: "OPP_BLAINE",
        beatFlag: "EVENT_BEAT_BLAINE",
        preText: "_CinnabarGymBlainePreBattleText",
        deactivate: gymTrainerFlags("EVENT_BEAT_CINNABAR_GYM_TRAINER_", 6),
        badge: "VOLCANOBADGE",
        badgeText: ["_CinnabarGymBlaineReceivedVolcanoBadgeText"],
        tmPre: "_CinnabarGymBlaineVolcanoBadgeInfoText",
        tm: "TM_FIRE_BLAST",
        gotFlag: "EVENT_GOT_TM38",
        tmText: ["_CinnabarGymBlaineReceivedTM38Text", "_CinnabarGymBlaineTM38ExplanationText"],
        advice: "_CinnabarGymBlainePostBattleAdviceText",
      }),
    },
  },

  // Giovanni is the exception twice over: his gym team is his THIRD roster
  // (the first two are the Rocket Hideout and Silph Co.), and once he has
  // said his farewell he leaves the gym for good — the original fades out,
  // HideObjects him, and fades back. This port has no fade primitive for a
  // talk script, so he simply goes; the objectToggles entry persists, so he
  // stays gone across re-entry.
  VIRIDIAN_GYM: {
    talk: {
      TEXT_VIRIDIANGYM_GIOVANNI: gymLeader({
        trainerClass: "OPP_GIOVANNI",
        party: 3,
        beatFlag: "EVENT_BEAT_GIOVANNI",
        preText: "_ViridianGymGiovanniPreBattleText",
        deactivate: gymTrainerFlags("EVENT_BEAT_VIRIDIAN_GYM_TRAINER_", 7),
        badge: "EARTHBADGE",
        badgeText: ["_ViridianGymGiovanniReceivedEarthBadgeText"],
        tmPre: "_ViridianGymGiovanniEarthBadgeInfoText",
        tm: "TM_FISSURE",
        gotFlag: "EVENT_GOT_TM27",
        tmText: [
          "_ViridianGymGiovanniReceivedTM27Text",
          "_ViridianGymGiovanniTM27ExplanationText",
        ],
        advice: "_ViridianGymGiovanniPostBattleAdviceText",
        afterAdvice: [["hide_object", "VIRIDIAN_GYM", "VIRIDIANGYM_GIOVANNI"]],
      }),
    },
  },

  // story4.lua M.ROUTE_24: the Nugget Bridge recruiter (route24RecruiterScript
  // above) is both the talk entry AND, since he has no trainer_headers sight
  // range, the forced onStep trigger for the one tile in front of him
  // (Route24DefaultScript's dbmapcoord 10,15) while EVENT_GOT_NUGGET is unset.
  ROUTE_24: {
    talk: {
      TEXT_ROUTE24_COOLTRAINER_M1: route24RecruiterScript,
    },
    onStep: (ow: any, save: any) => {
      const f = save?.flags ?? {};
      if (f.EVENT_GOT_NUGGET) return null;
      const p = ow?.player;
      if (p?.cellX !== 10 || p?.cellY !== 15) return null;
      return route24RecruiterScript(ow, save);
    },
  },

  // story5.lua M.CERULEAN_CITY: the Nugget Bridge rival ambush
  // (CeruleanCityCoords2) and the TM28 Rocket thief (Coords1), both onStep
  // land-triggers gated on their own beat flags so they fire once.
  CERULEAN_CITY: {
    talk: {
      TEXT_CERULEANCITY_ROCKET: ceruleanRocketRows,
    },
    onStep: (ow: any, save: any) => {
      const f = save?.flags ?? {};
      const p = ow?.player;
      const x = p?.cellX;
      const y = p?.cellY;
      if (!f.EVENT_BEAT_CERULEAN_ROCKET_THIEF && ((x === 30 && y === 7) || (x === 30 && y === 9))) {
        return ceruleanRocketRows;
      }
      if (!f.EVENT_BEAT_CERULEAN_RIVAL && ((x === 20 && y === 6) || (x === 21 && y === 6))) {
        return ceruleanRivalRows(x);
      }
      return null;
    },
  },

  // story.lua M.BILLS_HOUSE: the cell-separation cutscene (Bill-as-Pokémon
  // asks for the PC, the PC itself does the separation, human Bill hands
  // over the SS Ticket).
  BILLS_HOUSE: {
    talk: {
      TEXT_BILLSHOUSE_BILL_POKEMON: billsHousePokemonRows,
      TEXT_BILLSHOUSE_BILL_SS_TICKET: billsHouseSsTicketRows,
      TEXT_BILLSHOUSE_BILL_CHECK_OUT_MY_RARE_POKEMON: billsHouseRarePokemonRows,
      [TEXT_BILLSHOUSE_PC]: billsHousePcScript,
    },
  },

  // story.lua M.ROUTE_25 Route25ToggleBillsScript: leaving after the SS
  // Ticket arms the post-quest Bill NPC (BILL2) and retires the Nugget
  // Bridge recruiter for good, same as pokered's TOGGLE_NUGGET_BRIDGE_GUY.
  // MapScript has no onEnter hook, so this rides onStep instead (the same
  // mechanism PEWTER_CITY's guide-block already uses); the flag guard makes
  // it a one-time, idempotent side effect rather than a script, so firing on
  // the player's first step on the route (instead of the instant they walk
  // in) is the only difference from the reference, and an imperceptible one.
  ROUTE_25: {
    onStep: (ow: any, save: any) => {
      const f = save?.flags ?? {};
      if (!f.EVENT_GOT_SS_TICKET || f.EVENT_LEFT_BILLS_HOUSE_AFTER_HELPING) return null;
      f.EVENT_LEFT_BILLS_HOUSE_AFTER_HELPING = true;
      ow.setObjectHidden?.("ROUTE24_COOLTRAINER_M1", true);
      ow.setObjectHidden?.("BILLSHOUSE_BILL1", true);
      ow.setObjectHidden?.("BILLSHOUSE_BILL2", false);
      return null;
    },
  },

  // scripts/CeruleanTrashedHouse.asm: the Fishing Guru whose TM the Rocket
  // thief stole — pure flavor, no flags.
  CERULEAN_TRASHED_HOUSE: {
    talk: {
      TEXT_CERULEANTRASHEDHOUSE_FISHING_GURU: trashedHouseFishingGuruRows,
    },
  },

  // scripts/VermilionGym.asm + victories.lua OPP_LT_SURGE#1 (via gymLeader).
  VERMILION_GYM: {
    talk: {
      TEXT_VERMILIONGYM_LT_SURGE: LT_SURGE_GYM,
    },
  },

  // story.lua M.VERMILION_CITY: the sailor guarding the S.S. Anne gangway
  // (vermilionSailorRows above), both as the forced onStep at his coord
  // (18,30) facing down and as the ordinary talk entry.
  VERMILION_CITY: {
    talk: {
      TEXT_VERMILIONCITY_SAILOR1: (_ow: any, save: any) => vermilionSailorRows(save),
    },
    onStep: (ow: any, save: any) => {
      const p = ow?.player;
      if (p?.cellX !== 18 || p?.cellY !== 30 || p?.facing !== "down") return null;
      return vermilionSailorRows(save);
    },
  },

  // story3.lua M.VERMILION_DOCK (scripts/VermilionDock.asm
  // VermilionDockSSAnneLeavesScript): stepping off the ship (cellY 2) with
  // HM01 in hand sends her off. The reference slides the ship's hull BLOCKS
  // west column by column, live-editing the cooked map mesh — this engine
  // bakes geometry at cook time with no runtime rewrite path, and the
  // per-tile mesher every map shares is the wrong place to carve a one-map
  // exception into. Instead, voxelmon/cook/mesh.ts post-processes just this
  // map's FINISHED quad list (an isolated, additive step — nothing upstream
  // changed, no other map's cook output touched) and splits the hull's 8x3
  // cell footprint into 24 individual stamps, the exact mechanism cut trees
  // already use. hideHullColumn below turns 6 of them off at a time (2 cells
  // wide, all 3 rows), bow to stern, so the ship genuinely recedes column by
  // column — real animation, not a fade — just without the reference's
  // sub-tile pixel slide. A safety net covers landing here after she's
  // already left, though in practice the sailor's onStep in VERMILION_CITY
  // already blocks that approach before it's reachable.
  VERMILION_DOCK: {
    onStep: (ow: any, save: any) => {
      const f = save?.flags ?? {};
      const p = ow?.player;
      const mapId = ow?.map?.def?.index;
      if (f.EVENT_SS_ANNE_LEFT) {
        return [
          ["show_text", "_VermilionCitySailor1ShipSetSailText"],
          ["warp", "VERMILION_CITY", 18, 31, "up"],
        ];
      }
      if (f.EVENT_GOT_HM01 && p?.cellY === 2 && typeof mapId === "number") {
        // Hull footprint (voxelmon/cook/mesh.ts VERMILION_DOCK special case):
        // cellX 10-17, cellY 3-5 — 4 columns of 2 cells, bow (10-11) first.
        const hideHullColumn = (cx0: number): ScriptRow[] => {
          const rows: ScriptRow[] = [];
          for (let cx = cx0; cx < cx0 + 2; cx++) {
            for (let cy = 3; cy <= 5; cy++) rows.push(["stamp", mapId, cx, cy, false]);
          }
          rows.push(["wait", 20]);
          return rows;
        };
        return [
          ["set_flag", "EVENT_SS_ANNE_LEFT"],
          ["play_sound", "SS_Anne_Horn"],
          ["wait", 40],
          ...hideHullColumn(10),
          ...hideHullColumn(12),
          ...hideHullColumn(14),
          ...hideHullColumn(16),
          ["play_sound", "SS_Anne_Horn"],
          ["wait", 60],
          ["warp", "VERMILION_CITY", 18, 31, "up"],
        ];
      }
      return null;
    },
  },

  // story5.lua M.SS_ANNE_2F (scripts/SSAnne2F.asm): the rival ambush in the
  // corridor outside the captain's cabin, at the coord pair (36,8)/(37,8).
  //
  // This was a talk script, on the assumption he stands there to be spoken
  // to. He does not: SSANNE2F_RIVAL is `hidden` in the map data, exactly like
  // the Cerulean and Route 22 rivals, so nothing was ever on screen to talk
  // to and the battle could not happen at all. show_object is what puts him
  // there, which only the coord trigger does.
  //
  // His exit is keyed on the PLAYER's column, not on where he stopped
  // (SSAnne2FRivalAfterBattleScript): from (37,8) he stands below the player
  // and walks straight down out of the room; from (36,8) he stands above and
  // takes .RivalWalkAroundPlayerMovement, which steps RIGHT first and then
  // falls through into the same four downs — five downs in all.
  SS_ANNE_2F: {
    onStep: (ow: any, save: any) => {
      if (save?.flags?.EVENT_BEAT_SS_ANNE_RIVAL) return null;
      const p = ow?.player;
      const x = p?.cellX;
      const y = p?.cellY;
      if (y !== 8 || (x !== 36 && x !== 37)) return null;
      const onLeft = x === 36;
      // runAmbush's side effect: turn to face him as he arrives.
      if (p) p.facing = onLeft ? "up" : "left";
      return sceneWithTheme(MEET_RIVAL, [
        ["show_object", "SS_ANNE_2F", "SSANNE2F_RIVAL"], //        1
        ["move_npc_to", "SSANNE2F_RIVAL", 36, onLeft ? 7 : 8], //  2
        ["face_object", "SSANNE2F_RIVAL", onLeft ? "down" : "right"], // 3
        ["show_text", "_SSAnne2FRivalText"], //                    4
        ["rival_battle", "OPP_RIVAL2", 1], //                      5
        ["jump_if_false", 11], //                                  6  loss -> hide
        ["set_flag", "EVENT_BEAT_SS_ANNE_RIVAL"], //               7
        ["show_text", "_SSAnne2FRivalDefeatedText"], //            8
        ["show_text", "_SSAnne2FRivalCutMasterText"], //           9
        [
          "walk_npc",
          "SSANNE2F_RIVAL",
          onLeft
            ? ["right", "down", "down", "down", "down", "down"]
            : ["down", "down", "down", "down"],
        ], //                                                     10
        ["hide_object", "SS_ANNE_2F", "SSANNE2F_RIVAL"], //       11
      ] as ScriptRow[]);
    },
  },

  // story3.lua M.GAME_CORNER_PRIZE_ROOM (engine/events/prize_menu.asm
  // CeladonPrizeMenu): three counters, one window of three prizes each.
  // They are SIGN texts, not objects — the counters are bg events.
  GAME_CORNER_PRIZE_ROOM: {
    talk: {
      TEXT_GAMECORNERPRIZEROOM_PRIZE_VENDOR_1: prizeCounterRows(1),
      TEXT_GAMECORNERPRIZEROOM_PRIZE_VENDOR_2: prizeCounterRows(2),
      TEXT_GAMECORNERPRIZEROOM_PRIZE_VENDOR_3: prizeCounterRows(3),
    },
  },

  // story4.lua's oaksAide (engine/events/oaks_aide.asm): one routine, three
  // posts. Each checks the DEX for kinds owned and hands over its reward
  // once — 10 kinds for HM05 FLASH, 30 for the ITEMFINDER, 50 for EXP.ALL.
  // The thresholds and rewards live in world/oaksaide.ts, keyed by these
  // same TEXT_* ids.
  ROUTE_2_GATE: {
    talk: {
      TEXT_ROUTE2GATE_OAKS_AIDE: [
        ["face_player"],
        ["oaks_aide", "TEXT_ROUTE2GATE_OAKS_AIDE"],
      ],
      TEXT_ROUTE2GATE_YOUNGSTER: [
        ["face_player"],
        ["show_text", "_Route2GateYoungsterText"],
      ],
    },
  },
  ROUTE_11_GATE_2F: {
    talk: {
      TEXT_ROUTE11GATE2F_YOUNGSTER: tradeRows(1, "EVENT_TRADED_NIDORINO_FOR_NIDORINA"),
      TEXT_ROUTE11GATE2F_OAKS_AIDE: [
        ["face_player"],
        ["oaks_aide", "TEXT_ROUTE11GATE2F_OAKS_AIDE"],
      ],
    },
  },
  ROUTE_15_GATE_2F: {
    talk: {
      TEXT_ROUTE15GATE2F_OAKS_AIDE: [
        ["face_player"],
        ["oaks_aide", "TEXT_ROUTE15GATE2F_OAKS_AIDE"],
      ],
    },
  },

  // story5.lua M.CINNABAR_ISLAND (scripts/CinnabarIsland.asm): the gym door
  // is locked until the SECRET KEY is found in the Pokemon Mansion.
  CINNABAR_ISLAND: {
    onStep: (ow: any, save: any) =>
      lockedDoorStep(
        ow,
        [[18, 4]],
        (save?.inventory?.SECRET_KEY ?? 0) <= 0,
        "_CinnabarIslandDoorIsLockedText",
      ),
    // CinnabarIsland_Script line 6: every load of the island finishes the
    // lab's revival, so walking out of the lab and back in is the "go for a
    // walk" the scientist asks for.
    onEnter: (_ow: any, save: any) => {
      if (save?.flags) delete save.flags.EVENT_LAB_STILL_REVIVING_FOSSIL;
    },
  },

  // The in-game trades (Commands.lua trade over field.trades).
  ROUTE_2_TRADE_HOUSE: {
    talk: { TEXT_ROUTE2TRADEHOUSE_GAMEBOY_KID: tradeRows(2, "EVENT_TRADED_ABRA_FOR_MR_MIME") },
  },
  CERULEAN_TRADE_HOUSE: {
    talk: { TEXT_CERULEANTRADEHOUSE_GAMBLER: tradeRows(7, "EVENT_TRADED_POLIWHIRL_FOR_JYNX") },
  },
  VERMILION_TRADE_HOUSE: {
    talk: { TEXT_VERMILIONTRADEHOUSE_LITTLE_GIRL: tradeRows(5, "EVENT_TRADED_SPEAROW_FOR_FARFETCHD") },
  },
  UNDERGROUND_PATH_ROUTE_5: {
    talk: { TEXT_UNDERGROUNDPATHROUTE5_LITTLE_GIRL: tradeRows(10, "EVENT_TRADED_NIDORAN_M_FOR_NIDORAN_F") },
  },
  ROUTE_18_GATE_2F: {
    talk: { TEXT_ROUTE18GATE2F_YOUNGSTER: tradeRows(6, "EVENT_TRADED_SLOWBRO_FOR_LICKITUNG") },
  },
  CINNABAR_LAB_TRADE_ROOM: {
    talk: {
      TEXT_CINNABARLABTRADEROOM_GRAMPS: tradeRows(8, "EVENT_TRADED_RAICHU_FOR_ELECTRODE"),
      TEXT_CINNABARLABTRADEROOM_BEAUTY: tradeRows(9, "EVENT_TRADED_VENONAT_FOR_TANGELA"),
    },
  },

  // story2.lua M.MUSEUM_1F + flavor/museum_1f.lua (scripts/Museum1F.asm):
  // the scientist in the back room hands over the OLD AMBER, and the amber
  // on display goes with it.
  MUSEUM_1F: {
    talk: {
      TEXT_MUSEUM1F_SCIENTIST2: (_ow: any, save: any): ScriptRow[] =>
        save?.flags?.EVENT_GOT_OLD_AMBER
          ? [["face_player"], ["show_text", "_Museum1FScientist2GetTheOldAmberCheckText"]]
          : [
              ["face_player"],
              ["show_text", "_Museum1FScientist2TakeThisToAPokemonLabText"],
              ["give_item", "OLD_AMBER", 1, "_Museum1FScientist2ReceivedOldAmberText"],
              ["set_flag", "EVENT_GOT_OLD_AMBER"],
              ["hide_object", "MUSEUM_1F", "MUSEUM1F_OLD_AMBER"],
            ],
      TEXT_MUSEUM1F_OLD_AMBER: [["show_text", "_Museum1FOldAmberText"]],
      TEXT_MUSEUM1F_GAMBLER: [["face_player"], ["show_text", "_Museum1FGamblerText"]],
      TEXT_MUSEUM1F_SCIENTIST3: [["face_player"], ["show_text", "_Museum1FScientist3Text"]],
    },
  },

  // story2.lua M.CINNABAR_LAB_FOSSIL_ROOM (scripts/CinnabarLabFossilRoom.asm,
  // engine/events/cinnabar_lab.asm): deposit a fossil, leave for the island,
  // come back, and it is a Pokémon.
  CINNABAR_LAB_FOSSIL_ROOM: {
    talk: {
      TEXT_CINNABARLABFOSSILROOM_SCIENTIST1: fossilScientistRows,
      TEXT_CINNABARLABFOSSILROOM_SCIENTIST2: tradeRows(4, "EVENT_TRADED_PONYTA_FOR_SEEL"),
    },
  },

  // story.lua M.SILPH_CO_11F (scripts/SilphCo11F.asm) and story4.lua
  // M.SAFFRON_CITY: the end of Team Rocket.
  SILPH_CO_11F: {
    // Giovanni is a COORDINATE TRIGGER, not a talk. SilphCo11FDefaultScript
    // watches (6,13) and (7,12) every frame while EVENT_BEAT_SILPH_CO_GIOVANNI
    // is unset; he has no trainer header either, so sight engagement never
    // fires. Without this he is a statue four tiles from anything the player
    // would walk into, and the whole ending -- the flag, the MASTER BALL, the
    // Saffron streets clearing -- silently never happens.
    onStep: (ow: any, save: any) => {
      if (save?.flags?.EVENT_BEAT_SILPH_CO_GIOVANNI) return null;
      const x = ow?.player?.cellX;
      const y = ow?.player?.cellY;
      if (!((x === 6 && y === 13) || (x === 7 && y === 12))) return null;
      return [
        // The text comes FIRST and he walks after: pokered orders it
        // DisplayTextID then MoveSprite, so he speaks from behind the desk
        // rather than crossing the room in silence to deliver it point-blank.
        ["show_text", "_SilphCo11FGiovanniText"],
        ["walk_npc", "SILPHCO11F_GIOVANNI", ["down", "down", "down"]],
        ["face_object", "SILPHCO11F_GIOVANNI", "down"],
        // Party 2 is the Silph Co. team; 1 is the Rocket Hideout and 3 the
        // Viridian gym rematch.
        ["start_battle", "trainer", "OPP_GIOVANNI", 2],
        ["jump_if_false", "end"], // a loss re-arms the trigger, as vanilla
        ["set_flag", "EVENT_BEAT_SILPH_CO_GIOVANNI"],
        ...silphAftermathRows(),
        ["label", "end"],
      ];
    },
    talk: {
      // He is reachable through the teleport pads without passing the
      // trigger, so this branches on the ball rather than on the battle.
      TEXT_SILPHCO11F_SILPH_PRESIDENT: [
        ["face_player"],
        ["check_flag", "EVENT_GOT_MASTER_BALL"],
        ["jump_if_true", "already"],
        ["show_text", "_SilphCo11FSilphPresidentText"],
        ["give_item", "MASTER_BALL", 1, "_SilphCo11FSilphPresidentReceivedMasterBallText"],
        ["set_flag", "EVENT_GOT_MASTER_BALL"],
        ["show_text", "_SilphCo11FSilphPresidentMasterBallDescriptionText"],
        ["jump", "end"],
        ["label", "already"],
        ["show_text", "_SilphCo11FSilphPresidentMasterBallDescriptionText"],
        ["label", "end"],
      ],
      TEXT_SILPHCO11F_BEAUTY: [["face_player"], ["show_text", "_SilphCo11FBeautyText"]],
    },
  },

  // story.lua M.SAFARI_ZONE_SECRET_HOUSE (scripts/SafariZoneSecretHouse.asm):
  // reach the far corner of the Safari Zone and he hands over HM03 SURF.
  SAFARI_ZONE_SECRET_HOUSE: {
    talk: {
      TEXT_SAFARIZONESECRETHOUSE_FISHING_GURU: [
        ["face_player"],
        ["check_flag", "EVENT_GOT_HM03"],
        ["jump_if_true", "already"],
        ["show_text", "_SafariZoneSecretHouseFishingGuruYouHaveWonText"],
        // give-then-print: GiveItem fills wStringBuffer and the received
        // line reads the name back out of it.
        ["give_item", "HM_SURF", 1, "_SafariZoneSecretHouseFishingGuruReceivedHM03Text"],
        ["set_flag", "EVENT_GOT_HM03"],
        ["jump", "end"],
        ["label", "already"],
        ["show_text", "_SafariZoneSecretHouseFishingGuruHM03ExplanationText"],
        ["label", "end"],
      ],
    },
  },

  // story.lua M.WARDENS_HOUSE (scripts/WardensHouse.asm): the WARDEN cannot
  // be understood without his teeth. Bring the GOLD TEETH back from the
  // Safari Zone and he swaps them for HM04 STRENGTH.
  WARDENS_HOUSE: {
    talk: {
      TEXT_WARDENSHOUSE_WARDEN: [
        ["face_player"],
        ["check_flag", "EVENT_GOT_HM04"],
        ["jump_if_true", "gotHm04"],
        ["check_item", "GOLD_TEETH"],
        ["jump_if_false", "noTeeth"],
        // GaveTheGoldTeeth runs straight into "The WARDEN popped in his
        // teeth!" -- that line opens on a page break, so it is the second
        // page of this one rather than a box of its own. (The ROM carries
        // it; gen1recomp's rows do not use it.)
        ["show_text", "_WardensHouseWardenGaveTheGoldTeethText"],
        ["show_text", "_WardensHouseWardenTeethPoppedInHisTeethText"],
        ["take_item", "GOLD_TEETH", 1],
        ["set_flag", "EVENT_GAVE_GOLD_TEETH"],
        ["show_text", "_WardensHouseWardenThanksText"],
        ["give_item", "HM_STRENGTH", 1, "_WardensHouseWardenReceivedHM04Text"],
        ["set_flag", "EVENT_GOT_HM04"],
        ["jump", "end"],

        // No teeth: he asks something unintelligible and answers himself
        // the same way whichever you pick (Gibberish2 on yes, 3 on no).
        ["label", "noTeeth"],
        ["ask", "_WardensHouseWardenGibberish1Text"],
        ["jump_if_true", "gibberishYes"],
        ["show_text", "_WardensHouseWardenGibberish3Text"],
        ["jump", "end"],
        ["label", "gibberishYes"],
        ["show_text", "_WardensHouseWardenGibberish2Text"],
        ["jump", "end"],

        // Afterwards he explains what HM04 does, every time.
        ["label", "gotHm04"],
        ["show_text", "_WardensHouseWardenHM04ExplanationText"],
        ["label", "end"],
      ],
      TEXT_WARDENSHOUSE_BOULDER: [["show_text", "_WardensHouseDisplayMerchandiseText"]],
    },
  },

  // story2.lua M.BIKE_SHOP + flavor/bike_shop.lua (scripts/BikeShop.asm).
  // The clerk's three branches and his price window are in game.ts
  // openBikeShop; the other two are plain flavour.
  BIKE_SHOP: {
    talk: {
      TEXT_BIKESHOP_CLERK: [["face_player"], ["open_bike_shop"]],
      TEXT_BIKESHOP_MIDDLE_AGED_WOMAN: [
        ["face_player"],
        ["show_text", "_BikeShopMiddleAgedWomanText"],
      ],
      // CheckEvent EVENT_GOT_BICYCLE. Reads the BAG, not the event: the
      // BICYCLE is a key item and cannot be tossed, so it is the surer test
      // and reads right on saves written before the clerk set the flag.
      TEXT_BIKESHOP_YOUNGSTER: [
        ["face_player"],
        ["check_item", "BICYCLE"],
        ["jump_if_true", "gotBike"],
        ["show_text", "_BikeShopYoungsterTheseBikesAreExpensiveText"],
        ["jump", "end"],
        ["label", "gotBike"],
        ["show_text", "_BikeShopYoungsterCoolBikeText"],
        ["label", "end"],
      ],
    },
  },

  // story2.lua M.POKEMON_FAN_CLUB + flavor/pokemon_fan_club.lua
  // (scripts/PokemonFanClub.asm): the chairman's BIKE VOUCHER, and the two
  // fans bragging past each other.
  POKEMON_FAN_CLUB: {
    talk: {
      TEXT_POKEMONFANCLUB_CHAIRMAN: [
        ["face_player"],
        ["check_flag", "EVENT_GOT_BIKE_VOUCHER"],
        ["jump_if_true", "already"],
        // The intro ends "Did you come visit to hear about my POKéMON?"
        ["ask", "_PokemonFanClubChairmanIntroText"],
        ["jump_if_false", "noStory"],
        ["show_text", "_PokemonFanClubChairmanStoryText"],
        // give-then-print like the asm: GiveItem fills wStringBuffer, and
        // the received line reads the name back out of it.
        ["give_item", "BIKE_VOUCHER", 1, "_PokemonFanClubReceivedBikeVoucherText"],
        ["set_flag", "EVENT_GOT_BIKE_VOUCHER"],
        ["show_text", "_PokemonFanClubExplainBikeVoucherText"],
        ["jump", "end"],
        ["label", "noStory"],
        ["show_text", "_PokemonFanClubNoStoryText"],
        ["jump", "end"],
        ["label", "already"],
        ["show_text", "_PokemonFanClubChairFinalText"],
        ["label", "end"],
      ],
      // She brags unless she has already "won" the boast war, in which case
      // she gets huffy and resets it. Either way she arms the OTHER fan, so
      // their next line is the retort.
      TEXT_POKEMONFANCLUB_PIKACHU_FAN: [
        ["face_player"],
        ["check_flag", "EVENT_PIKACHU_FAN_BOAST"],
        ["jump_if_true", "better"],
        ["show_text", "_PokemonFanClubPikachuFanNormalText"],
        ["set_flag", "EVENT_SEEL_FAN_BOAST"],
        ["jump", "end"],
        ["label", "better"],
        ["show_text", "_PokemonFanClubPikachuFanBetterText"],
        ["clear_flag", "EVENT_PIKACHU_FAN_BOAST"],
        ["label", "end"],
      ],
      TEXT_POKEMONFANCLUB_SEEL_FAN: [
        ["face_player"],
        ["check_flag", "EVENT_SEEL_FAN_BOAST"],
        ["jump_if_true", "better"],
        ["show_text", "_PokemonFanClubSeelFanNormalText"],
        ["set_flag", "EVENT_PIKACHU_FAN_BOAST"],
        ["jump", "end"],
        ["label", "better"],
        ["show_text", "_PokemonFanClubSeelFanBetterText"],
        ["clear_flag", "EVENT_SEEL_FAN_BOAST"],
        ["label", "end"],
      ],
      TEXT_POKEMONFANCLUB_PIKACHU: [["show_text", "_PokemonFanClubPikachuText"]],
      TEXT_POKEMONFANCLUB_SEEL: [["show_text", "_PokemonFanClubSeelText"]],
    },
  },

  // story2.lua M.DAYCARE (scripts/Daycare.asm). Every line, the party pick
  // and the fee are in game.ts openDaycare — the flow branches mid-way on a
  // chooser, which script rows cannot express.
  DAYCARE: {
    talk: {
      TEXT_DAYCARE_GENTLEMAN: [["open_daycare"]],
    },
  },

  // story.lua M.SS_ANNE_CAPTAINS_ROOM (scripts/SSAnneCaptainsRoom.asm): rub
  // his back, he hands over HM01 CUT.
  SS_ANNE_CAPTAINS_ROOM: {
    talk: {
      TEXT_SSANNECAPTAINSROOM_CAPTAIN: [
        ["check_flag", "EVENT_GOT_HM01"],
        ["jump_if_true", "already"],
        ["show_text", "_SSAnneCaptainsRoomRubCaptainsBackText"],
        ["play_once", "Music_PkmnHealed"],
        ["show_text", "_SSAnneCaptainsRoomCaptainIFeelMuchBetterText"],
        ["give_item", "HM_CUT", 1, false],
        ["show_text", "_SSAnneCaptainsRoomCaptainReceivedHM01Text"],
        ["set_flag", "EVENT_GOT_HM01"],
        ["jump", "end"],
        ["label", "already"],
        ["show_text", "_SSAnneCaptainsRoomCaptainNotSickAnymoreText"],
      ],
    },
  },

  // scripts/CeladonDiner.asm, the busted gym guide — story5.lua
  // M.CELADON_DINER. A plain gift: the COIN CASE, then the same line
  // forever after.
  //
  // DEVIATION: upstream prints _CeladonDinerGymGuideCoinCaseNoRoomText on a
  // full bag; give_item prints its own refusal and halts (leaving the flag
  // unset, so the guide still has it next time), which is what every other
  // gift in this file does.
  CELADON_DINER: {
    talk: {
      TEXT_CELADONDINER_GYM_GUIDE: [
        ["check_flag", "EVENT_GOT_COIN_CASE"],
        ["jump_if_true", "already"],
        ["show_text", "_CeladonDinerGymGuideImFlatOutBustedText"],
        ["play_sound", "Get_Key_Item"],
        ["give_item", "COIN_CASE", 1, "_CeladonDinerGymGuideReceivedCoinCaseText"],
        ["set_flag", "EVENT_GOT_COIN_CASE"],
        ["jump", "end"],
        ["label", "already"],
        ["show_text", "_CeladonDinerGymGuideWinItBackText"],
      ],
    },
  },

  // scripts/GameCorner.asm — story3.lua M.GAME_CORNER. The way into the
  // Rocket Hideout.
  //
  // The stairs hide behind a wall block until the switch behind the poster is
  // pushed; setMap's applyGameCornerPoster swaps the block from the flag, so
  // all this has to do is set the flag and re-enter the map's block state.
  // onStep re-runs applyGameCornerPoster the step after the switch, which is
  // what makes the opening take effect without leaving and coming back.
  //
  // The grunt standing in front of the poster leaves the floor for good once
  // beaten (GameCornerRocketExitScript), freeing the tile. He is a text_asm
  // trainer with no def_trainers header, so the talk entry owns the engage.
  GAME_CORNER: {
    talk: {
      TEXT_GAMECORNER_POSTER: [
        ["check_flag", "EVENT_FOUND_ROCKET_HIDEOUT"],
        ["jump_if_true", "known"],
        ["play_sound", "Switch"],
        ["show_text", "_GameCornerPosterSwitchBehindPosterText"],
        ["set_flag", "EVENT_FOUND_ROCKET_HIDEOUT"],
        ["play_sound", "Go_Inside"],
        ["jump", "end"],
        ["label", "known"],
        ["show_text", "_GameCornerPosterSwitchBehindPosterText"],
      ],
      // GameCornerRocketText / GameCornerRocketExitScript. He stands at
      // (9,5), directly below the poster sign at (9,4), so he IS the lock on
      // the switch: until he moves, the player cannot face the poster.
      // Beaten, he walks up into the wall the hidden stairs are behind and
      // despawns, which frees the tile.
      // scripts/GameCorner.asm GameCornerClerk1Text / Clerk2Text: the coin
      // counter and the gambler's one-off 20.
      TEXT_GAMECORNER_CLERK1: coinClerkRows(),
      TEXT_GAMECORNER_CLERK: coinClerkRows(), // Yellow spells him CLERK
      TEXT_GAMECORNER_CLERK2: coinGiftRows(),
      TEXT_GAMECORNER_ROCKET: [
        ["engage_trainer", "GAMECORNER_ROCKET"],
        ["jump_if_false", "end"],
        ["walk_npc", "GAMECORNER_ROCKET", ["up"]],
        ["hide_object", "GAME_CORNER", "GAMECORNER_ROCKET"],
      ],
    },
    onStep: (ow: any, save: any) => {
      // The poster block swap lands on the next step rather than on the text
      // box closing — there is no post-script hook, and the player has to
      // step to reach the stairs anyway.
      if (save?.flags?.EVENT_FOUND_ROCKET_HIDEOUT) ow.refreshGameCornerPoster?.();
      // Repair, and upstream carries the same one: a grunt whose BEAT flag is
      // already set but who is still standing keeps blocking the poster
      // forever. That is any save that fought him through the trainer-sight
      // path, which is what he was before this file gave him a talk script —
      // sight trainers skip scripted ones, so registering the script is what
      // routed him through it, and saves made before that never hid him.
      const npc = ow.findNpc?.("GAMECORNER_ROCKET");
      if (npc && ow.trainerDefeated?.(npc)) {
        ow.setObjectHidden?.("GAMECORNER_ROCKET", true);
        const toggles = (save.objectToggles ??= {});
        (toggles.GAME_CORNER ??= {}).GAMECORNER_ROCKET = false;
      }
      return null;
    },
  },

  // scripts/PokemonTower5F.asm PokemonTower5FDefaultScript — story3.lua
  // M.POKEMON_TOWER_5F. The 2x2 pad at the centre heals the party once per
  // visit; EVENT_IN_PURIFIED_ZONE latches until the player steps off it.
  //
  // Upstream also returns true from onStep while on the pad, standing in for
  // the map script's BIT_NO_BATTLES so the pad suppresses wild encounters.
  // This onStep returns rows, not a boolean, so the no-battles half is not
  // wired — the pad is four tiles in a building whose encounter rate the
  // player is standing still on, so the difference is close to unobservable.
  POKEMON_TOWER_5F: {
    onStep: (ow: any, save: any) => {
      const f = save?.flags ?? {};
      const p = ow?.player;
      const onPad = TOWER_5F_PURIFIED.has(`${p?.cellX ?? -1},${p?.cellY ?? -1}`);
      if (!onPad) {
        delete f.EVENT_IN_PURIFIED_ZONE;
        return null;
      }
      if (f.EVENT_IN_PURIFIED_ZONE) return null;
      f.EVENT_IN_PURIFIED_ZONE = true;
      // HealParty -> GBFadeOutToWhite -> Delay3 -> Delay3 -> GBFadeInFromWhite
      // -> the purified-zone line. No Music_PkmnHealed, unlike a Center.
      return [
        ["heal_party"],
        ["fade", "out", "white"],
        ["wait", 3],
        ["wait", 3],
        ["fade", "in", "white"],
        ["show_text", "_PokemonTower5FPurifiedZoneText"],
      ] as ScriptRow[];
    },
  },

  // scripts/PokemonTower6F.asm PokemonTower6FDefaultScript — story3.lua
  // M.POKEMON_TOWER_6F. The ghost MAROWAK blocks the stairs at (10,16).
  //
  // The trigger does NOT check the SILPH SCOPE: vanilla opens the battle
  // either way, and the scope only decides whether the disguise sticks. An
  // earlier pass of the upstream port gated the trigger on the scope and made
  // 6F impassable for anyone who skipped the Rocket Hideout, which is the
  // mistake this comment exists to prevent repeating.
  //
  // Balls are dodged with or without the scope (item_effects.asm:166-175), so
  // noCatch rides the battle rather than the disguise.
  POKEMON_TOWER_6F: {
    onStep: (ow: any, save: any) => {
      const f = save?.flags ?? {};
      if (f.EVENT_BEAT_GHOST_MAROWAK) return null;
      const p = ow?.player;
      if ((p?.cellX ?? -1) !== 10 || (p?.cellY ?? -1) !== 16) return null;
      const hasScope = (save?.inventory?.SILPH_SCOPE ?? 0) > 0;
      return [
        ["show_text", "_PokemonTower6FBeGoneText"],
        // Without the scope it is the GHOST and cannot be fought; with it
        // the fight still opens on the GHOST, and the scope unveils it
        // (PrintBeginningBattleText .isMarowak).
        ["start_battle", "wild", "MAROWAK", 30,
          { noCatch: true, disguised: !hasScope, unveil: hasScope }],
        // lastCheck is the win. Losing blacks out and running leaves the
        // player on the trigger tile, which re-fires next step — vanilla
        // nudges them one tile clear instead (.did_not_defeat).
        ["jump_if_false", "fled"],
        ["set_flag", "EVENT_BEAT_GHOST_MAROWAK"],
        ["show_text", "_PokemonTower6FGhostWasCubonesMotherText"],
        ["wait", 30],
        ["show_text", "_PokemonTower6FSoulWasCalmedText"],
        ["jump", "end"],
        ["label", "fled"],
        ["move_player", "right", 1],
      ] as ScriptRow[];
    },
  },

  // scripts/PokemonTower7F.asm — story.lua M.POKEMON_TOWER_7F. Mr Fuji at
  // the top, and the rescue that carries the player home.
  //
  // The three grunts battle through the generic sight path, so only Fuji
  // needs a script. Upstream also walks a beaten grunt off the floor on an
  // onVictory hook (MapScript has no such hook here) — they stay put instead,
  // beaten and harmless, which does not block the corridor to Fuji.
  //
  // Warping to (3,7) facing up is deliberate and load-bearing: it is the
  // house's door mat, and the mat is inert until stepped OFF (warpEntryCell).
  // Landing at (3,3) — the Pokedex table, which reads like the friendlier
  // spot — walks the player onto a live mat and straight back outside before
  // they can talk to Fuji, and the POKE FLUTE is never collected, which seals
  // Route 16 behind the SNORLAX. Upstream hit exactly that.
  POKEMON_TOWER_7F: {
    talk: {
      TEXT_POKEMONTOWER7F_MR_FUJI: [
        ["face_player"],
        ["show_text", "_PokemonTower7FMrFujiRescueText"],
        ["set_flag", "EVENT_RESCUED_MR_FUJI"],
        ["set_flag", "EVENT_RESCUED_MR_FUJI_2"],
        ["show_object", "MR_FUJIS_HOUSE", "MRFUJISHOUSE_MR_FUJI"],
        // pokered also swaps the Silph Co. door guard here (ROCKET8 off the
        // door tile, ROCKET9 beside it) — kept, so Saffron is left in the
        // state the rest of the story expects.
        ["hide_object", "SAFFRON_CITY", "SAFFRONCITY_ROCKET8"],
        ["show_object", "SAFFRON_CITY", "SAFFRONCITY_ROCKET9"],
        ["warp", "MR_FUJIS_HOUSE", 3, 7, "up"],
      ],
    },
  },

  // scripts/MrFujisHouse.asm — story.lua M.MR_FUJIS_HOUSE. The POKE FLUTE,
  // which is what unsticks the SNORLAX on Routes 12 and 16.
  //
  // Fuji starts hidden in the map data and the tower rescue reveals him, so
  // the not-yet-rescued branch is only reachable by a save that toggled him
  // visible some other way; it prints his Pokedex line, as upstream does.
  MR_FUJIS_HOUSE: {
    talk: {
      TEXT_MRFUJISHOUSE_MR_FUJI: [
        ["face_player"],
        ["check_flag", "EVENT_GOT_POKE_FLUTE"],
        ["jump_if_true", "have"],
        ["check_flag", "EVENT_RESCUED_MR_FUJI"],
        ["jump_if_false", "notyet"],
        ["show_text", "_MrFujisHouseMrFujiIThinkThisMayHelpYourQuestText"],
        // give-then-print, like the asm: give_item halts on a full bag, so
        // the flag stays unset and he still has it next time.
        ["play_sound", "Get_Key_Item"],
        ["give_item", "POKE_FLUTE", 1, false],
        ["show_text", "_MrFujisHouseMrFujiReceivedPokeFluteText"],
        ["set_flag", "EVENT_GOT_POKE_FLUTE"],
        ["show_text", "_MrFujisHouseMrFujiPokeFluteExplanationText"],
        ["jump", "end"],
        ["label", "have"],
        ["show_text", "_MrFujisHouseMrFujiHasMyFluteHelpedYouText"],
        ["jump", "end"],
        ["label", "notyet"],
        ["show_text", "_MrFujisHouseMrFujiPokedexText"],
      ],
    },
  },

  // scripts/RocketHideoutB4F.asm — story3.lua M.ROCKET_HIDEOUT_B4F.
  //
  // The grunt drops the LIFT KEY when beaten: the ball object starts hidden
  // in the map data and show_object reveals it, after which the generic
  // item-ball path (itemBallScript below) picks it up like any other. Later
  // talks only reprint the line, which is why the reveal is flag-gated
  // rather than repeated (CheckAndSetEvent EVENT_ROCKET_DROPPED_LIFT_KEY).
  //
  // Giovanni has no trainer-header row upstream (def_trainers 2) — his
  // text_asm owns both the engage and BeatGiovanniScript's aftermath, which
  // is why he is a talk script rather than a sight trainer.
  ROCKET_HIDEOUT_B4F: {
    talk: {
      // Rocket3 is the one that drops it. Upstream also carries a Yellow
      // spelling (a single unnumbered grunt); this build cooks Red/Blue,
      // whose text set is Rocket1/2/3 and has no unnumbered line, so wiring
      // it would be a dead key pointing at a label that does not exist.
      TEXT_ROCKETHIDEOUTB4F_ROCKET3: liftKeyRocketRows("ROCKETHIDEOUTB4F_ROCKET3",
        "_RocketHideoutB4FRocket3AfterBattleText"),
      TEXT_ROCKETHIDEOUTB4F_GIOVANNI: [
        ["check_flag", "EVENT_BEAT_ROCKET_HIDEOUT_GIOVANNI"],
        ["jump_if_true", "beaten"],
        ["show_text", "_RocketHideoutB4FGiovanniImpressedYouGotHereText"],
        ["start_battle", "trainer", "OPP_GIOVANNI", 1],
        ["jump_if_false", "end"],
        ["set_flag", "EVENT_BEAT_ROCKET_HIDEOUT_GIOVANNI"],
        ["show_text", "_RocketHideoutB4FGiovanniWhatCannotBeText"],
        ["show_text", "_RocketHideoutB4FGiovanniHopeWeMeetAgainText"],
        ["fade", "out", "black"],
        ["hide_object", "ROCKET_HIDEOUT_B4F", "ROCKETHIDEOUTB4F_GIOVANNI"],
        ["show_object", "ROCKET_HIDEOUT_B4F", "ROCKETHIDEOUTB4F_SILPH_SCOPE"],
        ["fade", "in", "black"],
        ["jump", "end"],
        ["label", "beaten"],
        ["show_text", "_RocketHideoutB4FGiovanniHopeWeMeetAgainText"],
      ],
    },
  },

  // scripts/RocketHideoutElevator.asm RocketHideoutElevatorText — story3.lua
  // M.ROCKET_HIDEOUT_ELEVATOR's keyGate. Without the LIFT KEY the panel only
  // prints the need-a-key line and opens no floor menu; with it, the floor
  // list (world/elevator.ts, ui/floorpicker.ts).
  //
  // The panel is a SIGN, not an object (data/maps/objects/RocketHideout
  // Elevator.asm bg_event), which is why the key is the bare map constant —
  // signs route through showMapText and so reach talkScript the same way an
  // object's text does.
  ROCKET_HIDEOUT_ELEVATOR: {
    onEnter: seedElevator,
    talk: {
      TEXT_ROCKETHIDEOUTELEVATOR: [
        ["check_item", "LIFT_KEY"],
        ["jump_if_false", "no_key"],
        ["open_elevator"],
        ["jump", "end"],
        ["label", "no_key"],
        ["show_text", "_RocketHideoutElevatorAppearsToNeedKeyText"],
      ],
    },
  },

  // The other two cars: the same panel with nothing to unlock
  // (story3.lua M.SILPH_CO_ELEVATOR / M.CELADON_MART_ELEVATOR).
  SILPH_CO_ELEVATOR: {
    onEnter: seedElevator,
    talk: { TEXT_SILPHCOELEVATOR_ELEVATOR: [["open_elevator"]] as ScriptRow[] },
  },
  // story3.lua M.VERMILION_OLD_ROD_HOUSE / M.FUCHSIA_GOOD_ROD_HOUSE /
  // M.ROUTE_12_SUPER_ROD_HOUSE (scripts/VermilionOldRodHouse.asm and its two
  // siblings). Three houses, one script: the guru asks whether you like to
  // fish, and a yes is the only way any rod enters the game.
  VERMILION_OLD_ROD_HOUSE: {
    talk: {
      TEXT_VERMILIONOLDRODHOUSE_FISHING_GURU: rodGiverRows(
        "_VermilionOldRodHouseFishingGuruDoYouLikeToFishText",
        "_VermilionOldRodHouseFishingGuruTakeThisText",
        "_VermilionOldRodHouseFishingGuruHowAreTheFishBitingText",
        "_VermilionOldRodHouseFishingGuruThatsSoDisappointingText",
        "OLD_ROD",
        "EVENT_GOT_OLD_ROD",
      ),
    },
  },

  FUCHSIA_GOOD_ROD_HOUSE: {
    talk: {
      TEXT_FUCHSIAGOODRODHOUSE_FISHING_GURU: rodGiverRows(
        "_FuchsiaGoodRodHouseFishingGuruText",
        "_FuchsiaGoodRodHouseFishingGuruReceivedGoodRodText",
        "_FuchsiaGoodRodHouseFishingGuruHowAreTheFishText",
        "_FuchsiaGoodRodHouseFishingGuruThatsSoDisappointingText",
        "GOOD_ROD",
        "EVENT_GOT_GOOD_ROD",
      ),
    },
  },

  ROUTE_12_SUPER_ROD_HOUSE: {
    talk: {
      TEXT_ROUTE12SUPERRODHOUSE_FISHING_GURU: rodGiverRows(
        "_Route12SuperRodHouseFishingGuruDoYouLikeToFishText",
        "_Route12SuperRodHouseFishingGuruReceivedSuperRodText",
        "_Route12SuperRodHouseFishingGuruTryFishingText",
        "_Route12SuperRodHouseFishingGuruThatsDisappointingText",
        "SUPER_ROD",
        "EVENT_GOT_SUPER_ROD",
      ),
    },
  },

  // story4.lua M.NAME_RATERS_HOUSE (scripts/NameRatersHouse.asm): the man
  // in Lavender who renames a Pokemon. The flow is his own (game.ts
  // openNameRater); this is the door to it.
  NAME_RATERS_HOUSE: {
    talk: {
      TEXT_NAMERATERSHOUSE_NAME_RATER: [
        ["face_player"],
        ["open_name_rater"],
      ] as ScriptRow[],
    },
  },

  // story5.lua M.ROUTE_16_GATE_1F / M.ROUTE_18_GATE_1F (scripts/Route16
  // Gate1F.asm, Route18Gate1F.asm): the CYCLING ROAD gates. Walkers are
  // stopped on the cells beside the counter and turned back.
  ROUTE_16_GATE_1F: {
    onStep: bikeGate(
      [[4, 7], [4, 8], [4, 9], [4, 10]],
      "_Route16Gate1FGuardWaitUpText",
      "_Route16Gate1FGuardNoPedestriansAllowedText",
    ),
  },
  ROUTE_18_GATE_1F: {
    onStep: bikeGate(
      [[4, 3], [4, 4], [4, 5], [4, 6]],
      "_Route18Gate1FGuardExcuseMeText",
      "_Route18Gate1FGuardYouNeedABicycleText",
    ),
  },

  // story4.lua M.MR_PSYCHICS_HOUSE (scripts/MrPsychicsHouse.asm): TM29
  // PSYCHIC, once; afterwards he only explains it.
  MR_PSYCHICS_HOUSE: {
    talk: {
      TEXT_MRPSYCHICSHOUSE_MR_PSYCHIC: giftRows({
        flag: "EVENT_GOT_TM29",
        item: "TM_PSYCHIC_M",
        pre: "_MrPsychicsHouseMrPsychicYouWantedThisText",
        received: "_MrPsychicsHouseMrPsychicReceivedTM29Text",
        explain: "_MrPsychicsHouseMrPsychicTM29ExplanationText",
        already: "_MrPsychicsHouseMrPsychicTM29ExplanationText",
      }),
    },
  },

  // story5.lua M.ROUTE_12_GATE_2F (scripts/Route12Gate2F.asm): the girl
  // whose POKeMON's ashes are in the tower gives away TM39 SWIFT.
  ROUTE_12_GATE_2F: {
    talk: {
      TEXT_ROUTE12GATE2F_BRUNETTE_GIRL: giftRows({
        flag: "EVENT_GOT_TM39",
        item: "TM_SWIFT",
        pre: "_Route12Gate2FBrunetteGirlYouCanHaveThisText",
        received: "_Route12Gate2FBrunetteGirlReceivedTM39Text",
        explain: "_Route12Gate2FBrunetteGirlTM39ExplanationText",
        already: "_Route12Gate2FBrunetteGirlTM39ExplanationText",
      }),
    },
  },

  // story5.lua M.CELADON_CITY (scripts/CeladonCity.asm, Gramps3): TM41
  // SOFTBOILED from the old man by the mansion.
  CELADON_CITY: {
    talk: {
      TEXT_CELADONCITY_GRAMPS3: giftRows({
        flag: "EVENT_GOT_TM41",
        item: "TM_SOFTBOILED",
        pre: "_CeladonCityGramps3Text",
        received: "_CeladonCityGramps3ReceivedTM41Text",
        explain: "_CeladonCityGramps3TM41ExplanationText",
        already: "_CeladonCityGramps3TM41ExplanationText",
      }),
    },
  },

  // story5.lua M.CINNABAR_LAB_METRONOME_ROOM (scripts/CinnabarLabMetronome
  // Room.asm): the tch-tch-tch scientist's TM35 METRONOME.
  CINNABAR_LAB_METRONOME_ROOM: {
    talk: {
      TEXT_CINNABARLABMETRONOMEROOM_SCIENTIST1: giftRows({
        flag: "EVENT_GOT_TM35",
        item: "TM_METRONOME",
        pre: "_CinnabarLabMetronomeRoomScientist1Text",
        received: "_CinnabarLabMetronomeRoomScientist1ReceivedTM35Text",
        explain: "_CinnabarLabMetronomeRoomScientist1TM35ExplanationText",
        already: "_CinnabarLabMetronomeRoomScientist1TM35ExplanationText",
      }),
    },
  },

  // story4.lua M.COPYCATS_HOUSE_2F (scripts/CopycatsHouse2F.asm): the
  // COPYCAT mimics you, and if a POKe DOLL is in the bag she takes it for
  // TM31 MIMIC -- no question asked, the ROM just checks the bag. The doll
  // goes AFTER the TM, so a full bag (give_item halts) keeps the doll.
  COPYCATS_HOUSE_2F: {
    talk: {
      TEXT_COPYCATSHOUSE2F_COPYCAT: (_ow: any, save: any): ScriptRow[] => {
        if (save?.flags?.EVENT_GOT_TM31) {
          return [
            ["face_player"],
            ["show_text", "_CopycatsHouse2FCopycatTM31Explanation2Text"],
          ] as ScriptRow[];
        }
        return [
          ["face_player"],
          ["show_text", "_CopycatsHouse2FCopycatDoYouLikePokemonText"],
          ["check_item", "POKE_DOLL"],
          ["jump_if_false", "end"],
          ["show_text", "_CopycatsHouse2FCopycatTM31PreReceiveText"],
          ["give_item", "TM_MIMIC", 1, "_CopycatsHouse2FCopycatReceivedTM31Text"],
          ["take_item", "POKE_DOLL", 1],
          ["set_flag", "EVENT_GOT_TM31"],
          ["show_text", "_CopycatsHouse2FCopycatTM31Explanation1Text"],
        ] as ScriptRow[];
      },
    },
  },

  // story5.lua M.ROUTE_1 (scripts/Route1.asm): the POKeMON MART man's free
  // POTION sample, the first item in the game that is handed over rather
  // than found.
  ROUTE_1: {
    talk: {
      TEXT_ROUTE1_YOUNGSTER1: giftRows({
        flag: "EVENT_GOT_POTION_SAMPLE",
        item: "POTION",
        pre: "_Route1Youngster1MartSampleText",
        received: "_Route1Youngster1GotPotionText",
        already: "_Route1Youngster1AlsoGotPokeballsText",
      }),
    },
  },

  // story4.lua M.FIGHTING_DOJO (scripts/FightingDojo.asm). The KARATE
  // MASTER has no trainer header -- he is a text_asm trainer, like the Game
  // Corner Rocket -- so his fight is scripted here, and the prize is the
  // point of the building: beat him and take HITMONLEE or HITMONCHAN from
  // the two balls on the mat. Only the chosen ball goes; the other stays,
  // and asks for it get the "Better not get greedy" refusal.
  FIGHTING_DOJO: {
    talk: {
      TEXT_FIGHTINGDOJO_KARATE_MASTER: (_ow: any, save: any): ScriptRow[] => {
        if (save?.flags?.EVENT_BEAT_KARATE_MASTER) {
          return [
            ["face_player"],
            ["show_text", "_FightingDojoKarateMasterStayAndTrainWithUsText"],
          ] as ScriptRow[];
        }
        return [
          ["face_player"],
          ["show_text", "_FightingDojoKarateMasterText"],
          ["engage_trainer", "FIGHTINGDOJO_KARATE_MASTER"],
          ["jump_if_false", "end"],
          ["set_flag", "EVENT_BEAT_KARATE_MASTER"],
          ["show_text", "_FightingDojoKarateMasterIWillGiveYouAPokemonText"],
        ] as ScriptRow[];
      },
      TEXT_FIGHTINGDOJO_HITMONLEE_POKE_BALL: dojoBall(
        "HITMONLEE", "FIGHTINGDOJO_HITMONLEE_POKE_BALL", "_FightingDojoHitmonleePokeBallText",
      ),
      TEXT_FIGHTINGDOJO_HITMONCHAN_POKE_BALL: dojoBall(
        "HITMONCHAN", "FIGHTINGDOJO_HITMONCHAN_POKE_BALL", "_FightingDojoHitmonchanPokeBallText",
      ),
    },
  },

  // celadon_eevee.lua (scripts/CeladonMansionRoofHouse.asm): the EEVEE in
  // the ball on the table, L25, once. The flag and the hide come BEFORE the
  // got line, so a script that dies at the nickname prompt cannot leave the
  // EEVEE taken with the ball still on the table (#426 in the reference).
  CELADON_MANSION_ROOF_HOUSE: {
    talk: {
      TEXT_CELADONMANSION_ROOF_HOUSE_EEVEE_POKEBALL: (_ow: any, save: any): ScriptRow[] => {
        if (save?.flags?.EVENT_GOT_EEVEE) {
          // an old save with the flag but the ball still showing
          return [["hide_object", "CELADON_MANSION_ROOF_HOUSE",
            "CELADONMANSION_ROOF_HOUSE_EEVEE_POKEBALL"]] as ScriptRow[];
        }
        return [
          ["check_party_room"],
          ["jump_if_false", "full"],
          ["give_pokemon", "EEVEE", 25],
          ["set_flag", "EVENT_GOT_EEVEE"],
          ["hide_object", "CELADON_MANSION_ROOF_HOUSE", "CELADONMANSION_ROOF_HOUSE_EEVEE_POKEBALL"],
          ["play_sound", "Get_Item1"],
          ["show_text", "{PLAYER} got\nEEVEE!"],
          ["jump", "end"],
          ["label", "full"],
          ["show_text", "You have no room\nfor it!"],
        ] as ScriptRow[];
      },
    },
  },

  // story4.lua M.SILPH_CO_7F (the worker's LAPRAS) + story5.lua M.SILPH_CO_7F
  // (the rival ambush). Both live on this floor, so both are here.
  //
  // The rival stands at (3,7) in the map data with no `hidden` flag -- the
  // extractor gave SS Anne's rival one and not this one -- so without the
  // load-time hide he is simply standing in the room from the first visit,
  // and walking up to him says "What kept you?" with no battle. He belongs
  // off the floor until the doorway trigger puts him on it.
  SILPH_CO_7F: {
    onEnter: (ow: any, save: any) => {
      if (save?.flags?.EVENT_BEAT_SILPH_CO_RIVAL) return;
      ow?.setObjectHidden?.("SILPHCO7F_RIVAL", true);
    },
    talk: { TEXT_SILPHCO7F_SILPH_WORKER_M1: laprasRows },
    onStep: (ow: any, save: any) => {
      if (save?.flags?.EVENT_BEAT_SILPH_CO_RIVAL) return null;
      const p = ow?.player;
      const x = p?.cellX;
      const y = p?.cellY;
      // SilphCo7FDefaultScript's coord pair, the two cells inside the door.
      if (x !== 3 || (y !== 2 && y !== 3)) return null;
      // runAmbush's side effect: you turn to face him as he comes up.
      if (p) p.facing = "down";
      return sceneWithTheme(MEET_RIVAL, [
        ["show_object", "SILPH_CO_7F", "SILPHCO7F_RIVAL"], //      1
        ["show_text", "_SilphCo7FRivalText"], //                   2
        ["move_npc_to", "SILPHCO7F_RIVAL", 3, y + 1], //           3
        ["face_object", "SILPHCO7F_RIVAL", "up"], //               4
        ["show_text", "_SilphCo7FRivalWaitedHereText"], //         5
        // OPP_RIVAL2 parties 7-9, one per starter; rival_battle adds the
        // counterpick offset itself.
        ["rival_battle", "OPP_RIVAL2", 7], //                      6
        ["jump_if_false", 12], //                                  7  loss -> hide
        ["set_flag", "EVENT_BEAT_SILPH_CO_RIVAL"], //              8
        ["show_text", "_SilphCo7FRivalDefeatedText"], //           9
        ["show_text", "_SilphCo7FRivalGoodLuckToYouText"], //     10
        ["move_npc_to", "SILPHCO7F_RIVAL", 5, y + 1], //          11
        ["hide_object", "SILPH_CO_7F", "SILPHCO7F_RIVAL"], //     12
      ] as ScriptRow[]);
    },
  },

  CELADON_MART_ELEVATOR: {
    onEnter: seedElevator,
    talk: { TEXT_CELADONMARTELEVATOR: [["open_elevator"]] as ScriptRow[] },
  },

  // The rooftop (story4.lua M.CELADON_MART_ROOF). Three machines, one girl,
  // and the only drinks in Kanto worth carrying.
  CELADON_MART_ROOF: {
    talk: {
      TEXT_CELADONMARTROOF_VENDING_MACHINE1: vendingRows(),
      TEXT_CELADONMARTROOF_VENDING_MACHINE2: vendingRows(),
      TEXT_CELADONMARTROOF_VENDING_MACHINE3: vendingRows(),
      TEXT_CELADONMARTROOF_LITTLE_GIRL: thirstyGirlRows,
    },
  },
};

/**
 * A car remembers the floor you stepped in from, so walking back out lands
 * there rather than on the ROM's static default (the Rocket Hideout's is
 * B1F, however you got in). Choosing a floor rewrites it again.
 */
function seedElevator(ow: any): void {
  const id = ow?.map?.id;
  if (!id) return;
  seedExit(ow.map.def, floorsOf(ow.shell?.data ?? ow.data, id), ow.cameFromMapId);
}

/** The 2x2 purified pad on POKEMON_TOWER_5F (story3.lua TOWER_5F_PURIFIED). */
const TOWER_5F_PURIFIED = new Set(["10,8", "11,8", "10,9", "11,9"]);

/**
 * The Rocket Hideout B4F grunt who drops the LIFT KEY. Beating him reveals
 * the ball; talking again only reprints. engage_trainer reports the win in
 * lastCheck, so a loss (which blacks out) never reaches the reveal.
 */
function liftKeyRocketRows(npc: string, afterText: string): ScriptRow[] {
  return [
    ["engage_trainer", npc],
    ["jump_if_false", "end"],
    ["show_text", afterText],
    ["check_flag", "EVENT_ROCKET_DROPPED_LIFT_KEY"],
    ["jump_if_true", "end"],
    ["set_flag", "EVENT_ROCKET_DROPPED_LIFT_KEY"],
    ["show_object", "ROCKET_HIDEOUT_B4F", "ROCKETHIDEOUTB4F_LIFT_KEY"],
  ] as ScriptRow[];
}

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
/** MUSIC_MEET_RIVAL — the sting every rival encounter opens with. */
const MEET_RIVAL = "Music_MeetRival";

/**
 * A scene that opens with a theme of its own.
 *
 * The rival's encounters play MUSIC_MEET_RIVAL as he walks up -- the
 * reference starts it at the ambush (story5.lua runAmbush) or as a row
 * (oaks_lab.lua), and PlayTrainerMusic deliberately skips the rival classes
 * so this is the only thing that gives him one (home/trainers.asm:399, and
 * OverworldController.lua meetTrainerTheme's `cls:find("RIVAL")` bail).
 * The map theme comes back when the scene ends (overworld.ts oneShotPending).
 *
 * The row goes on the FRONT, which moves every numeric jump target after it
 * -- they are 1-based row numbers (script.ts VERBS jump) -- so they are
 * rewritten here instead of being hand-counted at each scene.
 */
function sceneWithTheme(song: string, rows: ScriptRow[]): ScriptRow[] {
  const jumps = ["jump", "jump_if_true", "jump_if_false"];
  const bumped = rows.map((r) =>
    jumps.includes(r[0] as string) && typeof r[1] === "number"
      ? ([r[0], (r[1] as number) + 1] as unknown as ScriptRow)
      : r,
  );
  return [["play_music", song] as unknown as ScriptRow, ...bumped];
}

/**
 * One of the FIGHTING DOJO's prize balls (FightingDojo.asm). The ask is the
 * ball's own line; taking it sets its EVENT_GOT_* and the dojo's done flag,
 * and hides ONLY that ball -- the other stays on the mat and refuses.
 */
function dojoBall(species: string, ball: string, askKey: string): TalkFn {
  return (_ow: any, save: any): ScriptRow[] => {
    const f = save?.flags ?? {};
    if (f.EVENT_GOT_HITMONLEE || f.EVENT_GOT_HITMONCHAN) {
      return [["show_text", "_FightingDojoBetterNotGetGreedyText"]] as ScriptRow[];
    }
    if (!f.EVENT_BEAT_KARATE_MASTER) {
      return [["show_text", "You'll have to\nbeat the master\nfirst!"]] as ScriptRow[];
    }
    return [
      ["ask", askKey],
      ["jump_if_false", "end"],
      ["check_party_room"],
      ["jump_if_false", "full"],
      ["give_pokemon", species, 30],
      ["set_flag", `EVENT_GOT_${species}`],
      ["set_flag", "EVENT_DEFEATED_FIGHTING_DOJO"],
      ["hide_object", "FIGHTING_DOJO", ball],
      ["show_text", `{PLAYER} got\n${species}!`],
      ["jump", "end"],
      ["label", "full"],
      ["show_text", "You have no room\nfor it!"],
    ] as ScriptRow[];
  };
}

/**
 * Someone who hands over one item, once (gen1recomp story5.lua `gift`): the
 * offer, the item, and a different line ever after. give_item prints the
 * received line itself, with the item's name folded in, and halts the
 * script on a full bag -- the ROM burns the flag even then, and the port
 * keeps its kinder halt-and-retry.
 */
function giftRows(o: {
  flag: string;
  item: string;
  pre: string;
  received: string;
  already: string;
  /** Read after the received line: the "TMxx is ..." page most TM givers add. */
  explain?: string;
}): ScriptRow[] {
  return [
    ["face_player"],
    ["check_flag", o.flag],
    ["jump_if_true", "already"],
    ["show_text", o.pre],
    ["give_item", o.item, 1, o.received],
    ["set_flag", o.flag],
    ...(o.explain ? [["show_text", o.explain]] : []),
    ["jump", "end"],
    ["label", "already"],
    ["show_text", o.already],
  ] as ScriptRow[];
}

/**
 * A CYCLING ROAD gate guard (gen1recomp story5.lua bikeGateGuard). With no
 * BICYCLE in the bag, stepping onto one of the cells beside his counter has
 * him call out, explain, walk you up level with the counter -- as many
 * tiles as you are below it, none when already there (the ROM's
 * wCoordIndex-1) -- and then one tile right, the simulated PAD_RIGHT of
 * Route16Gate1FGuardScript, without which you are left parked against the
 * desk with no way past.
 */
function bikeGate(
  cells: [number, number][],
  stop: string,
  explain: string,
): (ow: any, save: any) => ScriptRow[] | null {
  const closestY = Math.min(...cells.map((c) => c[1]));
  return (ow: any, save: any): ScriptRow[] | null => {
    if ((save?.inventory?.BICYCLE ?? 0) > 0) return null;
    const p = ow?.player;
    if (!cells.some(([x, y]) => p?.cellX === x && p?.cellY === y)) return null;
    const dist = p.cellY - closestY;
    return [
      ["show_text", stop],
      ["show_text", explain],
      ...(dist > 0 ? [["move_player", "up", dist]] : []),
      ["move_player", "right", 1],
    ] as ScriptRow[];
  };
}

/**
 * A fishing guru (VermilionOldRodHouse.asm and its two siblings). The rod is
 * handed over by give_item, which prints the guru's own received line with
 * the rod's name folded into it -- the text is written for exactly that.
 *
 * A "no" is not a refusal to be argued with: he says it is disappointing and
 * that is the end of the conversation. Coming back re-asks.
 */
function rodGiverRows(
  ask: string,
  received: string,
  after: string,
  refused: string,
  rod: string,
  flag: string,
): ScriptRow[] {
  return [
    ["face_player"],
    ["check_flag", flag],
    ["jump_if_true", "already"],
    ["ask", ask],
    ["jump_if_false", "no"],
    ["give_item", rod, 1, received],
    ["set_flag", flag],
    ["jump", "end"],
    ["label", "no"],
    ["show_text", refused],
    ["jump", "end"],
    ["label", "already"],
    ["show_text", after],
  ] as ScriptRow[];
}

/**
 * The SILPH worker's LAPRAS (SilphCo7F.asm). Once, and unconditional -- the
 * only thing gating it is having reached the floor to be thanked on.
 *
 * The description is the second half of the gift AND the whole of what he
 * says afterwards, which is how the original reads it back.
 */
function laprasRows(_ow: any, save: any): ScriptRow[] {
  if (save?.flags?.EVENT_GOT_LAPRAS) {
    return [["show_text", "_SilphCo7FSilphWorkerM1LaprasDescriptionText"]] as ScriptRow[];
  }
  return [
    ["face_player"],
    ["show_text", "_SilphCo7FSilphWorkerM1HaveThisPokemonText"],
    ["give_pokemon", "LAPRAS", 15],
    ["set_flag", "EVENT_GOT_LAPRAS"],
    ["show_text", "_SilphCo7FSilphWorkerM1LaprasDescriptionText"],
  ] as ScriptRow[];
}

/** What the Mt. Moon salesman asks for his MAGIKARP (MtMoonPokecenter.asm). */
const MAGIKARP_PRICE = 500;

/** The staircase cell the Agatha's Room warp lands on. */
const LANCE_STAIRS: [number, number] = [24, 16];

/** WalkToLance, along the floor: (24,16) -> the doorway at (6,11). */
export const LANCE_WALK_IN: [Dir, number][] = [
  ["down", 2],
  ["left", 6],
  ["down", 5],
  ["left", 10],
  ["up", 9],
  ["left", 2],
  ["up", 3],
];

/**
 * Run the walk-in, then seal the door behind them.
 *
 * The landing cell IS the doorway trigger, but a scripted move fires no
 * step, so the lock is called here rather than waited for.
 */
function startLanceWalkIn(ow: any): void {
  if (ow?.runner?.isRunning?.()) return;
  const rows = LANCE_WALK_IN.map(([dir, n]) => ["move_player", dir, n] as ScriptRow);
  ow.runner.run(rows, { onDone: () => ow.lanceLockDoor?.() });
}

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
    // no play_sound row: the cue was misspelled (Get_Item_1) and never
    // existed, and give_item plays the right jingle for the item itself.
    ["give_item", item],
    ["set_flag", flag],
    ["hide_object", mapLabel, textConst],
  ] as ScriptRow[];
}
