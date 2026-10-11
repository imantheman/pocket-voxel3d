// The Gen 1 cartridge save (32 KB of battery SRAM, four 8 KB banks), as the
// US/European Red, Blue and Yellow lay it out. This is the file the 3DS
// re-releases (VC) keep in each title's save data, byte for byte.
//
// Where the numbers come from:
//   - The bank map and the big anchors (player name $2598, Pokédex $25A3 /
//     $25B6, bag $25C9, money $25F3, rival $25F6, options $2601, badges
//     $2602, player ID $2605, PC items $27E6, current box $284C, Hall of
//     Fame count $284E, coins $2850, event flags $29F3, play time $2CED,
//     party $2F2C, current box data $30C0, main checksum $3523, the boxes
//     at $4000 / $6000 with their checksums at $5A4C / $7A4C, the Hall of
//     Fame at $0598, Yellow's PIKACHU friendship at $271C) are the publicly
//     documented Gen 1 save structure (Bulbapedia, "Save data structure
//     (Generation I)", and every save editor since).
//   - Everything between the anchors is the game's own work RAM block
//     ("main data") copied verbatim to $25A3; a field's offset is the sum of
//     the sizes of the fields declared before it, and each neighbouring pair
//     of anchors above checks the sums in between. gen1recomp's MIT-licensed
//     save converter (src/save_convert/GenSave.lua and MapContext.lua at the
//     pin 943ba5dc) did the same walk; the offsets it publishes agree.
//   - Each of these is checked against real cartridge saves by the tests
//     (tests/voxel-vcsave.test.ts) and against the real ROMs in mGBA.
//
// No game code is used here: only where the bytes live.

export const SAVE_SIZE = 0x8000;

/** Bank 0: the Hall of Fame, 50 teams of six 16-byte records. */
export const HOF = 0x0598;
export const HOF_TEAMS = 50;
export const HOF_MON = 16; // species, level, nickname (11), 3 unused

/** Bank 1. */
export const PLAYER_NAME = 0x2598; // 11 bytes, $50-terminated
/** The start of the main data block; every M.* below is relative to it. */
export const MAIN = 0x25a3;
export const MAIN_SIZE = 1929;

export const M = {
  dexOwned: 0, // 19 bytes, bit (dex - 1)
  dexSeen: 19, // 19
  numBagItems: 38,
  bagItems: 39, // 20 x (item, count) + $FF
  money: 80, // 3 bytes BCD ($25F3)
  rivalName: 83, // 11
  options: 94, // bit 7 animations off, bit 6 SET style, bits 0-3 text delay ($2601)
  badges: 95, // bit 0 first badge .. bit 7 eighth ($2602)
  letterDelay: 97, // text delay flags
  playerId: 98, // 2 bytes, big-endian ($2605)
  musicId: 100, // the current map's music: sound id, audio bank
  musicBank: 101,
  palOffset: 102, // 6 in a dark cave before FLASH, else 0
  curMap: 103,
  viewPointer: 104, // 2 bytes, little-endian: the top-left of the view in the block map buffer
  yCoord: 106,
  xCoord: 107,
  yBlock: 108,
  xBlock: 109,
  lastMap: 110, // the outdoor map a building's exit returns to
  mapHeader: 112, // 10 bytes: the current map's header, as the ROM has it
  connections: 122, // 4 x 11: north, south, west, east (map $FF = none)
  spriteSet: 166, // 11
  spriteSetId: 177,
  backgroundTile: 182,
  numWarps: 183,
  warps: 184, // 32 x (y, x, warp, map)
  destWarpId: 312,
  // 313-440 is unused in Red and Blue; Yellow keeps PIKACHU's here
  pikachuHappiness: 377, // Yellow ($271C)
  pikachuMood: 378, // Yellow, the byte after
  numSigns: 441,
  signCoords: 442, // 16 x (y, x)
  signTexts: 474, // 16
  numSprites: 490,
  spriteData: 493, // 16 x (movement 2, text id)
  spriteExtra: 525, // 16 x (trainer class / item, trainer set)
  height2: 557, // map height and width in 2x2 blocks
  width2: 558,
  playerMovingDir: 561,
  playerLastStopDir: 562,
  playerDir: 563,
  tilesetHeader: 564, // 11: bank, blocks, gfx, collision, 3 counter tiles, grass
  numPcItems: 579, // ($27E6)
  pcItems: 580, // 50 x (item, count) + $FF
  curBox: 681, // bits 0-6 the box (0-11), bit 7 the boxes are set up ($284C)
  numHofTeams: 683, // ($284E)
  coins: 685, // 2 bytes BCD ($2850)
  toggles: 687, // 256 bits: object hidden ($2852)
  progress: 761, // 200 bytes: each map's script position
  hiddenItems: 1017, // 112 bits
  hiddenCoins: 1031, // 16 bits
  walkBikeSurf: 1033, // 0 walking, 1 bike, 2 surfing
  townVisited: 1044, // 16 bits, bit = town map id
  safariSteps: 1046, // 2 bytes big-endian
  fossilItem: 1048,
  fossilMon: 1049,
  rivalStarter: 1054,
  playerStarter: 1056,
  lastBlackoutMap: 1058, // where a blackout or ESCAPE / DIG / TELEPORT lands
  statusFlags1: 1073, // bit 0 STRENGTH in use, 3-5 rods, 6 guards' drink
  statusFlags4: 1079, // bit 0 got LAPRAS
  statusFlags6: 1083, // bit 0 play time counting, bit 5 forced onto the bike
  elite4Flags: 1085, // bit 1 the ELITE FOUR started
  tradeFlags: 1088, // 16 bits: in-game trades done, by trade number
  trashFirst: 1100, // the gym's trash-can locks
  trashSecond: 1101,
  events: 1104, // 2560 bits ($29F3)
  playHours: 1866, // ($2CED)
  playMaxed: 1867,
  playMinutes: 1868,
  playSeconds: 1869,
  playFrames: 1870,
  safariGameOver: 1871,
  safariBalls: 1872,
  daycareInUse: 1873,
  daycareName: 1874, // 11
  daycareOt: 1885, // 11
  daycareMon: 1896, // a box record (33)
} as const;

/** Sprite state: 16 slots x 16 bytes, twice ($2D2C). */
export const SPRITE_DATA = MAIN + MAIN_SIZE;
export const SPRITE_DATA_SIZE = 512;
/** The party: count, species list, 6 records, 6 OT names, 6 nicknames ($2F2C). */
export const PARTY = SPRITE_DATA + SPRITE_DATA_SIZE;
/** The current box's working copy ($30C0); the box it is lives in its bank too. */
export const CUR_BOX = PARTY + 404;
export const BOX_SIZE = 1122;
/** The tileset's animation mode, the last byte the main checksum covers. */
export const TILE_ANIMATIONS = CUR_BOX + BOX_SIZE;
export const MAIN_CHECKSUM = TILE_ANIMATIONS + 1; // $3523, over $2598..$3522

/** Banks 2 and 3: boxes 1-6 and 7-12, then a checksum over all six and one each. */
export const BOX_BANKS = [0x4000, 0x6000] as const;
export const BOX_BANK_CHECKSUM = 6 * BOX_SIZE; // relative to the bank

export const NAME_LEN = 11;
export const PARTY_MON = 44;
export const BOX_MON = 33;
export const MONS_PER_BOX = 20;
export const BOXES = 12;
