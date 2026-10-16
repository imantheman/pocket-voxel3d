// A Citra tour of VISIBLE WILD and the gear's ENHANCEMENTS app on Red/Blue/
// Yellow for screenshots (bundled in place of game.js): the card's save
// continued, then
//
//   HOME          every app on offer, with and without CHEATS
//   the app       ENHANCEMENTS as it opens, SPEED 2X, the toggles on,
//                 VISIBLE WILD SOME and MANY -- all by taps
//   OPTION        its ENHANCEMENTS page walked down to VISIBLE WILD
//   the field     the first route with SOME and MANY in 3D, MANY in 2D; the
//                 forest; the big grass route; a cave; the sea, surfing
//   the touch     a mon set two cells ahead, the player walks into it: the
//                 battle opens with exactly that one, and afterwards it is
//                 gone
//
// Battles from a stray touch are held back until the touch's own step (the
// shell's pushStubBattle is wrapped). Each step is shot to the card
// (shot_N.ppm top, shot_N_r.ppm the right eye, shot_N_b.ppm bottom) with a
// "[pv] bpshot N name" line in pvlog.txt. Never shipped.
import "../voxelmon/game/psp-main.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";
import { OptionsMenuState } from "../voxelmon/game/ui/optionsmenu.ts";
import { CELL_LAND, CELL_WATER, WINDOW_X, WINDOW_Y, wildSprite } from "../voxelmon/game/visiblewild.ts";
import { WildMon } from "../voxelmon/game/world/wildmons.ts";

const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const RIGHT = 1 << 3;
const DOWN = 1 << 1;
const A = 1 << 4;
const START = 1 << 6;
const R = 1 << 26;
const touch = (x: number, y: number): number => 0x100 | ((x >> 1) << 9) | ((y >> 1) << 17);
const cell = (cx: number, cy: number): number => touch(cx * 16 + 8, Math.floor(cy * (240 / 18) + 6));

let i = 0;
let phase: "title" | "load" | "tour" | "done" = "title";
let wait = 0;
let shots = 0;
let step = 0;
let stepAt = 0;
let queue: number[] = [];
let held = 0;
let holdLeft = 0;

const top = (): any => game.stack?.[game.stack.length - 1];
const ow = (): any => game.overworld;
const opts = (): Record<string, unknown> => (game.save.options ??= {});
const shot = (name: string): void => {
  const w = ow()?.wild;
  const mons = w ? w.mons.map((m: any) => `${m.species}:${m.level}@${m.cellX},${m.cellY}/${m.sprite.replace("SPRITE_", "")}`).join(" ") : "";
  console.log(`[pv] bpshot ${shots} ${name} map=${ow()?.map?.id} mons=[${mons}] battles=${w?.battles ?? 0}`);
  shots++;
  native.screenshot?.();
};
const toOverworld = (): void => {
  while (game.stack.length > 1 && top()?.kind !== "overworld") game.pop();
};
/** The gear redraws a still screen only when its key moves: away now, and
 *  back a few frames later (the frame loop sets `pendingView`). */
let pendingView: string | null = null;
let pendingAt = 0;
const view = (v: string): void => { game.setGearView(v === "home" ? "party" : "home"); pendingView = v; pendingAt = i + 3; };

// stray touches start nothing until the touch's own step lets them
const realPush = game.pushStubBattle.bind(game);
let allowBattle = false;
game.pushStubBattle = (species: string, level: number): void => {
  if (allowBattle) realPush(species, level);
  else console.log(`[pv] vwild: stray touch ${species}:${level} held back`);
};

/** The cell of a kind with the most of that kind in the spawn window. */
function busiest(kind: number): [number, number] | null {
  const o = ow();
  const kinds: Uint8Array = o.wild.cellKinds();
  const w = o.map.widthCells, h = o.map.heightCells;
  let best: [number, number] | null = null;
  let bestN = -1;
  for (let cy = 1; cy < h - 1; cy++) {
    for (let cx = 1; cx < w - 1; cx++) {
      if (kinds[cy * w + cx] !== kind) continue;
      let n = 0;
      for (let y = Math.max(1, cy - WINDOW_Y); y <= Math.min(h - 2, cy + WINDOW_Y); y++) {
        for (let x = Math.max(1, cx - WINDOW_X); x <= Math.min(w - 2, cx + WINDOW_X); x++) if (kinds[y * w + x] === kind) n++;
      }
      if (n > bestN) { bestN = n; best = [cx, cy]; }
    }
  }
  return best;
}

/** Into a map on its busiest cell of `kind`, facing right. */
function goTo(map: string, kind = CELL_LAND, surf = false): void {
  toOverworld();
  const o = ow();
  o.enter(map, 2, 2, "right");
  const at = busiest(kind);
  if (at) {
    if (surf) game.save.surfing = true;
    o.enter(map, at[0], at[1], "right");
    if (surf) { o.player.surfing = true; game.save.surfing = true; }
  }
  console.log(`[pv] vwild: ${map} at ${at ? at.join(",") : "none"}`);
}

/** A mon of the route's own table two cells right of the player, and a
 *  clear grass cell between. */
let placed: any = null;
function placeAhead(): void {
  const o = ow();
  const p = o.player;
  o.wild.mons.length = 0;
  const kinds: Uint8Array = o.wild.cellKinds();
  const w = o.map.widthCells;
  // a row of three grass cells: the player, the gap, the mon
  for (let dy = 0; dy < 12 && !placed; dy++) {
    for (const sy of [p.cellY - dy, p.cellY + dy]) {
      for (let x = Math.max(1, p.cellX - 8); x < Math.min(w - 3, p.cellX + 8) && !placed; x++) {
        if ([0, 1, 2].every((k) => kinds[sy * w + x + k] === CELL_LAND)) {
          o.enter(o.map.id, x, sy, "right");
          o.wild.mons.length = 0;
          const slot = game.data.encounters[o.map.id].grass.slots[0];
          placed = new WildMon(slot.species, slot.level, wildSprite(game.data, slot.species), CELL_LAND,
            x + 2, sy, "left", 99999, 99999, 0);
          o.wild.mons.push(placed);
          console.log(`[pv] vwild: placed ${slot.species}:${slot.level} at ${x + 2},${sy}`);
        }
      }
    }
  }
}

type Step = { name: string; set?: () => void; inputs?: number[]; frames?: number; shoot?: boolean; pad?: () => number };

const STEPS: Step[] = [
  // HOME
  { name: "home_all_apps", set: () => { opts().cheats = true; view("home"); }, frames: 40 },
  { name: "home_no_cheats", set: () => { opts().cheats = false; view("home"); }, frames: 40 },
  // the app, by taps
  { name: "enh_app", set: () => { opts().cheats = true; view("enhancements"); }, frames: 40 },
  { name: "enh_speed_2x", inputs: [cell(17, 2)] },
  { name: "enh_toggles_on", inputs: [cell(17, 4), cell(17, 6), cell(17, 8), cell(17, 10)], frames: 60 },
  { name: "enh_wild_some", inputs: [cell(15, 13)] },
  { name: "enh_wild_many", inputs: [cell(15, 13)] },
  // OPTION's page agrees: down to VISIBLE WILD
  { name: "option_enhancements", set: () => { const m = new OptionsMenuState(game); m.turnPage(1); game.push(m); },
    inputs: [DOWN, DOWN, DOWN, DOWN, DOWN], frames: 60 },
  // the field, at 1X
  { name: "route1_some_3d", set: () => {
    toOverworld(); game.setGameSpeed(1);
    Object.assign(opts(), { visibleWild: "some", view: "3d", battleView: "3d", movement: "grid" });
    view("enhancements");
    goTo("ROUTE_1");
  }, frames: 240 },
  { name: "route1_many_3d", set: () => { opts().visibleWild = "many"; ow().wild.onMap(); }, frames: 240 },
  { name: "route1_many_2d", set: () => { opts().view = "2d"; }, frames: 90 },
  { name: "route1_some_2d", set: () => { opts().visibleWild = "some"; ow().wild.onMap(); }, frames: 200 },
  { name: "forest_many_3d", set: () => { Object.assign(opts(), { visibleWild: "many", view: "3d" }); goTo("VIRIDIAN_FOREST"); }, frames: 240 },
  { name: "forest_many_2d", set: () => { opts().view = "2d"; }, frames: 90 },
  { name: "route11_many_3d", set: () => { opts().view = "3d"; goTo("ROUTE_11"); }, frames: 240 },
  { name: "route11_many_3d_later", frames: 300 },
  { name: "route11_many_2d", set: () => { opts().view = "2d"; }, frames: 90 },
  { name: "route11_many_2d_later", frames: 300 },
  { name: "cave_many_3d", set: () => { opts().view = "3d"; goTo("MT_MOON_1F"); }, frames: 240 },
  { name: "sea_surfing_3d", set: () => { goTo("ROUTE_19", CELL_WATER, true); }, frames: 240 },
  // the touch
  { name: "touch_ahead", set: () => { goTo("ROUTE_1"); placed = null; }, frames: 30, shoot: false },
  { name: "touch_ahead_3d", set: () => { placeAhead(); }, frames: 20 },
  { name: "touch_walk", set: () => { allowBattle = true; }, pad: () => (top()?.kind === "overworld" ? RIGHT : 0), frames: 12 },
  { name: "battle_opens", pad: () => (top()?.kind === "overworld" ? RIGHT : 0), frames: 90 },
  { name: "battle_menu", pad: () => (top()?.battle?.phase === "messages" && i % 16 === 0 ? A : 0), frames: 200 },
  { name: "after_battle", set: () => { toOverworld(); allowBattle = false; }, frames: 30 },
];

g.frame = (b: number): void => {
  i++;
  let pad = 0;
  if (pendingView && i >= pendingAt) { game.setGearView(pendingView); pendingView = null; }
  const t = top();
  if (phase === "title") {
    if (t?.kind === "title") {
      phase = "load";
      game.pop();
      t.onChoose?.("continue");
    } else if (i % 30 === 0) pad = START;
  } else if (phase === "load") {
    if (game.save && t?.kind === "overworld") {
      if (++wait === 30) {
        game.save.options = { ...(game.save.options ?? {}), view: "3d", battleView: "3d", visibleWild: "off" };
        game.save.inventory ??= {};
        game.save.inventory.TOWN_MAP = 1;
        (game.save.flags ??= {}).EVENT_GOT_POKEDEX = true;
        game.save.repelSteps = 0;
        game.overworld.trainerDefeated = () => true;
        toOverworld();
        phase = "tour";
        step = 0;
        STEPS[0]!.set?.();
        queue = [...(STEPS[0]!.inputs ?? [])];
        stepAt = i + (STEPS[0]!.frames ?? 45);
      }
    } else if (t?.kind === "textbox" && i % 30 === 0) pad = A;
  } else if (phase === "tour") {
    const s = STEPS[step];
    if (!s) {
      phase = "done";
      console.log("[pv] bpshot done");
    } else {
      if (s.pad) pad |= s.pad();
      if (holdLeft > 0) { pad |= held; holdLeft--; }
      else if (queue.length > 0 && i % 8 === 0) { held = queue.shift()!; pad |= held; holdLeft = 1; }
      if (i >= stepAt && queue.length === 0 && holdLeft === 0) {
        // the host captures the frame it renders after this one: the next
        // step's set waits a few frames, or the shot would show its scene
        if (s.shoot !== false) { shot(s.name); stepAt = i + 4; s.shoot = false; s.pad = undefined; return finish(b, pad); }
        step++;
        const n = STEPS[step];
        if (n) {
          n.set?.();
          queue = [...(n.inputs ?? [])];
          stepAt = i + (n.frames ?? 45) + queue.length * 8;
        }
      }
    }
  }
  finish(b, pad);
};

function finish(b: number, pad: number): void {
  mainFrame((b & ~0xffffff & ~R) | pad);
}
