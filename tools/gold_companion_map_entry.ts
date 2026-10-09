// A Citra check of the cost of Gold's bottom-screen pages (kfix bench;
// cc_gold_bench.sh-style, bundled in place of game-gold.js): the card's save
// continued in 3D, the panel's PARTY page and then its MAP page (the tab
// tapped through the touch bits), each fifteen seconds standing and fifteen
// walking up and down (the host's perf line comes every five), and a shot of
// the MAP page. Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";

const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;
const SPAN = 15 * 60;
/** A held touch at bottom-screen pixel (x, y), as the host packs it. */
const touch = (x: number, y: number): number => 0x100 | ((x >> 1) << 9) | ((y >> 1) << 17);
const PHASES = ["party", "party walking", "map", "map walking"];
let started = false;
let t = -1;
let said = "";

g.frame = (_b: number): void => {
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
    game.options.view = "3d";
  }
  let b = 0;
  if (game.world?.map) t++;
  if (t >= 0) {
    const k = Math.min(PHASES.length - 1, Math.floor(t / SPAN));
    const phase = PHASES[k]!;
    if (phase !== said) {
      console.log(`[pv] kfix: companion ${phase} from tick ${t}`);
      said = phase;
    }
    // the MAP tab (row 14, columns 17-19 of the 2x panel), tapped as the
    // MAP phases begin: down four frames, then up
    const into = t - 2 * SPAN;
    if (into >= 0 && into < 4) b |= touch(290, 230);
    if (into === 120) native.screenshot?.();
    if (phase.endsWith("walking")) b |= Math.floor(t / 64) % 2 ? VOX_BTN.up : VOX_BTN.down;
  }
  mainFrame(b);
};
