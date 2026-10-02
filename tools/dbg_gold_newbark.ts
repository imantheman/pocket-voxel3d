// Debug: leaving New Bark Town west with no POKeMON yet (bun
// tools/dbg_gold_newbark.ts [2d]) -- the teacher's stop-you scene -- each
// page, screen and map change printed. Isaac's report: a save from before
// the starter crashed to the HOME Menu leaving the town.
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";

useGoldGen();
const game: any = Game2.new();
game.load({ startWorld: true });
if (process.argv[2] === "2d") game.options.view = "2d";
const lcd = new Lcd(new RecorderHost());
const step = (b = 0) => { game.frame(b); game.draw(lcd); lcd.end(); };
const w = game.world;
w.setMap("NEW_BARK_TOWN", 3, 8, "left");
for (let i = 0; i < 30; i++) step(0);
let last = "";
let lastTop = "";
let lastMap = "";
let lastCell = "";
for (let f = 0; f < 4000; f++) {
  const top = game.stack.top();
  const topId = top?.screenId ?? "world";
  if (topId !== lastTop) console.log(f, "top", topId);
  lastTop = topId;
  if (w.map.id !== lastMap) console.log(f, "map", w.map.id);
  lastMap = w.map.id;
  const cell = `${w.player.cellX},${w.player.cellY}`;
  if (cell !== lastCell) console.log(f, "cell", cell);
  lastCell = cell;
  const pages = top?.isTextBox ? (top.pages ?? top.text) : undefined;
  const t = pages ? JSON.stringify(Array.isArray(pages) ? pages[(top.pageIndex ?? 1) - 1] ?? pages : pages) : "";
  if (t && t !== last) console.log(f, "page", top.pageIndex, t);
  last = t;
  const busy = w.busy() || !!top;
  try {
    step(busy ? (f % 12 === 0 ? VOX_BTN.a : 0) : VOX_BTN.left);
  } catch (e) {
    console.log(f, "THROW", e instanceof Error ? e.stack : e);
    break;
  }
}
