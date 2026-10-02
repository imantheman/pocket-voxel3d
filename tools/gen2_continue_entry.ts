// A Citra check of the way a Gen 2 game is started (GAME=silver
// cc_gold_bench.sh tools/gen2_continue_entry.ts): the real boot, START
// through the copyright and intro, START on the title, CONTINUE and A on the
// main menu, then a top-screen shot once the world has been up a while --
// the voxel world must come back after the title stood it down (flatWorld).
// Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";

const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;
let n = 0;
let last = "";
let worldAt = 0;
let shot = false;

g.frame = (b: number): void => {
  n++;
  let pad = 0;
  const top = game.stack.top();
  const id = String(top?.screenId ?? (game.world?.map ? `world:${game.world.map.id}` : "-"));
  if (id !== last) {
    last = id;
    console.log(`[pv] bench continue: ${id} tick ${n}`);
    if (id.startsWith("world:") && !worldAt) worldAt = n;
  }
  if (!worldAt) {
    // START through the intro and the title; A on the main menu (CONTINUE
    // is its first row) and on the save panel that follows
    if (n % 40 === 0) pad = top?.screenId === "Gen2MainMenu" ? VOX_BTN.a : VOX_BTN.start;
  } else if (!shot && n - worldAt === 240) {
    shot = true;
    console.log("[pv] bench continue: shot");
    native.screenshot?.();
  }
  mainFrame((b & ~0xff) | pad);
};
