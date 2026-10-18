// A Citra shot of the border ring past map edges in Red/Blue/Yellow 3D: the
// card's save continued, then the player stood at each spot below (the
// nearest open cell to it) and the top screen shot once the map and its
// strips have built. Each shot is "[pv] bpshot N MAP x,y". Never shipped.
import "../voxelmon/game/psp-main.ts";

const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const START = 1 << 6;

/** Map and cell (a build can name others: --define 'SHOT_SPOTS=[["MAP",x,y]]'). */
declare const SHOT_SPOTS: [string, number, number][];
const SPOTS: [string, number, number][] = typeof SHOT_SPOTS !== "undefined" ? SHOT_SPOTS : [
  ["VIRIDIAN_CITY", 4, 4], // west edge north of the short west connection
  ["VIRIDIAN_CITY", 4, 30], // and south of it
  ["ROUTE_22", 30, 4],
];
const PER = 420;

let continued = false;
let n = 0;
let base = -1;
const log = (s: string): void => console.log("[pv] " + s);

function nearestOpen(map: any, cx: number, cy: number): [number, number] | null {
  for (let r = 0; r < 24; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= map.widthCells || y >= map.heightCells) continue;
        if (map.isWalkableCell(x, y) && !map.warpAtCell(x, y)) return [x, y];
      }
    }
  }
  return null;
}

function toOverworld(): void {
  while (game.stack.length > 1 && game.stack[game.stack.length - 1].kind !== "overworld") game.pop();
}

g.frame = (b: number): void => {
  n++;
  let pad = 0;
  const top = game.stack?.[game.stack.length - 1];
  if (!continued) {
    if (top?.kind === "title") {
      continued = true;
      game.pop();
      top.onChoose?.("continue");
    } else if (n % 30 === 0) pad = START;
  } else if (game.save) {
    game.save.options = { ...(game.save.options ?? {}), view: "3d" };
  }
  const ow = game.overworld;
  if (continued && ow?.map && base < 0) base = n + 300;
  const k = base < 0 || n < base ? -1 : Math.floor((n - base) / PER);
  const t = base < 0 ? -1 : (n - base) % PER;
  if (ow?.map && k >= 0 && k < SPOTS.length) {
    const [id, x, y] = SPOTS[k]!;
    if (t === 10) {
      toOverworld();
      ow.enter(id, 2, 2, "down");
    }
    if (t === 100 && ow.map.id === id) {
      const at = nearestOpen(ow.map, x, y);
      if (at) ow.enter(id, at[0], at[1], "down");
      toOverworld();
    }
    if (t === PER - 30) {
      log(`bpshot ${k} ${ow.map.id} ${ow.player?.cellX ?? "?"},${ow.player?.cellY ?? "?"}`);
      (globalThis as any).voxel?.screenshot?.();
    }
  }
  if (k === SPOTS.length && t === 10) log("bpshot done");
  mainFrame((b & ~0xff) | pad);
};
