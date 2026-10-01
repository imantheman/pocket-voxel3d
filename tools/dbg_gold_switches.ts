// Debug: the Goldenrod Underground switches -- flip some, print the room,
// leave and come back, print it again (bun tools/dbg_gold_switches.ts 1 2)
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { FlagNames } from "../voxelmon/game/gen2/core/FlagNames.ts";

useGoldGen();
const game: any = Game2.new();
game.load({ startWorld: true });
const lcd = new Lcd(new RecorderHost());
const step = (b = 0) => { game.frame(b); game.draw(lcd); lcd.end(); };
const w = game.world;
const ROOM = "GOLDENROD_UNDERGROUND_SWITCH_ROOM_ENTRANCES";
for (const f of ["EVENT_USED_BASEMENT_KEY", "EVENT_RIVAL_GOLDENROD_UNDERGROUND"]) w.events.set(FlagNames.events[f], true);
const SW: Record<string, [number, number]> = { "1": [16, 2], "2": [10, 2], "3": [2, 2], e: [20, 12] };
const board = (what: string) => {
  const ev = [...Array(11)].map((_, i) => (w.events.get(727 + i) ? 1 : 0)).join("");
  console.log(`-- ${what}: ${w.map.id} doors 727.. ${ev}`);
  for (let y = 0; y < 14; y++) {
    let r = "";
    for (let x = 0; x < w.map.widthCells; x++) r += w.player.cellX === x && w.player.cellY === y ? "@" : w.map.isWalkable(x, y) ? "." : "#";
    console.log(r);
  }
};
const settle = () => { for (let i = 0; i < 600; i++) step(i % 10 === 0 && (w.busy() || game.stack.top()) ? VOX_BTN.a : 0); };
for (const s of process.argv.slice(2)) {
  const [x, y] = SW[s]!;
  w.setMap(ROOM, x, y, s === "e" ? "left" : "up");
  for (let i = 0; i < 30; i++) step(0);
  step(VOX_BTN.a);
  settle();
}
board("switched");
w.setMap("GOLDENROD_UNDERGROUND_WAREHOUSE", 2, 11, "down");
for (let i = 0; i < 60; i++) step(0);
w.setMap(ROOM, 22, 11, "up");
for (let i = 0; i < 60; i++) step(0);
board("back");
