// A Citra check of map-switch time in VIEW 2D (cc_kanto_bench.sh
// tools/kanto_doors2d_entry.ts): the real entry, the card's save continued,
// VIEW 2D on, the player stood under Red's house door in PALLET TOWN, then
// in and out of the door over and over. Each warp logs, in wall-clock ms,
// the press that set it off -> the map switch -> the player free to walk
// again, beside the host's own "[pv] load" breakdown. Never shipped.
import "../voxelmon/game/psp-main.ts";

// SEAM=1 at bundle time: across PALLET TOWN's top edge into ROUTE 1 and
// back instead of through the door.
declare const SEAM: boolean;
const seam = typeof SEAM !== "undefined" && SEAM;
// TOUR=1: warps (the real fade) into big cities never visited this boot,
// so every pak is a first read off the card.
declare const TOUR: boolean;
const tour = typeof TOUR !== "undefined" && TOUR;
const CITIES = ["VIRIDIAN_CITY", "PEWTER_CITY", "CERULEAN_CITY", "SAFFRON_CITY", "CELADON_CITY", "VERMILION_CITY", "FUCHSIA_CITY", "LAVENDER_TOWN"];

const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const START = 1 << 6;
const UP = 1 << 0;
const DOWN = 1 << 1;
let continued = false;
let i = 0;
let placed = false;
let lastMap = "";
let pressAt = 0;
let switchAt = 0;
let waitFree = false;
let settle = 0;
let round = 0;

function free(): boolean {
  const ow = game.overworld;
  const top = game.stack?.[game.stack.length - 1];
  return top?.kind === "overworld" && !ow?.transitioning && !ow?.player?.moving && !ow?.busy?.();
}

g.frame = (b: number): void => {
  const top = game.stack?.[game.stack.length - 1];
  let pad = 0;
  if (!continued) {
    if (top?.kind === "title") {
      continued = true;
      game.pop();
      top.onChoose?.("continue");
    } else if (i % 30 === 0) pad = START;
  }
  if (continued && game.save) {
    const o = (game.save.options ??= {});
    o.view = "2d";
    o.battleView = "2d";
  }
  const ow = game.overworld;
  if (continued && ow?.map && top?.kind === "overworld") {
    if (!placed) {
      placed = true;
      if (seam) ow.enter("PALLET_TOWN", 10, 1, "up");
      else ow.enter("PALLET_TOWN", 5, 6, "up");
      while (game.stack.length > 1 && game.stack[game.stack.length - 1].kind !== "overworld") game.pop();
      settle = 120;
    }
  }
  if (placed && ow?.map) {
    const id = ow.map.id;
    if (id !== lastMap) {
      if (lastMap && pressAt) {
        switchAt = Date.now();
        waitFree = true;
      }
      lastMap = id;
    }
    if (waitFree && free()) {
      const now = Date.now();
      console.log(`[pv] bench warp ${round} -> ${id}: press->switch ${switchAt - pressAt} ms, switch->free ${now - switchAt} ms, total ${now - pressAt} ms`);
      waitFree = false;
      pressAt = 0;
      round++;
      settle = 30;
    }
    if (settle > 0) settle--;
    else if (tour && !waitFree && free() && round < CITIES.length) {
      const id2 = CITIES[round]!;
      const w = game.data.maps[id2]?.warps?.[0];
      pressAt = Date.now();
      ow.startWarpTo(id2, w?.x ?? 5, (w?.y ?? 5) + 1, "down");
    } else if (tour) {
      // (waiting on the warp)
    } else if (!waitFree && free() && round < 12) {
      if (!pressAt) pressAt = Date.now();
      pad = id === "PALLET_TOWN" ? UP : DOWN;
    } else if (pressAt && !waitFree) {
      pad = id === "PALLET_TOWN" ? UP : DOWN;
    }
  }
  i++;
  mainFrame((b & ~0xff) | pad);
};
