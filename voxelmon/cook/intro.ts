// Pages the boot intro needs that no ROM holds.
//
// Everything else the intro draws is the cartridge's own art (import stage
// `intro`). These four are ours: the flat white the splash is printed on,
// the flat black of the letterbox bars, the four torn flaps the screen
// comes apart into, and the fist that tears it. They are SYNTHESISED here
// rather than shipped as files so the repository keeps carrying no art at
// all, and so the tear can be re-cut by changing a number.
import { ATLAS_KIND } from "../../contracts/spec/voxel-spec.ts";
import type { PageDef } from "./atlas.ts";
import { artOf, type GenData, PX_CLEAR } from "./data.ts";

/** GB screen, which is the space the intro is laid out in. */
export const GB_W = 160;
export const GB_H = 144;
/** Each flap covers its quadrant plus the slack the rip wanders into. */
export const FLAP_W = 88;
export const FLAP_H = 80;
/** Where each flap sits on the GB screen when the paper is still whole. */
export const FLAP_AT = [
  { x: 0, y: 0 },
  { x: GB_W - FLAP_W, y: 0 },
  { x: 0, y: GB_H - FLAP_H },
  { x: GB_W - FLAP_W, y: GB_H - FLAP_H },
] as const;
/**
 * How far the rip may wander off the middle, in px. It is the slack each
 * flap has past the halfway line, so the four of them cover the screen
 * exactly however the tear falls -- a swing wider than this leaves a
 * hairline of nothing down the middle of the paper.
 */
const RIP_SWING = Math.min(FLAP_W - GB_W / 2, FLAP_H - GB_H / 2);
/** How deep both sides of a cut claim it; see the BLEED note below. */
const BLEED = 1;

/** A cheap, stable hash: the tear has to cut the same way in every cook. */
function noise(n: number): number {
  let h = (n * 1103515245 + 12345) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/**
 * Where the vertical rip crosses row `y` (and, transposed, where the
 * horizontal one crosses column `x`).
 *
 * Paper does not tear on a curve: it runs, catches, and jumps sideways. So
 * this is a slow wander (two out-of-phase sines, nothing periodic enough to
 * read as a wave) with a hard step every few rows, which is what gives the
 * edge its fibres.
 */
function rip(t: number, span: number, seed: number): number {
  const u = t / span;
  // A random WALK, not a random value: each step leans on the last, so the
  // edge wanders and occasionally runs instead of combing up and down.
  const step = Math.floor(t / 3);
  let walk = 0;
  for (let k = 0; k <= step; k++) {
    walk = Math.max(-1, Math.min(1, walk + (noise(k + seed * 977) - 0.5) * 0.5));
  }
  const wander = Math.sin(u * 5.1 + seed) * 0.3;
  // one pixel of fibre per row, so no two rows share an edge exactly
  const fibre = (noise(t * 17 + seed * 31) - 0.5) * 0.18;
  return Math.max(-1, Math.min(1, walk * 0.8 + wander + fibre));
}

/**
 * Whether a GB pixel is inside the hole the fist makes.
 *
 * A closed, jagged loop around the middle rather than a circle: this is the
 * piece of paper that leaves FIRST, and the whole reason it is cut out
 * separately is that four quadrant flaps parting can only ever make a
 * cross. A cross reads as a screen splitting in four; this reads as
 * something coming through.
 */
function inHole(gx: number, gy: number, bleed = 0): boolean {
  const dx = (gx - GB_W / 2) / 42;
  const dy = (gy - GB_H / 2) / 36;
  const r = Math.sqrt(dx * dx + dy * dy);
  const a = Math.atan2(dy, dx);
  const edge = 1
    + Math.sin(a * 7 + 1.3) * 0.17
    + Math.sin(a * 13 + 4.1) * 0.11
    + (noise(Math.floor((a + Math.PI) * 24) + 7) - 0.5) * 0.3;
  return r < edge + bleed / 40;
}

/**
 * The screen as the splash leaves it: four black letterbox rows top and
 * bottom, white between them, the GAME FREAK logo at (72,56) and its letter
 * row at (40,80). This is what the paper has PRINTED on it, so the tear
 * carries the logo away with it -- and, because the rip runs through the
 * middle of the screen, tears the logo itself in half.
 */
function splashSheet(gen: GenData): Uint8Array {
  const px = new Uint8Array(GB_W * GB_H).fill(0);
  for (let y = 0; y < GB_H; y++) {
    if (y >= 32 && y < 112) continue;
    px.fill(3, y * GB_W, (y + 1) * GB_W);
  }
  const stamp = (key: string, at: { x: number; y: number }): void => {
    const art = artOf(gen, key);
    if (!art) return;
    for (let y = 0; y < art.h; y++) {
      for (let x = 0; x < art.w; x++) {
        const v = art.px(x, y);
        if (v === PX_CLEAR) continue;
        px[(at.y + y) * GB_W + at.x + x] = v;
      }
    }
  };
  stamp("intro/gflogo", { x: 72, y: 56 });
  stamp("intro/gftext", { x: 40, y: 80 });
  return px;
}

/**
 * The paper, in eight pieces: the four flaps and, inside them, the four
 * patches of the hole.
 *
 * Both sets are cut on the same two rips and both live on the same
 * quadrant-sized canvas at the same place, so the movie draws them with one
 * piece of code and only moves them at different times: the patches on the
 * punch, the flaps on the push through afterwards.
 */
export function buildTearFlaps(gen: GenData): PageDef[] {
  const sheet = splashSheet(gen);
  const xRip = (y: number): number => GB_W / 2 + rip(y, GB_H, 1) * RIP_SWING;
  const yRip = (x: number): number => GB_H / 2 + rip(x, GB_W, 2) * RIP_SWING;
  const out: PageDef[] = [];
  for (const hole of [false, true]) {
    FLAP_AT.forEach((at, q) => {
      const right = q === 1 || q === 3;
      const below = q === 2 || q === 3;
      const px = new Uint8Array(FLAP_W * FLAP_H).fill(PX_CLEAR);
      for (let j = 0; j < FLAP_H; j++) {
        const gy = at.y + j;
        for (let i = 0; i < FLAP_W; i++) {
          const gx = at.x + i;
          // BLEED: each cut is claimed a pixel deep by BOTH sides. The
          // pieces are drawn as separate quads at 1.889 screen pixels per
          // GB pixel, and each samples its own page on its own phase, so a
          // cut they merely abut drops a one-pixel line of the backdrop
          // between them -- a dotted seam across an intact screen. The
          // doubled pixel is the same pixel on both, so paying for it twice
          // costs nothing but the fill.
          const keepX = right ? gx >= xRip(gy) - BLEED : gx < xRip(gy) + BLEED;
          const keepY = below ? gy >= yRip(gx) - BLEED : gy < yRip(gx) + BLEED;
          if (!keepX || !keepY) continue;
          if (inHole(gx, gy, hole ? BLEED : -BLEED) !== hole) continue;
          // No edge tint: until the fist comes through, these eight are
          // supposed to be ONE screen, and a shaded seam reads as a crack
          // in an intact one. The jagged silhouette is what sells the tear,
          // and it only has to sell it once the pieces are moving.
          px[j * FLAP_W + i] = sheet[gy * GB_W + gx]!;
        }
      }
      out.push({
        w: FLAP_W,
        h: FLAP_H,
        kind: ATLAS_KIND.pics,
        frames: [px],
        name: `intro/${hole ? "patch" : "flap"}${q}`,
      });
    });
  }
  return out;
}

/** A page of one GB shade, stretched to whatever rect it is drawn into. */
export function buildFlatPage(name: string, shade: number): PageDef {
  return {
    w: 8,
    h: 8,
    kind: ATLAS_KIND.pics,
    frames: [new Uint8Array(64).fill(shade)],
    name,
  };
}

const FIST = 96;

/** Distance from `p` to the segment `a`-`b`, for the capsule shapes below. */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
  const cx = ax + dx * t;
  const cy = ay + dy * t;
  return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
}

/** The same, with the radius lerped along the segment: a tapered limb. */
function coneDist(
  px: number, py: number,
  ax: number, ay: number, ar: number,
  bx: number, by: number, br: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
  const cx = ax + dx * t;
  const cy = ay + dy * t;
  return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy)) - (ar + (br - ar) * t);
}

/**
 * The fist, knuckles-on, at 96x96.
 *
 * Built out of capsules rather than drawn as a bitmap: the intro throws it
 * at the screen and it ends up filling more of the frame than any other
 * page, so it wants to be authored at a size the blow-up can survive, and
 * capsule distances give a clean outline at any radius. Shades are the four
 * the GB has, so it sits in the same grayscale as the rest of the intro.
 */
export function buildFistPage(): PageDef {
  const px = new Uint8Array(FIST * FIST).fill(PX_CLEAR);
  // palm, four knuckles across the top, thumb folded over the near side
  const knuckleY = 34;
  const knuckles = [21, 37.5, 54, 70.5];
  for (let y = 0; y < FIST; y++) {
    for (let x = 0; x < FIST; x++) {
      let d = Math.min(
        segDist(x, y, 26, 52, 70, 52) - 22,        // palm
        segDist(x, y, 30, 74, 66, 74) - 17,        // heel of the hand
      );
      let knuckleEdge = 99;
      for (const kx of knuckles) {
        const kd = segDist(x, y, kx, knuckleY, kx, knuckleY + 6) - 10;
        knuckleEdge = Math.min(knuckleEdge, kd);
      }
      d = Math.min(d, knuckleEdge);
      const thumb = coneDist(x, y, 19, 55, 13, 48, 73, 8.5);
      d = Math.min(d, thumb);
      if (d > 0) continue;
      let shade = 1;
      // the creases between the fingers, drawn down from the gaps
      for (let g = 0; g < 3; g++) {
        const gx = (knuckles[g]! + knuckles[g + 1]!) / 2;
        if (Math.abs(x - gx) < 1.2 && y > knuckleY - 4 && y < knuckleY + 22) shade = 2;
      }
      // a knuckle catches the light on its upper left, which is the only
      // thing that stops four circles reading as four circles
      for (const kx of knuckles) {
        const kd = segDist(x, y, kx, knuckleY, kx, knuckleY + 6) - 10;
        if (kd < -2.5 && x < kx - 1 && x > kx - 8 && y > knuckleY - 9 && y < knuckleY - 1) {
          shade = 0;
        }
      }
      if (thumb < -2.0) shade = 1;                 // the thumb lies over it
      if (thumb < 0 && thumb >= -2.0) shade = 3;   // ...with its own edge
      if (d > -2.5) shade = 3;                     // outline
      px[y * FIST + x] = shade;
    }
  }
  return { w: FIST, h: FIST, kind: ATLAS_KIND.pics, frames: [px], name: "intro/fist" };
}


// ---------------------------------------------------------------------------
// IN 3D
// ---------------------------------------------------------------------------

/**
 * The one thing on screen that is not the cartridge's, drawn in a hand the
 * cartridge does not have. Deliberately NOT the GB font: this is the port
 * talking, not the game, and it wants to read as a marquee.
 */
const MARQUEE: Record<string, string[]> = {
  I: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
  N: ["#...#", "##..#", "##..#", "#.#.#", "#..##", "#..##", "#...#"],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
  "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
};
const MARQUEE_TEXT = "IN 3D";
const MARQUEE_ZOOM = 2;                 // authored 5x7, drawn at 10x14
const MARQUEE_GAP = 2;
/** The page's size, which the movie draws at 1:1 in GAME BOY pixels. */
export const IN3D_W =
  MARQUEE_TEXT.length * 5 * MARQUEE_ZOOM + (MARQUEE_TEXT.length - 1) * MARQUEE_GAP + 2;
export const IN3D_H = 7 * MARQUEE_ZOOM + 2;

export function buildIn3dPage(): PageDef {
  const ink = new Uint8Array(IN3D_W * IN3D_H);   // 1 where a letter is
  let cx = 1;
  for (const ch of MARQUEE_TEXT) {
    const rows = MARQUEE[ch] ?? MARQUEE[" "]!;
    rows.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx++) {
        if (row[rx] !== "#") continue;
        for (let j = 0; j < MARQUEE_ZOOM; j++) {
          for (let i = 0; i < MARQUEE_ZOOM; i++) {
            ink[(1 + ry * MARQUEE_ZOOM + j) * IN3D_W + cx + rx * MARQUEE_ZOOM + i] = 1;
          }
        }
      }
    });
    cx += 5 * MARQUEE_ZOOM + MARQUEE_GAP;
  }
  // Black letters with a white halo: the words cross white paper AND the
  // black letterbox in the same second, and one shade alone loses half of
  // itself to whichever it is standing on.
  const px = new Uint8Array(IN3D_W * IN3D_H).fill(PX_CLEAR);
  for (let y = 0; y < IN3D_H; y++) {
    for (let x = 0; x < IN3D_W; x++) {
      if (ink[y * IN3D_W + x]) {
        px[y * IN3D_W + x] = 3;
        continue;
      }
      let near = false;
      for (let j = -1; j <= 1 && !near; j++) {
        for (let i = -1; i <= 1; i++) {
          const nx = x + i;
          const ny = y + j;
          if (nx < 0 || ny < 0 || nx >= IN3D_W || ny >= IN3D_H) continue;
          if (ink[ny * IN3D_W + nx]) { near = true; break; }
        }
      }
      if (near) px[y * IN3D_W + x] = 0;
    }
  }
  return { w: IN3D_W, h: IN3D_H, kind: ATLAS_KIND.pics, frames: [px], name: "intro/in3d" };
}

/** Every page the intro needs that is not in the ROM, in one call. */
export function buildIntroPages(gen: GenData): PageDef[] {
  return [
    buildFlatPage("intro/white", 0),
    buildFlatPage("intro/black", 3),
    ...buildTearFlaps(gen),
    buildFistPage(),
    buildIn3dPage(),
  ];
}
