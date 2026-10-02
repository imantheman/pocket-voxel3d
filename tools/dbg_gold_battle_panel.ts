// Debug: the bottom screen's battle page by touch (bun
// tools/dbg_gold_battle_panel.ts) -- a wild battle, A through its text, then
// FIGHT tapped, the first move tapped, and the battle's phase printed after
// each, as the companion would see the finger on the 3DS (touch is called
// after each step, as gen2/main.ts calls it).
import { RecorderHost } from "../voxelmon/game/host.ts";
import { useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Companion } from "../voxelmon/game/gen2/ui/Companion.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { Battle } from "../voxelmon/game/gen2/battle/Battle.ts";
import { Screens } from "../voxelmon/game/gen2/shared/ui/Screens.ts";

useGoldGen();
const game: any = Game2.new();
game.load({ startWorld: true });
const host = new RecorderHost();
const lcd = new Lcd(host);
const panel = new Companion(host, []);
let finger: [number, number] | null = null;
const step = (b = 0): void => {
  game.frame(b);
  game.draw(lcd);
  lcd.end();
  panel.touch(game, finger ? finger[0] : 0, finger ? finger[1] : 0, finger !== null);
  panel.frame(game);
};
const perfect = () => ({ attack: 15, defense: 15, speed: 15, special: 15 });
game.world.setMap("ROUTE_29", 30, 10, "down");
for (let i = 0; i < 30; i++) step();
game.save.party = [Mon.new(game.data, "CYNDAQUIL", 30, { dvs: perfect() })];
const wild: any = Mon.new(game.data, "SENTRET", 3, { dvs: perfect() });
const battle: any = Battle.new({ data: game.data, party: game.save.party, wild, save: game.save });
Screens.push(game, "Gen2BattleState", { battle, save: game.save, onDone: () => game.stack.pop() });
const st = game.stack.top();
/** A tap at bottom-screen cell (cx, cy): down a few steps, then up. */
const tap = (cx: number, cy: number): void => {
  finger = [cx * 16 + 8, cy * 16 + 8];
  step();
  step();
  finger = null;
  step();
  step();
};
// the intro's text: taps anywhere (A)
for (let k = 0; k < 40 && st.phase !== "menu"; k++) {
  for (let i = 0; i < 20; i++) step();
  tap(10, 3);
}
console.log("phase after intro taps:", st.phase, "menuIndex", st.menuIndex);
{
  tap(4, 9); // FIGHT
  console.log("after FIGHT tap: phase", st.phase, "moveIndex", st.moveIndex);
}
if (st.phase === "moves") {
  tap(0, 0); // BACK
  console.log("after BACK tap: phase", st.phase);
  tap(4, 9);
  tap(5, 8); // the first move
  console.log("after the first move's tap: phase", st.phase);
}
// through the turn's text to the menu again, then RUN's box
for (let k = 0; k < 60 && st.phase !== "menu"; k++) {
  for (let i = 0; i < 20; i++) step();
  tap(10, 3);
}
console.log("back on the menu:", st.phase);
tap(15, 13);
console.log("after a tap on RUN's box: phase", st.phase, "menuIndex", st.menuIndex);
