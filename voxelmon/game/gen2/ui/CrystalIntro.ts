// gen1recomp src/ui/gen2/CrystalIntro.lua (bdfac727, MIT): the Crystal intro
// movie (pokecrystal engine/movie/intro.asm CrystalIntro), transcribed: the
// 28-entry scene jumptable stepped once per frame (intro.asm:58-94) over
// hSCX/hSCY, the two intro counters, live wBGPals2 palettes and a real 32x32
// BG map with CGB attributes. Any button skips the whole thing (:11-15).
//
// Drawing. The Lua bakes the map into three canvases (backdrop, ordinary and
// PRIORITY tiles) and presents them at (hSCX, hSCY), per scanline while the
// perspective bands are live. The Gold screen is that hardware, as in
// GoldSilverIntro.ts: the map goes into the BG map's cells with each cell's
// palette slot and priority bit, hSCX/hSCY into its scroll registers, the
// tree/grass bands into its per-line SCX (`lcd.lines(2)`), and wShadowOAM
// into its objects (OAM_PRIO = behind the BG; OAM_BANK1 picks the bank-1
// sheet).

import { ATTR_PRIORITY, ATTR_X_FLIP, ATTR_Y_FLIP, type Palette4 } from "../platform/lcd.ts";
import { mod } from "../platform/lua.ts";
import G, { currentLcd, type LcdImage, SOLID } from "../platform/screen.ts";
import { Logger } from "../shared/core/Logger.ts";
import { Music } from "../shared/core/Music.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { Assets } from "../shared/render/Assets.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { SpriteAnims, type AnimStruct, type Frame, type OamEntry, type SpriteAnimSystem } from "./SpriteAnims.ts";

type Rgb = readonly number[];
type Colors = readonly Rgb[];

// Lua: CrystalIntro.lua:22
const SCREEN_W = 160;
const SCREEN_H = 144;
const BG_TILES = 32;
const INTRO_MUSIC = "Music_CrystalOpening";
const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];
const OAM_PRIO = SpriteAnims.OAM_PRIO;
const OAM_XFLIP = SpriteAnims.OAM_XFLIP;
const OAM_YFLIP = SpriteAnims.OAM_YFLIP;
/** OAM_BANK1 (constants/hardware.inc:997). */
const OAM_BANK1 = 0x08;

// ---------------------------------------------------------- sprite-anim data

/** dbsprite (macros/gfx.asm:67-70): y byte first, tile counts mod $100. */
function s(xTile: number, yTile: number, xPixel: number, yPixel: number, tile: number, attr: number): OamEntry {
  return { y: mod(yTile * 8 + yPixel, 256), x: mod(xTile * 8 + xPixel, 256), tile, attr };
}

// oam.asm:815-852 .OAMData_IntroSuicune1
const SUICUNE_1 = [
  s(1, -3, 0, 0, 0x05, 0), s(2, -3, 0, 0, 0x06, 0), s(3, -3, 0, 0, 0x07, 0),
  s(-3, -2, 0, 0, 0x11, 0), s(-2, -2, 0, 0, 0x12, 0), s(-1, -2, 0, 0, 0x13, 0),
  s(0, -2, 0, 0, 0x14, 0), s(1, -2, 0, 0, 0x15, 0), s(2, -2, 0, 0, 0x16, 0),
  s(3, -2, 0, 0, 0x17, 0),
  s(-4, -1, 0, 0, 0x20, 0), s(-3, -1, 0, 0, 0x21, 0), s(-2, -1, 0, 0, 0x22, 0),
  s(-1, -1, 0, 0, 0x23, 0), s(0, -1, 0, 0, 0x24, 0), s(1, -1, 0, 0, 0x25, 0),
  s(2, -1, 0, 0, 0x26, 0), s(3, -1, 0, 0, 0x27, 0),
  s(-4, 0, 0, 0, 0x30, 0), s(-3, 0, 0, 0, 0x31, 0), s(-2, 0, 0, 0, 0x32, 0),
  s(-1, 0, 0, 0, 0x33, 0), s(0, 0, 0, 0, 0x34, 0), s(1, 0, 0, 0, 0x35, 0),
  s(2, 0, 0, 0, 0x36, 0),
  s(-4, 1, 0, 0, 0x40, 0), s(-3, 1, 0, 0, 0x41, 0), s(-2, 1, 0, 0, 0x42, 0),
  s(-1, 1, 0, 0, 0x43, 0), s(0, 1, 0, 0, 0x44, 0), s(1, 1, 0, 0, 0x45, 0),
  s(2, 1, 0, 0, 0x46, 0), s(3, 1, 0, 0, 0x47, 0),
  s(-4, 2, 0, 0, 0x50, 0), s(-3, 2, 0, 0, 0x51, 0), s(3, 2, 0, 0, 0x57, 0),
];

// oam.asm:854-883 .OAMData_IntroSuicune2
const SUICUNE_2 = [
  s(0, -3, 0, 0, 0x04, 0), s(1, -3, 0, 0, 0x05, 0), s(2, -3, 0, 0, 0x06, 0),
  s(-3, -2, 0, 0, 0x11, 0), s(-2, -2, 0, 0, 0x12, 0), s(-1, -2, 0, 0, 0x13, 0),
  s(0, -2, 0, 0, 0x14, 0), s(1, -2, 0, 0, 0x15, 0), s(2, -2, 0, 0, 0x16, 0),
  s(-3, -1, 0, 0, 0x21, 0), s(-2, -1, 0, 0, 0x22, 0), s(-1, -1, 0, 0, 0x23, 0),
  s(0, -1, 0, 0, 0x24, 0), s(1, -1, 0, 0, 0x25, 0), s(2, -1, 0, 0, 0x26, 0),
  s(-4, 0, 0, 0, 0x30, 0), s(-3, 0, 0, 0, 0x31, 0), s(-2, 0, 0, 0, 0x32, 0),
  s(-1, 0, 0, 0, 0x33, 0), s(0, 0, 0, 0, 0x34, 0), s(1, 0, 0, 0, 0x35, 0),
  s(-2, 1, 0, 0, 0x42, 0), s(-1, 1, 0, 0, 0x43, 0), s(0, 1, 0, 0, 0x44, 0),
  s(1, 1, 0, 0, 0x45, 0),
  s(-1, 2, 0, 0, 0x53, 0), s(0, 2, 0, 0, 0x54, 0), s(1, 2, 0, 0, 0x55, 0),
];

// oam.asm:885-916 .OAMData_IntroSuicune3
const SUICUNE_3 = [
  s(0, -3, 0, 0, 0x04, 0), s(1, -3, 0, 0, 0x05, 0),
  s(-3, -2, 0, 0, 0x11, 0), s(-2, -2, 0, 0, 0x12, 0), s(-1, -2, 0, 0, 0x13, 0),
  s(0, -2, 0, 0, 0x14, 0), s(1, -2, 0, 0, 0x15, 0), s(2, -2, 0, 0, 0x16, 0),
  s(3, -2, 0, 0, 0x17, 0),
  s(-4, -1, 0, 0, 0x20, 0), s(-3, -1, 0, 0, 0x21, 0), s(-2, -1, 0, 0, 0x22, 0),
  s(-1, -1, 0, 0, 0x23, 0), s(0, -1, 0, 0, 0x24, 0), s(1, -1, 0, 0, 0x25, 0),
  s(2, -1, 0, 0, 0x26, 0),
  s(-4, 0, 0, 0, 0x30, 0), s(-3, 0, 0, 0, 0x31, 0), s(-2, 0, 0, 0, 0x32, 0),
  s(-1, 0, 0, 0, 0x33, 0), s(0, 0, 0, 0, 0x34, 0), s(1, 0, 0, 0, 0x35, 0),
  s(-2, 1, 0, 0, 0x42, 0), s(-1, 1, 0, 0, 0x43, 0), s(0, 1, 0, 0, 0x44, 0),
  s(1, 1, 0, 0, 0x45, 0),
  s(-2, 2, 0, 0, 0x52, 0), s(-1, 2, 0, 0, 0x53, 0), s(0, 2, 0, 0, 0x54, 0),
  s(1, 2, 0, 0, 0x55, 0),
];

// oam.asm:918-950 .OAMData_IntroSuicune4
const SUICUNE_4 = [
  s(-3, -2, 0, 0, 0x11, 0), s(-2, -2, 0, 0, 0x12, 0), s(-1, -2, 0, 0, 0x13, 0),
  s(0, -2, 0, 0, 0x14, 0), s(1, -2, 0, 0, 0x15, 0), s(2, -2, 0, 0, 0x16, 0),
  s(3, -2, 0, 0, 0x17, 0),
  s(-4, -1, 0, 0, 0x20, 0), s(-3, -1, 0, 0, 0x21, 0), s(-2, -1, 0, 0, 0x22, 0),
  s(-1, -1, 0, 0, 0x23, 0), s(0, -1, 0, 0, 0x24, 0), s(1, -1, 0, 0, 0x25, 0),
  s(2, -1, 0, 0, 0x26, 0), s(3, -1, 0, 0, 0x27, 0),
  s(-4, 0, 0, 0, 0x30, 0), s(-3, 0, 0, 0, 0x31, 0), s(-2, 0, 0, 0, 0x32, 0),
  s(-1, 0, 0, 0, 0x33, 0), s(0, 0, 0, 0, 0x34, 0), s(1, 0, 0, 0, 0x35, 0),
  s(2, 0, 0, 0, 0x36, 0),
  s(-3, 1, 0, 0, 0x41, 0), s(-2, 1, 0, 0, 0x42, 0), s(-1, 1, 0, 0, 0x43, 0),
  s(0, 1, 0, 0, 0x44, 0), s(1, 1, 0, 0, 0x45, 0),
  s(-3, 2, 0, 0, 0x51, 0), s(-2, 2, 0, 0, 0x52, 0), s(0, 2, 0, 0, 0x54, 0),
  s(1, 2, 0, 0, 0x55, 0),
];

// oam.asm:952-978 .OAMData_IntroPichu: 5x5, OBJ pal 1, VRAM bank 1
const PICHU: OamEntry[] = [];
for (let row = 0; row <= 4; row++) for (let col = 0; col <= 4; col++) PICHU.push(s(col - 3, row - 3, 4, 4, row * 16 + col, 1 + OAM_BANK1));

// oam.asm:980-997 .OAMData_IntroWooper: 4x4, OBJ pal 2, VRAM bank 1
const WOOPER: OamEntry[] = [];
for (let row = 0; row <= 3; row++) for (let col = 0; col <= 3; col++) WOOPER.push(s(col - 3, row - 2, 4, 0, row * 4 + col, 2 + OAM_BANK1));

// oam.asm:999-1017 .OAMData_IntroUnown1/2/3
const UNOWN_1 = [s(-1, -1, 4, 4, 0x00, 0)];
const UNOWN_2 = [s(-1, 0, 0, 0, 0x00, 0), s(-1, -1, 0, 0, 0x01, 0), s(0, -1, 0, 0, 0x02, 0)];
const UNOWN_3 = [
  s(-2, 1, 0, 0, 0x00, 0), s(-2, 0, 0, 0, 0x01, 0), s(-2, -1, 0, 0, 0x02, 0),
  s(-1, -1, 0, 0, 0x03, 0), s(-1, -2, 0, 0, 0x04, 0), s(0, -2, 0, 0, 0x05, 0),
  s(1, -2, 0, 0, 0x06, 0),
];

// oam.asm:177-182 .OAMData_IntroUnownF2_1
const UNOWN_F2_1 = [
  s(-1, -1, 0, 0, 0x00, 0), s(0, -1, 0, 0, 0x00, OAM_XFLIP),
  s(-1, 0, 0, 0, 0x00, OAM_YFLIP), s(0, 0, 0, 0, 0x00, OAM_XFLIP + OAM_YFLIP),
];

// oam.asm:1019-1028 .OAMData_IntroUnownF2_2
const UNOWN_F2_2 = [
  s(-2, -1, 0, 0, 0x00, 0), s(-1, -1, 0, 0, 0x01, 0),
  s(0, -1, 0, 0, 0x01, OAM_XFLIP), s(1, -1, 0, 0, 0x00, OAM_XFLIP),
  s(-2, 0, 0, 0, 0x00, OAM_YFLIP), s(-1, 0, 0, 0, 0x01, OAM_YFLIP),
  s(0, 0, 0, 0, 0x01, OAM_XFLIP + OAM_YFLIP),
  s(1, 0, 0, 0, 0x00, OAM_XFLIP + OAM_YFLIP),
];

// oam.asm:1030-1043 .OAMData_IntroUnownF2_3
const UNOWN_F2_3 = [
  s(-1, -3, 0, 0, 0x00, 0), s(-1, -2, 0, 0, 0x01, 0), s(-1, -1, 0, 0, 0x02, 0),
  s(0, -3, 0, 0, 0x00, OAM_XFLIP), s(0, -2, 0, 0, 0x01, OAM_XFLIP),
  s(0, -1, 0, 0, 0x02, OAM_XFLIP),
  s(-1, 0, 0, 0, 0x02, OAM_YFLIP), s(-1, 1, 0, 0, 0x01, OAM_YFLIP),
  s(-1, 2, 0, 0, 0x00, OAM_YFLIP),
  s(0, 0, 0, 0, 0x02, OAM_XFLIP + OAM_YFLIP),
  s(0, 1, 0, 0, 0x01, OAM_XFLIP + OAM_YFLIP),
  s(0, 2, 0, 0, 0x00, OAM_XFLIP + OAM_YFLIP),
];

// oam.asm:1045-1066 .OAMData_IntroUnownF2_4_5: 4x5
const UNOWN_F2_45: OamEntry[] = [];
for (let row = 0; row <= 4; row++) for (let col = 0; col <= 3; col++) UNOWN_F2_45.push(s(col - 2, row - 3, 0, 4, row * 4 + col, 0));

// oam.asm:1068-1089 .OAMData_IntroSuicuneAway: twenty grass tiles, OBJ pal 1, behind the BG
const AWAY: OamEntry[] = [];
[0, 1, 2, 3, 4, 3, 2, 1, 0, 1, 2, 3, 4, 3, 2, 1].forEach((y, i) => AWAY.push(s(i + 1, y, 0, 0, 0x00, 1 + OAM_PRIO)));
for (const [x, y] of [[-15, 0], [-14, 1], [-13, 2], [-12, 3]] as const) AWAY.push(s(x, y, 0, 0, 0x00, 1 + OAM_PRIO));

// spriteanimoam bases (oam.asm:120-136)
const OAMSETS: Record<string, [number, OamEntry[]]> = {
  INTRO_SUICUNE_1: [0x00, SUICUNE_1],
  INTRO_SUICUNE_2: [0x08, SUICUNE_2],
  INTRO_SUICUNE_3: [0x60, SUICUNE_3],
  INTRO_SUICUNE_4: [0x68, SUICUNE_4],
  INTRO_PICHU_1: [0x00, PICHU],
  INTRO_PICHU_2: [0x05, PICHU],
  INTRO_PICHU_3: [0x0a, PICHU],
  INTRO_WOOPER: [0x50, WOOPER],
  INTRO_UNOWN_1: [0x00, UNOWN_1],
  INTRO_UNOWN_2: [0x01, UNOWN_2],
  INTRO_UNOWN_3: [0x04, UNOWN_3],
  INTRO_UNOWN_F_2_1: [0x00, UNOWN_F2_1],
  INTRO_UNOWN_F_2_2: [0x01, UNOWN_F2_2],
  INTRO_UNOWN_F_2_3: [0x03, UNOWN_F2_3],
  INTRO_UNOWN_F_2_4: [0x08, UNOWN_F2_45],
  INTRO_UNOWN_F_2_5: [0x1c, UNOWN_F2_45],
  INTRO_SUICUNE_AWAY: [0x80, AWAY],
};

const f = (oamset: string, duration: number, flags = 0): Frame => ({ oamset, duration, flags });

// framesets.asm:429-489
const FRAMESETS: Record<string, Frame[]> = {
  IntroSuicune: [f("INTRO_SUICUNE_1", 3), f("INTRO_SUICUNE_2", 3), f("INTRO_SUICUNE_3", 3), f("INTRO_SUICUNE_4", 3), "restart"],
  IntroSuicune2: [f("INTRO_SUICUNE_4", 3), f("INTRO_SUICUNE_1", 7), "end"],
  IntroPichu: [f("INTRO_PICHU_1", 32), f("INTRO_PICHU_2", 7), f("INTRO_PICHU_3", 7), "end"],
  IntroWooper: [f("INTRO_WOOPER", 3), "end"],
  IntroUnown1: [f("INTRO_UNOWN_1", 3), f("INTRO_UNOWN_2", 3), f("INTRO_UNOWN_3", 7), f("delete", 0)],
  IntroUnown2: [f("INTRO_UNOWN_1", 3, OAM_XFLIP), f("INTRO_UNOWN_2", 3, OAM_XFLIP), f("INTRO_UNOWN_3", 7, OAM_XFLIP), f("delete", 0)],
  IntroUnown3: [f("INTRO_UNOWN_1", 3, OAM_YFLIP), f("INTRO_UNOWN_2", 3, OAM_YFLIP), f("INTRO_UNOWN_3", 7, OAM_YFLIP), f("delete", 0)],
  IntroUnown4: [
    f("INTRO_UNOWN_1", 3, OAM_XFLIP + OAM_YFLIP), f("INTRO_UNOWN_2", 3, OAM_XFLIP + OAM_YFLIP),
    f("INTRO_UNOWN_3", 7, OAM_XFLIP + OAM_YFLIP), f("delete", 0),
  ],
  IntroUnownF2: [
    f("INTRO_UNOWN_F_2_1", 3), f("INTRO_UNOWN_F_2_2", 3), f("INTRO_UNOWN_F_2_3", 3),
    f("INTRO_UNOWN_F_2_4", 7), f("INTRO_UNOWN_F_2_5", 7), "end",
  ],
  IntroSuicuneAway: [f("INTRO_SUICUNE_AWAY", 3), "end"],
  IntroUnownF: [f("wait", 0), "end"],
};

function reinit(st: AnimStruct, framesetId: string): void {
  st.framesetId = framesetId;
  st.duration = 0;
  st.frame = -1;
}

type IntroAnims = SpriteAnimSystem & { timer?: number; counter?: number };

const SEQUENCES: Record<string, (sys: IntroAnims, st: AnimStruct) => void> = {
  // SpriteAnimFunc_IntroSuicune (functions.asm:750-776)
  IntroSuicune(sys, st) {
    if ((sys.timer ?? 0) === 0) return;
    st.yOffset = 0;
    st.var2 = mod(st.var2 + 2, 256);
    st.yOffset = SpriteAnims.sine(mod(256 - st.var2, 256), 32);
    reinit(st, "IntroSuicune2");
  },
  // SpriteAnimFunc_IntroPichuWooper (functions.asm:778-795)
  IntroPichuWooper(_sys, st) {
    if (st.var1 >= 20) return;
    st.var1 += 2;
    st.yOffset = SpriteAnims.sine(mod(256 - st.var1, 256), 32);
  },
  // SpriteAnimFunc_IntroUnown (functions.asm:797-821): VAR1 the angle, the counter the radius
  IntroUnown(_sys, st) {
    const radius = st.jt;
    st.jt = mod(st.jt + 3, 256);
    st.yOffset = SpriteAnims.sine(st.var1, radius);
    st.xOffset = SpriteAnims.cosine(st.var1, radius);
  },
  // SpriteAnimFunc_IntroUnownF (functions.asm:823-829)
  IntroUnownF(sys, st) {
    if ((sys.counter ?? 0) !== 0x40) return;
    reinit(st, "IntroUnownF2");
  },
  // SpriteAnimFunc_IntroSuicuneAway (functions.asm:831-837)
  IntroSuicuneAway(_sys, st) {
    st.y = mod(st.y + 16, 256);
  },
};

// objects.asm:81-92
const OBJECTS: Record<string, [string, string]> = {
  INTRO_SUICUNE: ["IntroSuicune", "IntroSuicune"],
  INTRO_PICHU: ["IntroPichu", "IntroPichuWooper"],
  INTRO_WOOPER: ["IntroWooper", "IntroPichuWooper"],
  INTRO_UNOWN: ["IntroUnown1", "IntroUnown"],
  INTRO_UNOWN_F: ["IntroUnownF", "IntroUnownF"],
  INTRO_SUICUNE_AWAY: ["IntroSuicuneAway", "IntroSuicuneAway"],
};

function register<T>(target: Record<string, T>, entries: Record<string, T>): void {
  for (const [name, value] of Object.entries(entries)) if (target[name] === undefined) target[name] = value;
}
register(SpriteAnims.OAMSETS as Record<string, unknown>, OAMSETS);
register(SpriteAnims.FRAMESETS as Record<string, unknown>, FRAMESETS);
register(SpriteAnims.OBJECTS as Record<string, unknown>, OBJECTS);
register(SpriteAnims.SEQUENCES as Record<string, unknown>, SEQUENCES as Record<string, unknown>);

// ----------------------------------------------------------------- palettes

const scale31 = (v: number): number => Math.floor((v * 255) / 31 + 0.5);

// CrystalIntro_UnownFade's three 32-step ramps (intro.asm:1312-1328)
const BW_FADE: Rgb[] = [];
const LBLUE_FADE: Rgb[] = [];
const BLUE_FADE: Rgb[] = [];
for (let hue = 0; hue <= 31; hue++) {
  BW_FADE.push([scale31(hue), scale31(hue), scale31(hue)]);
  LBLUE_FADE.push([0, scale31(Math.floor(hue / 2)), scale31(hue)]);
  BLUE_FADE.push([0, 0, scale31(hue)]);
}

function palCopy(source: Colors | undefined): Rgb[] {
  const out: Rgb[] = [];
  for (let i = 0; i < 4; i++) {
    const c = source?.[i];
    out.push(c ? [c[0]!, c[1]!, c[2]!] : BLACK);
  }
  return out;
}

const flatPals = (color: Rgb): Rgb[][] => Array.from({ length: 8 }, () => [color, color, color, color]);

interface Sheet {
  image: LcdImage;
  count: number;
  /** Gold-screen id of each sheet tile, -1 past the image */
  lut: Int32Array;
}

interface Act {
  tiles?: string;
  sprites?: string;
  sprites1?: string;
  tilemap?: number[];
  attrmap?: number[];
  palettes?: { bg?: Colors[]; obj?: Colors[] };
}

export interface CrystalIntroOpts {
  intro?: any;
  onDone?: () => void;
}

// CrystalIntro_InitUnownAnim (intro.asm:1191-1229): four structs at one spot
const UNOWN_SWIRL: [number, string][] = [[0x08, "IntroUnown4"], [0x18, "IntroUnown3"], [0x28, "IntroUnown1"], [0x38, "IntroUnown2"]];
// Intro_RustleGrass (intro.asm:1521-1547)
const RUSTLE = [1, 2, 3, 2];
// IntroScene12's .UnownSounds (intro.asm:615-624)
const UNOWN_SOUNDS: Record<number, string> = {
  0x00: "Sfx_IntroUnown3", 0x20: "Sfx_IntroUnown2", 0x40: "Sfx_IntroUnown1", 0x60: "Sfx_IntroUnown2",
  0x80: "Sfx_IntroUnown3", 0x90: "Sfx_IntroUnown2", 0xa0: "Sfx_IntroUnown1", 0xb0: "Sfx_IntroUnown2",
};

export class CrystalIntro {
  static isOpaque = true;
  isOpaque = true;
  game: any;
  onDone: (() => void) | undefined;
  assets: any;
  images: Record<string, LcdImage | false> = {};
  sheets: Record<string, Sheet | false> = {};
  anims: IntroAnims;
  scene = 1;
  phase = 0;
  hold = 0;
  done = false;
  finished = false;
  skipped = false;
  frames = 0;
  scx = 0;
  scy = 0;
  counter = 0;
  timer = 0;
  treeScroll = 0;
  grassScroll = 0;
  lyActive = false;
  grassFrame: number | null = null;
  bgPals: Rgb[][] = flatPals(BLACK);
  obPals: Rgb[][] = flatPals(BLACK);
  map = new Uint8Array(BG_TILES * BG_TILES);
  attr = new Uint8Array(BG_TILES * BG_TILES);
  act: string | null = null;
  mapDirty = true;
  palsDirty = true;

  // Lua: CrystalIntro.lua:345
  constructor(game: any, opts: CrystalIntroOpts = {}) {
    this.game = game;
    this.onDone = opts.onDone;
    const data = (game && game.data) || {};
    this.assets = opts.intro ?? data.gen2Intro ?? game?.introData ?? null;
    if (!(this.assets && this.assets.acts)) {
      Logger.warn("crystal intro: no intro in the cache -- re-import this version or the movie plays blank");
    }
    this.anims = SpriteAnims.new();
  }

  static new(game: any, opts?: CrystalIntroOpts): CrystalIntro {
    return new CrystalIntro(game, opts ?? {});
  }

  wantsFillScale(): boolean {
    return true;
  }

  drawsWidescreen(): boolean {
    return true;
  }

  // ------------------------------------------------------------ plumbing

  actData(): Act | null {
    const acts = this.assets && this.assets.acts;
    return (acts && this.act && acts[this.act]) || null;
  }

  // ClearSpriteAnims zeroes through wGlobalAnimXOffset (core.asm:1-11)
  clearAnims(): void {
    this.anims.clear();
    this.anims.globalX = 0;
    this.anims.globalY = 0;
  }

  fades(): any {
    return (this.assets && this.assets.fades) || {};
  }

  loadAct(key: string): void {
    this.act = key;
    this.grassFrame = null;
    const act = this.actData();
    for (let i = 0; i < BG_TILES * BG_TILES; i++) {
      this.map[i] = act?.tilemap?.[i] ?? 0;
      this.attr[i] = act?.attrmap?.[i] ?? 0;
    }
    const palettes = act?.palettes ?? {};
    for (let pal = 0; pal < 8; pal++) {
      this.bgPals[pal] = palCopy(palettes.bg?.[pal]);
      this.obPals[pal] = palCopy(palettes.obj?.[pal]);
    }
    this.mapDirty = true;
    this.palsDirty = true;
  }

  // Intro_ClearBGPals blacks all 16 palettes and burns two frames
  // (intro.asm:1554-1571); IntroScene26 clears to white. Request2bpp: 8
  // tiles a frame, then one more frame for the short request.
  static requestFrames(tiles: number[]): number {
    let frames = 0;
    for (const count of tiles) frames += Math.floor(count / 8) + 1;
    return frames;
  }

  setup(white: boolean, tiles: number[], fn: () => void): void {
    if (this.phase === 0) {
      this.phase = 1;
      const color = white ? WHITE : BLACK;
      this.bgPals = flatPals(color);
      this.obPals = flatPals(color);
      this.palsDirty = true;
      this.hold = (white ? 4 : 2) + CrystalIntro.requestFrames(tiles) - 1;
      return;
    }
    this.phase = 0;
    fn();
    this.scene += 1;
  }

  playMusic(song: string): void {
    const data = this.game && this.game.data;
    const audio = data && data.audio;
    if (audio && audio.runtime && audio.songs && audio.songs[song]) Music.play(data, song);
  }

  playSfx(name: string): void {
    const data = this.game && this.game.data;
    const audio = data && data.audio;
    if (audio && audio.runtime && audio.sfx && audio.sfx[name]) Sound.play(data, name);
  }

  // CrystalIntro_UnownFade (intro.asm:1231-1310)
  unownFade(pal: number, t: number): void {
    let step = t % 64;
    if (step > 31) step = 63 - step;
    this.bgPals = flatPals(BLACK);
    const target = this.bgPals[pal]!;
    target[1] = BW_FADE[step]!;
    target[2] = LBLUE_FADE[step]!;
    target[3] = BLUE_FADE[step]!;
    this.palsDirty = true;
  }

  initUnownAnim(x: number, y: number): void {
    for (const [angle, frameset] of UNOWN_SWIRL) {
      const st = this.anims.init("INTRO_UNOWN", x, y);
      if (st) {
        st.var1 = angle;
        reinit(st, frameset);
      }
    }
  }

  // Intro_ResetLYOverrides / Intro_PerspectiveScrollBG (intro.asm:1630-1676)
  resetLYOverrides(): void {
    this.treeScroll = 0;
    this.grassScroll = 0;
    this.lyActive = true;
  }

  perspectiveScroll(): void {
    if (this.counter % 2 === 1) this.treeScroll = mod(this.treeScroll + 1, 256);
    this.grassScroll = mod(this.grassScroll + 2, 256);
    this.scx = this.treeScroll;
  }

  rustleGrass(): void {
    if (this.counter >= 36) return;
    const frame = RUSTLE[Math.floor(this.counter / 4) % 4]!;
    if (frame !== this.grassFrame) {
      this.grassFrame = frame;
      this.mapDirty = true;
    }
  }

  // Intro_ColoredSuicuneFrameSwap (intro.asm:1500-1519)
  frameSwap(): void {
    for (let row = 0; row <= 17; row++) {
      for (let col = 0; col <= 19; col++) {
        const i = row * BG_TILES + col;
        const id = this.map[i]!;
        if (id !== 0 && id < 0x80) this.map[i] = id ^ 8;
      }
    }
    this.mapDirty = true;
  }

  // ---------------------------------------------------------- frame loop

  // CrystalIntro's .loop (intro.asm:11-22); a pending `hold` skips the anim step
  step(): boolean {
    if (this.done) return true;
    this.frames += 1;
    if (this.hold > 0) {
      this.hold -= 1;
      return false;
    }
    const scene = SCENES[this.scene];
    if (scene) scene(this);
    if (this.done) return true;
    if (this.hold > 0) return false;
    this.anims.timer = this.timer;
    this.anims.counter = this.counter;
    this.anims.playFrame();
    return this.done;
  }

  enter(): void {
    if (Runtime.wants("intro.boot.movie")) Runtime.emit("intro.boot.movie", { screen: this, game: this.game });
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.done = true;
    if (Runtime.wants("intro.boot.movie_ended")) {
      Runtime.emit("intro.boot.movie_ended", { screen: this, game: this.game, skipped: this.skipped, frames: this.frames });
    }
    if (this.onDone) this.onDone();
  }

  // .ShutOffMusic (intro.asm:24-26)
  skip(): void {
    this.skipped = true;
    Music.stop();
    this.finish();
  }

  update(_dt?: number): void {
    if (this.finished) return;
    const input = this.game && this.game.input;
    if (input) {
      for (const button of ["a", "b", "start", "select"]) {
        if (input.wasPressed(button)) {
          this.skip();
          return;
        }
      }
    }
    if (this.step()) this.finish();
  }

  // ------------------------------------------------------------- drawing

  image(path: string | undefined): LcdImage | null {
    if (!path) return null;
    let cached = this.images[path];
    if (cached === undefined) {
      try {
        cached = Assets.image(path) || false;
      } catch {
        cached = false;
      }
      this.images[path] = cached;
    }
    return cached || null;
  }

  sheet(path: string | undefined): Sheet | null {
    if (!path) return null;
    const entry = this.sheets[path];
    if (entry !== undefined) return entry || null;
    const image = this.image(path);
    if (!image) {
      this.sheets[path] = false;
      return null;
    }
    const count = Math.floor(image.w / 8) * Math.floor(image.h / 8);
    const lut = new Int32Array(count).fill(-1);
    for (let tile = 0; tile < count; tile++) {
      const col = tile % 16;
      const row = Math.floor(tile / 16);
      if (col < image.tw && row < image.th) {
        const id = image.ids[row * image.tw + col];
        if (id !== undefined) lut[tile] = id;
      }
    }
    const made: Sheet = { image, count, lut };
    this.sheets[path] = made;
    return made;
  }

  /** Gold-screen id of sheet tile `tile` (16 across), or undefined past it. */
  tileId(sheet: Sheet, tile: number): number | undefined {
    if (tile < 0 || tile >= sheet.count) return undefined;
    const id = sheet.lut[tile]!;
    return id < 0 ? undefined : id;
  }

  private readonly cellIds = new Uint16Array(BG_TILES * BG_TILES);
  private readonly cellAttrs = new Uint8Array(BG_TILES * BG_TILES);
  private readonly bgSlots = new Int16Array(8);
  private readonly lastSlots = new Int16Array(8).fill(-1);
  private readonly lineScx = new Uint8Array(SCREEN_H);

  // the BG map: each cell's id (the grass frames over $09-$0c), its palette
  // slot and its priority bit; colour 0 of the cell's palette is the backdrop.
  // The ids are worked out again only when the map changes and the attrs
  // when it or a palette slot does: 1024 lookups a frame cost the 3DS ~20 ms.
  drawBackground(): void {
    const lcd = currentLcd();
    if (!lcd) return;
    const act = this.actData();
    const sheet = act && this.sheet(act.tiles);
    if (!sheet) return;
    const slots = this.bgSlots;
    for (let pal = 0; pal < 8; pal++) slots[pal] = lcd.palette(GbcPalette.resolvedPalette(this.bgPals[pal] as Colors) as Palette4);
    const ids = this.cellIds;
    const attrs = this.cellAttrs;
    const last = this.lastSlots;
    let slotsMoved = false;
    for (let pal = 0; pal < 8; pal++) if (last[pal] !== slots[pal]) slotsMoved = true;
    if (this.mapDirty) {
      const grass = this.grassFrame != null ? this.sheet(this.assets?.grassFrames) : null;
      const grassBase = grass ? (this.grassFrame! - 1) * 4 - 0x09 : 0;
      const lut = sheet.lut;
      const count = sheet.count;
      const solid = SOLID[0]!;
      for (let i = 0; i < BG_TILES * BG_TILES; i++) {
        const id = this.map[i]!;
        let tile: number;
        if (grass && id >= 0x09 && id <= 0x0c) {
          const t = grassBase + id;
          tile = t >= 0 && t < grass.count ? grass.lut[t]! : -1;
        } else tile = id < count ? lut[id]! : -1;
        ids[i] = tile < 0 ? solid : tile;
      }
    }
    if (this.mapDirty || slotsMoved) {
      for (let i = 0; i < BG_TILES * BG_TILES; i++) {
        const a = this.attr[i]!;
        attrs[i] = (slots[a % 8]! & 0x0f) | (a >= 0x80 ? ATTR_PRIORITY : 0);
      }
      last.set(slots);
    }
    lcd.s.cells.set(ids, 0);
    lcd.s.attrs.set(attrs, 0);
    this.mapDirty = false;
    this.palsDirty = false;
    lcd.regs({ scx: mod(this.scx, 256), scy: mod(this.scy, 256) });
    if (this.lyActive) {
      // trees on lines 0-94 at half speed, grass below at double (:1647-1676)
      for (let line = 0; line < SCREEN_H; line++) this.lineScx[line] = line < 0x5f ? this.treeScroll : this.grassScroll;
      lcd.lines(2, this.lineScx);
    } else {
      lcd.lines(0);
    }
  }

  private readonly objSlots = new Int16Array(8);

  // one pass over wShadowOAM: earlier objects on top on the Gold screen, as
  // in OAM; OAM_PRIO objects go behind the BG through the priority bit
  drawObjects(): void {
    const lcd = currentLcd();
    if (!lcd) return;
    const act = this.actData();
    const sheet0 = act ? this.sheet(act.sprites) : null;
    const sheet1 = act?.sprites1 ? this.sheet(act.sprites1) : null;
    if (!(sheet0 || sheet1)) return;
    const slots = this.objSlots;
    slots.fill(-1);
    for (const entry of this.anims.oam) {
      const sheet = entry.attr & OAM_BANK1 ? sheet1 : sheet0;
      const id = sheet ? this.tileId(sheet, entry.tile) : undefined;
      if (id === undefined) continue;
      const pal = entry.attr % 8;
      let slot = slots[pal]!;
      if (slot < 0) {
        slot = lcd.palette(GbcPalette.resolvedPalette(this.obPals[pal] as Colors) as Palette4, true);
        slots[pal] = slot;
      }
      let attr = slot;
      if (entry.attr & OAM_XFLIP) attr |= ATTR_X_FLIP;
      if (entry.attr & OAM_YFLIP) attr |= ATTR_Y_FLIP;
      if (entry.attr & OAM_PRIO) attr |= ATTR_PRIORITY;
      lcd.obj(entry.x - 8, entry.y - 16, id, attr);
    }
  }

  renderFrame(): boolean {
    const act = this.actData();
    if (!(act && this.sheet(act.tiles))) return false;
    this.drawBackground();
    this.drawObjects();
    return true;
  }

  drawPanel(): void {
    if (this.renderFrame()) return;
    G.setColor(0, 0, 0, 1);
    G.rectangle("fill", 0, 0, SCREEN_W, SCREEN_H);
    G.setColor(1, 1, 1, 1);
  }

  draw(): void {
    this.drawPanel();
  }

  // the Gold screen is the panel: no letterbox or fit
  drawWidescreen(_winW: number, _winH: number): void {
    this.drawPanel();
  }
}

// ------------------------------------------------- scenes (intro.asm:96-1153)

type SceneFn = (self: CrystalIntro) => void;
const SCENES: Record<number, SceneFn> = {
  // IntroScene1 (:96-146)
  1: (self) =>
    self.setup(false, [64, 128, 128, 64], () => {
      self.loadAct("unownA");
      self.clearAnims();
      self.scx = 0;
      self.scy = 0;
      self.counter = 0;
      self.timer = 0;
    }),
  // IntroScene2 (:148-170)
  2: (self) => {
    const a = self.counter;
    self.counter = mod(a + 1, 256);
    if (a >= 0x80) {
      self.scene = 3;
      return;
    }
    if (a === 0x60) {
      self.initUnownAnim(11 * 8, 11 * 8);
      self.playSfx("Sfx_IntroUnown1");
    }
    self.timer = a;
    self.unownFade(0, a);
  },
  // IntroScene3 (:172-218)
  3: (self) =>
    self.setup(false, [64, 128, 64], () => {
      self.loadAct("background");
      self.resetLYOverrides();
      self.scx = 0;
      self.scy = 0;
      self.counter = 0;
    }),
  // IntroScene4 (:220-232)
  4: (self) => {
    self.perspectiveScroll();
    if (self.counter === 0x80) {
      self.scene = 5;
      return;
    }
    self.counter = mod(self.counter + 1, 256);
  },
  // IntroScene5 (:234-285)
  5: (self) =>
    self.setup(false, [64, 128, 128, 64], () => {
      self.loadAct("unownHI");
      self.lyActive = false;
      self.clearAnims();
      self.scx = 0;
      self.scy = 0;
      self.counter = 0;
      self.timer = 0;
    }),
  // IntroScene6 (:287-330)
  6: (self) => {
    const a = self.counter;
    self.counter = mod(a + 1, 256);
    if (a >= 0x80) {
      self.scene = 7;
      return;
    }
    if (a === 0x60) {
      self.initUnownAnim(6 * 8, 14 * 8);
      self.playSfx("Sfx_IntroUnown1");
      self.timer = a;
      self.unownFade(1, a);
      return;
    }
    if (a >= 0x40) {
      self.timer = a;
      self.unownFade(1, a);
      return;
    }
    if (a === 0x20) {
      self.initUnownAnim(15 * 8, 7 * 8);
      self.playSfx("Sfx_IntroUnown2");
    }
    self.timer = a;
    self.unownFade(0, a);
  },
  // IntroScene7 (:332-401)
  7: (self) =>
    self.setup(false, [64, 128, 255, 128, 64], () => {
      self.loadAct("background");
      self.resetLYOverrides();
      self.clearAnims();
      self.anims.init("INTRO_SUICUNE", 27 * 8, 13 * 8 + 4);
      self.anims.globalX = 0xf0;
      self.scx = 0;
      self.scy = 0;
      self.counter = 0;
      self.timer = 0;
    }),
  // IntroScene8 (:403-430)
  8: (self) => {
    const a = self.counter;
    self.counter = mod(a + 1, 256);
    if (a === 0x40) {
      self.playSfx("Sfx_IntroSuicune3");
    } else if (a < 0x40) {
      self.perspectiveScroll();
      return;
    }
    if (self.anims.globalX === 0) {
      self.playSfx("Sfx_IntroSuicune2");
      self.anims.clear();
      self.scene = 9;
      return;
    }
    self.anims.globalX = mod(self.anims.globalX - 8, 256);
  },
  // IntroScene9 (:432-467): palette bands over the whole map, six blocking frames
  9: (self) => {
    self.lyActive = false;
    for (let row = 0; row <= 17; row++) {
      const pal = row < 12 ? 1 : row < 15 ? 2 : 3;
      for (let col = 0; col < BG_TILES; col++) self.attr[row * BG_TILES + col] = pal;
    }
    self.anims.globalX = 0;
    self.counter = 0;
    self.mapDirty = true;
    self.hold = 6;
    self.scene = 10;
  },
  // IntroScene10 (:469-500)
  10: (self) => {
    self.rustleGrass();
    const a = self.counter;
    self.counter = mod(a + 1, 256);
    if (a === 0xc0) {
      self.scene = 11;
      return;
    }
    if (a === 0x20) {
      self.anims.init("INTRO_WOOPER", 6 * 8, 22 * 8);
      self.playSfx("Sfx_IntroPichu");
    } else if (a === 0x40) {
      self.anims.init("INTRO_PICHU", 16 * 8, 21 * 8 + 1);
      self.playSfx("Sfx_IntroPichu");
    }
  },
  // IntroScene11 (:502-550)
  11: (self) =>
    self.setup(false, [64, 128, 64], () => {
      self.loadAct("unowns");
      self.lyActive = false;
      self.clearAnims();
      self.scx = 0;
      self.scy = 0;
      self.counter = 0;
      self.timer = 0;
    }),
  // IntroScene12 (:552-613)
  12: (self) => {
    const a = self.counter;
    const sound = UNOWN_SOUNDS[a];
    if (sound) {
      Sound.sfxChannelsOff();
      self.playSfx(sound);
    }
    self.counter = mod(a + 1, 256);
    if (a >= 0xc0) {
      self.scene = 13;
      return;
    }
    if (a < 0x80) {
      self.timer = (a % 0x20) * 2;
      self.unownFade(Math.floor(a / 0x20), self.timer);
    } else {
      self.timer = (a % 0x10) * 4;
      self.unownFade(4 + Math.floor((a - 0x80) / 0x10), self.timer);
    }
  },
  // IntroScene13 (:626-683)
  13: (self) =>
    self.setup(false, [64, 255, 128, 64], () => {
      self.loadAct("background");
      self.clearAnims();
      self.anims.init("INTRO_SUICUNE", 11 * 8, 13 * 8 + 4);
      self.playMusic(INTRO_MUSIC);
      self.scx = 0;
      self.scy = 0;
      self.counter = 0;
      self.timer = 0;
    }),
  // IntroScene14 (:685-728)
  14: (self) => {
    self.scx = mod(self.scx - 10, 256);
    const a = self.counter;
    self.counter = mod(a + 1, 256);
    if (a === 0x80) {
      self.scene = 15;
      return;
    }
    if (a === 0x60) self.playSfx("Sfx_IntroSuicune4");
    if (a >= 0x60) {
      self.timer = 1;
      const gx = self.anims.globalX;
      if (gx < 0x88) self.anims.clear();
      else self.anims.globalX = mod(gx - 8, 256);
    } else if (a >= 0x40) {
      self.anims.globalX = mod(self.anims.globalX - 2, 256);
    }
  },
  // IntroScene15 (:730-792)
  15: (self) =>
    self.setup(false, [64, 128, 128, 1, 64], () => {
      self.loadAct("suicuneJump");
      self.clearAnims();
      self.anims.init("INTRO_UNOWN_F", 5 * 8, 8 * 8);
      self.anims.init("INTRO_SUICUNE_AWAY", 0, 12 * 8);
      self.scx = 0;
      self.scy = SCREEN_H;
      self.counter = 0;
      self.timer = 0;
    }),
  // IntroScene16 (:794-810)
  16: (self) => {
    const a = self.counter;
    self.counter = mod(a + 1, 256);
    if (a >= 0x80) {
      self.scene = 17;
      return;
    }
    if (a % 4 === 0) self.frameSwap();
    if (self.scy !== 0) self.scy = mod(self.scy + 8, 256);
  },
  // IntroScene17 (:812-859)
  17: (self) =>
    self.setup(false, [64, 255, 64], () => {
      self.loadAct("suicuneClose");
      self.clearAnims();
      self.scx = 0;
      self.scy = 0;
      self.counter = 0;
      self.timer = 0;
    }),
  // IntroScene18 (:861-876)
  18: (self) => {
    const a = self.counter;
    self.counter = mod(a + 1, 256);
    if (a >= 0x60) {
      self.scene = 19;
      return;
    }
    if (self.scx !== 0x60) self.scx = mod(self.scx + 8, 256);
  },
  // IntroScene19 (:878-941)
  19: (self) =>
    self.setup(false, [64, 128, 128, 1, 64], () => {
      self.loadAct("suicuneBack");
      self.clearAnims();
      self.anims.init("INTRO_SUICUNE_AWAY", 0, 12 * 8);
      self.scx = 0;
      self.scy = mod(-5 * 8, 256);
      self.counter = 0;
      self.timer = 0;
    }),
  // IntroScene20 (:943-988)
  20: (self) => {
    const a = self.counter;
    self.counter = mod(a + 1, 256);
    if (a >= 0x98) {
      self.scene = 21;
      return;
    }
    if (a >= 0x58) return;
    if (a >= 0x40) {
      const b = a - 0x18;
      if (b % 4 === 3) {
        const slot = Math.floor((b % 0x20) / 4);
        self.timer = slot;
        self.bgPals[slot] = palCopy(self.fades().unownAppear);
        self.palsDirty = true;
      }
      return;
    }
    if (a >= 0x28) return;
    self.scy = mod(self.scy + 1, 256);
  },
  // IntroScene21 (:990-1000)
  21: (self) => {
    self.frameSwap();
    self.hold = 3;
    self.counter = 0;
    self.timer = 0;
    self.scene = 22;
  },
  // IntroScene22 (:1002-1012)
  22: (self) => {
    const a = self.counter;
    self.counter = mod(a + 1, 256);
    if (a >= 0x8) {
      self.anims.clear();
      self.scene = 23;
    }
  },
  // IntroScene23 (:1014-1018)
  23: (self) => {
    self.counter = 0;
    self.scene = 24;
  },
  // IntroScene24 (:1020-1042)
  24: (self) => {
    const a = self.counter;
    self.counter = mod(a + 1, 256);
    if (a >= 0x20) {
      self.counter = 0x40;
      self.scene = 25;
      return;
    }
    if (a % 4 !== 0) return;
    const pal = self.fades().toWhite?.[Math.floor((a % 0x20) / 4)];
    if (!pal) return;
    for (let slot = 0; slot < 8; slot++) self.bgPals[slot] = palCopy(pal);
    self.palsDirty = true;
  },
  // IntroScene25 (:1044-1054)
  25: (self) => {
    if (self.counter - 1 === 0) {
      self.scene = 26;
      return;
    }
    self.counter -= 1;
  },
  // IntroScene26 (:1056-1103)
  26: (self) =>
    self.setup(true, [64, 128, 64], () => {
      self.loadAct("crystalUnowns");
      self.clearAnims();
      self.scx = 0;
      self.scy = 0;
      self.counter = 0;
      self.timer = 0;
    }),
  // IntroScene27 / Intro_FadeUnownWordPals (:1105-1128, :1390-1455)
  27: (self) => {
    const a = self.counter;
    self.counter = mod(a + 1, 256);
    if (a >= 0x80) {
      self.scene = 28;
      self.counter = 0x80;
      return;
    }
    const t = a % 0x10;
    const pal = Math.floor((a % 0x80) / 0x10);
    const fade = self.fades();
    // a fresh array, not an edit in place: palettes are matched by identity
    const target = [...self.bgPals[pal]!];
    const fast = fade.wordFast?.[t];
    const slow = fade.wordSlow?.[t];
    if (fast) target[2] = [fast[0], fast[1], fast[2]];
    if (slow) target[3] = [slow[0], slow[1], slow[2]];
    self.bgPals[pal] = target;
    self.palsDirty = true;
  },
  // IntroScene28 (:1130-1153)
  28: (self) => {
    const a = self.counter;
    if (a === 0) {
      self.done = true;
      return;
    }
    self.counter = a - 1;
    if (a === 0x18) {
      self.bgPals = flatPals(WHITE);
      self.obPals = flatPals(WHITE);
      self.palsDirty = true;
    } else if (a === 0x8) {
      self.playSfx("Sfx_IntroWhoosh");
    }
  },
};

export const CrystalIntroScenes = SCENES;
export default CrystalIntro;
