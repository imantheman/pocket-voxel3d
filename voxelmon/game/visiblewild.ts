// VISIBLE WILD (ENHANCEMENTS) for Red, Blue and Yellow: the rules half. The
// wild mons a map's random encounters would have rolled walk about the
// overworld instead, and a battle starts by touching one. The runtime --
// spawning, wandering, the touch -- is world/wildmons.ts; this file is what
// the setting means, kept pure so the tests can drive it without a game.
//
//   the setting    options.visibleWild: "off" | "some" | "many", OFF unless
//                  set. A port-only key like the rest of ENHANCEMENTS:
//                  gen1recomp keeps it as it is, the VC conversion never
//                  writes it. While SOME or MANY is on (and no link is up)
//                  the step roll is skipped entirely: every wild battle
//                  outside fishing and the scripts is a visible one.
//   where          a map with a land table: its grass cells, or on a cave
//                  (an indoor map whose tileset is not FOREST, where the
//                  cart rolls on every tile) its walkable floor. A map with
//                  a surf table: its water, while the player is surfing (the
//                  cart only rolls the surf table afloat). Only a cell that
//                  is floor (or water) in all four of its tiles, not one
//                  half fence or ledge, not a grass patch's top row (the
//                  standing card would cover the fence or path behind it),
//                  nor its bottom row against a fence, a ledge or trees
//                  (its feet would sit on them). Never a warp, a
//                  cell beside one, the map's edge row, a one-wide corridor
//                  or its dead end, so no doorway or only path is ever stood
//                  in; never a map without a table (a town's grass included).
//   which mon      one slot of the table, picked with the cart's weights
//                  (ENCOUNTER_BUCKETS: 51, 51, 39, 25, 25, 25, 13, 13, 11, 3
//                  out of 256), exactly that species and level. A REPEL
//                  keeps the weaker ones from appearing, as it does the roll.
//   how many       SOME about 2-3 round the player, MANY about 5-6, fewer
//                  where the window round the player holds little grass
//                  (wildTarget). WILD ENCOUNTERS (the cheat) scales it: NONE
//                  none at all, LESS half, MORE half as many again.
//   the sprite     a species' own overworld sheet where the ROM has one
//                  (Yellow's PIKACHU, CLEFAIRY, JIGGLYPUFF, SANDSHREW,
//                  ODDISH, BULBASAUR, CHANSEY; SEEL in all three), else its
//                  party-menu icon family (MonPartyData), drawn from the
//                  overworld sheet the ROM's icon is (MONSTER, BIRD, FAIRY,
//                  SEEL, POKE_BALL, FOSSIL; Yellow's PIKACHU). BUG, GRASS,
//                  SNAKE and QUADRUPED icons have art of their own the pak
//                  does not carry; those families show the MONSTER sheet,
//                  the ROM's generic mon, until a pak holds sheets named
//                  icon_bug / icon_plant / icon_snake / icon_quadruped.

import type { EncounterDef, EncounterGroup, EncounterSlot } from "./data.ts";
import { randRange, type Rng } from "./rng.ts";
import { ENCOUNTER_BUCKETS } from "./rules/encounter.ts";
import type { WildMode } from "./extras.ts";

export const VISIBLE_WILD_MODES = ["off", "some", "many"] as const;
export type VisibleWildMode = (typeof VISIBLE_WILD_MODES)[number];

type SaveLike = { options?: Record<string, unknown> | null } | null | undefined;

/** options.visibleWild, OFF when unset or anything else. */
export function visibleWildMode(save: SaveLike): VisibleWildMode {
  const v = save?.options?.visibleWild;
  return (VISIBLE_WILD_MODES as readonly unknown[]).includes(v) ? (v as VisibleWildMode) : "off";
}

/** SOME or MANY. */
export function visibleWildOn(save: SaveLike): boolean {
  return visibleWildMode(save) !== "off";
}

// ---------------------------------------------------------------------------
// where: the cells a map's mons may stand on
// ---------------------------------------------------------------------------

/** A cell's kind: none, the land table's, the surf table's. */
export const CELL_NONE = 0;
export const CELL_LAND = 1;
export const CELL_WATER = 2;

/** What classifyCells needs of a GameMap. */
export interface WildMapLike {
  widthCells: number;
  heightCells: number;
  def: { index: number; tileset: string };
  isGrassCell(cx: number, cy: number): boolean;
  isWaterCell(cx: number, cy: number): boolean;
  isWalkableCell(cx: number, cy: number): boolean;
  isWarpTileCell(cx: number, cy: number): boolean;
  warpAtCell(cx: number, cy: number): unknown;
  /** All four tiles of the cell of the kind (map.ts); absent: the cell's
   *  own kind is taken as the whole of it. */
  isWholeCell?(cx: number, cy: number, kind: "floor" | "water"): boolean;
}

/** field.indoorEncounters: maps from this index roll on every tile, but
 *  not the FOREST tileset's (wild_encounters.asm). */
export interface IndoorRule {
  firstIndoorMap: number;
  excludedTileset: string;
}

/** The land table a map rolls, or null (no table, or a rate of 0). */
export function landTable(enc: EncounterDef | null | undefined): EncounterGroup | null {
  const g = enc?.grass;
  return g && g.rate > 0 && g.slots?.length ? g : null;
}

/** The surf table, or null. */
export function waterTable(enc: EncounterDef | null | undefined): EncounterGroup | null {
  const g = enc?.water;
  return g && g.rate > 0 && g.slots?.length ? g : null;
}

/** A cave in the cart's sense: every tile rolls the land table. */
export function everyTileRolls(map: WildMapLike, indoor: IndoorRule | null | undefined): boolean {
  return !!indoor && map.def.index >= indoor.firstIndoorMap && map.def.tileset !== indoor.excludedTileset;
}

/**
 * Every cell's kind for a map (CELL_*). A cell a mon could roll on but must
 * keep clear of is CELL_NONE: one that is only partly floor or water (the
 * top half a fence, a ledge or a cave wall), the top row of a patch of
 * grass (a mon there stands up in front of the fence or path behind it)
 * or its bottom row against a fence, a ledge or trees,
 * a warp or a door, a cell next to one, the edge row (a connection's
 * crossing), a one-wide corridor or its dead end -- so nothing ever stands
 * in a doorway or a path's only lane, or half out of the grass.
 *
 * The overworld works this out a few rows a tick (CellClassifier) so a
 * map's entry costs no long frame on the console; this is the whole map at
 * once, for the tests and the tools.
 */
export function classifyCells(
  map: WildMapLike,
  enc: EncounterDef | null | undefined,
  indoor?: IndoorRule | null,
): Uint8Array {
  const c = new CellClassifier(map, enc, indoor);
  c.step(Infinity);
  return c.out;
}

/** classifyCells a slice at a time: `step(budget)` does whole rows until
 *  about `budget` cells are done. `out` reads CELL_NONE where not yet done. */
export class CellClassifier {
  readonly out: Uint8Array;
  private y = 1;
  private readonly land: boolean;
  private readonly water: boolean;
  private readonly cave: boolean;

  constructor(
    private readonly map: WildMapLike,
    enc: EncounterDef | null | undefined,
    indoor?: IndoorRule | null,
  ) {
    this.out = new Uint8Array(map.widthCells * map.heightCells);
    this.land = landTable(enc) !== null;
    this.water = waterTable(enc) !== null;
    this.cave = this.land && everyTileRolls(map, indoor);
    if (!this.land && !this.water) this.y = map.heightCells;
  }

  get done(): boolean {
    return this.y >= this.map.heightCells - 1;
  }

  step(budget: number): void {
    const w = this.map.widthCells;
    let n = 0;
    while (!this.done && n < budget) {
      for (let x = 1; x < w - 1; x++) this.out[this.y * w + x] = this.kindOf(x, this.y);
      n += w;
      this.y++;
    }
  }

  private kindOf(x: number, y: number): number {
    const map = this.map;
    const isWater = (cx: number, cy: number) => map.isWaterCell(cx, cy);
    const walk = (cx: number, cy: number) => map.isWalkableCell(cx, cy) && !isWater(cx, cy);
    const cave = this.cave;
    let k = CELL_NONE;
    if (this.water && isWater(x, y)) k = CELL_WATER;
    else if (this.land && walk(x, y) && (cave || map.isGrassCell(x, y))) k = CELL_LAND;
    if (k === CELL_NONE) return k;
    {
      // the whole cell floor (grass included) or water: a cell half fence,
      // half ledge or half cave wall walks as its bottom tile says, but a
      // mon on it would be drawn over the fence
      if (map.isWholeCell && !map.isWholeCell(x, y, k === CELL_WATER ? "water" : "floor")) return CELL_NONE;
      // grass: not the top row of a patch -- the mon's card stands up from
      // its cell, so there it would be drawn over the fence or path behind
      if (k === CELL_LAND && !cave && !map.isGrassCell(x, y - 1)) return CELL_NONE;
      // nor the bottom row against a fence, a ledge or trees: the card's
      // feet would sit on them
      if (k === CELL_LAND && !cave && !walk(x, y + 1)) return CELL_NONE;
      // a warp or a door, or a cell beside one
      if (map.warpAtCell(x, y) || map.isWarpTileCell(x, y)) return CELL_NONE;
      if (map.warpAtCell(x - 1, y) || map.warpAtCell(x + 1, y) || map.warpAtCell(x, y - 1) || map.warpAtCell(x, y + 1)) return CELL_NONE;
      // a one-wide lane (open both ways along one axis, shut across it) or
      // the dead end of one: the way past, or to what the lane leads to
      const pass = k === CELL_WATER ? isWater : walk;
      const u = pass(x, y - 1), d = pass(x, y + 1), l = pass(x - 1, y), r = pass(x + 1, y);
      if ((u && d && !l && !r) || (l && r && !u && !d)) return CELL_NONE;
      if (+u + +d + +l + +r <= 1) return CELL_NONE;
    }
    return k;
  }
}

// ---------------------------------------------------------------------------
// how many
// ---------------------------------------------------------------------------

/** The spawn window, cells either side of the player: about what the 3D
 *  view shows round them at the default zoom. */
export const WINDOW_X = 7;
export const WINDOW_Y = 6;
/** No spawn closer than this (Chebyshev cells): nothing appears underfoot. */
export const NEAR = 3;
/** Gone past this many cells from the player. */
export const FAR = 10;
/** The most at once, whatever the setting and the cheat. */
export const MAX_WILD = 8;

/**
 * How many a setting keeps round the player, for `cells` cells of its kind
 * in the window: SOME 2-3, MANY 5-6, fewer for a small patch (a few cells
 * of grass hold one or two, not a crowd).
 */
export function baseCount(mode: VisibleWildMode, cells: number): number {
  if (mode === "off" || cells <= 0) return 0;
  if (mode === "some") return cells < 8 ? 1 : cells < 40 ? 2 : 3;
  return cells < 8 ? 2 : cells < 24 ? 4 : cells < 60 ? 5 : 6;
}

/**
 * The count to keep: baseCount scaled by WILD ENCOUNTERS (NONE 0, LESS
 * half, NORMAL as is, MORE half as many again), never more than MAX_WILD
 * or the entity slots free (`slots`).
 */
export function wildTarget(mode: VisibleWildMode, cheat: WildMode, cells: number, slots = MAX_WILD): number {
  if (cheat === "none") return 0;
  const base = baseCount(mode, cells);
  if (base === 0) return 0;
  const scaled = cheat === "less" ? Math.max(1, Math.round(base / 2))
    : cheat === "more" ? Math.round(base * 1.5)
    : base;
  return Math.max(0, Math.min(scaled, MAX_WILD, slots));
}

// ---------------------------------------------------------------------------
// which mon
// ---------------------------------------------------------------------------

/**
 * One slot of a table by the cart's weights: a single byte against the
 * cumulative buckets (TryDoWildEncounter's second roll; the rate gate, its
 * first, has no meaning here -- the mon is already on the map).
 */
export function pickSlot(table: EncounterGroup | null | undefined, rng: Rng): EncounterSlot | null {
  if (!table?.slots?.length) return null;
  const pick = rng.byte();
  const thresholds = table.buckets ?? ENCOUNTER_BUCKETS;
  for (let i = 0; i < thresholds.length; i++) {
    if (pick < thresholds[i]!) {
      const s = table.slots[i];
      return s ? { species: s.species, level: s.level } : null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// the sprite
// ---------------------------------------------------------------------------

/**
 * MonPartyData, the ROM's party-menu icon per species in dex order, one
 * letter each: M MON, B BALL, H HELIX, F FAIRY, D BIRD, W WATER, U BUG,
 * G GRASS, S SNAKE, Q QUADRUPED. Read off Red's ROM; Blue's is the same and
 * Yellow's differs only at 25 and 26 (its ICON_PIKACHU, see wildSprite).
 */
export const MON_PARTY_ICONS =
  "GGGMMMWWWUUUUUUDDDQQDDSSFFMMMMMMMMFFQQFFMMGGGUUUUM" +
  "MMMMMMMQQMMMMMMMMMGGGWWMMMQQQMBBDDDWWMMHHMMMSMMWWB" +
  "BGGMMMMMMMQMFGMWWWWHHMUMMMUQWSWMQQQQMHHHHDMDDDSSSM" +
  "M";

/** The overworld sheet each icon family is drawn from: the ROM's own for
 *  six of them (data/icon_pointers.asm points them at these sheets). The
 *  other four are their own art; a pak with sheets by these names has it. */
export const ICON_SHEETS: Record<string, string> = {
  M: "SPRITE_MONSTER",
  B: "SPRITE_POKE_BALL",
  H: "SPRITE_FOSSIL",
  F: "SPRITE_FAIRY",
  D: "SPRITE_BIRD",
  W: "SPRITE_SEEL",
  P: "SPRITE_PIKACHU",
  U: "SPRITE_ICON_BUG",
  G: "SPRITE_ICON_PLANT",
  S: "SPRITE_ICON_SNAKE",
  Q: "SPRITE_ICON_QUADRUPED",
};

/** Species whose own overworld sheet the ROM has (Yellow's set; SEEL in
 *  every game). Used only where the dataset has the sheet. */
export const OWN_SHEETS: Record<string, string> = {
  PIKACHU: "SPRITE_PIKACHU",
  SANDSHREW: "SPRITE_SANDSHREW",
  ODDISH: "SPRITE_ODDISH",
  BULBASAUR: "SPRITE_BULBASAUR",
  JIGGLYPUFF: "SPRITE_JIGGLYPUFF",
  CLEFAIRY: "SPRITE_CLEFAIRY",
  CHANSEY: "SPRITE_CHANSEY",
  SEEL: "SPRITE_SEEL",
};

interface SpriteData {
  pokemon?: Record<string, { dex?: number } | undefined>;
  sprites?: Record<string, unknown>;
  atlas?: { sprites?: Record<string, number> };
}

/** A sheet the game can draw: a page of the pak's atlas (scene.ts
 *  sheetIndex's lookup) when the dataset came with one, else an entry of
 *  the dataset's sprite table. */
function hasSheet(data: SpriteData, id: string): boolean {
  const atlas = data.atlas?.sprites;
  if (atlas) {
    const page = atlas[id.replace(/^SPRITE_/, "").toLowerCase()];
    return typeof page === "number" && page >= 0;
  }
  return !!data.sprites && id in data.sprites;
}

/** The icon family letter for a species (MON_PARTY_ICONS), Yellow's
 *  PIKACHU icon where its dataset has the sheet. */
export function iconFamily(data: SpriteData, species: string): string {
  const dex = data.pokemon?.[species]?.dex ?? 0;
  let f = dex >= 1 && dex <= MON_PARTY_ICONS.length ? MON_PARTY_ICONS[dex - 1]! : "M";
  // Yellow's MonPartyData gives PIKACHU and RAICHU ICON_PIKACHU, drawn from
  // the overworld PikachuSprite; the sheet itself marks a Yellow dataset
  if ((dex === 25 || dex === 26) && data.sprites && "SPRITE_PIKACHU" in data.sprites) f = "P";
  return f;
}

/** The overworld sheet a wild mon of `species` is drawn with. */
export function wildSprite(data: SpriteData, species: string): string {
  const own = OWN_SHEETS[species];
  if (own && hasSheet(data, own)) return own;
  const sheet = ICON_SHEETS[iconFamily(data, species)] ?? "SPRITE_MONSTER";
  return hasSheet(data, sheet) ? sheet : "SPRITE_MONSTER";
}

// ---------------------------------------------------------------------------
// timing (logic ticks: at SPEED 2X they pass twice as fast, as everything does)
// ---------------------------------------------------------------------------

/** Frames a step takes: slower than a person's sixteen. */
export const WILD_STEP_FRAMES = 24;

/** Frames between one wander decision and the next. */
export function wanderDelay(rng: Rng): number {
  return randRange(rng, 50, 160);
}

/** How long one stays before it may wander off (30-60 s). */
export function lifetime(rng: Rng): number {
  return randRange(rng, 1800, 3600);
}

/** Frames until the next spawn while under the count (1-2.5 s). */
export function respawnDelay(rng: Rng): number {
  return randRange(rng, 60, 150);
}
