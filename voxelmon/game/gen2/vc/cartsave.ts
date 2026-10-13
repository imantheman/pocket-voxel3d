// Gen 2 save table <-> cartridge save (32 KB battery RAM), for the 3DS's own
// re-releases (VC) of Gold, Silver and Crystal (US).
//
//   cartToSave(sram, data)              the cartridge save as this game's
//                                       save table (what CONTINUE loads)
//   saveToCart(save, data, template?)   this game's save as a cartridge save;
//                                       `template` is the cartridge save it
//                                       replaces, whose bytes this game does
//                                       not model are kept as they are
//   cartSummary(sram, engine)           name, badges, dex, time: the
//                                       CONTINUE choice's box
//
// Where each byte lives is ./layout.ts. Map scenes, event flags and the
// script-owned bytes cross one to one (the engine runs the cartridge's own
// scripts, so its numbers are the cartridge's); engine flags go through the
// ROM's own table. What does not cross is listed in LOSSY.
//
// Written for this project from the documented structure and the ROMs; no
// disassembly code is used.

import * as L from "./layout.ts";
import { type Engine, type Layout, LAYOUTS } from "./layout.ts";
import { buildMapContext, type MapDef } from "./mapctx.ts";

/** The dataset subset this reads (the Gen 2 import's tables). */
export interface G2Data {
  pokemon: Record<string, any>;
  items: Record<string, any>;
  moves: Record<string, any>;
  maps: Record<string, MapDef>;
  constants?: { speciesOrder?: string[]; engineFlagOrder?: string[]; [k: string]: unknown };
  landmarks?: { spawns?: Record<string, { map: string; x: number; y: number; index?: number }> };
  events?: { decorationOrder?: string[]; [k: string]: unknown };
  sprites?: Record<string, { paletteId?: number }>;
}

/**
 * What does not cross, and what is done about it. Shown nowhere; the log
 * and the report carry it.
 */
export const LOSSY = [
  "the clock: each game keeps its own clock setting. A VC session runs this game's clock from the Lua save's setting (or the console's clock); a write keeps the cartridge's clock bytes (wStartDay/Hour/Minute/Second and the RTC trailer the VC title keeps after the 32 KB) as the save had them, and a new VC game starts them at zero",
  "daily and weekly timers (the daily reset, the lucky number day, the Kenji/Buena/phone call delays, the virus timer): kept from the cartridge save being replaced; the daily flags themselves cross",
  "facing: the cartridge continues facing the way its own map object says; a moved save faces down",
  "repel steps, the poison/happiness step counters, the bike step count, cut trees and smashed rocks: not modelled across (a repel wears off; trees and rocks grow back on the next map load, as on the cartridge)",
  "this game's own options (camera, tilt, screen, sound filters...): not in the cartridge save; a VC session takes them from the Lua save when there is one. Text speed, battle scene and style, sound, the frame, the printer and MENU ACCOUNT cross",
  "a sleeping mon's turns: written as 3 (the count is battle state this game does not keep on the mon)",
  "mail: the letters' text is kept from the cartridge save being replaced; a letter written here crosses only as the MAIL item",
  "the Battle Tower record, Mystery Gift and the mobile data: kept from the cartridge save being replaced",
  "the bug-catching contest in progress: the cartridge cannot save during it, so there is nothing to carry",
  "mons, items and moves this game has no data for (unknown or glitch index): left out, with a note in the log",
  "key items: one each, both ways (the cartridge has no count for them)",
  "play time frames: carried; the cap flag is recomputed",
];

// ---------------------------------------------------------------------------
// bytes

const be16 = (b: Uint8Array, o: number): number => (b[o]! << 8) | b[o + 1]!;
const be24 = (b: Uint8Array, o: number): number => (b[o]! << 16) | (b[o + 1]! << 8) | b[o + 2]!;
const set16 = (b: Uint8Array, o: number, v: number): void => { b[o] = (v >> 8) & 0xff; b[o + 1] = v & 0xff; };
const set24 = (b: Uint8Array, o: number, v: number): void => { b[o] = (v >> 16) & 0xff; b[o + 1] = (v >> 8) & 0xff; b[o + 2] = v & 0xff; };
const bitOf = (b: Uint8Array, o: number, i: number): boolean => ((b[o + (i >> 3)]! >> (i & 7)) & 1) === 1;
function setBit(b: Uint8Array, o: number, i: number, on: boolean): void {
  if (on) b[o + (i >> 3)]! |= 1 << (i & 7);
  else b[o + (i >> 3)]! &= ~(1 << (i & 7));
}
const clamp = (v: unknown, lo: number, hi: number): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
};

/** The cartridge checksum: the 16-bit sum of the bytes. */
export function checksum(b: Uint8Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += b[i]!;
  return s & 0xffff;
}

function mainOk(b: Uint8Array, Lo: Layout): boolean {
  return b[Lo.check1] === L.CHECK_1 && b[Lo.check2] === L.CHECK_2
    && checksum(b, Lo.main, Lo.mainEnd) === (b[Lo.checksum]! | (b[Lo.checksum + 1]! << 8));
}
function backupOk(b: Uint8Array, Lo: Layout): boolean {
  if (b[Lo.backupCheck1] !== L.CHECK_1 || b[Lo.backupCheck2] !== L.CHECK_2) return false;
  let s = 0;
  for (const [bk, , n] of Lo.backup) s += checksum(b, bk, bk + n);
  return (s & 0xffff) === (b[Lo.backupChecksum]! | (b[Lo.backupChecksum + 1]! << 8));
}

/** The engine a dataset is (Crystal, or Gold and Silver). */
export function engineOf(version: unknown): Engine {
  return String(version ?? "").toLowerCase() === "crystal" ? "crystal" : "gs";
}

/** Whether these bytes hold a game: the main copy right, or the backup. */
export function isCartSave(b: Uint8Array | null | undefined, engine: Engine): boolean {
  if (!b || b.length < L.SAVE_SIZE) return false;
  const Lo = LAYOUTS[engine];
  return mainOk(b, Lo) || backupOk(b, Lo);
}

/** The bytes as the cartridge would load them: the main copy, else the
 *  backup copied over it (LoadPlayerData falls back the same way). */
function loadable(b: Uint8Array, Lo: Layout): Uint8Array {
  if (mainOk(b, Lo) || !backupOk(b, Lo)) return b;
  const out = b.slice();
  for (const [bk, mn, n] of Lo.backup) out.set(b.subarray(bk, bk + n), mn);
  out.set(b.subarray(Lo.backupOptions, Lo.backupOptions + 8), Lo.options);
  return out;
}

// ---------------------------------------------------------------------------
// text

const CHAR: [number, string][] = [[0x7f, " "]];
for (let i = 0; i < 26; i++) CHAR.push([0x80 + i, String.fromCharCode(65 + i)], [0xa0 + i, String.fromCharCode(97 + i)]);
for (let i = 0; i < 10; i++) CHAR.push([0xf6 + i, String(i)]);
CHAR.push(
  [0x9a, "("], [0x9b, ")"], [0x9c, ":"], [0x9d, ";"], [0x9e, "["], [0x9f, "]"],
  [0xc0, "Ä"], [0xc1, "Ö"], [0xc2, "Ü"], [0xc3, "ä"], [0xc4, "ö"], [0xc5, "ü"],
  [0xd0, "'d"], [0xd1, "'l"], [0xd2, "'m"], [0xd3, "'r"], [0xd4, "'s"], [0xd5, "'t"], [0xd6, "'v"],
  [0xe0, "'"], [0xe1, "<PK>"], [0xe2, "<MN>"], [0xe3, "-"], [0xe6, "?"], [0xe7, "!"], [0xe8, "."], [0xe9, "&"],
  [0xea, "é"], [0xeb, "→"], [0xec, "▷"], [0xed, "▶"], [0xee, "▼"], [0xef, "♂"], [0xf0, "¥"], [0xf1, "×"],
  [0xf3, "/"], [0xf4, ","], [0xf5, "♀"],
);
const BYTE_TO_CHAR = new Map(CHAR);
const CHAR_TO_BYTE = CHAR.map(([b, c]) => [c, b] as [string, number]).sort((x, y) => y[0].length - x[0].length);

function readName(b: Uint8Array, o: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    const c = b[o + i]!;
    if (c === 0x50) break;
    s += BYTE_TO_CHAR.get(c) ?? "?";
  }
  return s;
}

/** Text to bytes: at most len-1 characters, the terminator, then (pad) more
 *  terminators to the end of the field, as the naming screen leaves it. */
function writeName(b: Uint8Array, o: number, text: string, len: number, pad = false): void {
  const out: number[] = [];
  let s = String(text ?? "");
  while (s.length && out.length < len - 1) {
    const hit = CHAR_TO_BYTE.find(([c]) => s.startsWith(c));
    if (hit) { out.push(hit[1]); s = s.slice(hit[0].length); }
    else { out.push(0xe6); s = s.slice(1); }
  }
  for (let i = 0; i < len; i++) {
    if (i < out.length) b[o + i] = out[i]!;
    else if (i === out.length || pad) b[o + i] = 0x50;
  }
}

// ---------------------------------------------------------------------------
// tables from the dataset

interface Tables {
  engine: Engine;
  speciesByIndex: Map<number, string>;
  itemByIndex: Map<number, string>;
  moveByIndex: Map<number, string>;
  tmByNumber: Map<number, string>;
  mapByGm: Map<number, string>;
  engineName: string[];
  engineId: Record<string, number>;
}
const tableCache = new WeakMap<object, Tables>();

function tables(data: G2Data, engine: Engine): Tables {
  const hit = tableCache.get(data);
  if (hit && hit.engine === engine) return hit;
  const speciesByIndex = new Map<number, string>();
  for (const [id, p] of Object.entries<any>(data.pokemon ?? {})) {
    if (p && typeof p === "object" && typeof p.index === "number" && p.baseStats) speciesByIndex.set(p.index, id);
  }
  const itemByIndex = new Map<number, string>();
  const tmByNumber = new Map<number, string>();
  for (const [id, it] of Object.entries<any>(data.items ?? {})) {
    if (!it || typeof it !== "object" || typeof it.index !== "number") continue;
    if (!itemByIndex.has(it.index)) itemByIndex.set(it.index, id);
    if (typeof it.tmNumber === "number") tmByNumber.set(it.tmNumber, id);
  }
  const moveByIndex = new Map<number, string>();
  for (const [id, m] of Object.entries<any>(data.moves ?? {})) {
    if (m && typeof m === "object" && typeof m.index === "number") moveByIndex.set(m.index, id);
  }
  const mapByGm = new Map<number, string>();
  for (const [id, m] of Object.entries<any>(data.maps ?? {})) {
    if (m && typeof m === "object" && typeof m.group === "number") mapByGm.set((m.group << 8) | m.map, id);
  }
  const engineName = (data.constants?.engineFlagOrder as string[] | undefined) ?? [];
  const engineId: Record<string, number> = {};
  engineName.forEach((n, i) => { engineId[n] = i; });
  const t: Tables = { engine, speciesByIndex, itemByIndex, moveByIndex, tmByNumber, mapByGm, engineName, engineId };
  tableCache.set(data, t);
  return t;
}

/** Gold/Silver's ENGINE_* ids (the Crystal import names its own). */
const GS_ENGINE: Record<string, number> = {
  ENGINE_POKEDEX: 11, ENGINE_DAY_CARE_MAN_HAS_EGG: 5, ENGINE_DAY_CARE_MAN_HAS_MON: 6, ENGINE_DAY_CARE_LADY_HAS_MON: 7,
  ENGINE_MOM_SAVING_MONEY: 8, ENGINE_MOM_ACTIVE: 9, ENGINE_BUG_CONTEST_TIMER: 16, ENGINE_ZEPHYRBADGE: 26,
  ENGINE_BOULDERBADGE: 34, ENGINE_SWARM: 81, ENGINE_CREDITS_SKIP: 15, ENGINE_POKEGEAR: 4,
};
function eid(t: Tables, name: string): number | undefined {
  return t.engine === "crystal" ? t.engineId[name] : GS_ENGINE[name];
}

const JOHTO = ["ZEPHYR", "HIVE", "PLAIN", "FOG", "STORM", "MINERAL", "GLACIER", "RISING"];
const KANTO = ["BOULDER", "CASCADE", "THUNDER", "RAINBOW", "SOUL", "MARSH", "VOLCANO", "EARTH"];
const STATES: Record<number, string> = { 0: "normal", 1: "bike", 4: "surf", 8: "surf_pika" };
const STATE_ID: Record<string, number> = { normal: 0, bike: 1, surf: 4, surf_pika: 8 };
const DECO_SLOTS = ["bed", "carpet", "plant", "poster", "console", "leftOrnament", "rightOrnament", "bigDoll"];
const TEXT_SPEED: Record<string, number> = { FAST: 1, MID: 3, SLOW: 5 };
const PRINT: [string, number][] = [["LIGHTEST", 0x00], ["LIGHTER", 0x20], ["NORMAL", 0x40], ["DARKER", 0x60], ["DARKEST", 0x7f]];
const EGG = 0xfd;

// ---------------------------------------------------------------------------
// mons

type Mon = Record<string, any>;
const STAT_EXP = ["hp", "attack", "defense", "speed", "special"] as const;

function statValue(base: number, dv: number, level: number, exp: number): number {
  return Math.floor((((base + dv) * 2 + Math.floor(Math.ceil(Math.sqrt(exp)) / 4)) * level) / 100) + 5;
}
function calcStats(def: any, dvs: any, level: number, se: any): Record<string, number> {
  const b = def?.baseStats ?? {};
  const hpDv = ((dvs.attack & 1) << 3) | ((dvs.defense & 1) << 2) | ((dvs.speed & 1) << 1) | (dvs.special & 1);
  const hp = Math.floor((((b.hp ?? 1) + hpDv) * 2 + Math.floor(Math.ceil(Math.sqrt(se.hp ?? 0)) / 4)) * level / 100) + level + 10;
  return {
    hp,
    attack: statValue(b.attack ?? 1, dvs.attack, level, se.attack ?? 0),
    defense: statValue(b.defense ?? 1, dvs.defense, level, se.defense ?? 0),
    speed: statValue(b.speed ?? 1, dvs.speed, level, se.speed ?? 0),
    specialAttack: statValue(b.specialAttack ?? 1, dvs.special, level, se.special ?? 0),
    specialDefense: statValue(b.specialDefense ?? 1, dvs.special, level, se.special ?? 0),
  };
}

function growthExp(data: G2Data, def: any, level: number): number {
  const g = data.pokemon?.growthRates?.[def?.growthRate];
  if (!g) return level * level * level;
  const v = Math.floor(((g.numerator ?? 1) * level ** 3) / (g.denominator ?? 1)) + (g.squared ?? 0) * level * level + (g.linear ?? 0) * level - (g.constant ?? 0);
  return Math.max(0, v);
}

/** One box_struct (32 bytes) + party extras (16) as this game's mon. */
function readMon(b: Uint8Array, o: number, party: boolean, ot: string, nick: string, isEgg: boolean, t: Tables, data: G2Data, notes: string[], where: string): Mon | null {
  const species = t.speciesByIndex.get(b[o]!);
  if (!species) {
    notes.push(`${where}: species index ${b[o]} unknown, left out`);
    return null;
  }
  const def = data.pokemon[species];
  const dv1 = b[o + 0x15]!, dv2 = b[o + 0x16]!;
  const dvs: any = { attack: dv1 >> 4, defense: dv1 & 15, speed: dv2 >> 4, special: dv2 & 15 };
  dvs.hp = ((dvs.attack & 1) << 3) | ((dvs.defense & 1) << 2) | ((dvs.speed & 1) << 1) | (dvs.special & 1);
  const statExp: any = {};
  STAT_EXP.forEach((k, i) => { statExp[k] = be16(b, o + 0x0b + i * 2); });
  const moves: any[] = [];
  for (let i = 0; i < 4; i++) {
    const idx = b[o + 2 + i]!;
    if (!idx) continue;
    const id = t.moveByIndex.get(idx);
    if (!id) { notes.push(`${where}: move index ${idx} unknown, left out`); continue; }
    const ppByte = b[o + 0x17 + i]!;
    const base = Number(data.moves[id]?.pp) || 0;
    const ups = ppByte >> 6;
    const maxPp = base + ups * Math.floor(base / 5);
    moves.push({ id, pp: Math.min(ppByte & 0x3f, maxPp), maxPp, ppUps: ups });
  }
  let item: string | undefined;
  if (b[o + 1]) {
    item = t.itemByIndex.get(b[o + 1]!);
    if (!item) notes.push(`${where}: held item index ${b[o + 1]} unknown, dropped`);
  }
  let level = clamp(b[o + 0x1f], 1, 100);
  if (b[o + 0x1f]! < 1 || b[o + 0x1f]! > 100) notes.push(`${where}: level ${b[o + 0x1f]} clamped to ${level}`);
  const statsCalc = calcStats(def, dvs, level, statExp);
  const mon: Mon = {
    species,
    name: def?.name ?? species,
    level,
    experience: be24(b, o + 8),
    dvs,
    statExp,
    pokerus: b[o + 0x1c]!,
    moves,
    item,
    status: undefined,
    happiness: b[o + 0x1b]!,
    otId: be16(b, o + 6),
    types: def?.types,
  };
  // caught data: Crystal's two bytes (Gold and Silver leave them zero)
  if (t.engine === "crystal") {
    const c0 = b[o + 0x1d]!, c1 = b[o + 0x1e]!;
    mon.caughtTime = c0 >> 6;
    mon.caughtLevel = c0 & 0x3f;
    mon.caughtLocation = c1 & 0x7f;
    mon.caughtByGender = c1 & 0x80 ? "girl" : "boy";
  } else {
    mon.caughtLevel = level;
  }
  if (isEgg) {
    mon.isEgg = true;
    // an egg's happiness byte is its steps-to-hatch counter
    mon.eggSteps = mon.happiness;
    mon.happiness = 120;
  }
  if (party) {
    const st = b[o + 0x20]!;
    if (st & 0x07) mon.status = "sleep";
    else if (st & 0x08) mon.status = "poison";
    else if (st & 0x10) mon.status = "burn";
    else if (st & 0x20) mon.status = "freeze";
    else if (st & 0x40) mon.status = "paralyze";
    const maxHp = be16(b, o + 0x24) || statsCalc.hp;
    mon.maxHp = maxHp;
    mon.hp = Math.min(be16(b, o + 0x22), maxHp);
    mon.stats = {
      hp: maxHp,
      attack: be16(b, o + 0x26), defense: be16(b, o + 0x28), speed: be16(b, o + 0x2a),
      specialAttack: be16(b, o + 0x2c), specialDefense: be16(b, o + 0x2e),
    };
    if (!mon.stats.attack) mon.stats = statsCalc;
  } else {
    mon.stats = statsCalc;
    mon.maxHp = statsCalc.hp;
    mon.hp = isEgg ? 0 : statsCalc.hp;
  }
  if (isEgg) mon.hp = 0;
  mon.otName = ot;
  mon.ot = ot;
  // a nickname equal to the species name is no nickname
  const speciesName = String(def?.name ?? species).toUpperCase();
  if (!isEgg && nick && nick !== speciesName) mon.nickname = nick;
  return mon;
}

function writeMon(b: Uint8Array, o: number, mon: Mon, party: boolean, t: Tables, data: G2Data, playerId: number, notes: string[], where: string): boolean {
  const def = data.pokemon[mon.species];
  const sIdx = def?.index;
  if (typeof sIdx !== "number") {
    notes.push(`${where}: ${mon.species} has no cartridge index, left out`);
    return false;
  }
  const len = party ? L.PARTY_MON_LEN : L.BOX_MON_LEN;
  b.fill(0, o, o + len);
  b[o] = sIdx;
  if (mon.item) {
    const it = data.items[mon.item];
    if (typeof it?.index === "number") b[o + 1] = it.index;
    else notes.push(`${where}: held item ${mon.item} has no cartridge index, dropped`);
  }
  const moves = (mon.moves ?? []).slice(0, 4);
  let k = 0;
  for (const mv of moves) {
    const id = typeof mv === "object" ? mv.id : mv;
    const m = data.moves[id];
    if (typeof m?.index !== "number") { notes.push(`${where}: move ${id} has no cartridge index, left out`); continue; }
    const base = Number(m.pp) || 0;
    const ups = clamp(mv?.ppUps ?? (mv?.maxPp && base ? Math.round((mv.maxPp - base) / Math.max(1, Math.floor(base / 5))) : 0), 0, 3);
    const maxPp = base + ups * Math.floor(base / 5);
    b[o + 2 + k] = m.index;
    b[o + 0x17 + k] = (ups << 6) | clamp(mv?.pp ?? maxPp, 0, Math.min(63, maxPp));
    k++;
  }
  set16(b, o + 6, clamp(mon.otId ?? playerId, 0, 0xffff));
  const level = clamp(mon.level ?? 1, 1, 100);
  const exp = clamp(mon.experience ?? growthExp(data, def, level), 0, 0xffffff);
  set24(b, o + 8, exp);
  const se = mon.statExp ?? {};
  STAT_EXP.forEach((key, i) => set16(b, o + 0x0b + i * 2, clamp(se[key] ?? (key === "special" ? se.specialAttack : 0) ?? 0, 0, 0xffff)));
  const d = mon.dvs ?? {};
  const spc = d.special ?? d.specialAttack ?? 0;
  b[o + 0x15] = (clamp(d.attack, 0, 15) << 4) | clamp(d.defense, 0, 15);
  b[o + 0x16] = (clamp(d.speed, 0, 15) << 4) | clamp(spc, 0, 15);
  const egg = mon.isEgg === true;
  b[o + 0x1b] = egg ? clamp(mon.eggSteps ?? 0, 0, 255) : clamp(mon.happiness ?? 70, 0, 255);
  b[o + 0x1c] = clamp(mon.pokerus ?? 0, 0, 255);
  if (t.engine === "crystal") {
    b[o + 0x1d] = (clamp(mon.caughtTime ?? 0, 0, 3) << 6) | clamp(mon.caughtLevel ?? 0, 0, 63);
    b[o + 0x1e] = (mon.caughtByGender === "girl" ? 0x80 : 0) | clamp(mon.caughtLocation ?? 0, 0, 0x7f);
  }
  b[o + 0x1f] = level;
  if (party) {
    const st = String(mon.status ?? "");
    b[o + 0x20] = st === "sleep" ? 3 : st === "poison" || st === "toxic" ? 0x08 : st === "burn" ? 0x10 : st === "freeze" ? 0x20 : st === "paralyze" ? 0x40 : 0;
    const dvs = { attack: clamp(d.attack, 0, 15), defense: clamp(d.defense, 0, 15), speed: clamp(d.speed, 0, 15), special: clamp(spc, 0, 15) };
    // the mon's own stats when it carries them (this game keeps them up to
    // date as the cartridge does), else worked out from the base stats
    const calc = calcStats(def, dvs, level, { hp: se.hp ?? 0, attack: se.attack ?? 0, defense: se.defense ?? 0, speed: se.speed ?? 0, special: se.special ?? se.specialAttack ?? 0 });
    const own = mon.stats && typeof mon.stats === 'object' ? mon.stats : {};
    const pick = (v: unknown, fallback: number): number => (Number(v) > 0 ? clamp(v, 1, 999) : fallback);
    const stats = {
      hp: pick(mon.maxHp ?? own.hp, calc.hp), attack: pick(own.attack, calc.attack), defense: pick(own.defense, calc.defense),
      speed: pick(own.speed, calc.speed), specialAttack: pick(own.specialAttack, calc.specialAttack), specialDefense: pick(own.specialDefense, calc.specialDefense),
    };
    set16(b, o + 0x24, stats.hp);
    set16(b, o + 0x22, egg ? 0 : clamp(mon.hp ?? stats.hp, 0, stats.hp));
    set16(b, o + 0x26, stats.attack);
    set16(b, o + 0x28, stats.defense);
    set16(b, o + 0x2a, stats.speed);
    set16(b, o + 0x2c, stats.specialAttack);
    set16(b, o + 0x2e, stats.specialDefense);
  }
  return true;
}

/** The cartridge's OT name for a mon of this game (unstamped = the player). */
function otOf(mon: Mon, playerName: string): string {
  return String(mon.otName ?? mon.ot ?? playerName);
}
function nickOf(mon: Mon, data: G2Data): string {
  if (mon.isEgg) return 'EGG';
  return String(mon.nickname ?? data.pokemon[mon.species]?.name ?? mon.species);
}

// ---------------------------------------------------------------------------
// pockets

function readPocket(b: Uint8Array, o: number, cap: number, withQty: boolean, t: Tables, data: G2Data, notes: string[], where: string, inv: Record<string, number>, order: string[], keyItems = false): void {
  const n = Math.min(b[o]!, cap);
  for (let i = 0; i < n; i++) {
    const idx = b[o + 1 + i * (withQty ? 2 : 1)]!;
    if (idx === 0xff || idx === 0) break;
    const qty = withQty ? b[o + 2 + i * 2]! : 1;
    const id = t.itemByIndex.get(idx);
    if (!id) { notes.push(`${where}: item index ${idx} unknown, left out`); continue; }
    const one = keyItems || data.items[id]?.pocket === "KEY_ITEM";
    const q = one ? 1 : Math.min(qty, 99);
    if (q <= 0) continue;
    if (inv[id] == null) order.push(id);
    inv[id] = one ? 1 : Math.min(99, (inv[id] ?? 0) + q);
  }
}

function writePocket(b: Uint8Array, o: number, cap: number, withQty: boolean, ids: [string, number][], data: G2Data, notes: string[], where: string): void {
  const rows: [number, number][] = [];
  for (const [id, qty] of ids) {
    const it = data.items[id];
    if (typeof it?.index !== "number") { notes.push(`${where}: ${id} has no cartridge index, left out`); continue; }
    if (rows.length >= cap) { notes.push(`${where}: no room for ${id} (the cartridge holds ${cap})`); continue; }
    rows.push([it.index, withQty ? clamp(qty, 1, 99) : 1]);
  }
  const width = withQty ? 2 : 1;
  // rows, then the terminator; what lies past it is left as it was (the
  // cartridge leaves it too)
  b[o] = rows.length;
  rows.forEach(([idx, q], i) => {
    b[o + 1 + i * width] = idx;
    if (withQty) b[o + 2 + i * 2] = q;
  });
  b[o + 1 + rows.length * width] = 0xff;
}

// ---------------------------------------------------------------------------
// summary

export interface CartSummary { name: string; badges: number; caught: number; hours: number; minutes: number; seconds: number }

/** What the CONTINUE choice shows for a cartridge save; null when it is none. */
export function cartSummary(raw: Uint8Array | null | undefined, engine: Engine): CartSummary | null {
  if (!isCartSave(raw, engine)) return null;
  const Lo = LAYOUTS[engine];
  const b = loadable(raw!, Lo);
  const pop = (o: number, n: number): number => {
    let c = 0;
    for (let i = 0; i < n; i++) for (let v = b[o + i]!; v; v >>= 1) c += v & 1;
    return c;
  };
  return {
    name: readName(b, Lo.playerName, L.NAME_LEN),
    badges: pop(Lo.badges, 2),
    caught: pop(Lo.dexCaught, 32),
    hours: be16(b, Lo.hours),
    minutes: b[Lo.minutes]!,
    seconds: b[Lo.seconds]!,
  };
}

// ---------------------------------------------------------------------------
// cartridge -> save table

export interface CartLoad { save: Record<string, any>; notes: string[] }

/** Read one part; a part that throws is left out with a note. */
function part(notes: string[], what: string, fn: () => void): void {
  try { fn(); } catch (e) { notes.push(`${what}: could not be read (${String((e as Error)?.message ?? e)}), left out`); }
}

export function cartToSave(raw: Uint8Array, data: G2Data, version: string): CartLoad {
  const engine = engineOf(version);
  const Lo = LAYOUTS[engine];
  if (!isCartSave(raw, engine)) throw new Error("not a cartridge save (check bytes or checksum wrong)");
  const notes: string[] = [];
  if (!mainOk(raw, Lo)) notes.push("the main copy fails its checksum; the backup copy was read (as the cartridge would)");
  const b = loadable(raw, Lo);
  const t = tables(data, engine);
  const playerName = readName(b, Lo.playerName, L.NAME_LEN) || "?";
  const playerId = be16(b, Lo.playerId);
  const s: Record<string, any> = {
    format: 8,
    version,
    generation: 2,
    player: {
      name: playerName,
      id: playerId,
      gender: "male",
      money: Math.min(be24(b, Lo.money), 999999),
      coins: Math.min(be16(b, Lo.coins), 9999),
      badges: {},
      kantoBadges: {},
    },
    rival: { name: readName(b, Lo.rivalName, L.NAME_LEN) || "???" },
    mom: { name: readName(b, Lo.momName, L.NAME_LEN) || "MOM" },
    party: [],
    boxes: [],
    boxNames: [],
    inventory: {},
    bagOrder: [],
    pcItems: {},
    pcOrder: [],
    phoneContacts: {},
    tradeFlags: {},
    pokedex: { seen: {}, caught: {} },
    unownDex: [],
    firstUnownSeen: 0,
    events: {},
    flags: {},
    engineFlags: {},
    mapScenes: {},
    scriptMem: {},
    variableSprites: {},
    hallOfFame: { count: 0, teams: [] },
    mail: { party: [], box: [] },
    decorations: {},
    options: {},
  };
  JOHTO.forEach((n, i) => { if (bitOf(b, Lo.badges, i)) s.player.badges[n] = true; });
  KANTO.forEach((n, i) => { if (bitOf(b, Lo.kantoBadges, i)) s.player.kantoBadges[n] = true; });
  if (engine === "crystal" && Lo.crystalData !== undefined && (b[Lo.crystalData]! & 1)) s.player.gender = "female";

  part(notes, "the clock", () => {
    const hours = Math.min(be16(b, Lo.hours), 999);
    s.playTime = { hours, minutes: b[Lo.minutes]! % 60, seconds: b[Lo.seconds]! % 60, frames: b[Lo.frames]! % 60 };
    s.rtc = { dst: (b[Lo.dst]! & 0x80) !== 0 };
  });

  part(notes, "the options", () => {
    const o = b[Lo.options]!;
    const sp = o & 7;
    s.options.textSpeed = sp <= 1 ? "FAST" : sp >= 5 ? "SLOW" : "MID";
    s.options.sound = o & 0x20 ? "STEREO" : "MONO";
    s.options.battleStyle = o & 0x40 ? "SET" : "SHIFT";
    s.options.battleScene = (o & 0x80) === 0;
    s.options.frame = (b[Lo.options + 2]! & 7) + 1;
    const pr = b[Lo.options + 4]!;
    s.options.print = PRINT.reduce((best, p) => (Math.abs(p[1] - pr) < Math.abs(best[1] - pr) ? p : best))[0];
    s.options.menuAccount = (b[Lo.options + 5]! & 1) !== 0;
  });

  part(notes, "the party", () => {
    const n = Math.min(b[Lo.partyCount]!, 6);
    if (b[Lo.partyCount]! > 6) notes.push(`party count ${b[Lo.partyCount]} clamped to 6`);
    for (let i = 0; i < n; i++) {
      const egg = b[Lo.partySpecies + i] === EGG;
      try {
        const m = readMon(b, Lo.partyMons + i * L.PARTY_MON_LEN, true, readName(b, Lo.partyOts + i * L.NAME_LEN, L.NAME_LEN),
          readName(b, Lo.partyNicks + i * L.NAME_LEN, L.NAME_LEN), egg, t, data, notes, `party ${i + 1}`);
        if (m) s.party.push(m);
      } catch (e) {
        notes.push(`party ${i + 1}: unreadable (${String(e)}), left out`);
      }
    }
  });

  part(notes, "the boxes", () => {
    const cur = clamp((b[Lo.curBox]! & 0x0f) + 1, 1, L.NUM_BOXES);
    s.currentBox = cur;
    for (let bx = 1; bx <= L.NUM_BOXES; bx++) {
      const o = bx === cur ? Lo.box : Lo.boxBanks[bx - 1]!;
      s.boxes[bx - 1] = readBox(b, o, t, data, notes, `box ${bx}`);
      const nm = readName(b, Lo.boxNames + (bx - 1) * L.BOX_NAME_LEN, L.BOX_NAME_LEN);
      s.boxNames[bx - 1] = nm || `BOX${bx}`;
    }
  });

  part(notes, "the pack", () => {
    readPocket(b, Lo.numItems, 20, true, t, data, notes, "items", s.inventory, s.bagOrder);
    readPocket(b, Lo.numBalls, 12, true, t, data, notes, "balls", s.inventory, s.bagOrder);
    readPocket(b, Lo.numKeyItems, 25, false, t, data, notes, "key items", s.inventory, s.bagOrder, true);
    for (let n = 1; n <= 57; n++) {
      const q = b[Lo.tmhm + n - 1]!;
      if (!q) continue;
      const id = t.tmByNumber.get(n);
      if (!id) { notes.push(`TM/HM ${n} unknown, left out`); continue; }
      s.inventory[id] = n > 50 ? 1 : Math.min(q, 99);
      s.bagOrder.push(id);
    }
    readPocket(b, Lo.numPcItems, 50, true, t, data, notes, "PC items", s.pcItems, s.pcOrder);
    const reg = t.itemByIndex.get(b[Lo.registeredItem]!);
    if (b[Lo.registeredItem] && reg && s.inventory[reg]) s.registeredItem = { id: reg };
  });

  part(notes, "the dex", () => {
    const order = data.constants?.speciesOrder ?? [];
    for (let i = 0; i < 251; i++) {
      const sp = order[i] ?? t.speciesByIndex.get(i + 1);
      if (!sp) continue;
      if (bitOf(b, Lo.dexSeen, i)) s.pokedex.seen[sp] = true;
      if (bitOf(b, Lo.dexCaught, i)) s.pokedex.caught[sp] = true;
    }
    for (let i = 0; i < 26; i++) {
      const v = b[Lo.unownDex + i]!;
      if (!v || v > 26) break;
      if (!s.unownDex.includes(v)) s.unownDex.push(v);
    }
    const f = b[Lo.firstUnownSeen]!;
    s.firstUnownSeen = f <= 26 ? f : 0;
    const mode = b[Lo.lastDexMode]!;
    s.lastDexMode = mode === 1 ? "OLD" : mode === 2 ? "A-Z" : "NEW";
  });

  part(notes, "the event flags", () => {
    for (let i = 0; i < 256; i++) {
      const v = b[Lo.eventFlags + i]!;
      if (v) s.events[i] = v;
    }
  });

  part(notes, "the map scenes", () => {
    for (const [map, o] of Object.entries(Lo.scenes)) {
      if (data.maps[map]) s.mapScenes[map] = b[o]!;
    }
  });

  part(notes, "the engine flags", () => {
    Lo.engineFlags.forEach((row, id) => {
      if (row && (b[row[0]]! & row[1])) s.engineFlags[id] = true;
    });
    // the ones this game keeps in their own fields
    const mom = s.mom;
    mom.savingMoney = (b[Lo.momSaving]! & 1) !== 0;
    mom.active = (b[Lo.momSaving]! & 0x80) !== 0;
    mom.savedMoney = Math.min(be24(b, Lo.momMoney), 999999);
    mom.whichItem = b[Lo.whichMomItem]!;
    mom.triggerBalance = be24(b, Lo.momItemTrigger);
    const pokedex = eid(t, "ENGINE_POKEDEX");
    if (pokedex !== undefined && s.engineFlags[pokedex]) s.pokedexReceived = true;
    const gear = eid(t, "ENGINE_POKEGEAR");
    if (gear !== undefined && s.engineFlags[gear]) s.pokegearReceived = true;
    const swarm = eid(t, engine === "crystal" ? "ENGINE_QWILFISH_SWARM" : "ENGINE_SWARM");
    if (swarm !== undefined && s.engineFlags[swarm]) s.dailyFlags = { swarm: true };
  });

  part(notes, "the script bytes", () => {
    // every WRAM byte a script may read or write (readmem/writemem/loadmem):
    // the moo-moo berries, the underground switches, the fight counts... --
    // the player block between the pockets and the event flags, which this
    // game keeps by WRAM address
    for (const [from, to] of scriptRanges(Lo)) {
      for (let o = from; o < to; o++) {
        const w = L.wramOfSram(Lo, o);
        if (w !== null && b[o]) s.scriptMem[w] = b[o]!;
      }
    }
  });

  part(notes, "the variable sprites", () => {
    for (let i = 0; i < 16; i++) {
      const v = b[Lo.variableSprites + i]!;
      if (v) s.variableSprites[i] = v;
    }
  });

  part(notes, "the decorations", () => {
    DECO_SLOTS.forEach((k, i) => { const v = b[Lo.decorations + i]!; if (v) s.decorations[k] = v; });
  });

  part(notes, "the place", () => {
    const map = t.mapByGm.get((b[Lo.mapGroup]! << 8) | b[Lo.mapNumber]!);
    if (!map) throw new Error(`map ${b[Lo.mapGroup]}:${b[Lo.mapNumber]} unknown`);
    s.position = { map, x: b[Lo.x]!, y: b[Lo.y]!, facing: facingOf(b[Lo.playerStruct + 8]!) };
    s.playerState = STATES[b[Lo.playerState]!] ?? "normal";
    const bw = t.mapByGm.get((b[Lo.backupWarp + 1]! << 8) | b[Lo.backupWarp + 2]!);
    if (bw && b[Lo.backupWarp]) s.backupWarp = { map: bw, warp: b[Lo.backupWarp]! };
    const ls = t.mapByGm.get((b[Lo.lastSpawn]! << 8) | b[Lo.lastSpawn + 1]!);
    if (ls) s.blackoutMap = ls;
    s.spawnAfterChampion = b[Lo.spawnAfterChampion] ? spawnName(data, b[Lo.spawnAfterChampion]!) : undefined;
  });

  part(notes, "the day care", () => {
    const dc: any = { man: {}, lady: {}, compatible: false, hasEgg: false, stepsToEgg: b[Lo.stepsToEgg]! };
    const man = b[Lo.dayCareMan]!;
    if (man & 1) {
      const m = readMon(b, Lo.breedMon1 + 2 * L.NAME_LEN, false, readName(b, Lo.breedMon1 + L.NAME_LEN, L.NAME_LEN),
        readName(b, Lo.breedMon1, L.NAME_LEN), false, t, data, notes, "day-care man");
      if (m) dc.man.mon = m;
    }
    if (man & 0x80) dc.man.introSeen = true;
    const lady = b[Lo.dayCareLady]!;
    if (lady & 1) {
      const m = readMon(b, Lo.breedMon2 + 2 * L.NAME_LEN, false, readName(b, Lo.breedMon2 + L.NAME_LEN, L.NAME_LEN),
        readName(b, Lo.breedMon2, L.NAME_LEN), false, t, data, notes, "day-care lady");
      if (m) dc.lady.mon = m;
    }
    if (lady & 0x80) dc.lady.introSeen = true;
    if (man & 0x40) {
      dc.hasEgg = true;
      const e = readMon(b, Lo.egg + 2 * L.NAME_LEN, false, readName(b, Lo.egg + L.NAME_LEN, L.NAME_LEN), "EGG", true, t, data, notes, "day-care egg");
      if (e) dc.egg = e;
    }
    dc.compatible = (man & 0x20) !== 0;
    s.dayCare = dc;
  });

  part(notes, "the roaming mons", () => {
    const list: any[] = [];
    for (let i = 0; i < 3; i++) {
      const o = Lo.roamers + i * 7;
      const sp = t.speciesByIndex.get(b[o]!);
      const map = t.mapByGm.get((b[o + 2]! << 8) | b[o + 3]!);
      const slot: any = {};
      if (sp) { slot.species = sp; slot.level = b[o + 1]!; }
      if (map) slot.map = map;
      slot.hp = b[o + 4]!;
      const dv1 = b[o + 5]!, dv2 = b[o + 6]!;
      if (dv1 || dv2) slot.dvs = { attack: dv1 >> 4, defense: dv1 & 15, speed: dv2 >> 4, special: dv2 & 15 };
      list.push(slot);
    }
    s.roamers = list;
  });

  part(notes, "the Hall of Fame", () => {
    s.hallOfFame.count = b[Lo.hofCount]!;
    for (let k = 0; k < L.HOF_TEAMS; k++) {
      const o = Lo.hallOfFame + k * L.HOF_LEN;
      if (b[o + 1] === 0xff || b[o + 1] === 0) break;
      const team: any = { winCount: b[o]!, mons: [] };
      for (let i = 0; i < 6; i++) {
        const p = o + 1 + i * 16;
        if (b[p] === 0xff || b[p] === 0) break;
        const sp = t.speciesByIndex.get(b[p]!);
        if (!sp) { notes.push(`hall of fame team ${k + 1}: species ${b[p]} unknown, left out`); continue; }
        const dv1 = b[p + 3]!, dv2 = b[p + 4]!;
        team.mons.push({
          species: sp, otId: be16(b, p + 1),
          dvs: { attack: dv1 >> 4, defense: dv1 & 15, speed: dv2 >> 4, special: dv2 & 15 },
          level: b[p + 5]!, nickname: readName(b, p + 6, 10),
        });
      }
      s.hallOfFame.teams.push(team);
    }
    if (s.hallOfFame.count > 0 || s.hallOfFame.teams.length) s.hallOfFame.entered = true;
  });

  part(notes, "the phone", () => {
    const o = phoneListOf(Lo);
    if (o === null) return;
    const list: number[] = [];
    for (let i = 0; i < 10; i++) {
      const id = b[o + i]!;
      list.push(id);
      if (id) s.phoneContacts[id] = true;
    }
    s.phone = { list, specialCall: 0, timeCycles: 0, delayMins: 0 };
  });

  part(notes, "the trades", () => {
    for (let i = 0; i < 8; i++) if (bitOf(b, tradeFlagsOf(Lo), i)) s.tradeFlags[i] = true;
  });

  s.savedAt = 0;
  return { save: s, notes };
}

function readBox(b: Uint8Array, o: number, t: Tables, data: G2Data, notes: string[], where: string): Mon[] {
  const out: Mon[] = [];
  const n = Math.min(b[o]!, L.MONS_PER_BOX);
  if (b[o]! > L.MONS_PER_BOX && b[o] !== 0xff) notes.push(`${where}: count ${b[o]} clamped`);
  if (b[o] === 0xff) return out;
  const mons = o + 1 + 21;
  const ots = mons + L.MONS_PER_BOX * L.BOX_MON_LEN;
  const nicks = ots + L.MONS_PER_BOX * L.NAME_LEN;
  for (let i = 0; i < n; i++) {
    const egg = b[o + 1 + i] === EGG;
    try {
      const m = readMon(b, mons + i * L.BOX_MON_LEN, false, readName(b, ots + i * L.NAME_LEN, L.NAME_LEN),
        readName(b, nicks + i * L.NAME_LEN, L.NAME_LEN), egg, t, data, notes, `${where} slot ${i + 1}`);
      if (m) out.push(m);
    } catch (e) {
      notes.push(`${where} slot ${i + 1}: unreadable, left out`);
    }
  }
  return out;
}

function writeBox(b: Uint8Array, o: number, mons: Mon[], t: Tables, data: G2Data, playerName: string, playerId: number, notes: string[], where: string): void {
  b.fill(0, o, o + L.BOX_LEN);
  const mo = o + 1 + 21;
  const ots = mo + L.MONS_PER_BOX * L.BOX_MON_LEN;
  const nicks = ots + L.MONS_PER_BOX * L.NAME_LEN;
  let n = 0;
  for (const m of mons) {
    if (!m || typeof m !== "object") continue;
    if (n >= L.MONS_PER_BOX) { notes.push(`${where}: more than ${L.MONS_PER_BOX}, the rest left out`); break; }
    if (!writeMon(b, mo + n * L.BOX_MON_LEN, m, false, t, data, playerId, notes, `${where} slot ${n + 1}`)) continue;
    b[o + 1 + n] = m.isEgg ? EGG : b[mo + n * L.BOX_MON_LEN]!;
    writeName(b, ots + n * L.NAME_LEN, otOf(m, playerName), L.NAME_LEN);
    writeName(b, nicks + n * L.NAME_LEN, nickOf(m, data), L.NAME_LEN, true);
    n++;
  }
  b[o] = n;
  b[o + 1 + n] = 0xff;
}

const FACINGS = ["down", "up", "left", "right"];
function facingOf(byte: number): string {
  return FACINGS[(byte >> 2) & 3] ?? "down";
}
function spawnName(data: G2Data, index: number): string | undefined {
  for (const [id, sp] of Object.entries(data.landmarks?.spawns ?? {})) if (sp.index === index) return id;
  return undefined;
}

/** The player block's bytes this game keeps by WRAM address (scriptMem):
 *  from the trade flags to the start of the scene bytes, and from the end
 *  of the scene bytes to the event flags (the fight counts and the rest). */
function scriptRanges(Lo: Layout): [number, number][] {
  const scenes = Object.values(Lo.scenes);
  const first = Math.min(...scenes), last = Math.max(...scenes) + 1;
  return [[Lo.hofCount + 2, first], [last, Lo.eventFlags]];
}
function tradeFlagsOf(Lo: Layout): number {
  return Lo.hofCount + 3;
}
/** wPhoneList (CONTACT_LIST_SIZE + 1 bytes); null where not yet placed. */
function phoneListOf(Lo: Layout): number | null {
  return Lo.engine === "crystal" ? 0x280a : 0x282e;
}

// ---------------------------------------------------------------------------
// save table -> cartridge

export interface CartWrite { bytes: Uint8Array; notes: string[] }

/** A fresh image: what a new cartridge game holds before its first save. */
function blankImage(Lo: Layout): Uint8Array {
  const b = new Uint8Array(L.SAVE_SIZE);
  // options as a new game sets them: MID text, the frame, normal printing,
  // MENU ACCOUNT on
  b.set([0x03, 0x01, 0x00, 0x01, 0x40, 0x01, 0x00, 0x00], Lo.options);
  b[0x0be3] = 0xff;
  b[0x0be5] = 0xff;
  // each box empty, and the two filler bytes after it $FF, as a new game
  // leaves the banks
  for (let bx = 0; bx < L.NUM_BOXES; bx++) {
    const o = Lo.boxBanks[bx]!;
    b[o] = 0;
    b[o + 1] = 0xff;
    b[o + L.BOX_LEN] = 0xff;
    b[o + L.BOX_LEN + 1] = 0xff;
  }
  b[Lo.box] = 0;
  b[Lo.box + 1] = 0xff;
  // nobody following anybody (wObjectFollow_Leader / _Follower): left at 0
  // the player "follows" itself and the first step crashes the cartridge
  b[Lo.playerStruct - 9] = 0xff;
  b[Lo.playerStruct - 8] = 0xff;
  // the day counters a new game starts at 1 (and Crystal's one at 3), as
  // the cartridges' own new-game saves have them
  if (Lo.engine === "gs") {
    b[0x2720] = 1;
    b[0x27ce] = 1;
    b[0x23cd] = 0x80;
  } else {
    b[0x27aa] = 1;
    b[0x27e6] = 3;
  }
  // the fishing record as a new game starts it: 3'6", and the holder's name
  b[Lo.magikarpFeet] = 3;
  b[Lo.magikarpInches] = 6;
  b.set([0x91, 0x80, 0x8b, 0x8f, 0x87, 0x50], Lo.magikarpHolder);
  return b;
}

export interface CartWriteOpts {
  /** The map's blocks as they stand now (after its callbacks changed any:
   *  the decorations, the switches...), for the screen the continue restores. */
  blocks?: number[];
}

export function saveToCart(save: Record<string, any>, data: G2Data, version: string, template?: Uint8Array | null, opts?: CartWriteOpts): CartWrite {
  const engine = engineOf(version);
  const Lo = LAYOUTS[engine];
  const t = tables(data, engine);
  const notes: string[] = [];
  const useTemplate = !!template && template.length >= L.SAVE_SIZE && isCartSave(template, engine);
  const b = useTemplate ? loadable(template!, Lo).slice(0, L.SAVE_SIZE) : blankImage(Lo);
  if (template && !useTemplate) notes.push("the VC save held no game; writing a whole new cartridge save");
  const player = save.player ?? {};
  const playerName = String(player.name ?? "GOLD");
  const playerId = clamp(player.id ?? 0, 0, 0xffff);

  // names and identity
  set16(b, Lo.playerId, playerId);
  writeName(b, Lo.playerName, playerName, L.NAME_LEN);
  writeName(b, Lo.rivalName, String(save.rival?.name ?? "???"), L.NAME_LEN);
  writeName(b, Lo.momName, String(save.mom?.name ?? "MOM"), L.NAME_LEN);
  if (!useTemplate) {
    writeName(b, Lo.redName, "RED", L.NAME_LEN);
    writeName(b, Lo.greenName, "GREEN", L.NAME_LEN);
  }
  b[Lo.savedAtLeastOnce] = 1;
  if (engine === "crystal" && Lo.crystalData !== undefined) {
    b[Lo.crystalData] = (b[Lo.crystalData]! & ~1) | (player.gender === "female" ? 1 : 0);
  }

  // play time
  const pt = save.playTime ?? {};
  const hours = clamp(pt.hours ?? 0, 0, 999);
  set16(b, Lo.hours, hours);
  b[Lo.minutes] = clamp(pt.minutes ?? 0, 0, 59);
  b[Lo.seconds] = clamp(pt.seconds ?? 0, 0, 59);
  b[Lo.frames] = clamp(pt.frames ?? 0, 0, 59);
  b[Lo.timeCap] = hours >= 999 && pt.minutes >= 59 ? 1 : 0;
  if (save.rtc && typeof save.rtc.dst === "boolean") b[Lo.dst] = (b[Lo.dst]! & 0x7f) | (save.rtc.dst ? 0x80 : 0);

  // options (the cartridge's own; this game's others stay in the Lua save)
  const o = save.options ?? {};
  if (o.textSpeed || o.battleScene !== undefined) {
    let v = b[Lo.options]! & 0x10;
    v |= TEXT_SPEED[String(o.textSpeed ?? "MID")] ?? 3;
    if (o.sound === "STEREO") v |= 0x20;
    if (o.battleStyle === "SET") v |= 0x40;
    if (o.battleScene === false) v |= 0x80;
    b[Lo.options] = v;
    if (o.frame) b[Lo.options + 2] = clamp(o.frame - 1, 0, 7);
    const pr = PRINT.find((p) => p[0] === o.print);
    if (pr) b[Lo.options + 4] = pr[1];
    if (o.menuAccount !== undefined) b[Lo.options + 5] = (b[Lo.options + 5]! & ~1) | (o.menuAccount ? 1 : 0);
  }
  b[Lo.options + 1] = 1; // a save file exists

  // money, badges
  set24(b, Lo.money, clamp(player.money ?? 0, 0, 999999));
  set16(b, Lo.coins, clamp(player.coins ?? 0, 0, 9999));
  let jb = 0, kb = 0;
  JOHTO.forEach((n, i) => { if (player.badges?.[n] || player.badges?.[i] === true) jb |= 1 << i; });
  KANTO.forEach((n, i) => { if (player.kantoBadges?.[n] || player.kantoBadges?.[i] === true) kb |= 1 << i; });
  b[Lo.badges] = jb;
  b[Lo.kantoBadges] = kb;
  const mom = save.mom ?? {};
  set24(b, Lo.momMoney, clamp(mom.savedMoney ?? 0, 0, 999999));
  b[Lo.whichMomItem] = clamp(mom.whichItem ?? 0, 0, 255);
  set24(b, Lo.momItemTrigger, clamp(mom.triggerBalance ?? 2300, 0, 0xffffff));

  // the pack
  const inv: Record<string, number> = save.inventory ?? {};
  const order: string[] = Array.isArray(save.bagOrder) ? save.bagOrder.filter((id: string) => inv[id]) : [];
  for (const id of Object.keys(inv)) if (!order.includes(id)) order.push(id);
  const pocket = (p: string): [string, number][] => order.filter((id) => inv[id] > 0 && data.items[id]?.pocket === p && !id.includes("BADGE")).map((id) => [id, inv[id]!]);
  for (const id of order) {
    if (inv[id] > 0 && !data.items[id] && !id.includes("BADGE")) notes.push(`pack: ${id} unknown to the cartridge, left out`);
  }
  writePocket(b, Lo.numItems, 20, true, pocket("ITEM"), data, notes, "items");
  writePocket(b, Lo.numBalls, 12, true, pocket("BALL"), data, notes, "balls");
  writePocket(b, Lo.numKeyItems, 25, false, pocket("KEY_ITEM"), data, notes, "key items");
  b.fill(0, Lo.tmhm, Lo.tmhm + 57);
  for (const [id, q] of pocket("TM_HM")) {
    const n = data.items[id]?.tmNumber;
    if (typeof n === "number" && n >= 1 && n <= 57) b[Lo.tmhm + n - 1] = n > 50 ? 1 : clamp(q, 1, 99);
  }
  const pcInv: Record<string, number> = save.pcItems ?? {};
  const pcOrder: string[] = Array.isArray(save.pcOrder) ? save.pcOrder.filter((id: string) => pcInv[id]) : [];
  for (const id of Object.keys(pcInv)) if (!pcOrder.includes(id)) pcOrder.push(id);
  writePocket(b, Lo.numPcItems, 50, true, pcOrder.filter((id) => pcInv[id]! > 0).map((id) => [id, pcInv[id]!]), data, notes, "PC items");
  const reg = save.registeredItem?.id;
  const regIdx = reg && inv[reg] ? data.items[reg]?.index : undefined;
  b[Lo.registeredItem] = typeof regIdx === "number" ? regIdx : 0;
  if (typeof regIdx !== "number") b[Lo.whichRegisteredItem] = 0;

  // party
  // (what lies past the last member is left as it was, as the cartridge
  // leaves it when a mon goes to the PC)
  const party: Mon[] = (save.party ?? []).filter((m: unknown) => m && typeof m === "object").slice(0, 6);
  let pn = 0;
  for (const m of party) {
    if (!writeMon(b, Lo.partyMons + pn * L.PARTY_MON_LEN, m, true, t, data, playerId, notes, `party ${pn + 1}`)) continue;
    b[Lo.partySpecies + pn] = m.isEgg ? EGG : b[Lo.partyMons + pn * L.PARTY_MON_LEN]!;
    writeName(b, Lo.partyOts + pn * L.NAME_LEN, otOf(m, playerName), L.NAME_LEN);
    writeName(b, Lo.partyNicks + pn * L.NAME_LEN, nickOf(m, data), L.NAME_LEN, true);
    pn++;
  }
  b[Lo.partyCount] = pn;
  b[Lo.partySpecies + pn] = 0xff;

  // boxes
  const cur = clamp(save.currentBox ?? 1, 1, L.NUM_BOXES);
  b[Lo.curBox] = (b[Lo.curBox]! & 0xf0) | (cur - 1);
  for (let bx = 1; bx <= L.NUM_BOXES; bx++) {
    const mons: Mon[] = Array.isArray(save.boxes?.[bx - 1]) ? save.boxes[bx - 1] : [];
    writeBox(b, Lo.boxBanks[bx - 1]!, mons, t, data, playerName, playerId, notes, `box ${bx}`);
    if (bx === cur) b.copyWithin(Lo.box, Lo.boxBanks[bx - 1]!, Lo.boxBanks[bx - 1]! + L.BOX_LEN);
    const nm = typeof save.boxNames?.[bx - 1] === "string" && save.boxNames[bx - 1] ? save.boxNames[bx - 1] : `BOX${bx}`;
    writeName(b, Lo.boxNames + (bx - 1) * L.BOX_NAME_LEN, nm, L.BOX_NAME_LEN);
  }

  // the dex, the letters
  b.fill(0, Lo.dexCaught, Lo.dexCaught + 64);
  const order2 = data.constants?.speciesOrder ?? [];
  const dexIndex = (sp: string): number | undefined => {
    const i = order2.indexOf(sp);
    if (i >= 0) return i;
    const idx = data.pokemon[sp]?.index;
    return typeof idx === "number" ? idx - 1 : undefined;
  };
  for (const [sp, on] of Object.entries<any>(save.pokedex?.seen ?? {})) { const i = dexIndex(sp); if (on && i !== undefined && i < 251) setBit(b, Lo.dexSeen, i, true); }
  for (const [sp, on] of Object.entries<any>(save.pokedex?.caught ?? {})) {
    const i = dexIndex(sp);
    if (on && i !== undefined && i < 251) { setBit(b, Lo.dexCaught, i, true); setBit(b, Lo.dexSeen, i, true); }
  }
  b.fill(0, Lo.unownDex, Lo.unownDex + 26);
  (save.unownDex ?? []).filter((v: number) => v >= 1 && v <= 26).slice(0, 26).forEach((v: number, i: number) => { b[Lo.unownDex + i] = v; });
  b[Lo.firstUnownSeen] = clamp(save.firstUnownSeen ?? 0, 0, 26);
  b[Lo.lastDexMode] = save.lastDexMode === "OLD" ? 1 : save.lastDexMode === "A-Z" ? 2 : 0;

  // event flags, scenes, script bytes, sprites, decorations
  b.fill(0, Lo.eventFlags, Lo.eventFlags + 256);
  for (const [k, v] of Object.entries<any>(save.events ?? {})) {
    const i = Number(k);
    if (i >= 0 && i < 256) b[Lo.eventFlags + i] = clamp(v, 0, 255);
  }
  // a map this game never set a scene for is on scene 0, and a script byte it
  // never wrote is 0 (its VM reads it so): the replaced save's are not kept
  for (const [map, off] of Object.entries(Lo.scenes)) {
    const v = save.mapScenes?.[map];
    b[off] = v === undefined ? 0 : clamp(v, 0, 255);
  }
  for (const [from, to] of scriptRanges(Lo)) {
    for (let off = from; off < to; off++) {
      const w = L.wramOfSram(Lo, off);
      if (w === null) continue;
      const v = save.scriptMem?.[w] ?? save.scriptMem?.[String(w)];
      b[off] = v !== undefined ? clamp(v, 0, 255) : 0;
    }
  }
  for (let i = 0; i < 16; i++) {
    const v = save.variableSprites?.[i];
    if (v !== undefined) b[Lo.variableSprites + i] = clamp(v, 0, 255);
  }
  DECO_SLOTS.forEach((k, i) => { b[Lo.decorations + i] = clamp(save.decorations?.[k] ?? 0, 0, 255); });
  for (let i = 0; i < 8; i++) setBit(b, tradeFlagsOf(Lo), i, !!save.tradeFlags?.[i]);

  // engine flags: every row the save keeps, from where this game keeps it
  const fem = engine === "crystal" ? eid(t, "ENGINE_PLAYER_IS_FEMALE") : undefined;
  Lo.engineFlags.forEach((row, id) => {
    if (!row) return;
    if (id === fem) return; // the gender byte, written above
    let on = !!save.engineFlags?.[id] || !!save.engineFlags?.[String(id)];
    const name = engine === "crystal" ? t.engineName[id] : GS_NAMES[id];
    if (name) on = engineValue(name, on, save);
    b[row[0]] = on ? b[row[0]]! | row[1] : b[row[0]]! & ~row[1];
  });

  // day care
  const dc = save.dayCare ?? {};
  let man = 0, lady = 0;
  b.fill(0, Lo.breedMon1, Lo.breedMon1 + 2 * L.NAME_LEN + L.BOX_MON_LEN);
  b.fill(0, Lo.breedMon2, Lo.breedMon2 + 2 * L.NAME_LEN + L.BOX_MON_LEN);
  b.fill(0, Lo.egg, Lo.egg + 2 * L.NAME_LEN + L.BOX_MON_LEN);
  const putBreed = (at: number, m: Mon | undefined, where: string): boolean => {
    if (!m || typeof m !== "object") return false;
    if (!writeMon(b, at + 2 * L.NAME_LEN, m, false, t, data, playerId, notes, where)) return false;
    writeName(b, at, nickOf(m, data), L.NAME_LEN, true);
    writeName(b, at + L.NAME_LEN, otOf(m, playerName), L.NAME_LEN);
    return true;
  };
  if (putBreed(Lo.breedMon1, dc.man?.mon, "day-care man")) man |= 1;
  if (dc.man?.introSeen) man |= 0x80;
  if (putBreed(Lo.breedMon2, dc.lady?.mon, "day-care lady")) lady |= 1;
  if (dc.lady?.introSeen) lady |= 0x80;
  if (dc.hasEgg && putBreed(Lo.egg, { ...(dc.egg ?? {}), isEgg: true }, "day-care egg")) man |= 0x40;
  if (dc.compatible) man |= 0x20;
  b[Lo.dayCareMan] = man;
  b[Lo.dayCareLady] = lady;
  b[Lo.stepsToEgg] = clamp(dc.stepsToEgg ?? 0, 0, 255);

  // roamers
  (save.roamers ?? []).slice(0, 3).forEach((r: any, i: number) => {
    const o2 = Lo.roamers + i * 7;
    b.fill(0, o2, o2 + 7);
    const idx = r?.species ? data.pokemon[r.species]?.index : undefined;
    if (typeof idx === "number") { b[o2] = idx; b[o2 + 1] = clamp(r.level ?? 40, 1, 100); }
    const m = r?.map ? data.maps[r.map] : undefined;
    b[o2 + 2] = m ? m.group : 0xff;
    b[o2 + 3] = m ? m.map : 0xff;
    b[o2 + 4] = clamp(r?.hp ?? 0, 0, 255);
    if (r?.dvs) {
      b[o2 + 5] = (clamp(r.dvs.attack, 0, 15) << 4) | clamp(r.dvs.defense, 0, 15);
      b[o2 + 6] = (clamp(r.dvs.speed, 0, 15) << 4) | clamp(r.dvs.special, 0, 15);
    }
  });

  // hall of fame
  const hof = save.hallOfFame ?? {};
  b[Lo.hofCount] = clamp(hof.count ?? 0, 0, 200);
  b.fill(0, Lo.hallOfFame, Lo.hallOfFame + L.HOF_TEAMS * L.HOF_LEN);
  (hof.teams ?? []).slice(0, L.HOF_TEAMS).forEach((team: any, k: number) => {
    const o2 = Lo.hallOfFame + k * L.HOF_LEN;
    b[o2] = clamp(team.winCount ?? 0, 0, 255);
    let i = 0;
    for (const m of team.mons ?? []) {
      const idx = data.pokemon[m?.species]?.index;
      if (typeof idx !== "number" || i >= 6) continue;
      const p = o2 + 1 + i * 16;
      b[p] = idx;
      set16(b, p + 1, clamp(m.otId ?? 0, 0, 0xffff));
      const d = m.dvs ?? {};
      b[p + 3] = (clamp(d.attack, 0, 15) << 4) | clamp(d.defense, 0, 15);
      b[p + 4] = (clamp(d.speed, 0, 15) << 4) | clamp(d.special ?? d.specialAttack, 0, 15);
      b[p + 5] = clamp(m.level ?? 1, 1, 100);
      writeName(b, p + 6, String(m.nickname ?? data.pokemon[m.species]?.name ?? m.species), 11, false);
      i++;
    }
    b[o2 + 1 + i * 16] = 0xff;
  });

  // phone
  const po = phoneListOf(Lo);
  if (po !== null) {
    const list: number[] = Array.isArray(save.phone?.list) ? save.phone.list : Object.keys(save.phoneContacts ?? {}).map(Number);
    b.fill(0, po, po + 11);
    list.filter((v) => v > 0).slice(0, 10).forEach((v, i) => { b[po + i] = clamp(v, 0, 255); });
  }

  // the place and everything the cartridge's continue reads around it
  const pos = save.position ?? {};
  const mapId = String(pos.map ?? "PLAYERS_HOUSE_2F");
  const def = data.maps[mapId];
  if (!def) throw new Error(`the map ${mapId} is not in this game's data`);
  const x = clamp(pos.x ?? 0, 0, 255), y = clamp(pos.y ?? 0, 0, 255);
  const moved = !useTemplate || b[Lo.mapGroup] !== def.group || b[Lo.mapNumber] !== def.map || b[Lo.x] !== x || b[Lo.y] !== y;
  b[Lo.mapGroup] = def.group;
  b[Lo.mapNumber] = def.map;
  b[Lo.x] = x;
  b[Lo.y] = y;
  b[Lo.playerState] = STATE_ID[String(save.playerState ?? "normal")] ?? 0;
  if (moved) {
    const order = data.constants?.spriteOrder as string[] | undefined;
    const spriteId = (name: string): number => (order ? order.indexOf(name) + 1 : 0);
    const spritePalette = (id: number): number => Number(data.sprites?.[order?.[id - 1] ?? ""]?.paletteId ?? 0);
    // the player's own sprite as the cartridge picks it: by gender (Crystal)
    // and by bike or surf
    const female = engine === "crystal" && player.gender === "female";
    const st = String(save.playerState ?? "normal");
    const name = st === "bike" ? (female ? "SPRITE_KRIS_BIKE" : "SPRITE_CHRIS_BIKE")
      : st === "surf" ? "SPRITE_SURF" : st === "surf_pika" ? "SPRITE_SURFING_PIKACHU"
      : female ? "SPRITE_KRIS" : "SPRITE_CHRIS";
    const ps = spriteId(name) || 1;
    b[Lo.mapObjects + 1] = ps;
    b[Lo.playerStruct] = ps;
    const live = opts?.blocks;
    const ctxData = live ? { ...data, maps: { ...data.maps, [mapId]: { ...def, blocks: live } } } : data;
    buildMapContext(b, Lo, ctxData, mapId, x, y, String(pos.facing ?? "down"), notes, undefined, spritePalette, female ? 0x90 : 0x80);
  }
  if (save.backupWarp?.map && data.maps[save.backupWarp.map]) {
    const bw = data.maps[save.backupWarp.map]!;
    b[Lo.backupWarp] = clamp(save.backupWarp.warp ?? 1, 0, 255);
    b[Lo.backupWarp + 1] = bw.group;
    b[Lo.backupWarp + 2] = bw.map;
    b[Lo.digWarp] = b[Lo.backupWarp]!;
    b[Lo.digWarp + 1] = bw.group;
    b[Lo.digWarp + 2] = bw.map;
  }
  if (save.blackoutMap && data.maps[save.blackoutMap]) {
    const bm = data.maps[save.blackoutMap]!;
    b[Lo.lastSpawn] = bm.group;
    b[Lo.lastSpawn + 1] = bm.map;
  }
  const sac = save.spawnAfterChampion ? data.landmarks?.spawns?.[save.spawnAfterChampion]?.index : undefined;
  b[Lo.spawnAfterChampion] = typeof sac === "number" ? sac : 0;

  finish(b, Lo);
  return { bytes: b, notes };
}

/** Gold/Silver's engine flag names by id, for the ones kept elsewhere. */
const GS_NAMES: Record<number, string> = {};
for (const [n, id] of Object.entries(GS_ENGINE)) GS_NAMES[id] = n;
for (let i = 0; i < 8; i++) { GS_NAMES[26 + i] = `ENGINE_${JOHTO[i]}BADGE`; GS_NAMES[34 + i] = `ENGINE_${KANTO[i]}BADGE`; }

/** A flag this game keeps in a field of its own. */
function engineValue(name: string, flag: boolean, save: Record<string, any>): boolean {
  const p = save.player ?? {};
  const m = /^ENGINE_([A-Z]+)BADGE$/.exec(name);
  if (m) return !!(p.badges?.[m[1]!] || p.kantoBadges?.[m[1]!]);
  switch (name) {
    case "ENGINE_DAY_CARE_MAN_HAS_EGG": return !!save.dayCare?.hasEgg;
    case "ENGINE_DAY_CARE_MAN_HAS_MON": return !!save.dayCare?.man?.mon;
    case "ENGINE_DAY_CARE_LADY_HAS_MON": return !!save.dayCare?.lady?.mon;
    case "ENGINE_BUG_CONTEST_TIMER": return !!save.bugContest?.active;
    case "ENGINE_MOM_SAVING_MONEY": return flag || !!save.mom?.savingMoney;
    case "ENGINE_MOM_ACTIVE": return flag || !!save.mom?.active;
    case "ENGINE_POKEDEX": return flag || save.pokedexReceived === true;
    case "ENGINE_POKEGEAR": return flag || save.pokegearReceived === true;
    case "ENGINE_SWARM": case "ENGINE_QWILFISH_SWARM": return flag || !!save.dailyFlags?.swarm;
    case "ENGINE_CREDITS_SKIP": return flag || !!save.hallOfFame?.entered || (save.hallOfFame?.count ?? 0) > 0;
  }
  return flag;
}

/** Check bytes, the checksum, and the backup copy made to match. */
function finish(b: Uint8Array, Lo: Layout): void {
  b[Lo.check1] = L.CHECK_1;
  b[Lo.check2] = L.CHECK_2;
  const sum = checksum(b, Lo.main, Lo.mainEnd);
  b[Lo.checksum] = sum & 0xff;
  b[Lo.checksum + 1] = sum >> 8;
  for (const [bk, mn, n] of Lo.backup) b.copyWithin(bk, mn, mn + n);
  b.copyWithin(Lo.backupOptions, Lo.options, Lo.options + 8);
  b[Lo.backupCheck1] = L.CHECK_1;
  b[Lo.backupCheck2] = L.CHECK_2;
  b[Lo.backupChecksum] = sum & 0xff;
  b[Lo.backupChecksum + 1] = sum >> 8;
}
