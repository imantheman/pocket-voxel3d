// The border block that surrounds a map.
// A port of gen1recomp src/world/gen2/BorderFill.lua at bdfac727 (MIT).
//
// home/map.asm LoadBlockData byte-fills wOverworldMapBlocks with 0 before
// ChangeMap copies the map's own blocks into the middle of it, and then
// LoadMetatiles resolves every block it reads:
//
//   ; If the current map block is a border block, load the border block.
//   ld a, [de] / and a / jr nz, .ok / ld a, [wMapBorderBlock]
//
// So block id 0 is not "tileset block 0": it is a stand-in for the map
// header's border block, both in the margin ChangeMap never wrote to and
// anywhere inside the map's own block list.
//
// The Lua bakes the block into a 32x32 wrap-tiled image and tiles it under
// the map (bake, draw). That is tile-canvas drawing, which the voxel renderer
// owns here, so `bake` and `draw` are not ported; the logic they rest on --
// blockFor, the viewport math, the void-fill option and the crossfade
// bookkeeping -- is.

export type VoidFill = "fade" | "water" | "trees" | "black";

// Lua: BorderFill.lua:181-186 -- canonical fill blocks (the wMapBorderBlock
// values data/maps/attributes.asm already uses as those fills).
const FILL_BLOCKS: Record<string, { trees?: number; water?: number }> = {
  TILESET_JOHTO: { trees: 0x05, water: 0x35 },
  TILESET_JOHTO_MODERN: { trees: 0x05, water: 0x35 },
  TILESET_KANTO: { trees: 0x0f, water: 0x43 },
  TILESET_FOREST: { trees: 0x05 },
};

/** The crossfade bookkeeping BorderFill keeps on its owner (the World). */
export interface BorderOwner {
  borderKey?: unknown;
  borderFrom?: unknown;
  borderLast?: unknown;
  borderFade?: number;
  [key: string]: any;
}

export const BorderFill = {
  // Lua: BorderFill.lua:33-34 -- one block, in pixels: 4x4 tiles of 8.
  SIZE: 32,

  // Lua: BorderFill.lua:36-41 -- LoadMetatiles' `and a / jr nz` in one place:
  // id 0 (or a hole in the block list) reads as the map header's border block.
  blockFor(blockId: number | null | undefined, borderBlock?: number | null): number {
    if (blockId == null || blockId === 0) return borderBlock ?? 0;
    return blockId;
  },

  // Lua: BorderFill.lua:43-49 -- bakes share the map canvases' key; the suffix
  // keeps World:dropMapImages' "<mapId>|" prefix sweep working on it.
  cacheKey(mapKey: unknown): string {
    return String(mapKey) + "|border";
  },

  // Lua: BorderFill.lua:51-65 -- where to put the wrap-tiled quad for a
  // camera at (camX, camY) filling a w x h screen at scale s. Returns
  // [ix, iy, vw, vh, sx, sy].
  viewport(camX: number, camY: number, w: number, h: number, s?: number): [number, number, number, number, number, number] {
    s = (s && s > 0) ? s : 1;
    const ix = Math.floor(camX);
    const iy = Math.floor(camY);
    const vw = Math.ceil(w / s) + BorderFill.SIZE;
    const vh = Math.ceil(h / s) + BorderFill.SIZE;
    const sx = Math.floor((ix - camX) * s);
    const sy = Math.floor((iy - camY) * s);
    return [ix, iy, vw, vh, sx, sy];
  },

  // Lua: BorderFill.lua:67-166 bake: bakes the block into a 32x32 image with
  // the BG palettes (and a water frame). Tile drawing; not ported. Returns
  // nil as the Lua does when LÖVE is absent.
  bake(_atlas?: unknown, _tileset?: unknown, _blockId?: unknown, _bgSet?: unknown, _waterFrame?: unknown): undefined {
    return undefined;
  },

  // Lua: BorderFill.lua:168-179 -- VOID FILL (#1418): the beyond-edge scenery
  // under survey zoom.
  VOID_FILLS: ["fade", "water", "trees", "black"] as VoidFill[],
  voidFill: "fade" as VoidFill,

  // Lua: BorderFill.lua:188
  setVoidFill(mode: unknown): void {
    let ok = false;
    for (const name of BorderFill.VOID_FILLS) {
      if (name === mode) { ok = true; break; }
    }
    BorderFill.voidFill = ok ? (mode as VoidFill) : "fade";
  },

  // Lua: BorderFill.lua:196
  cycle(delta?: number): VoidFill {
    const cur = BorderFill.voidFill ?? "fade";
    let at = 1;
    BorderFill.VOID_FILLS.forEach((name, i) => {
      if (at === 1 && name === cur) at = i + 1;
    });
    const n = BorderFill.VOID_FILLS.length;
    const m = (at - 1 + (delta ?? 1));
    at = (m - Math.floor(m / n) * n) + 1;
    BorderFill.setVoidFill(BorderFill.VOID_FILLS[at - 1]);
    return BorderFill.voidFill;
  },

  // Lua: BorderFill.lua:208
  applyOptions(opts?: { voidFill?: unknown } | null): void {
    BorderFill.setVoidFill((opts && opts.voidFill) || "fade");
  },

  // Lua: BorderFill.lua:212-219
  voidFillLabel(mode?: VoidFill): string {
    mode = mode ?? BorderFill.voidFill ?? "fade";
    if (mode === "water") return "WATER";
    if (mode === "trees") return "TREES";
    if (mode === "black") return "BLACK";
    // trailing space blanks the 5-char WATER/TREES/BLACK from the value column
    return "FADE ";
  },

  // Lua: BorderFill.lua:221-231 -- the metatile the void should bake, or false
  // when BLACK skips tiling.
  fillBlock(def: any): number | false {
    const mode = BorderFill.voidFill ?? "fade";
    if (mode === "black") return false;
    if ((mode === "water" || mode === "trees") && def) {
      const fills = FILL_BLOCKS[def.tileset];
      const block = fills ? fills[mode] : undefined;
      if (block != null) return block;
    }
    return def ? (def.borderBlock ?? 0) : 0;
  },

  // Lua: BorderFill.lua:233-245 -- crossfade identity.
  fillKey(def: any): string {
    const mode = BorderFill.voidFill ?? "fade";
    if (mode === "black") return "black";
    const block = BorderFill.fillBlock(def);
    const str = (v: unknown): string => (v == null ? "nil" : String(v));
    if (mode === "water" || mode === "trees") {
      return mode + "|" + str(def ? def.tileset : undefined) + "|" + str(block);
    }
    return "fade|" + str(def ? def.id : undefined);
  },

  // Lua: BorderFill.lua:247-257 -- each map header carries its own border
  // block, so the swap at a boundary is dissolved rather than cut.
  CROSSFADE_FRAMES: 20,

  // Lua: BorderFill.lua:259-278 -- the bookkeeping half, love-free. Returns
  // [imageUnderneath | undefined, alpha of the incoming image].
  crossfade(owner: BorderOwner | null | undefined, image: unknown, key: unknown): [unknown, number] {
    if (!owner || key == null) return [undefined, 1];
    if (owner.borderKey !== key) {
      // Nothing to dissolve from on the first map of a session.
      owner.borderFrom = (owner.borderKey != null) ? owner.borderLast : undefined;
      owner.borderKey = key;
      owner.borderFade = owner.borderFrom != null ? 0 : undefined;
    }
    owner.borderLast = image;
    if (owner.borderFade == null) return [undefined, 1];
    owner.borderFade = owner.borderFade + 1;
    if (owner.borderFade >= BorderFill.CROSSFADE_FRAMES) {
      owner.borderFade = undefined;
      owner.borderFrom = undefined;
      return [undefined, 1];
    }
    return [owner.borderFrom, owner.borderFade / BorderFill.CROSSFADE_FRAMES];
  },

  // Lua: BorderFill.lua:280-303 draw: tiles the baked image across the view
  // (LÖVE drawing); not ported. The renderer calls crossfade() itself if it
  // wants the dissolve.
};

export default BorderFill;
