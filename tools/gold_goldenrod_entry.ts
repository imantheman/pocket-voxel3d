// A Citra check of walking into Goldenrod City (cc_gold_bench.sh
// tools/gold_goldenrod_entry.ts): the card's save continued, the player put
// on Route 34 a few steps below the city and walked north across the seam,
// then on up the street; a top-screen shot at intervals. Isaac's hardware
// showed the city mostly missing (2026-10-02). Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";

const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;
let started = false;
let n = 0;
let placed = 0;
let lastMap = "";
let shots = 0;

g.frame = (b: number): void => {
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
    game.options.view = "3d";
  }
  n++;
  let pad = 0;
  const w = game.world;
  if (w?.map) {
    if (!placed && n >= 120) {
      placed = n;
      const def = w.maps?.ROUTE_34;
      console.log(`[pv] bench goldenrod: ROUTE_34 ${def?.width}x${def?.height} connections ${JSON.stringify(Object.keys(def?.connections ?? {}))}`);
      // Goldenrod's south edge meets Route 34's north edge
      w.warpToMapId("ROUTE_34", 13, 3, "up");
    }
    if (w.map.id !== lastMap) {
      lastMap = w.map.id;
      console.log(`[pv] bench goldenrod: ${w.map.id} at (${w.player?.cellX},${w.player?.cellY}) tick ${n}`);
    }
    if (placed && n > placed + 90 && n < placed + 90 + 600) {
      const t = n - placed - 90;
      if (t < 300 && !game.stack.top()) pad = VOX_BTN.up;
      if (t % 90 === 45 && shots < 6) {
        shots++;
        console.log(`[pv] bench goldenrod: shot ${shots - 1} at ${w.map.id} (${w.player?.cellX},${w.player?.cellY})`);
        native.screenshot?.();
      }
    }
  }
  mainFrame((b & ~0xff) | pad);
};
