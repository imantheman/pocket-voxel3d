// A Citra look at a Gen 2 cart's own title screen (GAME=silver
// cc_gold_bench.sh tools/gen2_title_entry.ts): the real boot, START through
// the copyright and the intro movie, then a top-screen shot every two
// seconds while the title plays (Silver: Lugia over the sea). Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";
import { GameVersion } from "../voxelmon/game/gen2/shared/core/GameVersion.ts";

const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;
let n = 0;
let last = "";
let titleAt = 0;
let shots = 0;

g.frame = (b: number): void => {
  n++;
  let pad = 0;
  const top = game.stack.top();
  const id = String(top?.screenId ?? "-");
  if (id !== last) {
    last = id;
    console.log(`[pv] bench title: ${GameVersion.get()} ${id} tick ${n}`);
    if (id === "Gen2TitleState") titleAt = n;
  }
  // START through everything before the title
  if (!titleAt && n % 40 === 0) pad = VOX_BTN.start;
  if (titleAt && shots < 6 && (n - titleAt) % 120 === 60) {
    shots++;
    console.log(`[pv] bench title: shot ${shots - 1}`);
    native.screenshot?.();
  }
  mainFrame((b & ~0xff) | pad);
};
