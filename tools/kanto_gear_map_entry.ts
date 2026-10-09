// A Citra check of the Kanto Gear's views' cost (kfix bench; bundled in
// place of game.js): the card's save continued, the player in a town in 3D,
// the bottom screen on HOME, MAP and EXPLORER standing still, then EXPLORER,
// MAP and HOME walking up and down, fifteen seconds each (the host's perf
// line comes every five). The bench gives the TOWN MAP if the save lacks
// it. Never shipped.
import "../voxelmon/game/psp-main.ts";
import { drawExplorer } from "../voxelmon/game/ui/gear/apps/explorer.ts";
import { assists, mapItems } from "../voxelmon/game/ui/gear/model.ts";
import { ctxFor } from "../voxelmon/game/ui/gear/ui.ts";

declare const PROFILE: boolean;
const now = (globalThis as any).voxel?.now as (() => number) | undefined;
/** EXPLORER's pieces on this save, timed once (PROFILE builds). */
function profile(): void {
  if (!now) return;
  const nop = () => {};
  const host: any = { uiTileBottom: nop, uiClearBottom: nop, uiSpriteBottom: nop, uiSpriteRectBottom: nop, uiRectBottom: nop };
  const map = game.overworld.map;
  const time = (name: string, fn: () => void, n = 3): void => {
    const a = now();
    for (let k = 0; k < n; k++) fn();
    console.log(`[pv] kfix: ${name}: ${((now() - a) / n / 1000).toFixed(2)} ms`);
  };
  console.log(`[pv] kfix: ${map.id} ${map.widthCells}x${map.heightCells} assists ${assists(game.save)} npcs ${game.overworld.npcs?.length}`);
  time("drawExplorer", () => drawExplorer(ctxFor(host, game, "explorer")));
  time("warpAtCell x 26x13", () => { for (let y = 0; y < 13; y++) for (let x = 0; x < 26; x++) map.warpAtCell?.(x, y); });
  time("isWaterCell x 26x13", () => { for (let y = 0; y < 13; y++) for (let x = 0; x < 26; x++) map.isWaterCell?.(x, y); });
  time("isWalkableCell x 26x13", () => { for (let y = 0; y < 13; y++) for (let x = 0; x < 26; x++) map.isWalkableCell(x, y); });
  time("isGrassCell x 26x13", () => { for (let y = 0; y < 13; y++) for (let x = 0; x < 26; x++) map.isGrassCell?.(x, y); });
  time("mapItems", () => mapItems(game.data, game.save, map.id));
}

declare const WARP: string;
const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const UP = 1 << 0;
const DOWN = 1 << 1;
const START = 1 << 6;
const VIEWS = ["home", "map", "explorer", "explorer", "map", "home"];
const WALKS = [false, false, false, true, true, true];
const SPAN = 15 * 60;
let continued = false;
let placed = 0;
let i = 0;
let shown = "";

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
    game.save.inventory = game.save.inventory ?? {};
    if (!(game.save.inventory.TOWN_MAP > 0)) game.save.inventory.TOWN_MAP = 1;
    if (!placed && top?.kind === "overworld") {
      placed = i;
      const [m, x, y] = (typeof WARP !== "undefined" ? WARP : "VIRIDIAN_CITY,18,20").split(",");
      game.overworld.enter(m, Number(x), Number(y), "down");
      while (game.stack.length > 1 && game.stack[game.stack.length - 1].kind !== "overworld") game.pop();
    }
    const t = placed ? i - placed : -1;
    if (t >= 0) {
      const k = Math.floor(t / SPAN);
      const view = VIEWS[Math.min(k, VIEWS.length - 1)]!;
      if (typeof PROFILE !== "undefined" && PROFILE && t === 2 * SPAN + 300) profile();
      // the screens with EXPLORER up and with MAP up (shot_N_b.ppm: the bottom)
      if (t === 2 * SPAN + 120 || t === SPAN + 120) (globalThis as any).voxel?.screenshot?.();
      if (view !== shown || t % SPAN === 0) {
        game.setGearView ? game.setGearView(view) : (game.gearView = view);
        if (view !== shown || t % SPAN === 0) console.log(`[pv] kfix: gear ${view}${WALKS[k] ? " walking" : ""} from tick ${t}`);
        shown = view;
      }
      if (WALKS[Math.min(k, WALKS.length - 1)]) pad = Math.floor(t / 64) % 2 ? UP : DOWN;
    }
  }
  mainFrame((b & ~0xff) | pad);
};
