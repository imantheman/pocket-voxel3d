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

// FIRST: the host and the sound.
import { clock, drawProf } from "./platform/qjs_host.ts";
import { BenchScript, loadWorld, nat as n, padBits, setFrame, shotSet, worldOps } from "./platform/qjs_world.ts";
import { G } from "./platform/graphics.ts";
import { getHost } from "./platform/host.ts";
import { ImageData, newImage, type Image } from "./platform/image.ts";
import { CELL, neighbours, WorldView, type WorldEnt } from "./platform/worldview.ts";

declare const PV_G3_BENCH_SCRIPT: string;
declare const PV_G3_BENCH_SHOTS: string;

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

const script = new BenchScript(typeof PV_G3_BENCH_SCRIPT === "string" ? PV_G3_BENCH_SCRIPT : "240:RIGHT,336:UP,720:");
const shots = shotSet(typeof PV_G3_BENCH_SHOTS === "string" ? PV_G3_BENCH_SHOTS : "100,200,300,400");
let map = "FR_PALLET_TOWN";
let px = 6 * CELL, py = 8 * CELL;
let facing = "down";
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
  if (shown >= 50 && shown < 230) {
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
    ents.push(ent(player, px, py, f, facing === "right"));
  }
  for (const [gid, cx, cy] of PEOPLE[map] ?? []) {
    const s = sheetOf(gid);
    if (s) ents.push(ent(s, cx * CELL, cy * CELL, 0, false));
  }
  // the camera on the player's cell centre, as FieldView's
  view.emit({ map, camX: px + CELL / 2, camY: py + CELL / 2, ents });
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
