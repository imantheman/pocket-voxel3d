// Which rows of a map walk straight off its west edge (holding left from x):
// for placing a bench walk. Bundle and run in tools/qjs_gold_harness.c.
// Never shipped.
import { native } from "../voxelmon/game/quickjs-host.ts";
import { readGen2Container } from "../voxelmon/game/gen2/platform/container.ts";
import { setGen2Source } from "../voxelmon/game/gen2/platform/data.ts";
import { seed } from "../voxelmon/game/gen2/platform/rng.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { setSaveIo } from "../voxelmon/game/gen2/platform/saveio.ts";

setGen2Source(readGen2Container(native.gamedata()));
seed(17);
// the card's save when the harness has one (GOLD_SAVE): past the story's
// early fences
const nat = native as any;
setSaveIo({ read: () => nat.saveData?.() ?? undefined, write: () => true });
const game: any = Game2.new();
const [save] = Save.load();
console.log(`[walk] save: ${save ? "loaded" : "none"}`);
if (save) {
  game.load();
  game.continueGame(save);
} else game.load({ startWorld: true });
declare const MAP: string;
declare const X: number;
let y = 2;
let f = 0;
(globalThis as any).frame = (): void => {
  if (y > 17) return;
  if (f === 0) game.world.warpToMapId(MAP, X, y, "left");
  game.frame(f > 30 ? VOX_BTN.left : 0);
  f++;
  if (f === 700) {
    const p = game.world.player;
    console.log(`[walk] y ${y}: ended on ${game.world.map?.id} at ${p?.cellX},${p?.cellY}`);
    y++;
    f = 0;
  }
};
