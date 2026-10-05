// Port of gen1recomp src/import/gba/family.lua + families/frlg.lua (GPLv3 +
// additional terms; see LICENSE.md). The GBA layout family descriptor
// (struct sizes, decoders) for the active Gen 3 game. Only "frlg" is ported.

import { GameVersion } from "./game_version.ts";
import frlgData from "./data/family_frlg.ts";
import mapGroupsFirered from "./data/map_groups_firered.ts";
import type { Rom } from "./rom.ts";

export interface FamilyDesc {
  game: string;
  name: string;
  numPrimaryTiles: number;
  numTilesTotal: number;
  numPrimaryMetatiles: number;
  numMetatilesTotal: number;
  numPalsInPrimary: number;
  numPalsTotal: number;
  metatileBytes: number;
  layoutSize: number;
  tilesetOffsets: { tiles: number; palettes: number; metatiles: number; callback: number; attributes: number };
  attrBytes: number;
  cloneObjects: boolean;
  secretBaseBgKind: number | undefined;
  hiddenItemBgKind: number;
  encounterSource: string;
  aliases: boolean;
  groupsModule: string;
  connDirs: Record<number, string>;
  behaviorOf(w: number): number;
  layerOf(w: unknown): number;
  encounterOf(w: unknown): number;
  borderDims(rom: Rom, layoutOff: number): [number, number];
  decodeHeaderFlags(rom: Rom, headerOff: number, out: Record<string, unknown>): Record<string, unknown>;
  hiddenItem(rom: Rom, base: number): { item: number; hiddenItemId: number; quantity: number; underfoot: boolean };
  groups(): any;
  mapConstAt(): undefined;
  tilesetName(): undefined;
  uncompressedTileBytes(_rom: unknown, tilesOff: number | undefined, palsOff: number | undefined): number | undefined;
  [k: string]: unknown;
}

const num = (w: unknown): number => (typeof w === "number" ? w : Number(w) || 0);

// Lua: families/frlg.lua
const FRLG: Omit<FamilyDesc, "game"> = {
  ...(frlgData as unknown as Record<string, unknown>),
  name: "frlg",
  behaviorOf: (w: number) => w % 512,
  layerOf: (w: unknown) => Math.floor(num(w) / 0x20000000) % 4,
  encounterOf: (w: unknown) => Math.floor(num(w) / 0x1000000) % 8,
  // Lua: families/frlg.lua:49
  borderDims(rom: Rom, layoutOff: number): [number, number] {
    return [rom.get(layoutOff + 24) || 2, rom.get(layoutOff + 25) || 2];
  },
  // Lua: families/frlg.lua:54 -- pokefirered/include/global.fieldmap.h:204
  decodeHeaderFlags(rom: Rom, headerOff: number, out: Record<string, unknown>) {
    out.bikingAllowed = rom.get(headerOff + 24);
    const flags = rom.get(headerOff + 25) || 0;
    out.allowEscaping = flags % 2;
    out.allowRunning = Math.floor(flags / 2) % 2;
    out.showMapName = Math.floor(flags / 4) % 64;
    let floor = rom.get(headerOff + 26) || 0;
    if (floor >= 0x80) floor -= 0x100;
    out.floorNum = floor;
    out.battleType = rom.get(headerOff + 27);
    return out;
  },
  // Lua: families/frlg.lua:68 -- pokefirered/asm/macros/map.inc:109
  hiddenItem(rom: Rom, base: number) {
    const info = rom.u16(base + 10);
    let quantity = Math.floor(info / 256) % 128;
    if (quantity === 0) quantity = 1;
    return { item: rom.u16(base + 8), hiddenItemId: info % 256, quantity, underfoot: info >= 32768 };
  },
  groups() { return mapGroupsFirered; },
  mapConstAt() { return undefined; },
  tilesetName() { return undefined; },
  // Lua: families/frlg.lua:92
  uncompressedTileBytes(_rom: unknown, tilesOff: number | undefined, palsOff: number | undefined) {
    if (palsOff !== undefined && tilesOff !== undefined && palsOff > tilesOff) return palsOff - tilesOff;
    return undefined;
  },
} as Omit<FamilyDesc, "game">;

const BASES: Record<string, Omit<FamilyDesc, "game">> = { frlg: FRLG };
const perGame: Record<string, FamilyDesc> = {};
let lastId: string | undefined;
let lastF: FamilyDesc | undefined;

export const Family = {
  DEFAULT_GAME: "firered",
  // Lua: family.lua:21
  gameOf(id: string | undefined): string {
    if (id !== undefined && GameVersion.layout(id)) return id;
    return Family.DEFAULT_GAME;
  },
  // Lua: family.lua:26
  of(id: string | undefined): FamilyDesc {
    const game = Family.gameOf(id);
    const hit = perGame[game];
    if (hit) return hit;
    const layout = GameVersion.layout(game)!;
    const b = BASES[layout];
    if (!b) throw new Error(`layout family: no descriptor for '${layout}'`);
    const over = (b as Record<string, any>).games?.[game] ?? {};
    const F = { ...b, ...over, game } as FamilyDesc;
    perGame[game] = F;
    return F;
  },
  // Lua: family.lua:44
  active(): FamilyDesc {
    const id = GameVersion.get();
    if (id === lastId && lastF) return lastF;
    lastF = Family.of(id);
    lastId = id;
    return lastF;
  },
  activeGame(): string {
    return Family.active().game;
  },
  reset(): void {
    for (const k of Object.keys(perGame)) delete perGame[k];
    lastId = undefined;
    lastF = undefined;
  },
};

export default Family;
