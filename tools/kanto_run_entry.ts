// A Citra check of RUNNING SHOES on a Kanto cart (cc_kanto_bench.sh
// tools/kanto_run_entry.ts): the card's save continued, from Pallet Town north in GRID
// movement, two seconds walking north, two seconds walking north holding B;
// the steps taken in each are logged. Never shipped.
import "../voxelmon/game/psp-main.ts";

const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const UP = 1 << 0;
const B = 1 << 5;
const START = 1 << 6;
let continued = false;
let placed = 0;
let i = 0;
let y0 = 0;

g.frame = (b: number): void => {
  i++;
  const top = game.stack?.[game.stack.length - 1];
  let pad = 0;
  if (!continued) {
    if (top?.kind === "title") {
      continued = true;
      game.pop();
      top.onChoose?.("continue");
    } else if (i % 30 === 0) pad = START;
  } else if (game.save) {
    game.save.options = { ...(game.save.options ?? {}), view: "3d", movement: "grid" };
    delete game.save.options.runningShoes;
    if (!placed && top?.kind === "overworld") {
      placed = i;
      game.overworld.enter("PALLET_TOWN", 10, 2, "up");
      while (game.stack.length > 1 && game.stack[game.stack.length - 1].kind !== "overworld") game.pop();
    }
    const t = placed ? i - placed : -1;
    const p = game.overworld?.player;
    if (p) {
      if (t === 90) y0 = p.landedCount;
      if (t >= 90 && t < 150) pad = UP;
      if (t === 210) console.log(`[pv] bench run: walking, 60 ticks: ${p.landedCount - y0} steps (${game.overworld.map?.id})`);
      if (t === 215) game.overworld.enter("PALLET_TOWN", 10, 2, "up");
      if (t === 240) y0 = p.landedCount;
      if (t >= 240 && t < 300) pad = UP | B;
      if (t === 360) console.log(`[pv] bench run: running (B), 60 ticks: ${p.landedCount - y0} steps (${game.overworld.map?.id})`);
    }
  }
  mainFrame((b & ~0xff) | pad);
};
