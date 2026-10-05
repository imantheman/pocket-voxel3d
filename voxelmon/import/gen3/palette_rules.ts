// Port of gen1recomp src/import/gba/palette_rules.lua (GPLv3 + additional terms; see LICENSE.md).
// Category -> Gen2 BG slot + 4-shade demake ramp.
// Map profiles (outdoor / network / house / harbor) select the room ruleset.
// Network also composes material roles (floor / wall / machine / screen / ...)
// so tweaking the machine does not retint plaza walls.
//
// Shapes: RAMP and specialPalettes() stay keyed by slot number (1..9); a
// ramp's four shades are 0-based ([r, g, b] each); buf64 and the 4-entry
// role / slot lists are 0-based arrays (the Lua's t[i] is t[i - 1]).

export type Rgb = number[];
export type Ramp = Rgb[];
type Pred = (r: number, g: number, b: number) => boolean;

export interface RuleOpts {
  bottomIsRoof?: boolean;
  indoor?: boolean;
  pairName?: string;
  environment?: string;
  profileId?: string | Profile;
  profile?: string | Profile;
  _profile?: Profile;
  [k: string]: unknown;
}

export interface Profile {
  id: string;
  indoor: boolean;
  isOrangeRoof: Pred;
  isMagentaRoof: Pred;
  isRoofColor: Pred;
  buildingPartSlot(meanR?: number, meanG?: number, meanB?: number, quadIndex?: number, opts?: RuleOpts): number;
  slotForContext(category: string | undefined, meanR?: number, meanG?: number, meanB?: number, quadIndex?: number, opts?: RuleOpts): number;
  refineSlot(slot: number, category: string | undefined, meanR?: number, meanG?: number, meanB?: number, quadIndex?: number, opts?: RuleOpts): number;
}

const hasOwn = Object.prototype.hasOwnProperty;
function own<T>(t: Record<string, T>, k: string): T | undefined {
  return hasOwn.call(t, k) ? t[k] : undefined;
}

// ------------------------------------------------------------------------
// Shared colour predicates (profile may swap magenta / roof variants)
// ------------------------------------------------------------------------

// Lua: palette_rules.lua:133
function is_water_blue(r: number, g: number, b: number): boolean {
  const chroma = b - Math.max(r, g);
  return b > 150 && chroma > 55;
}

// Lua: palette_rules.lua:138
function is_brown_rock(r: number, g: number, b: number): boolean {
  return r > 100 && g > 70 && b <= Math.max(g + 8, r * 0.72)
    && (r + g) > b * 1.9 && Math.abs(r - g) < 65;
}

// Lua: palette_rules.lua:144 -- Darker cliff lips / wet rock.
function is_dark_cliff_lip(r: number, g: number, b: number): boolean {
  if (is_water_blue(r, g, b)) return false;
  return r > 55 && g > 40 && r >= g - 5 && g >= b - 20
    && (r + g) > b * 1.55 && b < 145
    && Math.abs(r - g) < 70;
}

// Lua: palette_rules.lua:153 -- Brown+blue quad means read as muted purple.
function is_muddy_shore_purple(r: number, g: number, b: number): boolean {
  const sum = r + g + b;
  if (sum > 400 || sum < 160) return false;
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  return chroma < 55 && g + 8 < r && g + 8 < b
    && r > 70 && b > 70 && Math.abs(r - b) < 45;
}

// Lua: palette_rules.lua:161
function is_strong_magenta_roof(r: number, g: number, b: number): boolean {
  return r > 155 && b > 155
    && (r + b) / 2 > g + 28 && b > g + 18 && r > g + 10;
}

// Lua: palette_rules.lua:166
function is_orange_roof(r: number, g: number, b: number): boolean {
  // PC orange + cream; exclude sand (g~r) which was becoming magenta corners.
  return r > 175 && g > 100 && r >= g
    && (r - b) > 90 && (g - b) > 40
    && g < r * 0.90;
}

// Lua: palette_rules.lua:174 -- Bright magenta lip only (indoor-safe).
function is_magenta_roof_bright(r: number, g: number, b: number): boolean {
  return r > 140 && b > 140 && r >= g && b >= g
    && (r + b) / 2 > g + 12;
}

// Lua: palette_rules.lua:181 -- Outdoor house roofs: bright lip + dark purple body.
function is_magenta_roof_outdoor(r: number, g: number, b: number): boolean {
  if (is_magenta_roof_bright(r, g, b)) return true;
  if (is_water_blue(r, g, b)) return false;
  // Dark roof body: B leads G, R still warm-purple (not cool gray cliff).
  return b > 118 && r > 95 && b >= g + 12 && r >= g - 8
    && (r + b) / 2 > g + 18
    && Math.abs(r - b) < 55;
}

// Lua: palette_rules.lua:194
function is_foliage_green(r: number, g: number, b: number): boolean {
  return g > r + 8 && g > b + 8 && g > 70;
}

// Lua: palette_rules.lua:198
function is_plaza_green(r: number, g: number, b: number): boolean {
  return g > 170 && g > r + 40 && g >= b;
}

// Lua: palette_rules.lua:202
function is_wood_tan(r: number, g: number, b: number): boolean {
  return r > 150 && r < 235 && g > 130 && g < 210
    && b <= g + 5 && b < r * 0.95
    && r + g > b * 2.0
    && Math.abs(r - g) < 50;
}

// Lua: palette_rules.lua:209
function is_sand_tan(r: number, g: number, b: number): boolean {
  return r > 200 && g > 190 && b < g * 0.78 && r >= g - 20
    && (r + g) > b * 2.2 && Math.abs(r - g) < 40;
}

// Lua: palette_rules.lua:214
function is_coral_metal(r: number, g: number, b: number): boolean {
  return r > 170 && g > 95 && g < 170 && b > 80 && b < 155
    && r > g + 25 && r > b + 15;
}

// Lua: palette_rules.lua:219
function is_red_rebar(r: number, g: number, b: number): boolean {
  return r > 120 && r >= g - 5 && g < 160 && b < 170
    && !is_water_blue(r, g, b)
    && (r > b + 5 || r > g + 15);
}

// Lua: palette_rules.lua:225
function terrain_slot_from_mean(r: number, g: number, b: number): number {
  if (is_water_blue(r, g, b)) return 1;
  if (is_foliage_green(r, g, b)) return 8;
  if (r > 190 && g > 160 && b < g * 0.72) return 3;
  if (is_brown_rock(r, g, b)) return 4;
  return 4;
}

// Lua: palette_rules.lua:237 -- Cream / ivory floors & walls (FRLG Network Center plaza).
function is_cream_ivory(r: number, g: number, b: number): boolean {
  const sum = r + g + b;
  // abs(r-g) < 40 (not 50): dusty rose desk wood (204,158,154) must hit wood_tan.
  return r > 165 && g > 150 && b > 110 && sum > 450
    && Math.abs(r - g) < 40 && g >= b - 8
    && (r + g) / 2 >= b + 6;
}

// Lua: palette_rules.lua:245
function is_cool_metal(r: number, g: number, b: number): boolean {
  // Machine panels / escalator: cool gray-blue-gray, not bright screen cyan.
  const sum = r + g + b;
  return sum < 520 && b >= r - 8 && b >= g - 20
    && Math.abs(r - g) < 55 && !is_cream_ivory(r, g, b);
}

// Lua: palette_rules.lua:253 -- Bright monitor / Network Machine screen (strongly cyan).
function is_cyan_screen(r: number, g: number, b: number): boolean {
  return b > 195 && g > 170 && b > r + 20 && (r + g + b) > 520;
}

// Lua: palette_rules.lua:258 -- Blue stool seats / crate lids.
function is_blue_furniture(r: number, g: number, b: number): boolean {
  const sum = r + g + b;
  return b > 200 && sum > 580 && b >= g - 5 && b > r + 5
    && (b - r) < 45
    && !is_cream_ivory(r, g, b);
}

// Lua: palette_rules.lua:267 -- Near-achromatic gray wall TVs / panels.
function is_wall_tv(r: number, g: number, b: number): boolean {
  const sum = r + g + b;
  return sum < 470 && sum > 220
    && Math.abs(r - g) < 12 && Math.abs(g - b) < 12
    && Math.abs(b - r) < 12
    && !is_cyan_screen(r, g, b);
}

// Lua: palette_rules.lua:275
function is_pink_accent(r: number, g: number, b: number): boolean {
  // True magenta/pink trim (B leads G). Dusty rose desk wood has g~b -- not accent.
  return r > 150 && b > 120 && g < 170
    && (r + b) / 2 > g + 12 && r > g + 8
    && b > g + 5;
}

// Lua: palette_rules.lua:282
function is_white_chrome(r: number, g: number, b: number): boolean {
  const sum = r + g + b;
  return sum > 580 && Math.abs(r - g) < 30 && Math.abs(g - b) < 35
    && !is_blue_furniture(r, g, b) && !is_cyan_screen(r, g, b);
}

// Lua: palette_rules.lua:312
function role_slot(roleId: string | undefined): number {
  const role = roleId === undefined ? undefined : own(PaletteRules.ROLES, roleId);
  return role ? role.slot : 5;
}

// Lua: palette_rules.lua:399
function indoor_terrain_slot(r: number, g: number, b: number, isMagenta: Pred): number {
  if (is_water_blue(r, g, b)) return 1;
  if (is_plaza_green(r, g, b) || is_foliage_green(r, g, b)) return 2;
  if (is_coral_metal(r, g, b) || is_red_rebar(r, g, b)
    || is_strong_magenta_roof(r, g, b) || is_orange_roof(r, g, b)
    || isMagenta(r, g, b) || is_pink_accent(r, g, b)) {
    return 6;
  }
  if (is_cream_ivory(r, g, b)) return 5;
  if (is_wood_tan(r, g, b) || is_brown_rock(r, g, b)) return 4;
  if (Math.abs(r - g) < 30 && Math.abs(g - b) < 30) return 5;
  return 5;
}

// Lua: palette_rules.lua:423
function network_slot_from_role(category: string | undefined, meanR?: number, meanG?: number, meanB?: number, quadIndex?: number, opts?: RuleOpts): number {
  const role = PaletteRules.resolveRole("network", category, meanR, meanG, meanB, quadIndex, opts);
  return role_slot(role);
}

// ------------------------------------------------------------------------
// Profile builders
// ------------------------------------------------------------------------

// Lua: palette_rules.lua:432
function outdoor_building_part(isMagenta: Pred, meanR?: number, meanG?: number, meanB?: number, quadIndex?: number, opts?: RuleOpts): number {
  const r = meanR ?? 0, g = meanG ?? 0, b = meanB ?? 0;
  opts = opts ?? {};
  if (is_wood_tan(r, g, b)) return 4;
  if (is_coral_metal(r, g, b)) return 6;
  if (is_orange_roof(r, g, b) || isMagenta(r, g, b)) return 6;
  const topHalf = quadIndex === 0 || quadIndex === 1;
  if (topHalf && opts.bottomIsRoof) return terrain_slot_from_mean(r, g, b);
  if (is_plaza_green(r, g, b)) return 2;
  return 5;
}

// Lua: palette_rules.lua:454
function outdoor_refine(isMagenta: Pred, slot: number, category: string | undefined, meanR?: number, meanG?: number, meanB?: number, quadIndex?: number, opts?: RuleOpts): number {
  const r = meanR ?? 0, g = meanG ?? 0, b = meanB ?? 0;
  opts = opts ?? {};
  if (category === "SIGN" || category === "STAIR" || category === "PIER") return 4;
  if (PaletteRules.isBuildingCategory(category)) return outdoor_building_part(isMagenta, r, g, b, quadIndex, opts);
  if (category === "WATER") {
    if (is_water_blue(r, g, b)) return 1;
    // Shore / cliff edges first: brown+blue means look purple and must not
    // land on the magenta roof ramp (slot 6).
    if (is_muddy_shore_purple(r, g, b) || is_brown_rock(r, g, b) || is_dark_cliff_lip(r, g, b)) return 4;
    if (is_coral_metal(r, g, b) || is_red_rebar(r, g, b)) return 6;
    if (is_sand_tan(r, g, b)) return 3;
    if (r > 170 && g > 140 && b > 120 && r >= g && g >= b - 10 && (r - b) < 70) return 4;
    return 1;
  }
  // TREE: pure canopy stays slot 8. Mixed tip|cliff quads are assigned slot 9
  // in extract via quadIsTreeCliffMix (needs the full 8x8, not just the mean).
  if (category === "TREE") return 8;
  if (PaletteRules.isLocked(category)) return slot;
  if (category === "BLOCKED" || category === "PATH") {
    if (is_brown_rock(r, g, b) || is_dark_cliff_lip(r, g, b)) return 4;
    if (is_muddy_shore_purple(r, g, b)) return 4;
    if (is_sand_tan(r, g, b)) return 3;
    if (is_water_blue(r, g, b)) return 1;
    if (is_coral_metal(r, g, b)) return 6;
    if (is_strong_magenta_roof(r, g, b) || isMagenta(r, g, b)) return 6;
    if (is_foliage_green(r, g, b)) return 8;
    if (b >= r - 5 && b >= g - 5 && r + g + b < 520) return 4;
    return 5;
  }
  if (category === "TOWN_PATH" || category === "SHORT_GRASS" || category === "SAND") {
    if (is_sand_tan(r, g, b)) return 3;
    if (is_coral_metal(r, g, b)) return 6;
    if (is_orange_roof(r, g, b) || is_strong_magenta_roof(r, g, b) || isMagenta(r, g, b)) return 6;
    if (is_wood_tan(r, g, b)) return 4;
  }
  return slot;
}

// Lua: palette_rules.lua:540
function outdoor_slot(isMagenta: Pred, category: string | undefined, meanR?: number, meanG?: number, meanB?: number, quadIndex?: number, opts?: RuleOpts): number {
  if (category === "SIGN") return 4;
  if (PaletteRules.isBuildingCategory(category)) return outdoor_building_part(isMagenta, meanR, meanG, meanB, quadIndex, opts);
  return PaletteRules.slotFor(category);
}

// Lua: palette_rules.lua:550
function indoor_refine(isMagenta: Pred, slot: number, category: string | undefined, meanR?: number, meanG?: number, meanB?: number, _quadIndex?: number, _opts?: RuleOpts): number {
  const r = meanR ?? 0, g = meanG ?? 0, b = meanB ?? 0;
  if (category === "SIGN" || category === "PIER") return 4;
  if (PaletteRules.isBuildingCategory(category)) {
    if (is_wood_tan(r, g, b)) return 4;
    if (is_coral_metal(r, g, b) || is_orange_roof(r, g, b)
      || isMagenta(r, g, b) || is_strong_magenta_roof(r, g, b)
      || is_pink_accent(r, g, b)) {
      return 6;
    }
    if (is_plaza_green(r, g, b)) return 2;
    return 5;
  }
  if (category === "WATER") {
    if (is_water_blue(r, g, b)) return 1;
    if (is_coral_metal(r, g, b) || is_red_rebar(r, g, b)) return 6;
    return 1;
  }
  return slot;
}

// Lua: palette_rules.lua:575 (the Lua passes the means through unchecked: nil would error)
function indoor_slot(isMagenta: Pred, category: string | undefined, meanR?: number, meanG?: number, meanB?: number, _quadIndex?: number, _opts?: RuleOpts): number {
  if (category === "SIGN") return 4;
  if (category === "TREE") return 8;
  if (category === "WATER") return 1;
  if (category === "STAIR") return 5;
  const r = meanR as number, g = meanG as number, b = meanB as number;
  if (PaletteRules.isBuildingCategory(category)) {
    if (is_wood_tan(r, g, b)) return 4;
    if (is_coral_metal(r, g, b) || is_orange_roof(r, g, b)
      || isMagenta(r, g, b) || is_strong_magenta_roof(r, g, b)
      || is_pink_accent(r, g, b)) {
      return 6;
    }
    if (is_plaza_green(r, g, b)) return 2;
    return 5;
  }
  return indoor_terrain_slot(r, g, b, isMagenta);
}

// Lua: palette_rules.lua:603
function network_slot(_isMagenta: Pred, category: string | undefined, meanR?: number, meanG?: number, meanB?: number, quadIndex?: number, opts?: RuleOpts): number {
  return network_slot_from_role(category, meanR, meanG, meanB, quadIndex, opts);
}

// Lua: palette_rules.lua:607
function network_refine(_isMagenta: Pred, _slot: number, category: string | undefined, meanR?: number, meanG?: number, meanB?: number, quadIndex?: number, opts?: RuleOpts): number {
  return network_slot_from_role(category, meanR, meanG, meanB, quadIndex, opts);
}

// Lua: palette_rules.lua:779
function bgr555_to_rgb_u8(c: number | undefined): [number, number, number] {
  c = c ?? 0;
  const r5 = c % 32;
  const g5 = Math.floor(c / 32) % 32;
  const b5 = Math.floor(c / 1024) % 32;
  return [r5 * 255 / 31, g5 * 255 / 31, b5 * 255 / 31];
}

// Lua: palette_rules.lua:816
function make_outdoor_profile(id: string): Profile {
  const isMagenta = is_magenta_roof_outdoor;
  return {
    id,
    indoor: false,
    isOrangeRoof: is_orange_roof,
    isMagentaRoof: isMagenta,
    isRoofColor: (r, g, b) => is_orange_roof(r, g, b) || isMagenta(r, g, b),
    buildingPartSlot: (meanR, meanG, meanB, quadIndex, opts) => outdoor_building_part(isMagenta, meanR, meanG, meanB, quadIndex, opts),
    slotForContext: (category, meanR, meanG, meanB, quadIndex, opts) => outdoor_slot(isMagenta, category, meanR, meanG, meanB, quadIndex, opts),
    refineSlot: (slot, category, meanR, meanG, meanB, quadIndex, opts) => outdoor_refine(isMagenta, slot, category, meanR, meanG, meanB, quadIndex, opts),
  };
}

// Lua: palette_rules.lua:838
function make_indoor_profile(id: string): Profile {
  // Strict bright magenta only -- dark outdoor body must not steal cream floors.
  const isMagenta = is_magenta_roof_bright;
  return {
    id,
    indoor: true,
    isOrangeRoof: is_orange_roof,
    isMagentaRoof: isMagenta,
    isRoofColor: (r, g, b) => is_orange_roof(r, g, b) || isMagenta(r, g, b),
    // Indoor buildings still use front/wood/accent; rear-lip path unused.
    buildingPartSlot: (meanR, meanG, meanB, quadIndex, opts) => indoor_slot(isMagenta, "BUILDING", meanR, meanG, meanB, quadIndex, opts),
    slotForContext: (category, meanR, meanG, meanB, quadIndex, opts) => indoor_slot(isMagenta, category, meanR, meanG, meanB, quadIndex, opts),
    refineSlot: (slot, category, meanR, meanG, meanB, quadIndex, opts) => indoor_refine(isMagenta, slot, category, meanR, meanG, meanB, quadIndex, opts),
  };
}

// Lua: palette_rules.lua:862
function make_network_profile(): Profile {
  const isMagenta = is_magenta_roof_bright;
  return {
    id: "network",
    indoor: true,
    isOrangeRoof: is_orange_roof,
    isMagentaRoof: isMagenta,
    isRoofColor: (r, g, b) => is_orange_roof(r, g, b) || isMagenta(r, g, b),
    buildingPartSlot: (meanR, meanG, meanB, quadIndex, opts) => network_slot_from_role("BUILDING", meanR, meanG, meanB, quadIndex, opts),
    slotForContext: (category, meanR, meanG, meanB, quadIndex, opts) => network_slot(isMagenta, category, meanR, meanG, meanB, quadIndex, opts),
    refineSlot: (slot, category, meanR, meanG, meanB, quadIndex, opts) => network_refine(isMagenta, slot, category, meanR, meanG, meanB, quadIndex, opts),
  };
}

// Lua: palette_rules.lua:926
function profile_from_opts(opts: RuleOpts | undefined, pairName?: string, environment?: string): Profile {
  opts = opts ?? {};
  if (opts._profile) return opts._profile;
  return PaletteRules.resolveProfile(pairName ?? opts.pairName, environment ?? opts.environment, opts);
}

export const PaletteRules = {
  // Slot plan (8 GBC BG pals):
  // 1 water | 2 grass road | 3 sand | 4 cliff/stairs | 5 building fronts
  // 6 roofs | 7 cool metal (Network Machine / escalator) | 8 trees
  // Slot 5 mid shade is window-blue -- never put gray metal there (reads as water stain).
  // Outdoor stairs share cliff (not front).
  SLOT: {
    WATER: 1,
    SHORT_GRASS: 2,
    TALL_GRASS: 2,
    TOWN_PATH: 2,
    TREE: 8,
    SAND: 3,
    CLIFF: 4,
    COAST_CLIFF: 4,
    ROCK_DECK: 4,
    LEDGE: 4,
    CAVE: 4,
    PIER: 4,
    STAIR: 4,
    PATH: 5,
    BLOCKED: 5,
    BUILDING: 6,
    DOOR: 6,
    SIGN: 4, // wood post / board uses cliff-brown family (not house front)
  } as Record<string, number>,

  RAMP: {
    1: [ // water
      [198, 222, 255], [90, 156, 239], [33, 90, 189], [8, 24, 66],
    ],
    2: [ // grass / town grass-road
      [165, 222, 99], [82, 173, 49], [41, 115, 24], [16, 49, 8],
    ],
    3: [ // sand
      [247, 230, 156], [222, 189, 90], [181, 140, 49], [99, 74, 24],
    ],
    4: [ // cliff / rock / pier / outdoor stairs
      [206, 173, 140], [156, 115, 82], [107, 74, 49], [49, 33, 24],
    ],
    5: [ // building fronts only: white, window-blue, gray, black
      [239, 239, 239], [115, 156, 206], [132, 132, 140], [24, 24, 33],
    ],
    6: [ // roofs only (PC orange / house magenta) -- not shared with fronts
      [247, 206, 165], [222, 132, 82], [181, 74, 123], [74, 24, 57],
    ],
    7: [ // cool metal (Network Machine body / escalator) -- screens use slot 1
      [198, 206, 214], [132, 140, 156], [74, 82, 99], [24, 28, 41],
    ],
    8: [ // trees
      [140, 189, 74], [57, 132, 33], [33, 82, 16], [8, 33, 0],
    ],
    // Tree tips over cliff: green shades + brown shades in one 8x8 (like roof
    // magenta+cream). Nearest-colour bake, not Y-threshold.
    9: [
      [165, 206, 90], [74, 148, 41], [156, 115, 82], [49, 33, 24],
    ],
  } as Record<number, Ramp>,

  TREE_CLIFF_SLOT: 9,

  OWNER_PRIORITY: {
    WATER: 80,
    CLIFF: 70,
    COAST_CLIFF: 70,
    ROCK_DECK: 65,
    LEDGE: 65,
    CAVE: 60,
    SAND: 55,
    BUILDING: 50,
    DOOR: 50,
    TREE: 45,
    TALL_GRASS: 40,
    SHORT_GRASS: 35,
    TOWN_PATH: 35,
    SIGN: 30,
    PIER: 25,
    STAIR: 20,
    PATH: 15,
    BLOCKED: 10,
  } as Record<string, number>,

  LOCKED: {
    TREE: true,
    WATER: true,
    BUILDING: true,
    DOOR: true,
    SIGN: true,
    SAND: true,
    // Map-edge cliffs must not be stolen by house neighbour votes.
    CLIFF: true,
    COAST_CLIFF: true,
    ROCK_DECK: true,
    LEDGE: true,
    // Pier wood must not be stolen by adjacent water (was painting dock edges blue).
    PIER: true,
  } as Record<string, boolean>,

  // Lua: palette_rules.lua:105
  slotFor(category: string | undefined): number {
    return own(PaletteRules.SLOT, category ?? "") ?? 5;
  },

  // Lua: palette_rules.lua:109
  rampForSlot(slot: number): Ramp {
    return (hasOwn.call(PaletteRules.RAMP, slot) ? PaletteRules.RAMP[slot] : undefined) ?? PaletteRules.RAMP[5]!;
  },

  // Lua: palette_rules.lua:113
  rampFor(category: string | undefined): Ramp {
    return PaletteRules.rampForSlot(PaletteRules.slotFor(category));
  },

  // Lua: palette_rules.lua:117
  priority(category: string | undefined): number {
    return own(PaletteRules.OWNER_PRIORITY, category ?? "") ?? 0;
  },

  // Lua: palette_rules.lua:121
  isLocked(category: string | undefined): boolean {
    return own(PaletteRules.LOCKED, category ?? "") === true;
  },

  // Lua: palette_rules.lua:125
  isBuildingCategory(category: string | undefined): boolean {
    return category === "BUILDING" || category === "DOOR";
  },

  // ----------------------------------------------------------------------
  // Material roles (composed on top of map profiles)
  // LOCKED (Network Machine -- do not retune without an explicit ask):
  //   machine -> slot 7, screen -> slot 1. Mid cohere keeps body/screen split.
  // ----------------------------------------------------------------------
  ROLES: {
    floor: { id: "floor", slot: 3 }, // cream plaza (warm sand)
    // Warm tan (cliff/wood family) -- NOT slot 5 (window-blue) or 7 (machine gray).
    wall: { id: "wall", slot: 4 },
    // LOCKED: Network Machine body. Same gray that currently looks correct in-game.
    machine: { id: "machine", slot: 7 },
    // LOCKED: Network Machine / monitor cyan tops.
    screen: { id: "screen", slot: 1 },
    furniture_blue: { id: "furniture_blue", slot: 1 },
    furniture_wood: { id: "furniture_wood", slot: 4 },
    accent: { id: "accent", slot: 6 }, // pink rails / wall trim only
    plant: { id: "plant", slot: 2 },
    escalator: { id: "escalator", slot: 7 },
    void: { id: "void", slot: 7 },
  } as Record<string, { id: string; slot: number }>,

  // Lua: palette_rules.lua:318 -- Pick a material role for one 8x8 under a map profile.
  resolveRole(mapProfileId: string | undefined, category: string | undefined, meanR?: number, meanG?: number, meanB?: number, _quadIndex?: number, _opts?: RuleOpts): string {
    const r = meanR ?? 0, g = meanG ?? 0, b = meanB ?? 0;
    category = category ?? "";

    if (category === "SIGN") return "furniture_wood";
    if (category === "TREE") return "plant";
    if (category === "WATER") return "screen";

    if (mapProfileId !== "network") {
      if (category === "STAIR") return "wall";
      if (is_pink_accent(r, g, b) || is_orange_roof(r, g, b)) return "accent";
      if (is_wood_tan(r, g, b)) return "furniture_wood";
      if (is_cream_ivory(r, g, b)) return "wall";
      if (PaletteRules.isBuildingCategory(category)) return "wall";
      return "wall";
    }

    // Network Center role stack (order matters).
    // LOCKED path: bright cyan -> screen; cool blue-gray metal -> machine (big PC).
    if (category === "STAIR") {
      if (is_pink_accent(r, g, b)) return "accent";
      return "escalator";
    }
    if (is_cyan_screen(r, g, b)) return "screen";
    // Wall-mounted TV / dark gray monitors -> dark shade of WALL (not machine pal).
    if (is_wall_tv(r, g, b)) return "wall";
    if (is_cool_metal(r, g, b)) return "machine";
    // True pink trim only -- dusty rose desk wood is not accent.
    if (is_pink_accent(r, g, b) || is_strong_magenta_roof(r, g, b)) return "accent";
    if (is_blue_furniture(r, g, b)) return "furniture_blue";
    if (is_plaza_green(r, g, b) || is_foliage_green(r, g, b)) return "plant";
    // Cream before wood: plaza / beige walls false-trigger wood tan.
    if (is_cream_ivory(r, g, b)) {
      if (PaletteRules.isBuildingCategory(category)) return "wall";
      return "floor";
    }
    if (is_wood_tan(r, g, b)) return "furniture_wood";
    if (is_white_chrome(r, g, b)) return "wall";
    if (is_brown_rock(r, g, b) && r > b + 15) return "furniture_wood";
    if ((r + g + b) < 80) return "void";
    if (PaletteRules.isBuildingCategory(category)) return "machine";
    if (category === "SHORT_GRASS" || category === "TOWN_PATH" || category === "PATH" || category === "BLOCKED") return "floor";
    return "machine";
  },

  // Lua: palette_rules.lua:611
  slotForRole(roleId: string | undefined): number {
    return role_slot(roleId);
  },

  /**
   * Lua: palette_rules.lua:617 -- Mid-level role vote so one object is not four
   * independent guesses. Returns a length-4 role id list. (The pairs() walk in
   * majority() only matters on a 3+ majority, which is unique.)
   */
  cohereMidRoles(profileId: string | undefined, category: string | undefined, rolesIn: (string | undefined)[]): (string | undefined)[] {
    const roles = [rolesIn[0], rolesIn[1], rolesIn[2], rolesIn[3]];
    category = category ?? "";

    // Category hard constraints before voting.
    for (let i = 0; i < 4; i++) {
      const r = roles[i] ?? "machine";
      if (PaletteRules.isBuildingCategory(category) && r === "floor") {
        roles[i] = "wall"; // never paint walls with plaza sand
      } else if ((category === "SHORT_GRASS" || category === "TOWN_PATH" || category === "PATH")
        && (r === "wall" || r === "machine")) {
        roles[i] = "floor";
      } else if (category === "STAIR" && r !== "accent") {
        roles[i] = "escalator";
      }
    }

    if (profileId !== "network") return roles;

    const counts = new Map<string, number>();
    for (let i = 0; i < 4; i++) {
      const r = roles[i];
      if (r === undefined) throw new Error("table index is nil");
      counts.set(r, (counts.get(r) ?? 0) + 1);
    }
    const n = (r: string): number => counts.get(r) ?? 0;
    const force = (r: string | undefined): (string | undefined)[] => [r, r, r, r];
    const majority = (): [string | undefined, number] => {
      let maj = roles[0], majN = 0;
      for (const [r, c] of counts) {
        if (c > majN) { maj = r; majN = c; }
      }
      return [maj, majN];
    };

    // Stairs / escalator: one metal set (pink rails stay accent if majority).
    if (category === "STAIR") {
      if (n("accent") >= 2) return force("accent");
      return force("escalator");
    }

    // Walls / corners / desk (BUILDING)
    if (PaletteRules.isBuildingCategory(category)) {
      // LOCKED: solid machine / solid screen mids (big PC) -- do not retune.
      if (n("machine") >= 3) return force("machine");
      if (n("screen") >= 3) return force("screen");
      // Wall + embedded TV/panel (no cyan screen): whole mid stays wall.
      if (n("wall") >= 2 && n("machine") >= 1 && n("screen") === 0
        && n("furniture_wood") === 0 && n("furniture_blue") === 0) {
        return force("wall");
      }
      // Pink trim band: accent + anything else -> accent|wall only.
      if (n("accent") >= 2) {
        const out = [roles[0], roles[1], roles[2], roles[3]];
        for (let i = 0; i < 4; i++) if (out[i] !== "accent") out[i] = "wall";
        return out;
      }
      // Reception desk: gray metal top (LOCKED machine) + wood front; drop accent.
      if (n("furniture_wood") >= 1 && n("machine") >= 1) {
        if (n("machine") >= 2 && n("furniture_wood") >= 2) {
          return ["machine", "machine", "furniture_wood", "furniture_wood"];
        }
        const out = [roles[0], roles[1], roles[2], roles[3]];
        for (let i = 0; i < 4; i++) {
          if (out[i] === "accent" || out[i] === "screen" || out[i] === "plant" || out[i] === "wall") {
            out[i] = out[i] === "wall" ? "machine" : "furniture_wood";
          }
        }
        return out;
      }
      // Pure / mostly wall.
      if (n("wall") >= 1 && n("machine") === 0 && n("screen") === 0
        && n("furniture_blue") === 0 && n("furniture_wood") === 0) {
        return force("wall");
      }
      if (n("wall") >= 1 && n("machine") === 0 && n("screen") === 0 && n("furniture_blue") === 0) {
        return force("wall");
      }
      // Furniture stools: keep blue/wood split.
      if (n("furniture_blue") + n("furniture_wood") >= 3) {
        const out = [roles[0], roles[1], roles[2], roles[3]];
        for (let i = 0; i < 4; i++) {
          if (out[i] !== "furniture_blue" && out[i] !== "furniture_wood") {
            out[i] = n("furniture_blue") >= n("furniture_wood") ? "furniture_blue" : "furniture_wood";
          }
        }
        return out;
      }
    }

    // Plaza floor mids: stay sand.
    if (category === "SHORT_GRASS" || category === "TOWN_PATH" || category === "PATH") {
      if (n("floor") >= 2) return force("floor");
    }

    const [maj, majN] = majority();
    if (majN >= 3) return force(maj);
    return roles;
  },

  // Lua: palette_rules.lua:735
  slotsFromRoles(roles: (string | undefined)[]): number[] {
    const slots: number[] = [];
    for (let i = 0; i < 4; i++) slots[i] = role_slot(roles[i] ?? "wall");
    return slots;
  },

  /**
   * Lua: palette_rules.lua:744 -- Back-compat wrapper used by tests / callers
   * that only have slots.
   * NOT FAITHFUL (order): with a 2-2 split on a network building mid, which
   * slot counts as the majority depends on LuaJIT's pairs() order over the
   * counts table; here the first slot counted.
   */
  cohereMidSlots(profileId: string | undefined, category: string | undefined, slotsIn: (number | undefined)[], _means?: unknown): (number | undefined)[] {
    const slots = [slotsIn[0], slotsIn[1], slotsIn[2], slotsIn[3]];
    const counts = new Map<number, number>();
    for (let i = 0; i < 4; i++) {
      const s = slots[i] ?? 5;
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    let maj = slots[0], majN = 0;
    for (const [s, c] of counts) {
      if (c > majN) { maj = s; majN = c; }
    }
    if (profileId === "network" && majN >= 2) {
      // Warm wall slot majority on a building mid (wall role uses slot 4).
      if (maj === 4 && majN >= 2 && PaletteRules.isBuildingCategory(category)) return [4, 4, 4, 4];
    }
    if (majN >= 3) return [maj, maj, maj, maj];
    return slots;
  },

  // Lua: palette_rules.lua:770 -- Only flat monitor screens use nearest-to-ramp quantize.
  usesFixedRampQuantize(profileId: string | undefined, role: string | undefined): boolean {
    return profileId === "network" && role === "screen";
  },

  // Lua: palette_rules.lua:775 -- Outdoor tree tip over cliff: bake by nearest shade of the hybrid ramp.
  usesNearestRampBake(slot: number | undefined): boolean {
    return slot === PaletteRules.TREE_CLIFF_SLOT;
  },

  /**
   * Lua: palette_rules.lua:790 -- True when an 8x8 has both foliage green and
   * cliff brown (tree tip on rock or stump on grass/cliff).
   */
  quadIsTreeCliffMix(buf64: number[] | undefined, category: string | undefined): boolean {
    if (!buf64) return false;
    category = category ?? "";
    let greenN = 0, brownN = 0;
    for (let i = 0; i < 64; i++) {
      const [r, g, b] = bgr555_to_rgb_u8(buf64[i]);
      if (is_foliage_green(r, g, b)) {
        greenN = greenN + 1;
      } else if (is_brown_rock(r, g, b) || is_dark_cliff_lip(r, g, b)
        || (r > 140 && g > 100 && b < r * 0.85 && r >= g && g >= b - 10
          && (r + g) > b * 1.7 && !is_water_blue(r, g, b))) {
        // Cliff tan / rock highlight (slot-4 light shade territory).
        brownN = brownN + 1;
      }
    }
    if (greenN >= 6 && brownN >= 6) return true;
    // Tip painted onto a cliff/blocked mid: strong green blob + some rock.
    if ((category === "CLIFF" || category === "COAST_CLIFF" || category === "BLOCKED")
      && greenN >= 8 && brownN >= 3) {
      return true;
    }
    return false;
  },

  PROFILES: {
    sevii_outdoor_town: make_outdoor_profile("sevii_outdoor_town"),
    sevii_outdoor_route: make_outdoor_profile("sevii_outdoor_route"),
    network: make_network_profile(),
    house: make_indoor_profile("house"),
    harbor: make_indoor_profile("harbor"),
  } as Record<string, Profile>,

  /**
   * Lua: palette_rules.lua:894 -- Auto-select profile from tileset pair + map
   * environment. opts.profile / opts.profileId force a named profile.
   */
  resolveProfile(pairName: string | undefined, environment: string | undefined, opts?: RuleOpts): Profile {
    opts = opts ?? {};
    const forced = opts.profileId ?? opts.profile;
    if (forced !== null && typeof forced === "object" && forced.id) return forced;
    if (typeof forced === "string" && own(PaletteRules.PROFILES, forced)) return PaletteRules.PROFILES[forced]!;

    if (pairName === "network") return PaletteRules.PROFILES.network!;
    if (pairName === "house") return PaletteRules.PROFILES.house!;
    if (pairName === "harbor") return PaletteRules.PROFILES.harbor!;

    // Indoor without a known pair (tests / future maps).
    if (opts.indoor || environment === "INDOOR" || (pairName !== undefined && pairName !== "sevii_outdoor")) {
      return PaletteRules.PROFILES.network!;
    }
    if (environment === "ROUTE") return PaletteRules.PROFILES.sevii_outdoor_route!;
    return PaletteRules.PROFILES.sevii_outdoor_town!;
  },

  // Lua: palette_rules.lua:938
  buildingPartSlot(meanR?: number, meanG?: number, meanB?: number, quadIndex?: number, opts?: RuleOpts): number {
    opts = opts ?? {};
    const profile = profile_from_opts(opts, opts.pairName, opts.environment);
    return profile.buildingPartSlot(meanR, meanG, meanB, quadIndex, opts);
  },

  // Lua: palette_rules.lua:944
  refineSlot(slot: number, category: string | undefined, meanR?: number, meanG?: number, meanB?: number, quadIndex?: number, opts?: RuleOpts): number {
    opts = opts ?? {};
    let profile = opts._profile;
    if (!profile) {
      if (opts.indoor === true && !opts.pairName && !opts.profileId) profile = PaletteRules.PROFILES.network!;
      else profile = profile_from_opts(opts, opts.pairName, opts.environment);
    }
    return profile.refineSlot(slot, category, meanR, meanG, meanB, quadIndex, opts);
  },

  /**
   * Lua: palette_rules.lua:957
   * NOT FAITHFUL (order): an exact tie between two neighbour categories'
   * scores goes to whichever LuaJIT's (seeded) string hash visits first in
   * pairs(); here the first key inserted.
   */
  ownCategory(selfCat: string | undefined, neighbourCounts?: Record<string, number>): string {
    selfCat = selfCat ?? "TOWN_PATH";
    if (PaletteRules.isLocked(selfCat)) return selfCat;
    neighbourCounts = neighbourCounts ?? {};
    let best = selfCat, bestScore = PaletteRules.priority(selfCat) + 50;
    for (const cat of Object.keys(neighbourCounts)) {
      const n = neighbourCounts[cat];
      if (n !== undefined && n !== null && n > 0) {
        const score = PaletteRules.priority(cat) + n * 8;
        if (score > bestScore) { best = cat; bestScore = score; }
      }
    }
    return best;
  },

  // Lua: palette_rules.lua:976 -- Indoor cream/wood/accent helper (Network profile predicates).
  indoorTerrainSlot(meanR?: number, meanG?: number, meanB?: number): number {
    return indoor_terrain_slot(meanR ?? 0, meanG ?? 0, meanB ?? 0, is_magenta_roof_bright);
  },

  // Lua: palette_rules.lua:980
  slotForContext(category: string | undefined, environment: string | undefined, pairName: string | undefined,
    meanR?: number, meanG?: number, meanB?: number, quadIndex?: number, opts?: RuleOpts): number {
    opts = opts ?? {};
    const profile = PaletteRules.resolveProfile(pairName, environment, opts);
    opts._profile = profile;
    opts.indoor = profile.indoor;
    opts.pairName = pairName;
    opts.environment = environment;
    return profile.slotForContext(category, meanR, meanG, meanB, quadIndex, opts);
  },

  // Lua: palette_rules.lua:991 -- True if RGB is roof orange/magenta under the resolved profile.
  isRoofColor(meanR: number | undefined, meanG: number | undefined, meanB: number | undefined, pairName?: string, environment?: string, opts?: RuleOpts): boolean {
    const profile = PaletteRules.resolveProfile(pairName, environment, opts);
    return profile.isRoofColor(meanR ?? 0, meanG ?? 0, meanB ?? 0);
  },

  // Lua: palette_rules.lua:996 -- slot -> copied ramp (keys 1..9)
  specialPalettes(): Record<number, Ramp> {
    const out: Record<number, Ramp> = {};
    const n = Math.max(8, PaletteRules.TREE_CLIFF_SLOT ?? 8);
    for (let i = 1; i <= n; i++) {
      const ramp = hasOwn.call(PaletteRules.RAMP, i) ? PaletteRules.RAMP[i] : undefined;
      if (ramp) {
        out[i] = [
          [ramp[0]![0]!, ramp[0]![1]!, ramp[0]![2]!],
          [ramp[1]![0]!, ramp[1]![1]!, ramp[1]![2]!],
          [ramp[2]![0]!, ramp[2]![1]!, ramp[2]![2]!],
          [ramp[3]![0]!, ramp[3]![1]!, ramp[3]![2]!],
        ];
      }
    }
    return out;
  },
};

export default PaletteRules;
