// Citra shots of cards standing behind other cards on Red/Blue/Yellow (bundled
// in place of game.js), for the empty corners of a card hiding whatever card
// stands behind it: the card's save continued, then
//
//   the town      a wild mon set one cell behind the player (further from
//                 the camera), and one behind and to the side; the
//                 player stepped down so Yellow's follower stands behind
//   the grass     the same on the first route, every card in the grass
//   tilt shift    SOFT, the mon behind (the cards go through the tilt pass)
//   2D            the mon behind, in VIEW 2D
//   a battle      a wild battle on the 3D stage, at its opening and menu
//
// The visible-wild list is held to the mons set here every frame (none
// wander or despawn). Each step is shot to the card (shot_N.ppm top,
// shot_N_r.ppm the right eye, shot_N_b.ppm bottom) with a "[pv] bpshot N
// name" line in pvlog.txt. Never shipped.
import "../voxelmon/game/psp-main.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";
import { CELL_LAND, wildSprite } from "../voxelmon/game/visiblewild.ts";
import { WildMon } from "../voxelmon/game/world/wildmons.ts";

const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const DOWN = 1 << 1;
const A = 1 << 4;
const START = 1 << 6;
const R = 1 << 26;

let i = 0;
let phase: "title" | "load" | "tour" | "done" = "title";
let wait = 0;
let shots = 0;
let step = 0;
let stepAt = 0;
let queue: number[] = [];
let held = 0;
let holdLeft = 0;
/** The wild mons held on the map, or null to leave the list alone. */
let mons: any[] | null = null;
/** The column the scene is built around: [x, y] of the player. */
let spot: [number, number] = [0, 0];

const top = (): any => game.stack?.[game.stack.length - 1];
const ow = (): any => game.overworld;
const opts = (): Record<string, unknown> => (game.save.options ??= {});
const shot = (name: string): void => {
  const p = ow()?.player;
  const ms = (mons ?? []).map((m: any) => `${m.species}@${m.cellX},${m.cellY}`).join(" ");
  console.log(`[pv] bpshot ${shots} ${name} map=${ow()?.map?.id} player=${p?.cellX},${p?.cellY} mons=[${ms}]`);
  shots++;
  native.screenshot?.();
};
const toOverworld = (): void => {
  while (game.stack.length > 1 && top()?.kind !== "overworld") game.pop();
};

const realPush = game.pushStubBattle.bind(game);
let allowBattle = false;
game.pushStubBattle = (species: string, level: number): void => {
  if (allowBattle) realPush(species, level);
};

/** A column of walkable cells (and the column right of it) four tall, as
 *  near the map's middle as there is one; `grass` asks for grass cells. */
function findSpot(grass: boolean): [number, number] | null {
  const m = ow().map;
  const w = m.widthCells, h = m.heightCells;
  const ok = (x: number, y: number): boolean =>
    m.isWalkableCell(x, y) && !m.isWarpTileCell(x, y) && (!grass || m.isGrassCell(x, y));
  let best: [number, number] | null = null;
  let bestD = 1e9;
  for (let y = 3; y < h - 3; y++) {
    for (let x = 2; x < w - 3; x++) {
      let good = true;
      for (let dy = -2; dy <= 1 && good; dy++) for (let dx = 0; dx <= 1 && good; dx++) good = ok(x + dx, y + dy);
      if (!good) continue;
      const d = Math.abs(x - w / 2) + Math.abs(y - h / 2);
      if (d < bestD) { bestD = d; best = [x, y]; }
    }
  }
  return best;
}

function mon(x: number, y: number): any {
  const enc = game.data.encounters?.ROUTE_1?.grass?.slots?.[0];
  const sp = enc?.species ?? "PIDGEY";
  return new WildMon(sp, enc?.level ?? 3, wildSprite(game.data, sp), CELL_LAND, x, y, "down", 99999, 99999, 0);
}

/** Into `map` at its spot, facing down, nothing set yet. */
function goTo(map: string, grass: boolean): void {
  toOverworld();
  const o = ow();
  mons = [];
  o.enter(map, 2, 2, "down");
  const at = findSpot(grass);
  if (at) { spot = at; o.enter(map, at[0], at[1], "down"); }
  console.log(`[pv] carddepth: ${map} at ${at ? at.join(",") : "none"}`);
}

type Step = { name: string; set?: () => void; inputs?: number[]; frames?: number; shoot?: boolean; pad?: () => number };

const scenes = (map: string, grass: boolean, tag: string): Step[] => [
  { name: `${tag}_enter`, set: () => goTo(map, grass), frames: 120, shoot: false },
  { name: `${tag}_wild_behind`, set: () => { mons = [mon(spot[0], spot[1] - 1)]; }, frames: 30 },
  { name: `${tag}_wild_behind_side`, set: () => { mons = [mon(spot[0] + 1, spot[1] - 1)]; }, frames: 30 },
  { name: `${tag}_wild_two_behind`, set: () => { mons = [mon(spot[0], spot[1] - 2), mon(spot[0] + 1, spot[1] - 1)]; }, frames: 30 },
  // a step down: the follower takes the cell the player left, behind them
  { name: `${tag}_partner_behind`, set: () => { mons = [mon(spot[0] + 1, spot[1])]; }, inputs: [DOWN], frames: 60 },
];

const STEPS: Step[] = [
  ...scenes("PALLET_TOWN", false, "town"),
  ...scenes("ROUTE_1", true, "grass"),
  { name: "tilt_enter", set: () => { goTo("PALLET_TOWN", false); opts().tiltShift = "soft"; }, frames: 120, shoot: false },
  { name: "tilt_wild_behind", set: () => { mons = [mon(spot[0], spot[1] - 1), mon(spot[0] + 1, spot[1] - 1)]; }, frames: 30 },
  { name: "view2d_wild_behind", set: () => { opts().tiltShift = "off"; opts().view = "2d"; }, frames: 60 },
  { name: "battle_enter", set: () => { opts().view = "3d"; goTo("ROUTE_1", true); }, frames: 60, shoot: false },
  { name: "battle_opens", set: () => { mons = null; allowBattle = true; realPush("ONIX", 12); }, frames: 150 },
  { name: "battle_menu", pad: () => (top()?.battle?.phase === "messages" && i % 16 === 0 ? A : 0), frames: 240 },
  { name: "battle_later", frames: 120 },
];

g.frame = (b: number): void => {
  i++;
  let pad = 0;
  const t = top();
  if (mons && ow()?.wild) {
    const list = ow().wild.mons;
    list.length = 0;
    for (const m of mons) list.push(m);
  }
  if (phase === "title") {
    if (t?.kind === "title") {
      phase = "load";
      game.pop();
      t.onChoose?.("continue");
    } else if (i % 30 === 0) pad = START;
  } else if (phase === "load") {
    if (game.save && t?.kind === "overworld") {
      if (++wait === 30) {
        game.save.options = { ...(game.save.options ?? {}), view: "3d", battleView: "3d", visibleWild: "some", movement: "grid", tiltShift: "off" };
        game.save.repelSteps = 60000;
        game.overworld.trainerDefeated = () => true;
        game.setGameSpeed?.(1);
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
