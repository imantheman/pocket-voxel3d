// A Citra check of the link record (cc_gold_bench.sh
// tools/gold_linkrecord_entry.ts): the card's save continued, a few battles
// put in its record (in play only), the player put in the Pokecenter 2F and
// the sign's own script run (special DisplayLinkRecord), a shot of the
// screen, then B. Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { LinkRecords } from "../voxelmon/game/gen2/core/LinkRecords.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";

const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;
let started = false;
let n = 0;

g.frame = (b: number): void => {
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
  }
  n++;
  let pad = 0;
  const w = game.world;
  if (w?.map) {
    if (n === 120) {
      for (const [name, id, r] of [["SILVER", 1234, "win"], ["SILVER", 1234, "lose"], ["KRIS", 777, "draw"], ["SILVER", 1234, "win"]] as const) {
        LinkRecords.add(game.save, name, id, r);
      }
      w.warpToMapId("POKECENTER_2F", 7, 4, "up");
    }
    if (n === 240) {
      const key = (w.map.def?.bgEvents ?? [])[0]?.scriptKey;
      console.log(`[pv] bench record: ${w.map.id} sign ${key}`);
      if (key) w.vm.start(key);
    }
    if (n === 330) {
      console.log(`[pv] bench record: top ${game.stack.top()?.screenId ?? "-"}`);
      native.screenshot?.();
    }
    if (n === 360) pad = VOX_BTN.b;
    if (n === 420) console.log(`[pv] bench record: after B top ${game.stack.top()?.screenId ?? "-"} script ${w.vm?.running?.() ? "running" : "done"}`);
  }
  mainFrame((b & ~0xff) | pad);
};
