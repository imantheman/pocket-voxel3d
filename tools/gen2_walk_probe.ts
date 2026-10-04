// A Citra probe of the Gen 2 overworld walk: the card's save continued, then
// the d-pad held from inside the guest (Citra's posted keys arrive only now
// and then, so a walk test cannot lean on them), with one line every half
// second in pvlog: where the player is, the buttons that went in, the free
// walk, and anything on top. Then a SAVE through the game's own Save.save.
// Built in place of game-gold.js by cc_gold_bench.sh; never shipped.
import "../voxelmon/game/gen2/main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";

const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;
let n = 0;
let started = false;
// [first tick, last tick, button]
const PLAN: [number, number, number][] = [
  [150, 170, VOX_BTN.down], [200, 220, VOX_BTN.down],
  [260, 280, VOX_BTN.right], [320, 340, VOX_BTN.right],
  [380, 400, VOX_BTN.up], [440, 460, VOX_BTN.left],
];

g.frame = (b: number): void => {
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
  }
  n++;
  let pad = 0;
  for (const [a, z, btn] of PLAN) if (n >= a && n <= z) pad = btn;
  mainFrame((b & ~0xff) | pad);
  if (n === 520) {
    game.snapshotSave?.();
    const [ok, err] = Save.save(game.save);
    console.log(`[pv] probe: saved ${ok ? "ok" : err}`);
  }
  if (n % 30 !== 0 || n > 560) return;
  const w = game.world;
  const p = w?.player;
  const top = game.stack.top();
  console.log(`[pv] probe: t${n} ${w?.map?.id ?? "-"} cell (${p?.cellX},${p?.cellY}) facing ${p?.facing} pad ${pad}`
    + ` yaw ${game.camYaw?.toFixed?.(2)} free ${!!w?.freeMoveActive?.()} top ${top?.screenId ?? top?.constructor?.name ?? "-"}`
    + ` vm ${!!w?.vm?.running?.()} busy ${!!w?.busy?.()} state ${w?.playerState}`);
};
