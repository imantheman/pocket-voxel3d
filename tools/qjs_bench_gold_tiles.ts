// Gold's 2D tile grid (gen2/platform/map2d.ts tilesFor) timed under
// QuickJS for a few maps (tools/qjs_gold_harness.c via
// cc_qjs_gold_tiles.sh). Never shipped.
import { native } from "../voxelmon/game/quickjs-host.ts";
import { readGen2Container } from "../voxelmon/game/gen2/platform/container.ts";
import { setGen2Source } from "../voxelmon/game/gen2/platform/data.ts";
import { seed } from "../voxelmon/game/gen2/platform/rng.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { tilesFor } from "../voxelmon/game/gen2/platform/map2d.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
const nop = () => {};
const lcd = new Lcd({ lcdCells: nop, lcdObjs: nop, lcdPals: nop, lcdRegs: nop, lcdLines: nop, lcdShow: nop, lcdBank: nop, lcdReset: nop, lcdUnder: nop, lcdUnderRow: nop } as never);

const now = (globalThis as unknown as { voxel: { now: () => number } }).voxel.now;
setGen2Source(readGen2Container(native.gamedata()));
seed(17);
const game: any = Game2.new();
game.load({ startWorld: true });
const w = game.world;
const names = ["NEW_BARK_TOWN", "ROUTE_29", "CHERRYGROVE_CITY", "GOLDENROD_CITY", "ECRUTEAK_CITY", "ROUTE_34", "PLAYERS_HOUSE_1F"];
let done = false;
(globalThis as any).frame = (): void => {
  if (done) return;
  done = true;
  let sum = 0;
  for (const id of names) {
    w.setMap(id, 3, 3, "down");
    const map = w.map;
    const key = w.mapCacheKey(map.id);
    tilesFor(w, map, key); // warm (atlas images)
    const a = now();
    for (let k = 0; k < 5; k++) tilesFor(w, map, key + "#" + k);
    const us = (now() - a) / 5;
    sum += us;
    const t = tilesFor(w, map, key)!;
    const u0 = now();
    for (let k = 0; k < 5; k++) lcd.under({}, t.ids, t.pal, t.pw, t.ph);
    const und = (now() - u0) / 5;
    const b = now();
    for (let k = 0; k < 5; k++) w.atlasFor(map.def);
    const atl = (now() - b) / 5;
    console.log(`[gt] ${id} ${map.width}x${map.height}: ${(us / 1000).toFixed(2)} ms (atlasFor ${(atl / 1000).toFixed(2)} ms, under ${(und / 1000).toFixed(2)} ms)`);
  }
  console.log(`[gt] mean ${(sum / names.length / 1000).toFixed(2)} ms`);
};
