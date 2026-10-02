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
import { Input } from "../voxelmon/game/gen2/shared/core/Input.ts";

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
// staged as the 3DS stages it (battlestage.ts), so the screens the battle
// opens go to the bottom screen
st.staged3d = true;
/** A tap on tile (tx, ty) of the bottom screen in whole mode (lcdTall). */
const tapTall = (tx: number, ty: number): void => {
  finger = [27 + (tx * 8 + 4) * (240 / 144), (ty * 8 + 4) * (240 / 144)];
  step();
  step();
  finger = null;
  step();
  step();
};
const topId = (): string => game.stack.top()?.screenId ?? "-";
// the intro's text: taps anywhere (A)
for (let k = 0; k < 40 && st.phase !== "menu"; k++) {
  for (let i = 0; i < 20; i++) step();
  tap(10, 3);
}
console.log("phase after intro taps:", st.phase, "menuIndex", st.menuIndex);
// <PK><MN>: the party on the bottom screen, the top keeping the battle
tap(15, 9);
for (let i = 0; i < 10; i++) step();
console.log("after the <PK><MN> tap: top", topId(), "routed", !!game.stagedBattleBelow(), "bottom tall", (panel as any).lcd.tall);
tapTall(5, 1); // the first mon: its SWITCH / STATS / CANCEL
for (let i = 0; i < 10; i++) step();
console.log("after the first mon's tap: submenu", JSON.stringify(game.stack.top()?.submenu?.items?.map((x: any) => x.id)));
tapTall(13, 16); // CANCEL in the submenu (the third line)
for (let i = 0; i < 10; i++) step();
console.log("after the submenu's CANCEL: top", topId(), "phase", st.phase);
// PACK: open, then its top rows close it
if (st.phase === "menu") {
  tap(4, 13);
  for (let i = 0; i < 10; i++) step();
  console.log("after the PACK tap: top", topId(), "routed", !!game.stagedBattleBelow());
  tapTall(10, 0);
  for (let i = 0; i < 10; i++) step();
  console.log("after the PACK's top-row tap: top", topId(), "phase", st.phase, "bottom tall", (panel as any).lcd.tall);
}
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
// last (it leaves the battle in a hand-made state): the level-up stats box
// and the forget list, put up by hand: drawn on the
// bottom screen whole, a tap on a move's row moving the forget cursor
{
  const save = { phase: st.phase, timer: st.messageTimer };
  st.phase = "stats-box";
  st.statsBoxMon = game.save.party[0];
  for (let i = 0; i < 4; i++) step();
  console.log("stats box: bottom tall", (panel as any).lcd.tall);
  st.phase = "choose-forget";
  st.messageTimer = 0;
  st.forgetIndex = 1;
  for (let i = 0; i < 4; i++) step();
  console.log("forget list: bottom tall", (panel as any).lcd.tall);
  // the finger down and up on the panel alone (no game step: the hand-made
  // phase has no learn behind it), then the press it queued taken back
  panel.touch(game, 27 + (8 * 8 + 4) * (240 / 144), (6 * 8 + 4) * (240 / 144), true);
  panel.touch(game, 0, 0, false);
  console.log("after a tap on the second move's row: forgetIndex", st.forgetIndex, "pressed", JSON.stringify(Input.pressQueue));
  panel.touch(game, 0, 0, false);
  Input.pressQueue.length = 0;
  st.phase = save.phase;
  st.messageTimer = save.timer;
  for (let i = 0; i < 4; i++) step();
  console.log("back:", st.phase, "bottom tall", (panel as any).lcd.tall);
}
