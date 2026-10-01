// pret data/sprites/facings.asm: per-facing OAM tables for standard 16x16
// walkers. RELATIVE_ATTRIBUTES (bit 3) on an entry means InitSprite ORs
// hCurSpriteOAMFlags into that tile's attribute byte -- IN_GRASS sets OAM_PRIO
// there, so only those rows sit behind BG palette shades 1-3.
// A port of gen1recomp src/world/gen2/OamFacings.lua at bdfac727 (MIT).

// Lua: OamFacings.lua:6-7
const OAM_XFLIP = 0x20;
const RELATIVE_ATTRIBUTES = 0x08; // RELATIVE_ATTRIBUTES_F in map_object_constants.asm

/** One OAM entry { y, x, attr, tile } relative to the InitSprite anchor. */
export interface OamRow {
  y: number;
  x: number;
  attr: number;
  tile: number;
}

// Lua: OamFacings.lua:14-20
function row(y: number, x: number, attr: number, tile: number): OamRow {
  return { y, x, attr, tile };
}

function facing(rows: OamRow[]): OamRow[] {
  return rows;
}

export const OamFacings = {
  // Lua: OamFacings.lua:11-12
  OAM_XFLIP,
  RELATIVE_ATTRIBUTES,

  // Lua: OamFacings.lua:22-28 -- FacingStepDown0 / FacingStepDown2 (standing down)
  standingDown: facing([
    row(0, 0, 0, 0x00),
    row(0, 8, 0, 0x01),
    row(8, 0, RELATIVE_ATTRIBUTES, 0x02),
    row(8, 8, RELATIVE_ATTRIBUTES, 0x03),
  ]),

  // Lua: OamFacings.lua:30
  walkDown1: facing([
    row(0, 0, 0, 0x80),
    row(0, 8, 0, 0x81),
    row(8, 0, RELATIVE_ATTRIBUTES, 0x82),
    row(8, 8, RELATIVE_ATTRIBUTES, 0x83),
  ]),

  // Lua: OamFacings.lua:37
  walkDown2: facing([
    row(0, 8, OAM_XFLIP, 0x80),
    row(0, 0, OAM_XFLIP, 0x81),
    row(8, 8, RELATIVE_ATTRIBUTES + OAM_XFLIP, 0x82),
    row(8, 0, RELATIVE_ATTRIBUTES + OAM_XFLIP, 0x83),
  ]),

  // Lua: OamFacings.lua:44
  standingUp: facing([
    row(0, 0, 0, 0x04),
    row(0, 8, 0, 0x05),
    row(8, 0, RELATIVE_ATTRIBUTES, 0x06),
    row(8, 8, RELATIVE_ATTRIBUTES, 0x07),
  ]),

  // Lua: OamFacings.lua:51
  standingLeft: facing([
    row(0, 0, 0, 0x08),
    row(0, 8, 0, 0x09),
    row(8, 0, RELATIVE_ATTRIBUTES, 0x0a),
    row(8, 8, RELATIVE_ATTRIBUTES, 0x0b),
  ]),

  // Lua: OamFacings.lua:58
  standingRight: facing([
    row(0, 8, OAM_XFLIP, 0x08),
    row(0, 0, OAM_XFLIP, 0x09),
    row(8, 8, RELATIVE_ATTRIBUTES + OAM_XFLIP, 0x0a),
    row(8, 0, RELATIVE_ATTRIBUTES + OAM_XFLIP, 0x0b),
  ]),

  // Lua: OamFacings.lua:65-73
  relativeAttrRows(facingTable?: OamRow[]): OamRow[] {
    const out: OamRow[] = [];
    for (const entry of facingTable ?? []) {
      if ((entry.attr & RELATIVE_ATTRIBUTES) !== 0) {
        out.push(entry);
      }
    }
    return out;
  },

  // Lua: OamFacings.lua:75
  bottomRowY(): number {
    return 8;
  },
};

export default OamFacings;
