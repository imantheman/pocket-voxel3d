// Lua save <-> Gen 1 cartridge save (32 KB SRAM), for the 3DS's own
// re-releases (VC) of Red, Blue and Yellow (US).
//
//   cartToSave(sram, data)              the cartridge save as this game's
//                                       save table (what CONTINUE loads)
//   saveToCart(save, data, template?)   this game's save as a cartridge save;
//                                       `template` is the cartridge save it
//                                       replaces, whose bytes this game does
//                                       not model are kept as they are
//   cartSummary(sram, data)             name, badges, POKéDEX, time: what the
//                                       CONTINUE choice shows
//
// The byte layout is ./layout.ts (where every offset comes from is written
// there). The ROM facts a save has to carry for the map the player stands on
// come from the dataset (gamedata `vcsave`, voxelmon/import/stages/vcsave.ts).
//
// What does not cross, and what is done about it, is listed in LOSSY below.

import * as L from "./layout.ts";
import { M } from "./layout.ts";
import { EVENT_FLAGS_RB, EVENT_FLAGS_YELLOW } from "./eventflags.ts";
import { calc as calcStats, ensure as ensureStats } from "../rules/stats.ts";

/** The ROM facts (gamedata.vcsave). */
export interface VcTables {
  maps: Record<string, { h: string; c: string; o: string; m?: [number, number] }>;
  tilesets: Record<string, string>;
  toggles: [string, number, number][];
  hiddenItems: [string, number, number][];
  hiddenCoins: [string, number, number][];
}

type Obj = { index: number; name?: string; item?: string; pokemon?: string; trainerClass?: string };
/** The dataset subset this reads. */
export interface CartData {
  version?: string | { version?: string };
  pokemon: Record<string, { index?: number; dex?: number; name?: string; types?: string[]; catchRate?: number; baseStats?: Record<string, number>; growthRate?: string }>;
  moves: Record<string, { index?: number; pp?: number }>;
  items: Record<string, { index?: number; machine?: { kind: string; number: number } }>;
  maps?: Record<string, { index?: number; label?: string; tileset?: string; objects?: Obj[]; warps?: { x: number; y: number; destMap: string; destWarp: number }[] }>;
  field?: { darkMaps?: { maps?: string[] }; flyWarps?: Record<string, { x: number; y: number }> };
  trainer_headers?: Record<string, unknown>;
  vcsave?: VcTables;
}

/**
 * What a Lua save keeps that a cartridge save has no room for, and the
 * reverse. Each is handled as described; none is ever guessed at silently.
 */
export const LOSSY = [
  "facing: the cartridge always continues facing down (its main menu sets it)",
  "repel steps, the poison step count and cut trees: not in the cartridge save; a repel wears off, cut trees grow back (as on the cartridge)",
  "this game's own options (camera, tilt, movement, dev menu): not in the cartridge save; a VC session takes them from the Lua save when there is one",
  "Yellow's surfing minigame record: not mapped (a VC session starts it at zero)",
  "the partner's walk-step and emotion counters, and this game's own one-off flags (the cable-club gifts, the champion-run marker): not in the cartridge save",
  "play time frames: the cartridge counts 1/60 s; this game counts whole seconds",
  "each map's script position (wGameProgressFlags) and the engine's scratch bytes: kept from the cartridge save being replaced; a save with none starts them at zero, and the cartridge's map scripts re-check the event flags",
  "mons this game has no data for (unknown species index): left out, with a note",
];

// ---------------------------------------------------------------------------
// bytes

const u8 = (b: Uint8Array, o: number): number => b[o]!;
const u16be = (b: Uint8Array, o: number): number => (b[o]! << 8) | b[o + 1]!;
const u24be = (b: Uint8Array, o: number): number => (b[o]! << 16) | (b[o + 1]! << 8) | b[o + 2]!;
const set8 = (b: Uint8Array, o: number, v: number): void => { b[o] = v & 0xff; };
const set16be = (b: Uint8Array, o: number, v: number): void => { b[o] = (v >> 8) & 0xff; b[o + 1] = v & 0xff; };
const set24be = (b: Uint8Array, o: number, v: number): void => { b[o] = (v >> 16) & 0xff; b[o + 1] = (v >> 8) & 0xff; b[o + 2] = v & 0xff; };
const bit = (b: Uint8Array, base: number, i: number): boolean => ((b[base + (i >> 3)]! >> (i & 7)) & 1) === 1;
function setBit(b: Uint8Array, base: number, i: number, on: boolean): void {
  const o = base + (i >> 3);
  b[o] = on ? b[o]! | (1 << (i & 7)) : b[o]! & ~(1 << (i & 7));
}
function bcd(b: Uint8Array, o: number, n: number): number {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 100 + (b[o + i]! >> 4) * 10 + (b[o + i]! & 15);
  return v;
}
function setBcd(b: Uint8Array, o: number, n: number, v: number): void {
  let x = Math.max(0, Math.floor(v));
  for (let i = n - 1; i >= 0; i--) {
    const d = x % 100;
    x = Math.floor(x / 100);
    b[o + i] = (Math.floor(d / 10) << 4) | (d % 10);
  }
}
const hexBytes = (s: string): number[] => {
  const out: number[] = [];
  for (let i = 0; i + 1 < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out;
};

/** The game's checksum: the complement of the byte sum (CalcCheckSum). */
export function checksum(b: Uint8Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s = (s + b[i]!) & 0xff;
  return ~s & 0xff;
}

/** Whether these bytes are a Gen 1 save: big enough, main checksum right. */
export function isCartSave(b: Uint8Array | null | undefined): boolean {
  return !!b && b.length >= L.SAVE_SIZE && checksum(b, L.PLAYER_NAME, L.MAIN_CHECKSUM) === b[L.MAIN_CHECKSUM];
}

// ---------------------------------------------------------------------------
// text: the game's character set for names (the publicly documented Gen 1
// encoding; $50 ends a name)

const CHARS: [number, string][] = [[0x7f, " "]];
for (let i = 0; i < 26; i++) CHARS.push([0x80 + i, String.fromCharCode(65 + i)], [0xa0 + i, String.fromCharCode(97 + i)]);
for (let i = 0; i < 10; i++) CHARS.push([0xf6 + i, String(i)]);
CHARS.push(
  [0x9a, "("], [0x9b, ")"], [0x9c, ":"], [0x9d, ";"], [0x9e, "["], [0x9f, "]"],
  [0xba, "é"], [0xbb, "'d"], [0xbc, "'l"], [0xbd, "'s"], [0xbe, "'t"], [0xbf, "'v"],
  [0xe0, "'"], [0xe1, "<PK>"], [0xe2, "<MN>"], [0xe3, "-"], [0xe4, "'r"], [0xe5, "'m"],
  [0xe6, "?"], [0xe7, "!"], [0xe8, "."], [0xef, "♂"], [0xf0, "¥"], [0xf1, "×"],
  [0xf3, "/"], [0xf4, ","], [0xf5, "♀"],
);
const BYTE_TO_CHAR = new Map(CHARS);
// longest first, so "'s" wins over "'"
const CHAR_TO_BYTE = CHARS.map(([b, c]) => [c, b] as [string, number]).sort((a, b) => b[0].length - a[0].length);

function readName(b: Uint8Array, o: number, len = L.NAME_LEN): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    const c = b[o + i]!;
    if (c === 0x50) break;
    s += BYTE_TO_CHAR.get(c) ?? "?";
  }
  return s;
}

/** Name text to bytes: at most len-1 characters, then $50. `pad` fills the
 * rest with $50 (a fresh field); otherwise the old tail is left. */
function writeName(b: Uint8Array, o: number, text: string, pad: boolean, len = L.NAME_LEN): void {
  let i = 0;
  let p = 0;
  while (i < len - 1 && p < text.length) {
    let hit: [string, number] | undefined;
    for (const e of CHAR_TO_BYTE) if (text.startsWith(e[0], p)) { hit = e; break; }
    if (hit) { b[o + i] = hit[1]; p += hit[0].length; }
    else { b[o + i] = 0xe6; p += 1; } // "?" for anything the cartridge cannot show
    i++;
  }
  b[o + i] = 0x50;
  if (pad) for (let j = i + 1; j < len; j++) b[o + j] = 0x50;
}

// ---------------------------------------------------------------------------
// the dataset's id <-> the cartridge's numbers

const TYPE_ID: Record<string, number> = {
  NORMAL: 0, FIGHTING: 1, FLYING: 2, POISON: 3, GROUND: 4, ROCK: 5, BIRD: 6, BUG: 7, GHOST: 8,
  FIRE: 20, WATER: 21, GRASS: 22, ELECTRIC: 23, PSYCHIC_TYPE: 24, PSYCHIC: 24, ICE: 25, DRAGON: 26,
};
const BADGES = ["BOULDERBADGE", "CASCADEBADGE", "THUNDERBADGE", "RAINBOWBADGE", "SOULBADGE", "MARSHBADGE", "VOLCANOBADGE", "EARTHBADGE"];

/** Progress this game spells as flags that the cartridge keeps outside its
 * event flags: [byte (main-data offset), bit]. */
const EXTRA_FLAGS: Record<string, [number, number]> = {
  EVENT_GOT_OLD_ROD: [M.statusFlags1, 3],
  EVENT_GOT_GOOD_ROD: [M.statusFlags1, 4],
  EVENT_GOT_SUPER_ROD: [M.statusFlags1, 5],
  EVENT_GAVE_GUARDS_DRINK: [M.statusFlags1, 6],
  EVENT_GOT_LAPRAS: [M.statusFlags4, 0],
  EVENT_STARTED_ELITE_4: [M.elite4Flags, 1],
};
/** The in-game trades, by their number in the trade table (the bit). */
const TRADE_FLAGS: Record<string, number> = {
  EVENT_TRADED_NIDORINO_FOR_NIDORINA: 0,
  EVENT_TRADED_ABRA_FOR_MR_MIME: 1,
  EVENT_TRADED_PONYTA_FOR_SEEL: 3,
  EVENT_TRADED_SPEAROW_FOR_FARFETCHD: 4,
  EVENT_TRADED_SLOWBRO_FOR_LICKITUNG: 5,
  EVENT_TRADED_POLIWHIRL_FOR_JYNX: 6,
  EVENT_TRADED_RAICHU_FOR_ELECTRODE: 7,
  EVENT_TRADED_VENONAT_FOR_TANGELA: 8,
  EVENT_TRADED_NIDORAN_M_FOR_NIDORAN_F: 9,
};
/** This game's name for a flag the cartridge spells another way. */
const FLAG_ALIAS: Record<string, string> = {
  EVENT_RECEIVED_BIKE_VOUCHER: "EVENT_GOT_BIKE_VOUCHER",
  EVENT_BEAT_GIOVANNI: "EVENT_BEAT_VIRIDIAN_GYM_GIOVANNI",
  EVENT_BEAT_MT_MOON_3_SUPER_NERD: "EVENT_BEAT_MT_MOON_EXIT_SUPER_NERD",
};
/** This game's flags for what the cartridge records only by hiding the
 * object: the flag is set exactly when the object is hidden. */
const TOGGLE_FLAGS: Record<string, [string, string]> = {
  EVENT_BEAT_SS_ANNE_RIVAL: ["SS_ANNE_2F", "SSANNE2F_RIVAL"],
  EVENT_BEAT_GAME_CORNER_ROCKET: ["GAME_CORNER", "GAMECORNER_ROCKET"],
  EVENT_GOT_EEVEE: ["CELADON_MANSION_ROOF_HOUSE", "CELADONMANSION_ROOF_HOUSE_EEVEE_POKEBALL"],
  EVENT_GOT_TM28: ["CERULEAN_CITY", "CERULEANCITY_ROCKET"],
};

/** Trainers this game remembers by object (save.defeatedTrainers) whose
 * defeat the cartridge keeps in a named flag (the rest carry their flag in
 * their trainer header). By object name, so a version's numbering does not
 * matter. */
const TRAINER_FLAGS: Record<string, string> = {
  CELADONGYM_ERIKA: "EVENT_BEAT_ERIKA",
  CERULEANCITY_ROCKET: "EVENT_BEAT_CERULEAN_ROCKET_THIEF",
  CERULEANGYM_MISTY: "EVENT_BEAT_MISTY",
  CINNABARGYM_BLAINE: "EVENT_BEAT_BLAINE",
  CINNABARGYM_SUPER_NERD1: "EVENT_BEAT_CINNABAR_GYM_TRAINER_0",
  CINNABARGYM_SUPER_NERD2: "EVENT_BEAT_CINNABAR_GYM_TRAINER_1",
  CINNABARGYM_SUPER_NERD3: "EVENT_BEAT_CINNABAR_GYM_TRAINER_2",
  CINNABARGYM_SUPER_NERD4: "EVENT_BEAT_CINNABAR_GYM_TRAINER_3",
  CINNABARGYM_SUPER_NERD5: "EVENT_BEAT_CINNABAR_GYM_TRAINER_4",
  CINNABARGYM_SUPER_NERD6: "EVENT_BEAT_CINNABAR_GYM_TRAINER_5",
  CINNABARGYM_SUPER_NERD7: "EVENT_BEAT_CINNABAR_GYM_TRAINER_6",
  FIGHTINGDOJO_KARATE_MASTER: "EVENT_BEAT_KARATE_MASTER",
  FUCHSIAGYM_KOGA: "EVENT_BEAT_KOGA",
  GAMECORNER_ROCKET: "EVENT_BEAT_GAME_CORNER_ROCKET", // (a TOGGLE_FLAGS flag)
  OAKSLAB_RIVAL: "EVENT_BATTLED_RIVAL_IN_OAKS_LAB",
  PEWTERGYM_BROCK: "EVENT_BEAT_BROCK",
  ROCKETHIDEOUTB4F_GIOVANNI: "EVENT_BEAT_ROCKET_HIDEOUT_GIOVANNI",
  ROUTE24_COOLTRAINER_M1: "EVENT_BEAT_ROUTE24_ROCKET",
  SAFFRONGYM_SABRINA: "EVENT_BEAT_SABRINA",
  SILPHCO11F_GIOVANNI: "EVENT_BEAT_SILPH_CO_GIOVANNI",
  SSANNE2F_RIVAL: "EVENT_BEAT_SS_ANNE_RIVAL", // (a TOGGLE_FLAGS flag)
  VERMILIONGYM_LT_SURGE: "EVENT_BEAT_LT_SURGE",
  VIRIDIANGYM_GIOVANNI: "EVENT_BEAT_VIRIDIAN_GYM_GIOVANNI",
};
/** The fossils the lab revives: the mon, and the item it came from. */
const FOSSILS: Record<string, string> = { OMANYTE: "HELIX_FOSSIL", KABUTO: "DOME_FOSSIL", AERODACTYL: "OLD_AMBER" };
/** Red and Blue's starters, each with the one the rival picks against it. */
const RIVAL_PICK: Record<string, string> = { BULBASAUR: "CHARMANDER", CHARMANDER: "SQUIRTLE", SQUIRTLE: "BULBASAUR" };

function gameOf(data: CartData): string {
  const v = data.version;
  return (typeof v === "string" ? v : v?.version) ?? "red";
}

interface Tables {
  yellow: boolean;
  species: Map<number, string>;
  speciesId: Map<string, number>;
  dex: Map<number, string>;
  moves: Map<number, string>;
  moveId: Map<string, number>;
  items: Map<number, string>;
  itemId: Map<string, number>;
  maps: Map<number, string>;
  mapId: Map<string, number>;
  events: Map<number, string>;
  eventBit: Map<string, number>;
}

const cache = new WeakMap<object, Tables>();
function tables(data: CartData): Tables {
  const hit = cache.get(data);
  if (hit) return hit;
  const t: Tables = {
    yellow: gameOf(data) === "yellow",
    species: new Map(), speciesId: new Map(), dex: new Map(),
    moves: new Map(), moveId: new Map(), items: new Map(), itemId: new Map(),
    maps: new Map(), mapId: new Map(), events: new Map(), eventBit: new Map(),
  };
  for (const [id, d] of Object.entries(data.pokemon ?? {})) {
    if (typeof d.index === "number") { t.species.set(d.index, id); t.speciesId.set(id, d.index); }
    if (typeof d.dex === "number") t.dex.set(d.dex, id);
  }
  for (const [id, d] of Object.entries(data.moves ?? {})) {
    if (typeof d.index === "number") { t.moves.set(d.index, id); t.moveId.set(id, d.index); }
  }
  for (const [id, d] of Object.entries(data.items ?? {})) {
    let n = d.index;
    // The machines are items too: HM01 is $C4 and TM01 is $C9, counting up.
    if (typeof n !== "number" && d.machine) n = (d.machine.kind === "HM" ? 0xc3 : 0xc8) + d.machine.number;
    if (typeof n === "number") { t.items.set(n, id); t.itemId.set(id, n); }
  }
  for (const [id, d] of Object.entries(data.maps ?? {})) {
    if (typeof d.index === "number") { t.maps.set(d.index, id); t.mapId.set(id, d.index); }
  }
  const list = (t.yellow ? EVENT_FLAGS_YELLOW : EVENT_FLAGS_RB).split(" ");
  for (let i = 0; i + 1 < list.length; i += 2) {
    const n = Number(list[i]);
    const name = `EVENT_${list[i + 1]}`;
    t.events.set(n, name);
    t.eventBit.set(name, n);
  }
  cache.set(data, t);
  return t;
}

// ---------------------------------------------------------------------------
// mons

type Mon = Record<string, any>;
const STATUS_BITS: [string, number][] = [["PSN", 3], ["BRN", 4], ["FRZ", 5], ["PAR", 6]];
const STATS = ["hp", "attack", "defense", "speed", "special"] as const;

function readMon(b: Uint8Array, o: number, party: boolean, t: Tables, data: CartData): Mon | null {
  try {
    return readMonUnsafe(b, o, party, t, data);
  } catch {
    return null; // the caller notes it as a mon left out
  }
}

function readMonUnsafe(b: Uint8Array, o: number, party: boolean, t: Tables, data: CartData): Mon | null {
  const species = t.species.get(u8(b, o));
  if (!species) return null;
  const st = u8(b, o + 4);
  let status: string | null = null;
  if (st & 7) status = "SLP";
  else for (const [s, k] of STATUS_BITS) if (st & (1 << k)) { status = s; break; }
  const moves: Mon[] = [];
  for (let i = 0; i < 4; i++) {
    const id = t.moves.get(u8(b, o + 8 + i));
    if (!id) continue;
    const pp = u8(b, o + 29 + i);
    const slot: Mon = { id, pp: pp & 0x3f };
    if (pp >> 6) slot.ppUps = pp >> 6;
    moves.push(slot);
  }
  const a = u8(b, o + 27);
  const s = u8(b, o + 28);
  const dvs = { attack: a >> 4, defense: a & 15, speed: s >> 4, special: s & 15, hp: 0 };
  dvs.hp = ((dvs.attack & 1) << 3) | ((dvs.defense & 1) << 2) | ((dvs.speed & 1) << 1) | (dvs.special & 1);
  const statExp: Mon = {};
  STATS.forEach((k, i) => { statExp[k] = u16be(b, o + 17 + i * 2); });
  const mon: Mon = {
    species,
    // (a level outside 1-100 is no level this game can show or grow from)
    level: Math.max(1, Math.min(100, u8(b, party ? o + 33 : o + 3))),
    exp: u24be(b, o + 14),
    dvs,
    statExp,
    hp: u16be(b, o + 1),
    catchRate: u8(b, o + 7),
    status,
    moves,
    otId: u16be(b, o + 12),
  };
  if (party) {
    const stats: Mon = {};
    STATS.forEach((k, i) => { stats[k] = u16be(b, o + 34 + i * 2); });
    mon.stats = stats;
    if (!(stats.hp > 0)) {
      const def = data.pokemon[species];
      if (def?.baseStats) mon.stats = calcStats(def as never, mon.level, dvs, statExp as never);
    }
    mon.hp = Math.min(mon.hp, mon.stats.hp);
  } else {
    // a box record has no stat block: work it out, as the cartridge does
    // when the mon leaves the box (the stored HP is kept as it is)
    const def = data.pokemon[species];
    if (def?.baseStats) mon.stats = calcStats(def as never, mon.level, dvs, statExp as never);
  }
  return mon;
}

function writeMon(b: Uint8Array, o: number, mon: Mon, party: boolean, t: Tables, data: CartData, otId: number, boxLevel?: number): void {
  const def = data.pokemon[mon.species];
  set8(b, o, t.speciesId.get(mon.species) ?? 0);
  set16be(b, o + 1, Math.max(0, mon.hp ?? 0));
  set8(b, o + 3, boxLevel ?? mon.level ?? 1);
  let st = 0;
  if (mon.status === "SLP") st = mon.sleepTurns ? Math.min(7, mon.sleepTurns) : 7;
  for (const [s, k] of STATUS_BITS) if (mon.status === s) st = 1 << k;
  set8(b, o + 4, st);
  const types = def?.types ?? [];
  set8(b, o + 5, TYPE_ID[types[0] ?? "NORMAL"] ?? 0);
  set8(b, o + 6, TYPE_ID[types[1] ?? types[0] ?? "NORMAL"] ?? 0);
  set8(b, o + 7, mon.catchRate ?? def?.catchRate ?? 0);
  for (let i = 0; i < 4; i++) {
    const mv = Array.isArray(mon.moves) ? mon.moves[i] : undefined;
    set8(b, o + 8 + i, mv ? t.moveId.get(mv.id) ?? 0 : 0);
    set8(b, o + 29 + i, mv ? (((mv.ppUps ?? 0) & 3) << 6) | (Math.max(0, mv.pp ?? 0) & 0x3f) : 0);
  }
  set16be(b, o + 12, otId);
  set24be(b, o + 14, Math.max(0, Math.min(0xffffff, Math.floor(mon.exp ?? 0))));
  STATS.forEach((k, i) => set16be(b, o + 17 + i * 2, Math.max(0, Math.min(0xffff, mon.statExp?.[k] ?? 0))));
  const dv = mon.dvs ?? {};
  set8(b, o + 27, ((dv.attack ?? 0) & 15) << 4 | ((dv.defense ?? 0) & 15));
  set8(b, o + 28, ((dv.speed ?? 0) & 15) << 4 | ((dv.special ?? 0) & 15));
  if (party) {
    set8(b, o + 33, mon.level ?? 1);
    const stats = mon.stats ?? (ensureStats(def as never, { ...mon, stats: undefined } as never) as Mon).stats ?? {};
    STATS.forEach((k, i) => set16be(b, o + 34 + i * 2, stats[k] ?? 0));
  }
}

/** A cartridge OT (name, id) as this game's convention: unstamped when it
 * is the player's own, `otName` / `otId` / `traded` when it is not. */
function ownership(mon: Mon, ot: string, otId: number, player: { name: string; id: number }): void {
  if (ot === player.name && otId === player.id) {
    delete mon.otId;
    return;
  }
  if (ot !== player.name) mon.otName = ot;
  mon.otId = otId;
  mon.traded = true;
}

/** This game's mon as a cartridge OT (name, id). */
function stamp(mon: Mon, player: { name: string; id: number }): { ot: string; id: number } {
  // an in-game trade names no trainer here; the cartridge's say TRAINER
  const ot = mon.otName ?? mon.ot ?? (mon.traded ? "TRAINER" : player.name);
  let id = mon.otId;
  // a traded mon with no number must still not read as the player's own
  if (typeof id !== "number") id = mon.traded ? (player.id ^ 0x8000) & 0xffff : player.id;
  return { ot, id: id & 0xffff };
}

function nickname(data: CartData, species: string, stored: string): string | undefined {
  return stored === (data.pokemon[species]?.name ?? species) ? undefined : stored;
}

// ---------------------------------------------------------------------------
// items

function readItems(b: Uint8Array, o: number, cap: number, t: Tables, notes: string[], where: string): { inv: Record<string, number>; order: string[] } {
  const inv: Record<string, number> = {};
  const order: string[] = [];
  for (let i = 0; i < cap; i++) {
    const id = u8(b, o + i * 2);
    if (id === 0xff) break;
    const item = t.items.get(id);
    if (!item) { notes.push(`${where}: unknown item $${id.toString(16)} left out`); continue; }
    inv[item] = (inv[item] ?? 0) + u8(b, o + i * 2 + 1);
    if (!order.includes(item)) order.push(item);
  }
  return { inv, order };
}

function writeItems(b: Uint8Array, o: number, cap: number, inv: Record<string, number>, order: string[] | undefined, t: Tables, notes: string[], where: string): number {
  let n = 0;
  const done = new Set<string>();
  const put = (id: string): void => {
    if (done.has(id)) return;
    done.add(id);
    const count = Math.floor(Number(inv[id]) || 0);
    if (count <= 0 || BADGES.includes(id)) return;
    const code = t.itemId.get(id);
    if (code === undefined) { notes.push(`${where}: ${id} has no cartridge item; left out`); return; }
    if (n >= cap) { notes.push(`${where}: no room for ${id}`); return; }
    set8(b, o + n * 2, code);
    set8(b, o + n * 2 + 1, Math.min(99, count));
    n++;
  };
  for (const id of order ?? []) if (inv[id] !== undefined) put(id);
  for (const id of Object.keys(inv)) put(id);
  set8(b, o + n * 2, 0xff);
  return n;
}

// ---------------------------------------------------------------------------
// summary

export interface CartSummary {
  name: string;
  badges: number;
  owned: number;
  /** Play time in seconds. */
  seconds: number;
}

/** What the CONTINUE choice shows for a cartridge save; null when it is none. */
export function cartSummary(b: Uint8Array | null | undefined): CartSummary | null {
  if (!isCartSave(b)) return null;
  const s = b!;
  let badges = 0;
  for (let i = 0; i < 8; i++) if (s[L.MAIN + M.badges]! & (1 << i)) badges++;
  let owned = 0;
  for (let i = 0; i < 151; i++) if (bit(s, L.MAIN + M.dexOwned, i)) owned++;
  const seconds = s[L.MAIN + M.playHours]! * 3600 + s[L.MAIN + M.playMinutes]! * 60 + s[L.MAIN + M.playSeconds]!;
  return { name: readName(s, L.PLAYER_NAME), badges, owned, seconds };
}

// ---------------------------------------------------------------------------
// cartridge -> Lua save

export interface CartLoad {
  save: Record<string, any>;
  notes: string[];
}

export function cartToSave(sram: Uint8Array, data: CartData): CartLoad {
  if (sram.length < L.SAVE_SIZE) throw new Error(`a cartridge save is 32768 bytes, not ${sram.length}`);
  const t = tables(data);
  const notes: string[] = [];
  const b = sram;
  const m = (k: number): number => L.MAIN + k;
  if (!isCartSave(b)) notes.push("main checksum does not match (read anyway)");

  const player = { name: readName(b, L.PLAYER_NAME), id: u16be(b, m(M.playerId)) };
  const mapIdx = u8(b, m(M.curMap));
  const mapId = t.maps.get(mapIdx);
  const wbs = u8(b, m(M.walkBikeSurf));
  const save: Record<string, any> = {
    meta: { format: 5, mods: {} },
    version: t.yellow ? "yellow" : "red",
    player: {
      name: player.name,
      rival: readName(b, m(M.rivalName)),
      id: player.id,
      map: mapId ?? "REDS_HOUSE_2F",
      x: mapId ? u8(b, m(M.xCoord)) : 3,
      y: mapId ? u8(b, m(M.yCoord)) : 6,
      // the cartridge's main menu turns the player to face down on CONTINUE
      facing: "down",
      surfing: wbs === 2,
    },
    flags: {},
    inventory: {},
    pcItems: {},
    party: [],
    box: [], // (the legacy single box: an array, as decodeSave makes it)
    boxes: [],
    currentBox: 1,
    money: bcd(b, m(M.money), 3),
    coins: bcd(b, m(M.coins), 2),
    defeatedTrainers: {},
    pokedex: { seen: {}, owned: {} },
    repelSteps: 0,
    modData: {},
    options: {},
    onBike: wbs === 1,
    surfing: wbs === 2,
  };
  if (!mapId) notes.push(`unknown map $${mapIdx.toString(16)}: placed in the bedroom`);
  // Each part on its own: one that cannot be read is left out with a note
  // rather than failing the whole save (it was the player's save, made by
  // another program; this game can only do its best with it).
  const vc = data.vcsave;
  const part = (name: string, fn: () => void): void => {
    try { fn(); } catch (e) { notes.push(`${name} could not be read (${String((e as Error)?.message ?? e)}); left out`); }
  };

  // POKéDEX: bit (dex number - 1)
  for (const [dex, sp] of t.dex) {
    if (bit(b, m(M.dexOwned), dex - 1)) save.pokedex.owned[sp] = true;
    if (bit(b, m(M.dexSeen), dex - 1)) save.pokedex.seen[sp] = true;
  }

  const bag = readItems(b, m(M.bagItems), 20, t, notes, "bag");
  save.inventory = bag.inv;
  save.bagOrder = bag.order;
  const pc = readItems(b, m(M.pcItems), 50, t, notes, "PC");
  save.pcItems = pc.inv;
  save.pcOrder = pc.order;
  const badges = u8(b, m(M.badges));
  BADGES.forEach((id, i) => { if (badges & (1 << i)) save.inventory[id] = 1; });

  const opt = u8(b, m(M.options));
  save.options.textSpeed = opt & 0x0f;
  save.options.animations = (opt & 0x80) === 0;
  save.options.battleStyle = opt & 0x40 ? "set" : "shift";

  part("the party", () => {
    // the party
    const count = Math.min(6, u8(b, L.PARTY));
    for (let i = 0; i < count; i++) {
      const mon = readMon(b, L.PARTY + 8 + i * L.PARTY_MON, true, t, data);
      if (!mon) { notes.push(`party slot ${i + 1}: unknown species $${u8(b, L.PARTY + 8 + i * L.PARTY_MON).toString(16)} left out`); continue; }
      const ot = readName(b, L.PARTY + 8 + 6 * L.PARTY_MON + i * L.NAME_LEN);
      ownership(mon, ot, mon.otId, player);
      const nick = nickname(data, mon.species, readName(b, L.PARTY + 8 + 6 * (L.PARTY_MON + L.NAME_LEN) + i * L.NAME_LEN));
      if (nick !== undefined) mon.nickname = nick;
      save.party.push(mon);
    }
  });

  part("the boxes", () => {
    // the boxes: the current one from its working copy, the rest from banks
    // 2 and 3 -- which hold nothing yet until the boxes are first set up
    // (bit 7 of the box byte)
    const boxByte = u8(b, m(M.curBox));
    const cur = Math.min(11, boxByte & 0x7f);
    const ready = (boxByte & 0x80) !== 0;
    const readBox = (o: number, n: number): Mon[] => {
      const out: Mon[] = [];
      const c = Math.min(L.MONS_PER_BOX, u8(b, o));
      for (let i = 0; i < c; i++) {
        const mon = readMon(b, o + 22 + i * L.BOX_MON, false, t, data);
        if (!mon) { notes.push(`box ${n + 1}: unknown species left out`); continue; }
        const ot = readName(b, o + 22 + L.MONS_PER_BOX * L.BOX_MON + i * L.NAME_LEN);
        ownership(mon, ot, mon.otId, player);
        const nick = nickname(data, mon.species, readName(b, o + 22 + L.MONS_PER_BOX * (L.BOX_MON + L.NAME_LEN) + i * L.NAME_LEN));
        if (nick !== undefined) mon.nickname = nick;
        out.push(mon);
      }
      return out;
    };
    for (let n = 0; n < L.BOXES; n++) {
      if (n === cur) save.boxes.push(readBox(L.CUR_BOX, n));
      else if (!ready) save.boxes.push([]);
      else save.boxes.push(readBox(L.BOX_BANKS[n < 6 ? 0 : 1] + (n % 6) * L.BOX_SIZE, n));
    }
    save.currentBox = cur + 1;
  });

  part("the event flags", () => {
    // event flags, and the progress the cartridge keeps beside them
    for (const [n, name] of t.events) if (bit(b, m(M.events), n)) save.flags[name] = true;
    for (const [name, [byte, k]] of Object.entries(EXTRA_FLAGS)) if (u8(b, m(byte)) & (1 << k)) save.flags[name] = true;
    for (const [name, k] of Object.entries(TRADE_FLAGS)) if (bit(b, m(M.tradeFlags), k)) save.flags[name] = true;
    for (const [ours, theirs] of Object.entries(FLAG_ALIAS)) if (save.flags[theirs]) save.flags[ours] = true;
  });

  part("shown objects and trainers", () => {
    // the objects the scripts have shown and hidden; item balls taken and
    // static mons beaten are hidden objects to the cartridge
    save.objectToggles = {};
    save.itemsTaken = {};
    for (let i = 0; i < (vc?.toggles.length ?? 0); i++) {
      const [map, objNo, hiddenAtStart] = vc!.toggles[i]!;
      const obj = toggleObject(data, vc!, i);
      if (!obj?.name) continue;
      const hidden = bit(b, m(M.toggles), i);
      (save.objectToggles[map] ??= {})[obj.name] = !hidden;
      if (hidden && !hiddenAtStart) {
        if (obj.item) save.itemsTaken[`${map}_obj_${obj.index}`] = true;
        if (obj.pokemon) save.defeatedTrainers[`${map}_obj_${obj.index}`] = true;
      }
      // an item a script puts down (hidden at the start) is hidden again once
      // taken: taken when the player has it
      if (hidden && hiddenAtStart && obj.item && ((save.inventory[obj.item] ?? 0) > 0 || (save.pcItems[obj.item] ?? 0) > 0)) {
        save.itemsTaken[`${map}_obj_${obj.index}`] = true;
      }
    }
    for (const [flag, [map, name]] of Object.entries(TOGGLE_FLAGS)) {
      if (save.objectToggles[map]?.[name] === false) save.flags[flag] = true;
    }
    // trainers: every one whose defeat flag is set
    forEachTrainer(data, (key, obj, flag) => {
      if (flag && save.flags[flag]) save.defeatedTrainers[key] = true;
    });
  });

  part("hidden items", () => {
    // hidden items and coins
    save.hiddenTaken = {};
    vc?.hiddenItems.forEach(([map, x, y], i) => { if (bit(b, m(M.hiddenItems), i)) save.hiddenTaken[`${map}_${x}_${y}`] = true; });
    vc?.hiddenCoins.forEach(([map, x, y], i) => { if (bit(b, m(M.hiddenCoins), i)) save.hiddenTaken[`${map}_${x}_${y}`] = true; });
  });

  part("towns visited", () => {
    // FLY: bit = the town's map id
    save.visited = {};
    for (let i = 0; i < 16; i++) {
      const town = t.maps.get(i);
      if (town && bit(b, m(M.townVisited), i)) save.visited[town] = true;
    }
  });

  part("the last map and blackout point", () => {
    // where a building's exit and a blackout go
    const last = t.maps.get(u8(b, m(M.lastMap)));
    if (last) save.lastOutdoor = outdoorSpot(data, last, mapId);
    const heal = t.maps.get(u8(b, m(M.lastBlackoutMap)));
    save.lastHeal = healSpot(data, heal ?? "PALLET_TOWN");
  });

  // the clock
  save.playTime = u8(b, m(M.playHours)) * 3600 + u8(b, m(M.playMinutes)) * 60 + u8(b, m(M.playSeconds));

  part("status bits", () => {
    // status bits this game keeps as fields
    save.strengthActive = (u8(b, m(M.statusFlags1)) & 1) === 1;
    save.forcedBike = (u8(b, m(M.statusFlags6)) & 0x20) !== 0;
    if (mapId && (data.field?.darkMaps?.maps ?? []).includes(mapId)) save.flashLit = u8(b, m(M.palOffset)) === 0;
    save.trashPuzzle = { first: u8(b, m(M.trashFirst)), second: u8(b, m(M.trashSecond)) };
  });

  part("starters, fossil, safari", () => {
    // starters: Red and Blue name the player's pick by flag here
    const starter = t.species.get(u8(b, m(M.playerStarter)));
    if (!t.yellow && starter && RIVAL_PICK[starter] && save.flags.EVENT_GOT_STARTER) save.flags[`EVENT_CHOSE_${starter}`] = true;
    if (t.yellow) {
      if (save.flags.EVENT_GOT_STARTER) save.flags.EVENT_CHOSE_PIKACHU = true;
      save.rivalStarter = u8(b, m(M.rivalStarter));
      save.pikachuHappiness = u8(b, m(M.pikachuHappiness));
      save.pikachuMood = u8(b, m(M.pikachuMood));
    }

    // the lab's fossil
    const fossil = t.species.get(u8(b, m(M.fossilMon)));
    if (fossil && FOSSILS[fossil] && save.flags.EVENT_GAVE_FOSSIL_TO_LAB) save.labFossilMon = fossil;

    // the SAFARI ZONE game, while one is on
    if (save.flags.EVENT_IN_SAFARI_ZONE && mapId?.startsWith("SAFARI_ZONE") && !mapId.endsWith("GATE")) {
      save.safari = { balls: u8(b, m(M.safariBalls)), steps: u16be(b, m(M.safariSteps)) };
    }
  });

  part("the day care", () => {
    // the DAY CARE: its exp counter is the box record's, its level byte the
    // level the mon went in at
    if (u8(b, m(M.daycareInUse))) {
      const mon = readMon(b, m(M.daycareMon), false, t, data);
      if (mon) {
        const depositLevel = u8(b, m(M.daycareMon) + 3);
        ownership(mon, readName(b, m(M.daycareOt)), mon.otId, player);
        const nick = nickname(data, mon.species, readName(b, m(M.daycareName)));
        if (nick !== undefined) mon.nickname = nick;
        save.daycare = { mon, steps: 0, depositLevel };
      }
    }
  });

  part("the hall of records", () => {
    // the HALL OF FAME, oldest first
    const teams = Math.min(L.HOF_TEAMS, u8(b, m(M.numHofTeams)));
    if (teams > 0) {
      save.hallOfFame = [];
      for (let n = 0; n < teams; n++) {
        const team: Mon[] = [];
        for (let i = 0; i < 6; i++) {
          const o = L.HOF + (n * 6 + i) * L.HOF_MON;
          const species = t.species.get(u8(b, o));
          if (!species) break;
          const rec: Mon = { species, level: u8(b, o + 1) };
          const nick = nickname(data, species, readName(b, o + 2));
          if (nick !== undefined) rec.nickname = nick;
          team.push(rec);
        }
        save.hallOfFame.push(team);
      }
    }
  });
  return { save, notes };
}

/**
 * The object a toggle bit stands for -- only the first bit naming it: the
 * ROM's table names a few objects twice (copies for scripts to use), and
 * the object's state is the first one's.
 */
function toggleObject(data: CartData, vc: VcTables, i: number): Obj | undefined {
  const [map, objNo] = vc.toggles[i]!;
  for (let j = 0; j < i; j++) if (vc.toggles[j]![0] === map && vc.toggles[j]![1] === objNo) return undefined;
  return data.maps?.[map]?.objects?.find((o) => o.index === objNo);
}

/** Each trainer object with the flag that records its defeat. */
function forEachTrainer(data: CartData, fn: (key: string, obj: Obj, flag: string | undefined) => void): void {
  for (const [mapId, map] of Object.entries(data.maps ?? {})) {
    const headers = map.label ? (data.trainer_headers?.[map.label] as unknown) : undefined;
    for (const obj of map.objects ?? []) {
      if (!obj.trainerClass) continue;
      let h: { event?: string } | undefined;
      if (Array.isArray(headers)) h = headers[obj.index - 1];
      else if (headers && typeof headers === "object") h = (headers as Record<string, { event?: string }>)[obj.index];
      fn(`${mapId}_obj_${obj.index}`, obj, h?.event ?? (obj.name ? TRAINER_FLAGS[obj.name] : undefined));
    }
  }
}

/** lastOutdoor for a map id: the spot is only a fallback (the exit mat's
 * warp says where), so the town's FLY spot, else the map's first warp. */
function outdoorSpot(data: CartData, id: string, _cur?: string): { id: string; x: number; y: number } {
  const fly = data.field?.flyWarps?.[id];
  if (fly) return { id, x: fly.x, y: fly.y };
  const w = data.maps?.[id]?.warps?.[0];
  return { id, x: w?.x ?? 0, y: w?.y ?? 0 };
}

/**
 * The cartridge's blackout point is a town (wLastBlackoutMap); this game's
 * is the spot in front of the counter inside that town's healing center,
 * with the town as its outdoor side. Pallet (home) is the town itself.
 */
function healSpot(data: CartData, town: string): Record<string, any> {
  if (town === "PALLET_TOWN") return { map: "PALLET_TOWN", x: 5, y: 6 };
  const maps = data.maps ?? {};
  const warps = maps[town]?.warps ?? [];
  for (const w of warps) {
    const inside = maps[w.destMap];
    if (!inside || !(w.destMap.endsWith("POKECENTER") || w.destMap === "INDIGO_PLATEAU_LOBBY")) continue;
    const nurse = (inside.objects ?? []).find((o: any) => /NURSE/.test(String(o.name ?? o.sprite ?? "")));
    const at = nurse ? { x: (nurse as any).x, y: (nurse as any).y + 2 } : { x: 3, y: 3 };
    return { map: w.destMap, x: at.x, y: at.y, outdoor: { id: town, x: w.x, y: w.y + 1 } };
  }
  const fly = data.field?.flyWarps?.[town];
  return { map: town, x: fly?.x ?? 5, y: fly?.y ?? 6 };
}

// ---------------------------------------------------------------------------
// Lua save -> cartridge

export interface CartWrite {
  bytes: Uint8Array;
  notes: string[];
}

export function saveToCart(save: Record<string, any>, data: CartData, template?: Uint8Array | null): CartWrite {
  const t = tables(data);
  const notes: string[] = [];
  const fresh = !template || template.length < L.SAVE_SIZE;
  const b = new Uint8Array(L.SAVE_SIZE);
  if (!fresh) b.set(template!.subarray(0, L.SAVE_SIZE));
  const m = (k: number): number => L.MAIN + k;
  const pl = save.player ?? {};
  const player = { name: String(pl.name ?? "RED"), id: Number(pl.id ?? 0) & 0xffff };

  writeName(b, L.PLAYER_NAME, player.name, fresh);
  writeName(b, m(M.rivalName), String(pl.rival ?? "BLUE"), fresh);
  set16be(b, m(M.playerId), player.id);

  // options: text delay, animations, battle style (Yellow's sound bits, 4-5,
  // stay as they were)
  const o = save.options ?? {};
  let opt = u8(b, m(M.options)) & 0x30;
  opt |= (Number(o.textSpeed) || 3) & 0x0f;
  if (o.battleStyle === "set") opt |= 0x40;
  if (o.animations === false) opt |= 0x80;
  set8(b, m(M.options), opt);
  if (fresh) set8(b, m(M.letterDelay), 0x01);

  setBcd(b, m(M.money), 3, Math.min(999999, save.money ?? 0));
  setBcd(b, m(M.coins), 2, Math.min(9999, save.coins ?? 0));
  let badges = 0;
  BADGES.forEach((id, i) => { if (save.inventory?.[id]) badges |= 1 << i; });
  set8(b, m(M.badges), badges);

  // POKéDEX (owned is seen too)
  for (const [dex, sp] of t.dex) {
    const owned = !!save.pokedex?.owned?.[sp];
    setBit(b, m(M.dexOwned), dex - 1, owned);
    setBit(b, m(M.dexSeen), dex - 1, owned || !!save.pokedex?.seen?.[sp]);
  }

  set8(b, m(M.numBagItems), writeItems(b, m(M.bagItems), 20, save.inventory ?? {}, save.bagOrder, t, notes, "bag"));
  set8(b, m(M.numPcItems), writeItems(b, m(M.pcItems), 50, save.pcItems ?? {}, save.pcOrder, t, notes, "PC"));

  // event flags: this game's are the authority for every bit it has a name for
  const flags: Record<string, boolean> = { ...(save.flags ?? {}) };
  for (const [ours, theirs] of Object.entries(FLAG_ALIAS)) if (flags[ours]) flags[theirs] = true;
  forEachTrainer(data, (key, _obj, flag) => {
    if (flag && save.defeatedTrainers?.[key] && t.eventBit.has(flag)) flags[flag] = true;
  });
  for (const [n, name] of t.events) setBit(b, m(M.events), n, !!flags[name]);
  for (const [name, [byte, k]] of Object.entries(EXTRA_FLAGS)) setBit(b, m(byte), k, !!flags[name]);
  for (const [name, k] of Object.entries(TRADE_FLAGS)) setBit(b, m(M.tradeFlags), k, !!flags[name]);

  // shown/hidden objects, folding in item balls taken and static mons beaten
  const vc = data.vcsave;
  if (!vc) notes.push("the dataset has no cartridge tables (gamedata vcsave): objects, hidden items and the map were not written");
  vc?.toggles.forEach(([map, objNo, hiddenAtStart], i) => {
    const obj = toggleObject(data, vc, i);
    // a bit this game has no object for (a second bit naming the same
    // object, or an object the port does not have) stays as it was
    if (!obj?.name) {
      if (fresh) setBit(b, m(M.toggles), i, !!hiddenAtStart);
      return;
    }
    let visible = !hiddenAtStart;
    const told = obj?.name ? save.objectToggles?.[map]?.[obj.name] : undefined;
    if (typeof told === "boolean") visible = told;
    const key = `${map}_obj_${objNo}`;
    if (obj?.item && (save.itemsTaken?.[key] || flags[`EVENT_ITEMBALL_${map}_${(obj as any).text}`])) visible = false;
    if (obj?.pokemon && save.defeatedTrainers?.[key]) visible = false;
    for (const [flag, [fm, fname]] of Object.entries(TOGGLE_FLAGS)) if (flags[flag] && fm === map && fname === obj.name) visible = false;
    setBit(b, m(M.toggles), i, !visible);
  });
  vc?.hiddenItems.forEach(([map, x, y], i) => setBit(b, m(M.hiddenItems), i, !!save.hiddenTaken?.[`${map}_${x}_${y}`]));
  vc?.hiddenCoins.forEach(([map, x, y], i) => setBit(b, m(M.hiddenCoins), i, !!save.hiddenTaken?.[`${map}_${x}_${y}`]));

  // FLY
  if (save.visited && typeof save.visited === "object") {
    for (let i = 0; i < 16; i++) {
      const town = t.maps.get(i);
      if (town && i < 11) setBit(b, m(M.townVisited), i, !!save.visited[town]);
    }
  }

  // the party
  const party: Mon[] = (Array.isArray(save.party) ? save.party : []).filter((x: Mon) => {
    const ok = x && t.speciesId.has(x.species);
    if (x && !ok) notes.push(`party: ${x.species} has no cartridge species; left out`);
    return ok;
  }).slice(0, 6);
  set8(b, L.PARTY, party.length);
  party.forEach((mon, i) => {
    const s = stamp(mon, player);
    const o = L.PARTY + 8 + i * L.PARTY_MON;
    // A party record's box-level byte is the level it last had in a box (or
    // when it was caught); the cartridge never updates it in the party.
    // Kept when the same mon is in the same slot, else the level.
    const same = !fresh && b[o] === t.speciesId.get(mon.species) && u24be(b, o + 14) <= (mon.exp ?? 0) &&
      u16be(b, o + 27) === ((((mon.dvs?.attack ?? 0) & 15) << 12) | (((mon.dvs?.defense ?? 0) & 15) << 8) | (((mon.dvs?.speed ?? 0) & 15) << 4) | ((mon.dvs?.special ?? 0) & 15));
    const boxLevel = same ? b[o + 3] : undefined;
    set8(b, L.PARTY + 1 + i, t.speciesId.get(mon.species)!);
    writeMon(b, o, mon, true, t, data, s.id, boxLevel);
    writeName(b, L.PARTY + 8 + 6 * L.PARTY_MON + i * L.NAME_LEN, s.ot, fresh);
    writeName(b, L.PARTY + 8 + 6 * (L.PARTY_MON + L.NAME_LEN) + i * L.NAME_LEN, mon.nickname ?? data.pokemon[mon.species]?.name ?? mon.species, fresh);
  });
  set8(b, L.PARTY + 1 + party.length, 0xff);

  // the boxes: every box into its bank, the current one into the working
  // copy too, and the boxes marked set up
  const boxes: Mon[][] = Array.isArray(save.boxes) ? save.boxes : [];
  const cur = Math.max(1, Math.min(L.BOXES, Number(save.currentBox) || 1)) - 1;
  const writeBox = (o: number, list: Mon[] | undefined, n: number): void => {
    const mons = (Array.isArray(list) ? list : []).filter((x) => x && t.speciesId.has(x.species));
    if (mons.length > L.MONS_PER_BOX) notes.push(`box ${n + 1}: only ${L.MONS_PER_BOX} fit`);
    const k = Math.min(L.MONS_PER_BOX, mons.length);
    set8(b, o, k);
    for (let i = 0; i < k; i++) {
      const mon = mons[i]!;
      const s = stamp(mon, player);
      set8(b, o + 1 + i, t.speciesId.get(mon.species)!);
      writeMon(b, o + 22 + i * L.BOX_MON, mon, false, t, data, s.id);
      writeName(b, o + 22 + L.MONS_PER_BOX * L.BOX_MON + i * L.NAME_LEN, s.ot, fresh);
      writeName(b, o + 22 + L.MONS_PER_BOX * (L.BOX_MON + L.NAME_LEN) + i * L.NAME_LEN, mon.nickname ?? data.pokemon[mon.species]?.name ?? mon.species, fresh);
    }
    set8(b, o + 1 + k, 0xff);
  };
  // Until the boxes are first set up (bit 7), banks 2 and 3 hold nothing
  // the cartridge reads, and it sets them up itself on the first box change;
  // a save that only uses the first box leaves them that way.
  const othersEmpty = boxes.every((x, n) => n === cur || !Array.isArray(x) || x.length === 0);
  const ready = fresh || (b[m(M.curBox)]! & 0x80) !== 0 || cur !== 0 || !othersEmpty;
  if (ready) for (let n = 0; n < L.BOXES; n++) writeBox(L.BOX_BANKS[n < 6 ? 0 : 1] + (n % 6) * L.BOX_SIZE, boxes[n], n);
  writeBox(L.CUR_BOX, boxes[cur], cur);
  set8(b, m(M.curBox), cur | (ready ? 0x80 : 0));

  // the clock (the cartridge stops at 255:59:59)
  const secs = Math.max(0, Math.floor(save.playTime ?? 0));
  if (secs >= 256 * 3600) {
    set8(b, m(M.playHours), 255); set8(b, m(M.playMaxed), 1);
    set8(b, m(M.playMinutes), 59); set8(b, m(M.playSeconds), 59); set8(b, m(M.playFrames), 59);
  } else {
    const h = Math.floor(secs / 3600), mi = Math.floor(secs / 60) % 60, se = secs % 60;
    // the frames only survive when the seconds have not moved
    const keepFrames = !fresh && b[m(M.playHours)] === h && b[m(M.playMinutes)] === mi && b[m(M.playSeconds)] === se;
    set8(b, m(M.playHours), h); set8(b, m(M.playMaxed), 0);
    set8(b, m(M.playMinutes), mi); set8(b, m(M.playSeconds), se);
    if (!keepFrames) set8(b, m(M.playFrames), 0);
  }

  // status bits
  setBit(b, m(M.statusFlags1), 0, !!save.strengthActive);
  setBit(b, m(M.statusFlags6), 5, !!save.forcedBike);
  setBit(b, m(M.statusFlags6), 0, true); // the play clock runs
  const surfing = !!(pl.surfing ?? save.surfing);
  set8(b, m(M.walkBikeSurf), surfing ? 2 : save.onBike ? 1 : 0);
  if (save.trashPuzzle) {
    if (typeof save.trashPuzzle.first === "number") set8(b, m(M.trashFirst), save.trashPuzzle.first);
    if (typeof save.trashPuzzle.second === "number") set8(b, m(M.trashSecond), save.trashPuzzle.second);
  }

  // starters
  if (t.yellow) {
    set8(b, m(M.playerStarter), t.speciesId.get("PIKACHU") ?? 0);
    if (typeof save.rivalStarter === "number") set8(b, m(M.rivalStarter), save.rivalStarter);
    set8(b, m(M.pikachuHappiness), Math.max(0, Math.min(255, Math.floor(save.pikachuHappiness ?? 90))));
    set8(b, m(M.pikachuMood), Math.max(0, Math.min(255, Math.floor(save.pikachuMood ?? 128))));
  } else {
    const mine = Object.keys(RIVAL_PICK).find((s) => flags[`EVENT_CHOSE_${s}`]);
    if (mine) {
      set8(b, m(M.playerStarter), t.speciesId.get(mine) ?? 0);
      set8(b, m(M.rivalStarter), t.speciesId.get(RIVAL_PICK[mine]!) ?? 0);
    }
  }

  // the lab's fossil
  if (typeof save.labFossilMon === "string" && FOSSILS[save.labFossilMon]) {
    set8(b, m(M.fossilMon), t.speciesId.get(save.labFossilMon) ?? 0);
    set8(b, m(M.fossilItem), t.itemId.get(FOSSILS[save.labFossilMon]!) ?? 0);
  }

  // the SAFARI ZONE game
  if (save.safari && typeof save.safari === "object") {
    set8(b, m(M.safariBalls), Math.max(0, Math.min(255, save.safari.balls ?? 0)));
    set16be(b, m(M.safariSteps), Math.max(0, Math.min(0xffff, save.safari.steps ?? 0)));
    set8(b, m(M.safariGameOver), 0);
  }

  // the DAY CARE
  const dc = save.daycare;
  if (dc?.mon && t.speciesId.has(dc.mon.species)) {
    const s = stamp(dc.mon, player);
    // the steps walked are exp to the cartridge, which counts them as it goes
    const mon = { ...dc.mon, exp: Math.min(0x500000, (dc.mon.exp ?? 0) + (dc.steps ?? 0)) };
    set8(b, m(M.daycareInUse), 1);
    writeMon(b, m(M.daycareMon), mon, false, t, data, s.id, dc.depositLevel ?? dc.mon.level);
    writeName(b, m(M.daycareOt), s.ot, true);
    writeName(b, m(M.daycareName), dc.mon.nickname ?? data.pokemon[dc.mon.species]?.name ?? dc.mon.species, true);
  } else {
    set8(b, m(M.daycareInUse), 0);
  }

  // the HALL OF FAME (the newest 50)
  const hall: Mon[][] = (Array.isArray(save.hallOfFame) ? save.hallOfFame : []).filter((x: unknown) => Array.isArray(x) && x.length > 0);
  const keep = hall.slice(-L.HOF_TEAMS);
  set8(b, m(M.numHofTeams), keep.length);
  keep.forEach((team, n) => {
    for (let i = 0; i < 6; i++) {
      const o = L.HOF + (n * 6 + i) * L.HOF_MON;
      const rec = team[i];
      if (!rec || !t.speciesId.has(rec.species)) {
        if (i < 6) set8(b, o, 0xff);
        break;
      }
      set8(b, o, t.speciesId.get(rec.species)!);
      set8(b, o + 1, rec.level ?? 1);
      writeName(b, o + 2, rec.nickname ?? data.pokemon[rec.species]?.name ?? rec.species, true);
    }
  });

  // where a building's exit and a blackout go
  const lastOut = save.lastOutdoor?.id;
  if (lastOut && t.mapId.has(lastOut)) set8(b, m(M.lastMap), t.mapId.get(lastOut)!);
  const heal = save.lastHeal;
  const healTown = heal?.outdoor?.id ?? (heal?.map && t.mapId.get(heal.map)! < 0x25 ? heal.map : undefined);
  if (healTown && t.mapId.has(healTown)) set8(b, m(M.lastBlackoutMap), t.mapId.get(healTown)!);
  else if (fresh) set8(b, m(M.lastBlackoutMap), 0);

  // the map the player stands on
  writeMap(b, save, data, t, notes, fresh ? null : template!);

  // the checksums, last
  set8(b, L.MAIN_CHECKSUM, checksum(b, L.PLAYER_NAME, L.MAIN_CHECKSUM));
  // (banks not set up are not checked by the cartridge, and stay as they were)
  if (ready) for (const bank of L.BOX_BANKS) {
    for (let n = 0; n < 6; n++) {
      const o = bank + n * L.BOX_SIZE;
      set8(b, bank + L.BOX_BANK_CHECKSUM + 1 + n, checksum(b, o, o + L.BOX_SIZE));
    }
    set8(b, bank + L.BOX_BANK_CHECKSUM, checksum(b, bank, bank + 6 * L.BOX_SIZE));
  }
  return { bytes: b, notes };
}

/** The tile-block buffer the view pointer indexes (wOverworldMap). */
const OVERWORLD_MAP = 0xc6e8;

/**
 * The current map's engine state. CONTINUE never re-reads the map header
 * from the ROM: the cartridge takes the header, connections, warps, signs,
 * objects, tileset header and music straight out of the save (and marks
 * them as loaded). So a save for a map the cartridge save was not already
 * on carries them here, rebuilt from the ROM facts the way the game builds
 * them on entering a map; a save on the same map keeps the game's own
 * bytes (live NPC positions and all) and only the player's spot moves.
 */
function writeMap(b: Uint8Array, save: Record<string, any>, data: CartData, t: Tables, notes: string[], template: Uint8Array | null): void {
  const m = (k: number): number => L.MAIN + k;
  const pl = save.player ?? {};
  let mapId: string = pl.map;
  let x = Math.floor(pl.x ?? 0);
  let y = Math.floor(pl.y ?? 0);
  if (!t.mapId.has(mapId)) {
    notes.push(`map ${mapId} has no cartridge map: saved at home`);
    mapId = "REDS_HOUSE_2F"; x = 3; y = 6;
  }
  const idx = t.mapId.get(mapId)!;
  const vc = data.vcsave?.maps?.[mapId];
  const same = !!template && template[m(M.curMap)] === idx;
  if (!same && !vc) {
    notes.push(`no cartridge map data for ${mapId}`);
    return;
  }
  set8(b, m(M.curMap), idx);
  set8(b, m(M.yCoord), y);
  set8(b, m(M.xCoord), x);
  const header = vc ? hexBytes(vc.h) : Array.from(b.subarray(m(M.mapHeader), m(M.mapHeader) + 10));
  const width = header[2]!;
  // the player's quarter of its 2x2 block, and the view's corner in the
  // block buffer (a row is the map's width plus the 3-block border each side)
  set8(b, m(M.yBlock), y & 1);
  set8(b, m(M.xBlock), x & 1);
  const view = OVERWORLD_MAP + 7 + width + (width + 6) * (y >> 1) + (x >> 1);
  b[m(M.viewPointer)] = view & 0xff;
  b[m(M.viewPointer) + 1] = (view >> 8) & 0xff;
  // a dark cave before FLASH
  const dark = (data.field?.darkMaps?.maps ?? []).includes(mapId);
  set8(b, m(M.palOffset), dark && !save.flashLit ? 6 : 0);
  if (same) return;

  for (let i = 0; i < 10; i++) set8(b, m(M.mapHeader) + i, header[i]!);
  // connections: every slot off ($FF), then the present ones N, S, W, E
  const conn = hexBytes(vc!.c);
  for (let i = 0; i < 44; i++) set8(b, m(M.connections) + i, 0);
  for (let s = 0; s < 4; s++) set8(b, m(M.connections) + s * 11, 0xff);
  let p = 0;
  [0x08, 0x04, 0x02, 0x01].forEach((flag, s) => {
    if (header[9]! & flag) {
      for (let i = 0; i < 11; i++) set8(b, m(M.connections) + s * 11 + i, conn[p + i] ?? 0);
      p += 11;
    }
  });
  // the sprite set is reloaded when its id does not match: make it not
  set8(b, m(M.spriteSetId), 0);

  // the object data, into the engine's warp, sign and sprite tables
  const obj = hexBytes(vc!.o);
  let q = 0;
  set8(b, m(M.backgroundTile), obj[q++]!);
  const warps = obj[q++]!;
  set8(b, m(M.numWarps), warps);
  for (let i = 0; i < 128; i++) set8(b, m(M.warps) + i, i < warps * 4 ? obj[q + i]! : 0);
  q += warps * 4;
  const signs = obj[q++]!;
  set8(b, m(M.numSigns), signs);
  for (let i = 0; i < 16; i++) {
    set8(b, m(M.signCoords) + i * 2, i < signs ? obj[q + i * 3]! : 0);
    set8(b, m(M.signCoords) + i * 2 + 1, i < signs ? obj[q + i * 3 + 1]! : 0);
    set8(b, m(M.signTexts) + i, i < signs ? obj[q + i * 3 + 2]! : 0);
  }
  q += signs * 3;
  const sprites = obj[q++]!;
  set8(b, m(M.numSprites), sprites);
  const sd = new Uint8Array(L.SPRITE_DATA_SIZE);
  // slots 1-15 empty and off screen; slot 0 (the player) the game rebuilds
  for (let s = 1; s < 16; s++) sd[s * 16 + 2] = 0xff;
  for (let i = 0; i < Math.min(16, sprites); i++) {
    const [pic, my, mx, mv1, mv2, text] = obj.slice(q, q + 6) as number[];
    q += 6;
    const slot = i + 1;
    if (slot < 16) {
      sd[slot * 16] = pic!;
      sd[256 + slot * 16 + 4] = my!;
      sd[256 + slot * 16 + 5] = mx!;
      sd[256 + slot * 16 + 6] = mv1!;
    }
    set8(b, m(M.spriteData) + i * 2, mv2!);
    set8(b, m(M.spriteData) + i * 2 + 1, text! & 0x3f);
    if (text! & 0x40) {
      set8(b, m(M.spriteExtra) + i * 2, obj[q++]!);
      set8(b, m(M.spriteExtra) + i * 2 + 1, obj[q++]!);
    } else if (text! & 0x80) {
      set8(b, m(M.spriteExtra) + i * 2, obj[q++]!);
    }
    // (an ordinary sprite's extra bytes are not the map's: left as they were)
  }
  // the player's own slot keeps its facing; the rest is the map's
  sd.set(b.subarray(L.SPRITE_DATA, L.SPRITE_DATA + 16), 0);
  sd.set(b.subarray(L.SPRITE_DATA + 256, L.SPRITE_DATA + 256 + 16), 256);
  b.set(sd, L.SPRITE_DATA);

  set8(b, m(M.height2), (header[1]! * 2) & 0xff);
  set8(b, m(M.width2), (header[2]! * 2) & 0xff);
  // the tileset header, and its animation mode in the last checksummed byte
  const tsName = data.maps?.[mapId]?.tileset;
  const ts = tsName ? data.vcsave?.tilesets?.[tsName] : undefined;
  if (ts) {
    const th = hexBytes(ts);
    for (let i = 0; i < 11; i++) set8(b, m(M.tilesetHeader) + i, th[i]!);
    set8(b, L.TILE_ANIMATIONS, th[11]!);
  } else notes.push(`no tileset header for ${mapId}`);
  if (vc!.m) {
    set8(b, m(M.musicId), vc!.m[0]);
    set8(b, m(M.musicBank), vc!.m[1]);
  }
}
