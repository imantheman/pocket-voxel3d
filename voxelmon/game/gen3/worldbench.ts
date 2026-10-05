// pocket-voxel host entry for the gen3 (FireRed) port (GPLv3 + additional terms; see LICENSE.md).
//
// The WORLD BENCH: FireRed's voxel world on the 3DS without the Game3
// runtime (which does not fit the console's heap yet). A stand-in field --
// the player on FR_PALLET_TOWN (6,8), its people where the town's object
// events put them, walked by a script with FRLG's own pace (a pixel a tick,
// sixteen to a cell) across the seam into FR_ROUTE_1 -- goes through
// platform/worldview.ts exactly as Game3World's state does, so the host's
// side is what is being tested: the paks, the seams, the camera, the
// billboards with their sprite frames (the cache's own overworld sheets),
// stereo, the 2D layer laid over the world (a message box, clear round it),
// and the frame time. Bundled instead of main.ts by
//   PV_G3_ENTRY=voxelmon/game/gen3/worldbench.ts bash cc_build_firered.sh
// with PV_G3_BENCH_SCRIPT / PV_G3_BENCH_SHOTS as for main.ts's bench.
//
// PV_G3_BENCH_SCENE="fx" stands the player below the house's door instead
// and plays what the 3D field must show as the 2D one does, on a timeline
// of shown frames: the door opening and closing (10-70, the cache's door
// sheet as a decal on the facade), a fade to black and back (70-110) and to
// white (110-150) with the side strips, a battle transition's bars (150-200,
// the strips stretching the layer's edge), then a balloon over the head,
// stirred grass, a jump lifting the player, the warp arrow and a
// ripple flat on the floor, dust and a surf blob standing (200-300), all
// drawn with the field's own G.draw calls under G.captureBegin and turned
// into billboards by platform/world_fx.ts as game3_world.ts does.
// PV_G3_BENCH_SCENE="fx-before" plays the same with all of that off (no
// strips, no doors or effects, no lift): the 3D field as it was.

// FIRST: the host and the sound.
import { clock, drawProf } from "./platform/qjs_host.ts";
import { BenchScript, loadWorld, nat as n, padBits, setFrame, shotSet, worldOps } from "./platform/qjs_world.ts";
import { G } from "./platform/graphics.ts";
import { getHost } from "./platform/host.ts";
import { ImageData, newImage, type Image } from "./platform/image.ts";
import { CELL, neighbours, STRIPS_COLOUR, STRIPS_EDGE, STRIPS_OFF, WorldView, type WorldEnt, type WorldStrips } from "./platform/worldview.ts";
import { type CapturedQuad } from "./platform/graphics.ts";
import { Quad } from "./platform/image.ts";
import { backedImage, cardEnt, groundEnt, wallEnt } from "./platform/world_fx.ts";

declare const PV_G3_BENCH_SCRIPT: string;
declare const PV_G3_BENCH_SHOTS: string;
declare const PV_G3_BENCH_SCENE: string;

const SCENE = typeof PV_G3_BENCH_SCENE === "string" ? PV_G3_BENCH_SCENE : "";
const FX = SCENE === "fx" || SCENE === "fx-before";
const BEFORE = SCENE === "fx-before";

/** An overworld sheet from the cache (ow/<gid>.meta + .rgba: frames 16x32
 *  stacked down the image, ow_extract.ts's SVOW header). */
interface Sheet { img: Image; w: number; h: number; frames: number }
function sheet(gid: number): Sheet | undefined {
  const host = getHost();
  const meta = host.read(`data/generated/gba/ow/${gid}.meta`);
  const px = host.read(`data/generated/gba/ow/${gid}.rgba`);
  if (!meta || !px || meta.slice(0, 4) !== "SVOW") return undefined;
  const u16 = (o: number): number => meta.charCodeAt(o) | (meta.charCodeAt(o + 1) << 8);
  const w = u16(8), h = u16(10), frames = u16(12);
  if (px.length < w * h * frames * 4) return undefined;
  const bytes = new Uint8Array(w * h * frames * 4);
  for (let i = 0; i < bytes.length; i++) bytes[i] = px.charCodeAt(i);
  const img = newImage(new ImageData(w, h * frames, bytes));
  img.sync();
  return { img, w, h, frames };
}

/** A sheet's frame as a billboard at a cell origin (map px). */
function ent(s: Sheet, x: number, y: number, frame: number, flip: boolean): WorldEnt {
  const v0 = frame / s.frames, v1 = (frame + 1) / s.frames;
  return { tex: s.img.id, x: x + CELL / 2, z: y + CELL / 2, lift: 0, w: s.w, h: s.h,
    u0: flip ? 1 : 0, v0, u1: flip ? 0 : 1, v1, alpha: 1 };
}

// ow_sprites.ts ANIM_STD: stand S/N/W, walk frames, east = west mirrored
const STAND: Record<string, number> = { down: 0, up: 1, left: 2, right: 2 };
const WALK_A: Record<string, number> = { down: 3, up: 5, left: 7, right: 7 };
const WALK_B: Record<string, number> = { down: 4, up: 6, left: 8, right: 8 };
const DIRS: [string, number, number, number][] = [["up", 0, 0, -1], ["down", 1, 0, 1], ["left", 2, -1, 0], ["right", 3, 1, 0]];

/** The people of the two maps walked (the object events FieldView draws
 *  there: graphics id, cell). */
const PEOPLE: Record<string, [number, number, number][]> = {
  FR_PALLET_TOWN: [[23, 5, 15], [27, 13, 17]],
  FR_ROUTE_1: [[68, 6, 28], [27, 19, 16]],
};

const world = loadWorld();
const view = new WorldView(worldOps(), world);
const sheets = new Map<number, Sheet | undefined>();
const sheetOf = (gid: number): Sheet | undefined => {
  if (!sheets.has(gid)) sheets.set(gid, sheet(gid));
  return sheets.get(gid);
};
const player = sheetOf(0);
console.log(`[pv] g3 worldbench: player sheet ${player ? `${player.w}x${player.h} x${player.frames}` : "MISSING"}`);

const script = new BenchScript(typeof PV_G3_BENCH_SCRIPT === "string" ? PV_G3_BENCH_SCRIPT : FX ? "" : "240:RIGHT,336:UP,720:");
const shots = shotSet(typeof PV_G3_BENCH_SHOTS === "string" ? PV_G3_BENCH_SHOTS : "100,200,300,400");
let map = "FR_PALLET_TOWN";
// (the fx scene: two cells south of the house's door, so the door shows)
let px = 6 * CELL, py = (FX ? 9 : 8) * CELL;
let facing = FX ? "up" : "down";

/** A cache sheet of `frames` frames stacked down (field_effects/, doors/). */
interface FxSheet { img: Image; quads: Quad[]; fw: number; fh: number }
function fxSheet(rel: string, fw: number, fh: number, frames: number): FxSheet | undefined {
  const px8 = getHost().read(`data/generated/gba/${rel}`);
  const h = fh * frames;
  if (!px8 || px8.length < fw * h * 4) { console.log(`[pv] g3 worldbench: no ${rel}`); return undefined; }
  const bytes = new Uint8Array(fw * h * 4);
  for (let i = 0; i < bytes.length; i++) bytes[i] = px8.charCodeAt(i);
  const img = newImage(new ImageData(fw, h, bytes));
  const quads: Quad[] = [];
  for (let i = 0; i < frames; i++) quads.push(new Quad(0, i * fh, fw, fh, fw, h));
  return { img, quads, fw, fh };
}
const fxs = FX ? {
  door: fxSheet("doors/general.rgba", 16, 16, 3),
  emote: fxSheet("field_effects/emoticons.rgba", 16, 16, 15),
  grass: fxSheet("field_effects/tall_grass.rgba", 16, 16, 5),
  arrow: fxSheet("field_effects/arrow.rgba", 16, 16, 8),
  ripple: fxSheet("field_effects/ripple.rgba", 16, 16, 5),
  dust: fxSheet("field_effects/ground_impact_dust.rgba", 16, 8, 3),
  surf: fxSheet("field_effects/surf_blob.rgba", 32, 32, 6),
} : undefined;
const cap: CapturedQuad[] = [];
/** What one G.draw makes, captured (the field draws with the camera at 0, 0). */
function captured(img: Image, q: Quad, x: number, y: number): CapturedQuad[] {
  cap.length = 0;
  G.captureBegin(cap);
  G.draw(img, q, x, y);
  G.captureEnd();
  return cap.slice();
}
/** The scene's side strips and the player's lift (the fx timeline). */
const strips: WorldStrips = { mode: STRIPS_OFF, r: 0, g: 0, b: 0, a: 0 };
let lift = 0;
/** The scene's 2D layer and billboards for shown frame `f`. */
function sceneFrame(f: number, ents: WorldEnt[]): void {
  strips.mode = STRIPS_OFF;
  lift = 0;
  // the door (doors.ts draw: the room's dark behind, the frame over it): open 10-34, hold, close 50-70
  if (fxs?.door && f >= 10 && f < 70) {
    const fr = f < 34 ? Math.min(2, Math.floor((f - 10) / 8)) : f < 50 ? 2 : Math.max(0, 2 - Math.floor((f - 50) / 8));
    const dx = 6 * CELL, dy = 7 * CELL;
    for (const q of captured(fxs.door.img, fxs.door.quads[fr]!, dx, dy)) {
      if (!BEFORE) ents.push(wallEnt(q, dy + CELL, undefined, backedImage(q.img, [0.05, 0.07, 0.1])));
    }
  }
  // a screen fade (ui/fade.ts draw over the GBA screen), black then white
  const fade = (f0: number, white: boolean): void => {
    if (f < f0 || f >= f0 + 40) return;
    const k = f - f0;
    const t = k < 16 ? k + 1 : k < 24 ? 16 : Math.max(0, 16 - (k - 23));
    const c = white ? 1 : 0;
    G.setColor(c, c, c, t / 16);
    G.rectangle("fill", 0, 0, 240, 160);
    G.setColor(1, 1, 1, 1);
    if (!BEFORE) { strips.mode = STRIPS_COLOUR; strips.r = strips.g = strips.b = c; strips.a = t / 16; }
  };
  fade(70, false);
  fade(110, true);
  // a battle transition's black bars closing (150-200)
  if (f >= 150 && f < 200) {
    const k = Math.min(16, Math.floor((f - 150) / 2));
    G.setColor(0, 0, 0, 1);
    for (let y = 0; y < 160; y += 16) G.rectangle("fill", 0, y, 240, k);
    G.setColor(1, 1, 1, 1);
    if (!BEFORE) strips.mode = STRIPS_EDGE;
  }
  if (!fxs || BEFORE || f < 200 || f >= 300) return;
  // a jump's arc (field_view.ts playerPixels' yOff) as the player's lift
  if (f >= 220 && f < 252) lift = Math.round(Math.sin(((f - 220) / 32) * Math.PI) * 16);
  const feet = py + CELL;
  // the balloon over the head (field_effects.ts collectActors "emote": oy - 16)
  if (fxs.emote) for (const q of captured(fxs.emote.img, fxs.emote.quads[0]!, px, py - 16)) ents.push(cardEnt(q, feet, 4));
  // stirred grass on the cell east, on the leaned plane of that cell's
  // grass card (game3_world.ts behindEnt; Pallet's cell has no card of its own)
  if (fxs.grass) {
    for (const q of captured(fxs.grass.img, fxs.grass.quads[Math.floor(f / 6) % 5]!, px + CELL, py)) {
      const e = wallEnt(q, py + CELL - 1.5);
      e.lift = 0.2;
      ents.push(e);
    }
  }
  // the warp arrow and a ripple, flat on the floor (two cells west, one west)
  if (fxs.arrow) for (const q of captured(fxs.arrow.img, fxs.arrow.quads[Math.floor(f / 8) % 2]!, px - 2 * CELL, py)) ents.push(groundEnt(q));
  if (fxs.ripple) for (const q of captured(fxs.ripple.img, fxs.ripple.quads[Math.floor(f / 6) % 5]!, px - CELL, py + 6)) ents.push(groundEnt(q));
  // landing dust on the cell south-east, and a surf blob two cells east
  if (fxs.dust) for (const q of captured(fxs.dust.img, fxs.dust.quads[Math.floor(f / 6) % 3]!, px + CELL, py + CELL + 8)) ents.push(cardEnt(q, feet + CELL, 3));
  if (fxs.surf) for (const q of captured(fxs.surf.img, fxs.surf.quads[0]!, px + 2 * CELL - 8, py - 8)) ents.push(cardEnt(q, feet, -1));
}

let dx = 0, dy = 0, stepping = false, stepFlip = false;
let tick = 0, shown = 0;
const prof = { frames: 0, guest: 0 };

/** Cross a seam when the walk leaves the map through a connection. */
function crossSeam(): void {
  const m = world?.maps[map];
  if (!world || !m) return;
  const cx = Math.floor(px / CELL), cy = Math.floor(py / CELL);
  if (cx >= 0 && cy >= 0 && cx < m.width && cy < m.height) return;
  for (const nb of neighbours(world.maps, map)) {
    const d = world.maps[nb.id]!;
    const lx = px - nb.ox, ly = py - nb.oy;
    if (lx >= 0 && ly >= 0 && lx < d.width * CELL && ly < d.height * CELL) {
      console.log(`[pv] g3 worldbench: ${map} -> ${nb.id} at (${lx / CELL},${ly / CELL}), tick ${tick}`);
      map = nb.id;
      px = lx;
      py = ly;
      return;
    }
  }
}

G.setFrameClearAlpha(0);
setFrame((buttons: number): void => {
  tick++;
  const t0 = clock();
  const keys = padBits(buttons) | script.at(tick);
  // FRLG's walk: a pixel a tick, a step is a whole cell
  if (!stepping) {
    for (const [name, bit, ddx, ddy] of DIRS) {
      if (keys & (1 << bit)) {
        facing = name; dx = ddx; dy = ddy; stepping = true; stepFlip = !stepFlip;
        break;
      }
    }
  }
  if (stepping) {
    px += dx; py += dy;
    if (px % CELL === 0 && py % CELL === 0) { stepping = false; crossSeam(); }
  }
  prof.guest += clock() - t0;
  if (n.lastStep && !n.lastStep()) return;
  const t1 = clock();
  // the 2D layer: clear (the world shows), with a message box for a while
  G.beginFrame();
  const sceneEnts: WorldEnt[] = [];
  if (FX) sceneFrame(shown, sceneEnts);
  if (FX ? shown >= 260 && shown < 300 : shown >= 50 && shown < 230) {
    G.setColor(0.25, 0.25, 0.3, 1);
    G.rectangle("fill", 2, 114, 236, 44);
    G.setColor(1, 1, 1, 1);
    G.rectangle("fill", 6, 118, 228, 36);
    G.setColor(0.4, 0.4, 0.45, 1);
    for (let i = 0; i < 3; i++) G.rectangle("fill", 14, 124 + i * 10, 120 + 30 * i, 4);
    G.setColor(1, 1, 1, 1);
  }
  G.endFrame();
  const ents: WorldEnt[] = [];
  if (player) {
    const walkPhase = stepping && ((px + py) % CELL) >= CELL / 2;
    const f = walkPhase ? (stepFlip ? WALK_A[facing]! : WALK_B[facing]!) : STAND[facing]!;
    const e = ent(player, px, py, f, facing === "right");
    e.lift = lift;
    ents.push(e);
  }
  for (const e of sceneEnts) ents.push(e);
  for (const [gid, cx, cy] of PEOPLE[map] ?? []) {
    const s = sheetOf(gid);
    if (s) ents.push(ent(s, cx * CELL, cy * CELL, 0, false));
  }
  // the camera on the player's cell centre, as FieldView's
  view.emit({ map, camX: px + CELL / 2, camY: py + CELL / 2, ents, strips });
  prof.guest += clock() - t1;
  shown++;
  if (shots.has(shown)) {
    n.screenshot?.();
    console.log(`[pv] g3 worldbench: shot at shown frame ${shown} (tick ${tick}) ${map} (${px / CELL},${py / CELL}) ents=${view.entCount}`);
  }
  if (++prof.frames === 150) {
    console.log(`[pv] g3 worldbench: guest ${(prof.guest / prof.frames / 1000).toFixed(2)} ms/frame, ` +
      `g3Draw ${(drawProf.conv / prof.frames / 1000).toFixed(2)} ms, ${map} (${px / CELL},${py / CELL})`);
    prof.frames = prof.guest = 0;
    drawProf.conv = drawProf.len = 0;
  }
});
