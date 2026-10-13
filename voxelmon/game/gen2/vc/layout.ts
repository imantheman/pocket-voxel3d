// Where everything lives in a Gen 2 cartridge save (32 KB battery RAM), for
// the 3DS's own re-releases (VC) of Gold, Silver and Crystal.
//
// Sources, in the order they were used:
//   - the publicly documented save structure (Bulbapedia, "Save data
//     structure (Generation II)"): the checksums and their ranges, the check
//     bytes, player name/ID, money, the pockets, party, boxes, the dex;
//   - the ROMs themselves (tools/vc2/romfacts.ts reads them by shape): the
//     three WRAM blocks the save routine copies and where each lands, the
//     backup copy, the map scene table and the engine flag table. The test
//     suite checks every table here against the ROMs when they are present;
//   - offsets between the documented anchors, walked by field size, and
//     checked against saves the real cartridges wrote (made in a headless
//     emulator and in mGBA, tests/voxel-gen2-vcsave.test.ts);
//   - gen1recomp's MIT tree (bdfac727, src/save_convert/Gen2Layout.lua), a
//     table of the same facts, used only to cross-check.
//
// Every offset is into the 32 KB file (bank n at n * $2000). "Main" offsets
// are the primary copy; the backup copy holds the same three blocks (Gold and
// Silver split it in pieces, Crystal keeps it whole) and its own checksum.

export type Engine = "gs" | "crystal";

export const SAVE_SIZE = 0x8000;
export const NAME_LEN = 11; // NAME_LENGTH: 10 characters and the terminator
export const BOX_NAME_LEN = 9;
export const MONS_PER_BOX = 20;
export const NUM_BOXES = 14;
export const BOX_MON_LEN = 32;
export const PARTY_MON_LEN = 48;
export const BOX_LEN = 0x44e; // count, 21 species, 20 mons, 20 OT names, 20 nicknames
export const CHECK_1 = 0x63;
export const CHECK_2 = 0x7f;
export const HOF_TEAMS = 30;
export const HOF_LEN = 0x62;

/** One WRAM block the save routine copies, and where its main copy lands. */
export interface Block { sram: number; wram: number; len: number }

export interface Layout {
  engine: Engine;
  options: number; // 8 bytes (wOptions..)
  check1: number;
  main: number; // first byte of the checksummed run
  mainEnd: number; // one past its last byte
  checksum: number; // 16-bit sum of main..mainEnd-1, little endian
  check2: number;
  blocks: Block[];
  /** The backup copy: each piece [backup offset, main offset, length]. */
  backup: [number, number, number][];
  backupOptions: number;
  backupCheck1: number;
  backupCheck2: number;
  backupChecksum: number;

  playerId: number; playerName: number; momName: number; rivalName: number; redName: number; greenName: number;
  savedAtLeastOnce: number; spawnAfterChampion: number;
  startTime: number; // wStartDay, wStartHour, wStartMinute, wStartSecond
  dst: number;
  timeCap: number; hours: number; minutes: number; seconds: number; frames: number;
  playerStruct: number; mapObjects: number; objectMasks: number; variableSprites: number;
  statusFlags: number; statusFlags2: number;
  money: number; momMoney: number; momSaving: number; coins: number;
  badges: number; kantoBadges: number; tmhm: number;
  numItems: number; numKeyItems: number; numBalls: number; numPcItems: number;
  pokegearFlags: number; radioTuning: number; lastDexMode: number; whichRegisteredItem: number; registeredItem: number;
  playerState: number; hofCount: number;
  eventFlags: number; curBox: number; boxNames: number; decorations: number;
  /** wCurMapSceneScriptPointer, then the caller, then the map's event and
   *  script lists as (count, pointer) triples. */
  mapEvents: number;
  whichMomItem: number; whichMomItemSet: number; momItemTrigger: number;
  visitedSpawns: number; digWarp: number; backupWarp: number; lastSpawn: number; warpNumber: number;
  mapGroup: number; mapNumber: number; y: number; x: number; screenSave: number;
  partyCount: number; partySpecies: number; partyMons: number; partyOts: number; partyNicks: number;
  dexCaught: number; dexSeen: number; unownDex: number; unlockedUnowns: number; firstUnownSeen: number;
  dayCareMan: number; breedMon1: number; dayCareLady: number; stepsToEgg: number; breedMother: number; breedMon2: number;
  egg: number; contestSecondSpecies: number; contestMon: number;
  swarmMap: number; fishingSwarm: number; roamers: number; roamerCurMap: number;
  magikarpFeet: number; magikarpInches: number; magikarpHolder: number;
  /** sBox: the current box's working copy (its bank slot is stale). */
  box: number;
  boxBanks: number[];
  hallOfFame: number;
  /** Crystal: wPlayerGender and the bytes saved beside it. */
  crystalData?: number;
  /** Map id -> the main offset of its scene byte (MapScenes). */
  scenes: Record<string, number>;
  /** Engine flag id -> [main offset, mask], or null for a flag the save does
   *  not keep (it lives in WRAM outside the saved blocks). */
  engineFlags: ([number, number] | null)[];
}

// ---------------------------------------------------------------------------
// the ROM tables (tools/vc2/romfacts.ts), as offsets into the save

/** The map scene table's maps in ROM order; their bytes run consecutively. */
const SCENES_GS = [
  "POKECENTER_2F", "TRADE_CENTER", "COLOSSEUM", "TIME_CAPSULE", "POWER_PLANT", "CERULEAN_GYM", "ROUTE_25",
  "TRAINER_HOUSE_B1F", "VICTORY_ROAD_GATE", "SAFFRON_MAGNET_TRAIN_STATION", "ROUTE_16_GATE", "ROUTE_17_ROUTE_18_GATE",
  "INDIGO_PLATEAU_POKECENTER_1F", "WILLS_ROOM", "KOGAS_ROOM", "BRUNOS_ROOM", "KARENS_ROOM", "LANCES_ROOM",
  "HALL_OF_FAME", "ROUTE_27", "NEW_BARK_TOWN", "ELMS_LAB", "PLAYERS_HOUSE_1F", "ROUTE_29", "CHERRYGROVE_CITY",
  "MR_POKEMONS_HOUSE", "ROUTE_32", "ROUTE_35_NATIONAL_PARK_GATE", "ROUTE_36_NATIONAL_PARK_GATE", "AZALEA_TOWN",
  "GOLDENROD_GYM", "GOLDENROD_MAGNET_TRAIN_STATION", "OLIVINE_CITY", "ROUTE_34", "ECRUTEAK_TIN_TOWER_ENTRANCE",
  "ECRUTEAK_POKECENTER_1F", "MAHOGANY_TOWN", "ROUTE_43_GATE", "MOUNT_MOON", "SPROUT_TOWER_3F", "BURNED_TOWER_1F",
  "BURNED_TOWER_B1F", "RADIO_TOWER_5F", "RUINS_OF_ALPH_OUTSIDE", "RUINS_OF_ALPH_RESEARCH_CENTER",
  "RUINS_OF_ALPH_INNER_CHAMBER", "MAHOGANY_MART_1F", "TEAM_ROCKET_BASE_B1F", "TEAM_ROCKET_BASE_B2F",
  "TEAM_ROCKET_BASE_B3F", "GOLDENROD_UNDERGROUND_SWITCH_ROOM_ENTRANCES", "SILVER_CAVE_ROOM_3", "VICTORY_ROAD",
  "DRAGONS_DEN_B1F", "OLIVINE_PORT", "VERMILION_PORT", "FAST_SHIP_1F", "FAST_SHIP_B1F", "MOUNT_MOON_SQUARE",
];
const SCENES_CRYSTAL = [
  "POKECENTER_2F", "TRADE_CENTER", "COLOSSEUM", "TIME_CAPSULE", "POWER_PLANT", "CERULEAN_GYM", "ROUTE_25",
  "TRAINER_HOUSE_B1F", "VICTORY_ROAD_GATE", "SAFFRON_MAGNET_TRAIN_STATION", "ROUTE_16_GATE", "ROUTE_17_ROUTE_18_GATE",
  "INDIGO_PLATEAU_POKECENTER_1F", "WILLS_ROOM", "KOGAS_ROOM", "BRUNOS_ROOM", "KARENS_ROOM", "LANCES_ROOM",
  "HALL_OF_FAME", "ROUTE_27", "NEW_BARK_TOWN", "ELMS_LAB", "PLAYERS_HOUSE_1F", "ROUTE_29", "CHERRYGROVE_CITY",
  "MR_POKEMONS_HOUSE", "ROUTE_32", "ROUTE_35_NATIONAL_PARK_GATE", "ROUTE_36", "ROUTE_36_NATIONAL_PARK_GATE",
  "AZALEA_TOWN", "GOLDENROD_GYM", "GOLDENROD_MAGNET_TRAIN_STATION", "GOLDENROD_POKECENTER_1F", "OLIVINE_CITY",
  "ROUTE_34", "ROUTE_34_ILEX_FOREST_GATE", "ECRUTEAK_TIN_TOWER_ENTRANCE", "WISE_TRIOS_ROOM", "ECRUTEAK_POKECENTER_1F",
  "ECRUTEAK_GYM", "MAHOGANY_TOWN", "ROUTE_42", "CIANWOOD_CITY", "BATTLE_TOWER_1F", "BATTLE_TOWER_BATTLE_ROOM",
  "BATTLE_TOWER_ELEVATOR", "BATTLE_TOWER_HALLWAY", "BATTLE_TOWER_OUTSIDE", "ROUTE_43_GATE", "MOUNT_MOON",
  "SPROUT_TOWER_3F", "TIN_TOWER_1F", "BURNED_TOWER_1F", "BURNED_TOWER_B1F", "RADIO_TOWER_5F", "RUINS_OF_ALPH_OUTSIDE",
  "RUINS_OF_ALPH_RESEARCH_CENTER", "RUINS_OF_ALPH_HO_OH_CHAMBER", "RUINS_OF_ALPH_KABUTO_CHAMBER",
  "RUINS_OF_ALPH_OMANYTE_CHAMBER", "RUINS_OF_ALPH_AERODACTYL_CHAMBER", "RUINS_OF_ALPH_INNER_CHAMBER",
  "MAHOGANY_MART_1F", "TEAM_ROCKET_BASE_B1F", "TEAM_ROCKET_BASE_B2F", "TEAM_ROCKET_BASE_B3F",
  "GOLDENROD_UNDERGROUND_SWITCH_ROOM_ENTRANCES", "SILVER_CAVE_ROOM_3", "VICTORY_ROAD", "DRAGONS_DEN_B1F",
  "DRAGON_SHRINE", "OLIVINE_PORT", "VERMILION_PORT", "FAST_SHIP_1F", "FAST_SHIP_B1F", "MOUNT_MOON_SQUARE",
  "MOBILE_TRADE_ROOM", "MOBILE_BATTLE_ROOM",
];

/** The engine flag table as [WRAM address, mask] rows, by flag id. */
const EF_GS: [number, number][] = [
  [0xd67c, 2], [0xd67c, 1], [0xd67c, 4], [0xd67c, 8], [0xd67c, 0x80], [0xdc40, 0x40], [0xdc40, 1], [0xdc77, 1],
  [0xd579, 1], [0xd579, 0x80], [0xd983, 1], [0xd571, 1], [0xd571, 2], [0xd571, 8], [0xd571, 0x10], [0xd571, 0x40],
  [0xd572, 4], [0xd572, 2], [0xd572, 1], [0xd572, 0x10], [0xd572, 0x20], [0xd572, 0x40], [0xd572, 0x80],
  [0xd93f, 1], [0xd93f, 2], [0xd93f, 4],
];
const EF_CRYSTAL: [number, number][] = [
  [0xd957, 2], [0xd957, 1], [0xd957, 4], [0xd957, 8], [0xd957, 0x80], [0xdef5, 0x40], [0xdef5, 1], [0xdf2c, 1],
  [0xd854, 1], [0xd854, 0x80], [0xdc39, 1], [0xd84c, 1], [0xd84c, 2], [0xd84c, 8], [0xd84c, 0x10], [0xd84c, 0x40],
  [0xd84c, 0x80], [0xd84d, 4], [0xd84d, 2], [0xd84d, 1], [0xd84d, 0x10], [0xd84d, 0x20], [0xd84d, 0x40], [0xd84d, 0x80],
  [0xdbf5, 1], [0xdbf5, 2], [0xdbf5, 4],
];
/** Runs of consecutive bits: [first address, first bit, count, (skip bit)]. */
function bitsFrom(addr: number, count: number, skip: number[] = [], firstBit = 0): [number, number][] {
  const out: [number, number][] = [];
  let a = addr, b = firstBit;
  while (out.length < count) {
    if (!skip.includes(a * 8 + b)) out.push([a, 1 << b]);
    if (++b === 8) { b = 0; a++; }
  }
  return out;
}
// badges (16), unlocked Unown sets (8), flypoints (27, bit 1 of the third
// byte unused and skipped), then the rows after them
EF_GS.push(
  ...bitsFrom(0xd57c, 16), ...bitsFrom(0xdc3e, 8), ...bitsFrom(0xd9ee, 27, [0xd9f0 * 8 + 1, 0xd9f1 * 8 + 3]),
  [0xd9e7, 1], [0xd572, 8], ...bitsFrom(0xd968, 14),
);
EF_CRYSTAL.push(
  ...bitsFrom(0xd857, 16), ...bitsFrom(0xdef3, 8), ...bitsFrom(0xdca5, 27, [0xdca7 * 8 + 1, 0xdca8 * 8 + 3]),
  [0xdc9d, 1], [0xd84d, 8], ...bitsFrom(0xdc1e, 18), [0xcfbc, 0x80], [0xd472, 1], [0xdbf3, 4],
  ...bitsFrom(0xdc4c, 24), ...bitsFrom(0xdc50, 10), ...bitsFrom(0xdc54, 24), [0xd45b, 4], [0xdc20, 4], [0xdc20, 8],
);

// ---------------------------------------------------------------------------

const L_BOXNAMES = NUM_BOXES * BOX_NAME_LEN;

function make(engine: Engine): Layout {
  const gs = engine === "gs";
  // the three blocks (ROM): player data, current map data, party/dex data
  const blocks: Block[] = gs
    ? [{ sram: 0x2009, wram: 0xd1a1, len: 0x84d }, { sram: 0x2856, wram: 0xd9ee, len: 0x34 }, { sram: 0x288a, wram: 0xda22, len: 0x4df }]
    : [{ sram: 0x2009, wram: 0xd47b, len: 0x82a }, { sram: 0x2833, wram: 0xdca5, len: 0x32 }, { sram: 0x2865, wram: 0xdcd7, len: 0x31e }];
  const toSram = (w: number): number | null => {
    if (w >= 0xd000 && w < 0xe000) for (const b of blocks) if (w >= b.wram && w < b.wram + b.len) return b.sram + w - b.wram;
    return null;
  };
  const d = gs ? 0 : -1; // Crystal's player block runs one byte earlier from the clock on
  const party = gs ? 0x288a : 0x2865;
  const cm = gs ? 0x2856 : 0x2833;
  const dex = party + 1 + 7 + 6 * PARTY_MON_LEN + 6 * NAME_LEN * 2 + 22;
  const unown = dex + 64;
  const dayCare = unown + 26 + 2;
  const egg = dayCare + 1 + 2 * NAME_LEN + BOX_MON_LEN + 3 + 2 * NAME_LEN + BOX_MON_LEN;
  const contest = egg + 2 * NAME_LEN + BOX_MON_LEN;
  const roam = contest + 1 + PARTY_MON_LEN + 3;
  const scenes: Record<string, number> = {};
  (gs ? SCENES_GS : SCENES_CRYSTAL).forEach((m, i) => { scenes[m] = (gs ? 0x251f : 0x2500) + i; });
  const banks: number[] = [];
  for (let i = 0; i < NUM_BOXES; i++) banks.push(i < 7 ? 0x4000 + i * 0x450 : 0x6000 + (i - 7) * 0x450);
  const L: Layout = {
    engine,
    options: 0x2000,
    check1: 0x2008,
    main: 0x2009,
    mainEnd: gs ? 0x2d69 : 0x2b83,
    checksum: gs ? 0x2d69 : 0x2d0d,
    check2: gs ? 0x2d6b : 0x2d0f,
    blocks,
    backup: gs
      ? [[0x15c7, 0x2009, 0x226], [0x3d96, 0x222f, 0x1aa], [0x0c6b, 0x23d9, 0x47d], [0x7e39, 0x2856, 0x34], [0x10e8, 0x288a, 0x4df]]
      : [[0x1209, 0x2009, 0xb7a]],
    backupOptions: gs ? 0x7e30 : 0x1200,
    backupCheck1: gs ? 0x7e38 : 0x1208,
    backupCheck2: gs ? 0x7e6f : 0x1f0f,
    backupChecksum: gs ? 0x7e6d : 0x1f0d,

    playerId: 0x2009, playerName: 0x200b, momName: 0x2016, rivalName: 0x2021, redName: 0x202c, greenName: 0x2037,
    savedAtLeastOnce: 0x2042, spawnAfterChampion: 0x2043,
    startTime: 0x2044,
    dst: gs ? 0x2050 : 0x2050,
    timeCap: 0x2052 + d, hours: 0x2053 + d, minutes: 0x2055 + d, seconds: 0x2056 + d, frames: 0x2057 + d,
    playerStruct: 0x2065 + d, mapObjects: 0x22ad + d, objectMasks: 0x23ad + d, variableSprites: 0x23bd + d,
    statusFlags: gs ? 0x23d9 : 0x23da, statusFlags2: gs ? 0x23da : 0x23db,
    money: gs ? 0x23db : 0x23dc, momMoney: gs ? 0x23de : 0x23df, momSaving: gs ? 0x23e1 : 0x23e2,
    coins: gs ? 0x23e2 : 0x23e3, badges: gs ? 0x23e4 : 0x23e5, kantoBadges: gs ? 0x23e5 : 0x23e6, tmhm: gs ? 0x23e6 : 0x23e7,
    numItems: gs ? 0x241f : 0x2420, numKeyItems: gs ? 0x2449 : 0x244a, numBalls: gs ? 0x2464 : 0x2465,
    numPcItems: gs ? 0x247e : 0x247f,
    pokegearFlags: gs ? 0x24e4 : 0x24e5, radioTuning: gs ? 0x24e5 : 0x24e6, lastDexMode: gs ? 0x24e6 : 0x24e7,
    whichRegisteredItem: gs ? 0x24e8 : 0x24e9, registeredItem: gs ? 0x24e9 : 0x24ea, playerState: gs ? 0x24ea : 0x24eb,
    hofCount: gs ? 0x24eb : 0x24ec,
    eventFlags: gs ? 0x261f : 0x2600, curBox: gs ? 0x2724 : 0x2700, boxNames: gs ? 0x2727 : 0x2703,
    mapEvents: (gs ? 0x2727 : 0x2703) + L_BOXNAMES + 4,
    decorations: gs ? 0x27c1 : 0x279d, whichMomItem: gs ? 0x27c9 : 0x27a5, whichMomItemSet: gs ? 0x27ca : 0x27a6,
    momItemTrigger: gs ? 0x27cb : 0x27a7,
    visitedSpawns: cm, digWarp: cm + 4, backupWarp: cm + 7, lastSpawn: gs ? cm + 15 : cm + 13, warpNumber: gs ? cm + 17 : cm + 15,
    mapGroup: gs ? 0x2868 : 0x2843, mapNumber: gs ? 0x2869 : 0x2844, y: gs ? 0x286a : 0x2845, x: gs ? 0x286b : 0x2846,
    screenSave: gs ? 0x286c : 0x2847,
    partyCount: party, partySpecies: party + 1, partyMons: party + 8,
    partyOts: party + 8 + 6 * PARTY_MON_LEN, partyNicks: party + 8 + 6 * PARTY_MON_LEN + 6 * NAME_LEN,
    dexCaught: dex, dexSeen: dex + 32, unownDex: unown, unlockedUnowns: unown + 26, firstUnownSeen: unown + 27,
    dayCareMan: dayCare, breedMon1: dayCare + 1, dayCareLady: dayCare + 1 + 2 * NAME_LEN + BOX_MON_LEN,
    stepsToEgg: dayCare + 2 + 2 * NAME_LEN + BOX_MON_LEN, breedMother: dayCare + 3 + 2 * NAME_LEN + BOX_MON_LEN,
    breedMon2: dayCare + 4 + 2 * NAME_LEN + BOX_MON_LEN,
    egg, contestSecondSpecies: contest, contestMon: contest + 1,
    swarmMap: contest + 1 + PARTY_MON_LEN, fishingSwarm: contest + 3 + PARTY_MON_LEN,
    roamers: roam, roamerCurMap: roam + 21,
    magikarpFeet: roam + 25, magikarpInches: roam + 26, magikarpHolder: roam + 27,
    box: gs ? 0x2d6c : 0x2d10,
    boxBanks: banks,
    hallOfFame: gs ? 0x321a : 0x32c0,
    crystalData: gs ? undefined : 0x3e3d,
    scenes,
    engineFlags: (gs ? EF_GS : EF_CRYSTAL).map(([w, m]) => {
      const s = toSram(w);
      return s === null ? null : [s, m] as [number, number];
    }),
  };
  return L;
}

export const LAYOUTS: Record<Engine, Layout> = { gs: make("gs"), crystal: make("crystal") };

/** The main-copy offset a WRAM address is saved at, or null. */
export function sramOfWram(L: Layout, wram: number): number | null {
  for (const b of L.blocks) if (wram >= b.wram && wram < b.wram + b.len) return b.sram + wram - b.wram;
  return null;
}
export function wramOfSram(L: Layout, off: number): number | null {
  for (const b of L.blocks) if (off >= b.sram && off < b.sram + b.len) return b.wram + off - b.sram;
  return null;
}
