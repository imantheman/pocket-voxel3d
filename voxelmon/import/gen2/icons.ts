// Port of gen1recomp RomExtractorGen2.lua (bdfac727): extractIcons
// (:5502-5575, the party-menu mon icons) and extractMonSprites (:1562-1602,
// the SPRITE_POKEMON-and-up overworld ids that reuse those icons).

import { check } from "../ctx.ts";
import type { Gen2Ctx } from "./ctx.ts";
import { gfxKey, lua, write2bpp } from "./helpers.ts";

/** :5504 — eight tiles: two 16x16 frames stacked into a 16x32 sheet. */
const ICON_TILES = 8;

/** A row extractMonSprites adds to sprites.json: sprites.ts's SpriteEntry
 * shape plus the species and ICON_* it came from. */
export interface MonSpriteEntry {
  id: string;
  source: string;
  /** gfx key "icons/gen2/<base>" — the icon sheet extractIcons writes. */
  image: string;
  frames: number;
  walker: boolean;
  spriteType: string;
  palette: string;
  paletteId: number;
  species?: string;
  icon: string;
}

/**
 * RomExtractorGen2.lua:5506 extractIcons. Returns { icons: <icons.json> }:
 * - generation 2, source;
 * - icons: {ICON_X: {id, index (0-BASED icon id), image "icons/gen2/<base>",
 *   width 16, height 32, frames 2}} — each image 16x32, shade 0 transparent;
 * - species: {SPECIES: "ICON_X"} (the raw id when iconOrder has no name);
 * - heldItem (when HeldItemIcons is listed): {image
 *   "icons/gen2/held_item_markers" (8x16, mail row 0 over item row 1),
 *   width 8, height 8, mailRow 0, itemRow 1}.
 */
export function extractIcons(ctx: Gen2Ctx): Record<string, unknown> {
  const { rom } = ctx;
  const consts = ctx.manifest.constants;
  const iconOrder = (consts.iconOrder as string[] | undefined) ?? [];
  const speciesOrder = consts.speciesOrder ?? [];
  const pointers = ctx.symbol("IconPointers");
  const icons = ctx.symbol("Icons");

  const out: {
    generation: number;
    source: string;
    icons: Record<string, unknown>;
    species: Record<string, string | number>;
    heldItem?: Record<string, unknown>;
  } = { generation: 2, source: "ROM:IconPointers + MonMenuIcons", icons: {}, species: {} };

  for (let index = 0; index < iconOrder.length; index++) {
    const iconId = iconOrder[index]!;
    const address = rom.word(pointers.bank, pointers.address + index * 2);
    const raw = rom.bytes(icons.bank, address, ICON_TILES * 16);
    const base = iconId.toLowerCase().replace(/^icon_/, "");
    // :5524 — OBJ sprites, so shade 0 is transparent.
    const image = write2bpp(ctx, raw, 16, 32, `icons/gen2/${base}.png`, true);
    out.icons[iconId] = { id: iconId, index, image, width: 16, height: 32, frames: 2 };
  }

  // :5532 — MonMenuIcons is one byte per species, 0-based on species-1.
  const monIcons = ctx.symbol("MonMenuIcons");
  for (let index = 0; index < speciesOrder.length; index++) {
    const iconId = rom.byte(monIcons.bank, monIcons.address + index);
    out.species[speciesOrder[index]!] = iconOrder[iconId] ?? iconId;
  }

  // :5539 .SpawnItemIcon's two HeldItemIcons tiles, mail on top; tolerated
  // when the manifest lacks the symbol.
  const markers = ctx.location("HeldItemIcons");
  if (markers) {
    const image = write2bpp(ctx, rom.bytes(markers[0], markers[1], 2 * 16), 8, 16,
      "icons/gen2/held_item_markers.png", true);
    out.heldItem = { image, width: 8, height: 8, mailRow: 0, itemRow: 1 };
  }

  return { icons: out };
}

/**
 * RomExtractorGen2.lua:1580 extractMonSprites — SpriteMons is one species
 * byte per sprite id from SPRITE_POKEMON ($80) up; GetMonSprite draws that
 * species' party-menu icon (two frames, OBJECT_ACTION_BOUNCE), palette 0
 * (_GetSpritePalette's `xor a` = PAL_OW_RED). Mutates and returns `out`, the
 * sprites table extractSprites returned; call it right after extractSprites.
 * The images are the icon sheets extractIcons adds to gfx (keys only here).
 */
export function extractMonSprites(ctx: Gen2Ctx, out: Record<string, unknown>): Record<string, unknown> {
  const { rom } = ctx;
  const consts = ctx.manifest.constants;
  const order = consts.spriteOrder;
  const first = consts.spritePokemon;
  if (!first || first > order.length) return out;
  const spriteMons = ctx.symbol("SpriteMons");
  const monIcons = ctx.symbol("MonMenuIcons");
  const iconOrder = (consts.iconOrder as string[] | undefined) ?? [];
  const speciesOrder = consts.speciesOrder ?? [];
  // `first` is a 1-based Lua index into spriteOrder (= the constant value).
  for (let index = first; index <= order.length; index++) {
    const constName = order[index - 1];
    if (!constName || constName === "UNUSED") continue;
    const row = index - first;
    const species = rom.byte(spriteMons.bank, spriteMons.address + row);
    const iconId = rom.byte(monIcons.bank, monIcons.address + (species - 1));
    const icon = iconOrder[iconId];
    check(icon, `${constName}: no ICON_* name for icon ${iconId}`);
    const base = icon.toLowerCase().replace(/^icon_/, "");
    const entry: MonSpriteEntry = {
      id: constName,
      source: `ROM:SpriteMons[${row}]`,
      image: gfxKey(`icons/gen2/${base}.png`),
      frames: 2,
      walker: false,
      spriteType: "POKEMON_SPRITE",
      palette: "PAL_OW_RED",
      paletteId: 0,
      icon,
    };
    const speciesName = lua(speciesOrder, species);
    if (speciesName !== undefined) entry.species = speciesName;
    out[constName] = entry;
  }
  return out;
}
