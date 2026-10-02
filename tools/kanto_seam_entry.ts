// A Citra check of seam crossings in the Kanto games (cc_kanto_bench.sh
// tools/kanto_seam_entry.ts): the card's save continued, the player put at
// Pallet Town's north edge in VIEW 3D, then up into Route 1 and back down,
// over and over; the host logs each load and its strips (deferred ones too).
// SHOTS=1: a top-screen shot just after each crossing. Never shipped.
import "../voxelmon/game/psp-main.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";

declare const SHOTS: boolean;
const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const UP = 1 << 0;
const DOWN = 1 << 1;
const START = 1 << 6;
let continued = false;
let placed = 0;
let i = 0;
let lastMap = "";
let since = 0;

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
    game.save.options = { ...(game.save.options ?? {}), view: "3d" };
    if (!placed && top?.kind === "overworld") {
      placed = i;
      game.overworld.enter("PALLET_TOWN", 10, 2, "up");
      while (game.stack.length > 1 && game.stack[game.stack.length - 1].kind !== "overworld") game.pop();
    }
    const map = String(game.overworld?.mapId ?? game.overworld?.map?.id ?? "");
    if (map !== lastMap) {
      console.log(`[pv] bench seam: ${map} at tick ${i}`);
      lastMap = map;
      since = 0;
    }
    since++;
    if (typeof SHOTS !== "undefined" && since === 20 && placed) native.screenshot?.();
    if (placed && i > placed + 120) {
      // ~5 s each way: up the route a few cells, then back into town
      const leg = Math.floor((i - placed) / 150) % 2;
      pad = leg === 0 ? UP : DOWN;
    }
  }
  mainFrame((b & ~0xff) | pad);
};
