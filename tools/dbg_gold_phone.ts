// Debug: a special phone call (bun tools/dbg_gold_phone.ts [id=5 SSTICKET]) --
// queued, a step taken, every page of the call printed.
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Phone } from "../voxelmon/game/gen2/core/Phone.ts";

useGoldGen();
const game: any = Game2.new();
game.load({ startWorld: true });
const lcd = new Lcd(new RecorderHost());
const step = (b = 0) => { game.frame(b); game.draw(lcd); lcd.end(); };
const w = game.world;
w.setMap("NEW_BARK_TOWN", 13, 6, "down");
for (let i = 0; i < 30; i++) step(0);
Phone.queueSpecialCall(game.save, Number(process.argv[2] ?? 5));
let last = "";
for (let f = 0; f < 3000; f++) {
  const top = game.stack.top();
  const pages = top?.isTextBox ? (top.pages ?? top.text) : undefined;
  const t = pages ? JSON.stringify(Array.isArray(pages) ? pages[(top.pageIndex ?? 1) - 1] ?? pages : pages) : "";
  if (t && t !== last) console.log(f, "page", top.pageIndex, t);
  last = t;
  const busy = w.busy() || !!top;
  step(busy ? (f % 12 === 0 ? VOX_BTN.a : 0) : (f < 200 ? (f % 40 < 8 ? VOX_BTN.down : 0) : 0));
  if (f > 300 && !busy && last === "") break;
}
console.log("special now", Phone.specialCallVar(game.save));
