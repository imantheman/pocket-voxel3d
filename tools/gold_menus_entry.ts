// A Citra profile of Gold's menus (cc_gold_bench.sh tools/gold_menus_entry.ts):
// the card's save continued, then each START menu screen held for twelve
// seconds -- the cursor stepping now and then -- with Gold's own
// step/draw/lcd/view split on ("[pv] gold us/frame") and a "[pv] prof
// scene:" line naming each stop. The POKEGEAR is visited card by card.
// ONLY="3,4" at bundle time picks stops (0-based). Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";

const g = globalThis as unknown as { goldGame: any; goldProf: boolean; frame: (b: number) => void };
g.goldProf = true;
const game = g.goldGame;
const mainFrame = g.frame;

type Stop = { name: string; item?: string; gearCard?: number; step?: number };
const STOPS: Stop[] = [
  { name: "START menu" },
  { name: "POKEDEX", item: "pokedex", step: VOX_BTN.down },
  { name: "PARTY", item: "pokemon", step: VOX_BTN.down },
  { name: "PACK", item: "pack", step: VOX_BTN.down },
  { name: "POKEGEAR card 1", item: "pokegear", gearCard: 1 },
  { name: "POKEGEAR card 2", item: "pokegear", gearCard: 2 },
  { name: "POKEGEAR card 3", item: "pokegear", gearCard: 3 },
  { name: "POKEGEAR card 4", item: "pokegear", gearCard: 4 },
  { name: "TRAINER CARD", item: "status" },
  { name: "OPTION", item: "option", step: VOX_BTN.down },
];
declare const ONLY: string;
const stops = typeof ONLY !== "undefined" ? ONLY.split(",").map((i) => STOPS[Number(i)]!).filter(Boolean) : STOPS;
const STOP_TICKS = 12 * 60;
let started = false;
let n = 0;
let at = -1;

function arrive(s: Stop): void {
  console.log(`[pv] prof scene: ${s.name}`);
  while (game.stack.top()) game.stack.pop();
  game.openStartMenu();
  if (s.item) game.pushStartMenuItem(s.item);
  if (s.gearCard) {
    const gear = game.stack.top();
    const cards = gear?.cards?.length ?? 0;
    console.log(`[pv] prof gear: ${gear?.screenId} cards ${cards}`);
    if (gear && cards > 0) gear.cardIndex = Math.min(s.gearCard, cards);
  }
}

g.frame = (b: number): void => {
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
  }
  n++;
  let pad = 0;
  if (game.world?.map && n >= 180) {
    const k = Math.floor((n - 180) / STOP_TICKS);
    if (k !== at && k < stops.length) {
      at = k;
      arrive(stops[k]!);
    }
    const s = stops[at];
    if (s?.step && n % 45 === 0) pad = s.step;
  }
  mainFrame((b & ~0xff) | pad);
};
