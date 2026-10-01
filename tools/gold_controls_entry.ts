// A Citra check of Gold's camera-relative walk and free walk
// (cc_gold_bench.sh tools/gold_controls_entry.ts): the card's save continued,
// then the host's button word replaced by a script -- the camera bits a
// C-stick turn would set, and UP held -- with "[pv] controls:" lines saying
// where the player went. Never shipped.
//   0-2 s    stand
//   2-5 s    MOVEMENT GRID, camera a quarter turn round: UP walks east
//   5-8 s    MOVEMENT FREE, camera at 45 degrees: UP walks north-east
//   8-11 s   MOVEMENT FREE, camera straight: UP walks north
import "../voxelmon/game/gen2/main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";

const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;
let started = false;
let n = 0;

/** The camera's yaw in 64ths of a turn as the host packs it (main.rs). */
function camBits(fine64: number): number {
  const e = (fine64 + 8) & 63;
  return ((e >> 4) << 24) | ((e & 15) << 28);
}

function log(what: string): void {
  const p = game.world?.player;
  if (!p) return;
  console.log(`[pv] controls: ${what} ${game.world.map.id} cell ${p.cellX},${p.cellY} px ${p.px.toFixed(1)},${p.py.toFixed(1)} facing ${p.facing} turns ${game.camTurns} yaw ${(game.camYaw ?? -1).toFixed(2)} mv ${game.options?.movement ?? "free"}`);
}

g.frame = (b: number): void => {
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
  }
  n++;
  const s = n / 60;
  let word = b & ~0xff & ~(0xff << 24); // the host's touch bits, no pad, no camera
  if (s >= 2 && s < 5) {
    game.options.movement = "grid";
    word |= VOX_BTN.up | camBits(16);
  } else if (s >= 5 && s < 8) {
    game.options.movement = "free";
    word |= VOX_BTN.up | camBits(8);
  } else if (s >= 8 && s < 11) {
    word |= VOX_BTN.up | camBits(0);
  }
  if (n % 30 === 0 && s < 12) log(`t=${s.toFixed(1)}`);
  mainFrame(word);
};
