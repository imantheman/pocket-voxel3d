// Port of gen1recomp src/core/game3/capabilities.lua (GPLv3 + additional terms; see LICENSE.md).
// The capability vocabulary (which game features a profile has), the
// feature table that ties each feature to its modules, and the gates the
// runtime asks (Capabilities.has / gate / nativeAllowed).

import { Profile } from "./profile.ts";
import { pairs, sort, len } from "../platform/lt.ts";
import { tostring } from "../../../import/gen3/lua.ts";

// Lua: capabilities.lua:5-623 (data)
const NAMES: Record<string, any> = {
  easyChat: true,
  braille: true,
  mysteryGift: true,
  unionRoom: true,
  daycare: true,
  pokecenter: true,
  marts: true,
  moveRelearner: true,
  eggs: true,
  berries: true,
  sizeRecord: true, // pokeemerald/src/pokemon_size_record.c
  helpSystem: true, // pokefirered/src/help_system.c
  tmCase: true, // pokefirered/src/tm_case.c
  fameChecker: true, // pokefirered/src/fame_checker.c
  teachyTV: true, // pokefirered/src/teachy_tv.c
  vsSeeker: true, // pokefirered/src/vs_seeker.c
  trainerTower: true, // pokefirered/src/trainer_tower.c
  seagallop: true, // pokefirered/src/seagallop.c
  trainerFanClub: true, // pokefirered/src/trainer_fan_club.c
  sevii: true,
  contests: true,
  secretBase: true,
  battleTower: true,
  berryPouch: true,
  matchCall: true,
  pokeNav: true,
  questLog: true, // pokefirered/src/quest_log.c
  mapPreview: true, // pokefirered/src/map_preview_screen.c
  signpostFrame: true,
  rtc: true, // pokeemerald/src/rtc.c
  tv: true, // pokeemerald/src/tv.c
  berryTrees: true, // pokeemerald/src/berry.c
  pokeblocks: true, // pokeemerald/src/pokeblock.c
  berryBlender: true, // pokeemerald/src/berry_blender.c
  dewfordTrend: true, // pokeemerald/src/dewford_trend.c
  lottery: true, // pokeemerald/src/lottery_corner.c
  mauvilleOldMan: true, // pokeemerald/src/mauville_old_man.c
  lilycoveLady: true, // pokeemerald/src/lilycove_lady.c
  cableCar: true, // pokeemerald/src/cable_car.c
  rayquazaScene: true, // pokeemerald/src/rayquaza_scene.c
  gameCornerRSE: true, // pokeemerald/src/roulette.c
  battleFrontier: true, // pokeemerald/src/frontier_util.c
  battleTents: true, // pokeemerald/src/battle_tent.c
  battlePyramid: true, // pokeemerald/src/battle_pyramid.c
  apprentice: true, // pokeemerald/src/apprentice.c
  trainerHill: true, // pokeemerald/src/trainer_hill.c
  recordMixing: true, // pokeemerald/src/record_mixing.c
  roamerData: true, // pokeemerald/src/roamer.c
  decorations: true, // pokeemerald/src/decoration.c
  wallClock: true, // pokeemerald/src/wallclock.c
  contestPainting: true, // pokeemerald/src/contest_painting.c
  berryTag: true, // pokeemerald/src/berry_tag_screen.c
  pyramidBag: true, // pokeemerald/src/battle_pyramid_bag.c
  frontierPass: true, // pokeemerald/src/frontier_pass.c
  ribbons: true, // pokeemerald/src/pokenav_ribbons_list.c
  trainersEyes: true,
  dive: true, // pokeemerald/src/field_effect.c
  machAcroBike: true, // pokeemerald/src/bike.c
  secretBaseField: true, // pokeemerald/src/secret_base.c
  mirageTower: true, // pokeemerald/src/mirage_tower.c
  rseFieldSpecials: true, // pokeemerald/src/field_specials.c
};

const CORE: Record<string, any> = {
  easyChat: true, braille: true, mysteryGift: true, unionRoom: true,
  daycare: true, pokecenter: true, marts: true, moveRelearner: true,
  eggs: true, berries: true, sizeRecord: true,
};

const FRLG: Record<string, any> = {
  easyChat: true, braille: true, mysteryGift: true, unionRoom: true,
  daycare: true, pokecenter: true, marts: true, moveRelearner: true,
  eggs: true, berries: true, sizeRecord: true,
  helpSystem: true, tmCase: true, fameChecker: true, teachyTV: true,
  vsSeeker: true, trainerTower: true, seagallop: true,
  trainerFanClub: true, berryPouch: true, sevii: true,
};

const RSE: Record<string, any> = {
  easyChat: true, braille: true, mysteryGift: true, unionRoom: true,
  daycare: true, pokecenter: true, marts: true, moveRelearner: true,
  eggs: true, berries: true, sizeRecord: true,
  battleTower: true, // pokeemerald/src/battle_tower.c
  contests: true, secretBase: true, pokeNav: true,
  rtc: true, tv: true, berryTrees: true, pokeblocks: true, berryBlender: true,
  dewfordTrend: true, lottery: true, mauvilleOldMan: true, cableCar: true,
  gameCornerRSE: true, recordMixing: true, roamerData: true, decorations: true,
  wallClock: true, contestPainting: true, berryTag: true, ribbons: true,
  dive: true, machAcroBike: true, secretBaseField: true, mirageTower: true,
  rseFieldSpecials: true,
};

const EMERALD: Record<string, any> = {
  matchCall: true, // pokeemerald/src/match_call.c
  battleFrontier: true, battleTents: true, battlePyramid: true, pyramidBag: true,
  frontierPass: true, apprentice: true, trainerHill: true, lilycoveLady: true,
  rayquazaScene: true,
};

const FEATURES: Record<string, any> = {
  fame_checker: {
    cap: "fameChecker",
    label: "Fame Checker",
    source: "pokefirered/src/fame_checker.c",
    counterpart: "absent from pokeemerald/pokeruby (ITEM_FAME_CHECKER is a leftover constant)",
    core: "src.core.game3.fame_checker",
    ui: "src.ui.game3.fame_checker",
    extractor: "fame_checker_extract",
    natives: "natives_fame",
  },
  teachy_tv: {
    cap: "teachyTV",
    label: "Teachy TV",
    source: "pokefirered/src/teachy_tv.c",
    counterpart: "absent from pokeemerald/pokeruby (ITEM_TEACHY_TV is a leftover constant)",
    core: "src.core.game3.teachy_tv",
    ui: "src.ui.game3.teachy_tv",
    extractor: "teachy_tv_extract",
  },
  vs_seeker: {
    cap: "vsSeeker",
    label: "VS Seeker",
    source: "pokefirered/src/vs_seeker.c",
    counterpart: "absent from pokeemerald/pokeruby (ITEM_VS_SEEKER is a leftover constant)",
    core: "src.core.game3.vs_seeker",
    data: "src.core.game3.vs_seeker_data",
  },
  trainer_tower: {
    cap: "trainerTower",
    label: "Trainer Tower",
    source: "pokefirered/src/trainer_tower.c",
    counterpart: "absent from pokeemerald/pokeruby (Emerald's src/battle_tower.c is a different mode)",
    core: "src.core.game3.trainer_tower",
    ui: "src.ui.game3.trainer_tower_records",
    extractor: "trainer_tower_extract",
    natives: "natives_tower",
  },
  seagallop: {
    cap: "seagallop",
    label: "Seagallop ferry",
    source: "pokefirered/src/seagallop.c",
    counterpart: "absent from pokeemerald/pokeruby",
    natives: "natives_seagallop",
    extractor: "seagallop_extract",
  },
  help_system: {
    cap: "helpSystem",
    label: "Help System",
    source: "pokefirered/src/help_system.c",
    counterpart: "absent from pokeemerald/pokeruby",
    ui: "src.ui.game3.help_system",
    extractor: "help_extract",
  },
  tm_case: {
    cap: "tmCase",
    label: "TM Case",
    source: "pokefirered/src/tm_case.c",
    counterpart: "absent from pokeemerald/pokeruby",
    ui: "src.ui.game3.tm_case",
    extractor: "tm_case_extract",
  },
  trainer_fan_club: {
    cap: "trainerFanClub",
    label: "Trainer Fan Club",
    source: "pokefirered/src/trainer_fan_club.c",
    counterpart: "absent from pokeemerald/pokeruby",
    core: "src.core.game3.trainer_fan_club",
    natives: "natives_fan_club",
  },
  berry_pouch: {
    cap: "berryPouch",
    label: "Berry Pouch",
    source: "pokefirered/src/berry_pouch.c",
    counterpart: "absent from pokeemerald/pokeruby (RSE keeps berries in the bag)",
    ui: "src.ui.game3.berry_pouch",
    extractor: "berry_pouch_extract",
  },
  contests: {
    cap: "contests",
    label: "Pokemon Contests",
    source: "pokeemerald/src/contest.c",
    counterpart: "absent from pokefirered",
    core: "src.core.game3.rse.contest",
    ui: "src.ui.game3.rse.contest",
    extractor: "rse/contest_gfx_extract",
    natives: "natives_contest",
  },
  secret_base: {
    cap: "secretBase",
    label: "Secret Bases",
    source: "pokeemerald/src/secret_base.c",
    counterpart: "absent from pokefirered",
    core: "src.core.game3.rse.secret_base",
    ui: "src.ui.game3.rse.decoration",
    extractor: "rse/secret_base_extract",
    natives: "natives_secret_base",
  },
  match_call: {
    cap: "matchCall",
    label: "Match Call (Emerald)",
    source: "pokeemerald/src/match_call.c",
    counterpart: "absent from pokefirered and pokeruby (RS use the PokeNav)",
    core: "src.core.game3.rse.match_call",
    ui: "src.ui.game3.rse.pokenav.init",
    natives: "natives_match_call",
  },
  poke_nav: {
    cap: "pokeNav",
    label: "PokeNav",
    source: "pokeemerald/src/pokenav.c",
    counterpart: "absent from pokefirered",
  },
  quest_log: {
    cap: "questLog",
    label: "Quest Log",
    source: "pokefirered/src/quest_log.c",
    counterpart: "absent from pokeemerald/pokeruby",
  },
  map_preview: {
    cap: "mapPreview",
    label: "Map preview",
    source: "pokefirered/src/map_preview_screen.c",
    counterpart: "absent from pokeemerald/pokeruby",
  },
  rtc: {
    cap: "rtc",
    label: "Real-time clock",
    source: "pokeemerald/src/rtc.c",
    counterpart: "pokefirered has no RTC",
  },
  tv: {
    cap: "tv",
    label: "TV shows",
    source: "pokeemerald/src/tv.c",
    counterpart: "absent from pokefirered",
    core: "src.core.game3.rse.tv",
    natives: "natives_tv",
  },
  rse_field_specials: {
    cap: "rseFieldSpecials",
    label: "Hoenn field specials",
    source: "pokeemerald/src/field_specials.c",
    counterpart: "pokefirered/src/field_specials.c carries the Kanto set",
    ui: "src.ui.game3.rse.starter_choose",
    extractor: "rse/extract_starter_choose_rse",
    natives: "natives_field_rse",
  },
  rse_field_puzzles: {
    cap: "rseFieldSpecials",
    label: "Hoenn field puzzles and scenes",
    source: "pokeemerald/src/rotating_gate.c",
    counterpart: "absent from pokefirered",
    natives: "natives_puzzles_rse",
  },
  rse_region_map: {
    cap: "rseFieldSpecials",
    label: "Hoenn region map",
    source: "pokeemerald/src/region_map.c",
    counterpart: "pokefirered/src/region_map.c (Kanto/Sevii)",
    ui: "src.ui.game3.rse.region_map",
    extractor: "rse/region_map_extract",
    natives: "natives_region_map_rse",
  },
  rse_pc: {
    cap: "rseFieldSpecials",
    label: "Hoenn PC and Hall of Fame",
    source: "pokeemerald/src/player_pc.c",
    counterpart: "pokefirered/src/player_pc.c",
    natives: "natives_pc_rse",
  },
  rse_story_battles: {
    cap: "rseFieldSpecials",
    label: "Hoenn story special battles",
    source: "pokeemerald/src/battle_tower.c",
    counterpart: "pokefirered/src/battle_setup.c (Kanto legendary/old man starts)",
    natives: "natives_frontier_story",
  },
  berry_trees: {
    cap: "berryTrees",
    label: "Berry trees",
    source: "pokeemerald/src/berry.c",
    counterpart: "absent from pokefirered (berries are items only)",
    natives: "natives_berry",
  },
  pokeblocks: {
    cap: "pokeblocks",
    label: "Pokeblocks",
    source: "pokeemerald/src/pokeblock.c",
    counterpart: "absent from pokefirered",
    natives: "natives_pokeblock",
  },
  berry_blender: {
    cap: "berryBlender",
    label: "Berry Blender",
    source: "pokeemerald/src/berry_blender.c",
    counterpart: "absent from pokefirered",
    natives: "natives_blender",
  },
  dewford_trend: {
    cap: "dewfordTrend",
    label: "Dewford trends",
    source: "pokeemerald/src/dewford_trend.c",
    counterpart: "absent from pokefirered",
    natives: "natives_dewford",
  },
  lottery: {
    cap: "lottery",
    label: "Lottery Corner",
    source: "pokeemerald/src/lottery_corner.c",
    counterpart: "absent from pokefirered",
    natives: "natives_lottery",
  },
  mauville_old_man: {
    cap: "mauvilleOldMan",
    label: "Mauville old man",
    source: "pokeemerald/src/mauville_old_man.c",
    counterpart: "absent from pokefirered",
    natives: "natives_old_man",
  },
  lilycove_lady: {
    cap: "lilycoveLady",
    label: "Lilycove lady",
    source: "pokeemerald/src/lilycove_lady.c",
    counterpart: "absent from pokefirered and pokeruby",
    natives: "natives_lilycove_lady",
  },
  cable_car: {
    cap: "cableCar",
    label: "Cable car",
    source: "pokeemerald/src/cable_car.c",
    counterpart: "absent from pokefirered",
  },
  rayquaza_scene: {
    cap: "rayquazaScene",
    label: "Rayquaza scenes",
    source: "pokeemerald/src/rayquaza_scene.c",
    counterpart: "absent from pokefirered and pokeruby",
    natives: "natives_scenes_rse",
  },
  game_corner_rse: {
    cap: "gameCornerRSE",
    label: "Mauville Game Corner",
    source: "pokeemerald/src/roulette.c",
    counterpart: "pokefirered/src/slot_machine.c is a different machine",
    natives: "natives_game_corner_rse",
  },
  battle_frontier: {
    cap: "battleFrontier",
    label: "Battle Frontier",
    source: "pokeemerald/src/frontier_util.c",
    counterpart: "absent from pokefirered and pokeruby",
  },
  battle_tents: {
    cap: "battleTents",
    label: "Battle Tents",
    source: "pokeemerald/src/battle_tent.c",
    counterpart: "absent from pokefirered and pokeruby",
  },
  battle_pyramid: {
    cap: "battlePyramid",
    label: "Battle Pyramid",
    source: "pokeemerald/src/battle_pyramid.c",
    counterpart: "absent from pokefirered and pokeruby",
  },
  pyramid_bag: {
    cap: "pyramidBag",
    label: "Pyramid Bag",
    source: "pokeemerald/src/battle_pyramid_bag.c",
    counterpart: "absent from pokefirered and pokeruby",
  },
  frontier_pass: {
    cap: "frontierPass",
    label: "Frontier Pass",
    source: "pokeemerald/src/frontier_pass.c",
    counterpart: "absent from pokefirered and pokeruby",
  },
  apprentice: {
    cap: "apprentice",
    label: "Apprentice",
    source: "pokeemerald/src/apprentice.c",
    counterpart: "absent from pokefirered and pokeruby",
  },
  trainer_hill: {
    cap: "trainerHill",
    label: "Trainer Hill",
    source: "pokeemerald/src/trainer_hill.c",
    counterpart: "absent from pokefirered and pokeruby",
  },
  record_mixing: {
    cap: "recordMixing",
    label: "Record mixing",
    source: "pokeemerald/src/record_mixing.c",
    counterpart: "absent from pokefirered",
  },
  roamer_data: {
    cap: "roamerData",
    label: "Hoenn roamer",
    source: "pokeemerald/src/roamer.c",
    counterpart: "pokefirered/src/roamer.c roams Kanto beasts",
  },
  decorations: {
    cap: "decorations",
    label: "Decorations",
    source: "pokeemerald/src/decoration.c",
    counterpart: "absent from pokefirered",
  },
  wall_clock: {
    cap: "wallClock",
    label: "Wall clock",
    source: "pokeemerald/src/wallclock.c",
    counterpart: "absent from pokefirered",
    natives: "natives_clock",
  },
  contest_painting: {
    cap: "contestPainting",
    label: "Contest painting",
    source: "pokeemerald/src/contest_painting.c",
    counterpart: "absent from pokefirered",
    ui: "src.ui.game3.rse.contest_painting",
    extractor: "rse/contest_painting_extract",
  },
  berry_tag: {
    cap: "berryTag",
    label: "Berry tag",
    source: "pokeemerald/src/berry_tag_screen.c",
    counterpart: "absent from pokefirered",
  },
  ribbons: {
    cap: "ribbons",
    label: "Ribbons",
    source: "pokeemerald/src/pokenav_ribbons_list.c",
    counterpart: "absent from pokefirered",
  },
  dive: {
    cap: "dive",
    label: "Dive",
    source: "pokeemerald/src/field_effect.c",
    counterpart: "absent from pokefirered",
  },
  mach_acro_bike: {
    cap: "machAcroBike",
    label: "Mach and Acro Bikes",
    source: "pokeemerald/src/bike.c",
    counterpart: "pokefirered has one bike",
  },
  mirage_tower: {
    cap: "mirageTower",
    label: "Mirage Tower",
    source: "pokeemerald/src/mirage_tower.c",
    counterpart: "absent from pokefirered",
  },
  frontier_util: {
    cap: "battleFrontier",
    label: "Battle Frontier core",
    source: "pokeemerald/src/frontier_util.c",
    counterpart: "absent from pokefirered and pokeruby",
    core: "src.core.game3.rse.frontier.util",
    ui: "src.ui.game3.rse.frontier_records",
    extractor: "rse/frontier_extract",
    natives: "natives_frontier",
  },
  battle_tower_rse: {
    cap: "battleFrontier",
    label: "Battle Tower",
    source: "pokeemerald/src/battle_tower.c",
    counterpart: "pokefirered/src/battle_tower.c is the unused RS tower",
    core: "src.core.game3.rse.frontier.tower",
    natives: "natives_tower_rse",
  },
  battle_tents_rse: {
    cap: "battleTents",
    label: "Battle Tents",
    source: "pokeemerald/src/battle_tent.c",
    counterpart: "absent from pokefirered and pokeruby",
    core: "src.core.game3.rse.frontier.tents",
    natives: "natives_tents",
  },
  rse_link: {
    cap: "recordMixing",
    label: "Hoenn cable club and record corner",
    source: "pokeemerald/src/cable_club.c",
    counterpart: "pokefirered/src/cable_club.c binds through natives_link",
    core: "src.core.game3.link.record_mix",
    natives: "natives_link_rse",
  },
  battle_factory: {
    cap: "battleFrontier",
    label: "Battle Factory",
    source: "pokeemerald/src/battle_factory.c",
    counterpart: "absent from pokefirered and pokeruby",
    core: "src.core.game3.rse.frontier.factory",
    ui: "src.ui.game3.rse.factory_select",
    extractor: "rse/factory_extract",
    natives: "natives_factory",
  },
  battle_pike: {
    cap: "battleFrontier",
    label: "Battle Pike",
    source: "pokeemerald/src/battle_pike.c",
    counterpart: "absent from pokefirered and pokeruby",
    core: "src.core.game3.rse.frontier.pike",
    extractor: "rse/pike_extract",
    natives: "natives_pike",
  },
  battle_dome: {
    cap: "battleFrontier",
    label: "Battle Dome",
    source: "pokeemerald/src/battle_dome.c",
    counterpart: "absent from pokefirered and pokeruby",
    core: "src.core.game3.rse.frontier.dome",
    ui: "src.ui.game3.rse.dome_tourney",
    extractor: "rse/frontier_f2_extract",
    natives: "natives_dome",
  },
  battle_palace: {
    cap: "battleFrontier",
    label: "Battle Palace",
    source: "pokeemerald/src/battle_palace.c",
    counterpart: "absent from pokefirered and pokeruby",
    core: "src.core.game3.rse.frontier.palace",
    extractor: "rse/frontier_f2_extract",
    natives: "natives_palace",
  },
  battle_arena: {
    cap: "battleFrontier",
    label: "Battle Arena",
    source: "pokeemerald/src/battle_arena.c",
    counterpart: "absent from pokefirered and pokeruby",
    core: "src.core.game3.rse.frontier.arena",
    extractor: "rse/frontier_f2_extract",
    natives: "natives_arena",
  },
  battle_pyramid_rse: {
    cap: "battlePyramid",
    label: "Battle Pyramid",
    source: "pokeemerald/src/battle_pyramid.c",
    counterpart: "absent from pokefirered and pokeruby",
    core: "src.core.game3.rse.frontier.pyramid",
    ui: "src.ui.game3.rse.pyramid_bag",
    extractor: "rse/pyramid_extract",
    natives: "natives_pyramid",
  },
  trainer_hill_rse: {
    cap: "trainerHill",
    label: "Trainer Hill",
    source: "pokeemerald/src/trainer_hill.c",
    counterpart: "absent from pokefirered and pokeruby",
    core: "src.core.game3.rse.trainer_hill",
    ui: "src.ui.game3.rse.trainer_hill_records",
    extractor: "rse/trainer_hill_extract",
    natives: "natives_trainer_hill",
  },
  apprentice_rse: {
    cap: "apprentice",
    label: "Apprentice",
    source: "pokeemerald/src/apprentice.c",
    counterpart: "absent from pokefirered and pokeruby",
    core: "src.core.game3.rse.frontier.apprentice",
    extractor: "rse/apprentice_extract",
    natives: "natives_apprentice",
  },
  event_islands: {
    cap: "rseFieldSpecials",
    label: "Event islands and tickets",
    source: "pokeemerald/src/field_specials.c",
    counterpart: "pokefirered/src/field_specials.c DoDeoxysTriangleInteraction binds through natives_events",
    core: "src.core.game3.rse.event_islands",
    extractor: "rse/event_islands_extract",
    natives: "natives_event_islands",
  },
  shared_specials_rse: {
    cap: "rseFieldSpecials",
    label: "In-game trades, move relearner and move deleter",
    source: "pokeemerald/src/trade.c",
    counterpart: "pokefirered/src/trade_scene.c binds through natives_trade and natives_moveteach",
    core: "src.core.game3.scripting.natives_trade",
    natives: "natives_shared_rse",
  },
  rse_diploma_specials: {
    cap: "rseFieldSpecials", label: "Emerald diploma special", source: "pokeemerald/src/diploma.c",
    counterpart: "profile-specific Emerald UI", natives: "natives_diploma_rse",
  },
  rse_ereader_trainer_specials: {
    cap: "rseFieldSpecials", label: "Emerald saved e-Reader trainer specials",
    source: "pokeemerald/src/battle_tower.c",
    counterpart: "field_specials.c name buffering; e-Reader card import and raw checksum validation are not modeled",
    natives: "natives_ereader_rse",
  },
  rse_easy_chat_profile_specials: {
    cap: "rseFieldSpecials", label: "RSE easy-chat profile specials", source: "pokeemerald/src/easy_chat.c",
    counterpart: "profile-specific RSE data", natives: "natives_easy_chat_profile_rse",
  },
  rse_egg_hatch_specials: {
    cap: "rseFieldSpecials", label: "RSE egg-hatch specials", source: "pokeemerald/src/egg_hatch.c",
    counterpart: "FireRed egg-hatch specials use their own indexed module", natives: "natives_egg_hatch_rse",
  },
  rse_frontier_tutor_specials: {
    cap: "rseFieldSpecials", label: "Emerald Frontier tutor specials", source: "pokeemerald/src/field_specials.c",
    counterpart: "absent from FireRed", natives: "natives_frontier_tutor_rse",
  },
  rse_size_record_specials: {
    cap: "rseFieldSpecials", label: "Emerald size-record specials", source: "pokeemerald/src/pokemon_size_record.c",
    counterpart: "FireRed size records use a separate species set", natives: "natives_size_record_rse",
  },
  rse_walda_specials: {
    cap: "rseFieldSpecials", label: "Walda phrase and wallpaper specials", source: "pokeemerald/src/walda_phrase.c",
    counterpart: "absent from FireRed", natives: "natives_walda_rse",
  },
};

const warned: Record<string, boolean> = {};

// Lua: capabilities.lua:627
function log(msg: unknown): void {
  console.log("[game3/capabilities] " + tostring(msg));
}

// Lua: capabilities.lua:631
function warnOnce(key: string, msg: string): void {
  if (warned[key]) return;
  warned[key] = true;
  log(msg);
}

let nativesIndex: Record<string, string> | undefined;

export const Capabilities = {
  NAMES,
  CORE,
  FRLG,
  RSE,
  EMERALD,
  FEATURES,

  // Lua: capabilities.lua:105
  compose(...tables: unknown[]): Record<string, any> {
    const out: Record<string, any> = {};
    for (const t of tables) {
      for (const [name, value] of pairs(t ?? {})) out[name as string] = value;
    }
    return out;
  },

  // Lua: capabilities.lua:637
  of(session?: any): Record<string, any> {
    return Profile.capabilitiesFor(session);
  },

  // Lua: capabilities.lua:641
  has(session: any, cap: string): boolean {
    if (!NAMES[cap]) {
      warnOnce("cap:" + tostring(cap), "unknown capability '" + tostring(cap) + "'");
      return false;
    }
    return Capabilities.of(session)[cap] === true;
  },

  // Lua: capabilities.lua:649
  enabled(caps: any, featureId: string): boolean {
    const feature = FEATURES[featureId];
    if (!feature || caps == null || typeof caps !== "object") return false;
    return caps[feature.cap] === true;
  },

  // Lua: capabilities.lua:655
  gate(session: any, featureId: string): boolean {
    if (!FEATURES[featureId]) {
      warnOnce("feat:" + tostring(featureId),
        "unknown feature '" + tostring(featureId) + "'");
      return false;
    }
    return Capabilities.enabled(Capabilities.of(session), featureId);
  },

  // Lua: capabilities.lua:666
  nativeFeature(moduleName: unknown): string | undefined {
    nativesIndex = nativesIndex || (() => {
      const index: Record<string, string> = {};
      for (const [id, feature] of pairs(FEATURES)) {
        if (feature.natives) index[feature.natives] = id as string;
      }
      return index;
    })();
    if (typeof moduleName !== "string") return undefined;
    return nativesIndex[moduleName];
  },

  // Lua: capabilities.lua:678
  nativeAllowed(session: any, moduleName: unknown): boolean {
    const featureId = Capabilities.nativeFeature(moduleName);
    if (!featureId) return true;
    return Capabilities.gate(session, featureId);
  },

  // Lua: capabilities.lua:684 -- [ok, problems]
  audit(caps: unknown): [boolean, (string | null)[]] {
    const problems: (string | null)[] = [null];
    if (caps == null || typeof caps !== "object") {
      problems[1] = "capabilities table is missing";
      return [false, problems];
    }
    for (const [name, value] of pairs(caps)) {
      if (!NAMES[name as string]) {
        problems[len(problems) + 1] = "unknown capability '" + tostring(name) + "'";
      } else if (typeof value !== "boolean") {
        problems[len(problems) + 1] =
          "capability '" + name + "' is " + luaType(value) + ", not boolean";
      }
    }
    sort<string>(problems);
    return [len(problems) === 0, problems];
  },

  // Lua: capabilities.lua:702
  reset(): void {
    for (const k of Object.keys(warned)) delete warned[k];
  },
};

function luaType(v: unknown): string {
  if (v == null) return "nil";
  if (typeof v === "object") return "table";
  return typeof v;
}

export default Capabilities;
