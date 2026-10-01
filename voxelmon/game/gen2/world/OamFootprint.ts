// Map-pixel coverage for standard 16x16 overworld walkers, derived from pret
// pokecrystal data/sprites/facings.asm and map_objects.asm InitSprite.
// A port of gen1recomp src/world/gen2/OamFootprint.lua at bdfac727 (MIT).
//
// FacingStep* tables place RELATIVE_ATTRIBUTES on the bottom OAM row (y = 8).
// InitSprite writes each OBJ at object Y + OAM_Y_OFS - 4, so that row covers
// map pixels py+4 .. py+12. OBJECT_SPRITE_Y_OFFSET moves the whole sprite
// without moving the object off its tile.

interface Placed {
  px?: number;
  py?: number;
  spriteYOffset?: number;
}

export const OamFootprint = {
  // Lua: OamFootprint.lua:11
  spriteYOffset(entity: Placed | null | undefined): number {
    return entity ? (entity.spriteYOffset ?? 0) : 0;
  },

  // Lua: OamFootprint.lua:15-20 -- bottom OAM row when IN_GRASS sets OAM_PRIO.
  // Returns [x0, y0, x1, y1].
  feetStrip(entity: Placed): [number, number, number, number] {
    const px = entity.px ?? 0;
    const py = (entity.py ?? 0) + OamFootprint.spriteYOffset(entity);
    return [px, py + 4, px + 16, py + 12];
  },

  // Lua: OamFootprint.lua:22-27 -- full OBJ footprint for wAttrmap B_BG_PRIO
  // (bit 7) overdraw. Returns [x0, y0, x1, y1].
  spriteBBox(entity: Placed): [number, number, number, number] {
    const px = entity.px ?? 0;
    const py = (entity.py ?? 0) + OamFootprint.spriteYOffset(entity);
    return [px, py, px + 16, py + 24];
  },
};

export default OamFootprint;
