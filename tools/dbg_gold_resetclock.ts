// Debug: the clock-reset screens rendered to PNGs (bun tools/dbg_gold_resetclock.ts <dir>):
// the NO/YES ask, the digits, the restart editor and its "Is this OK?".
import { useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { useGoldTiles, shotLcd } from "../voxelmon/game/gen2/platform/shot-node.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { setLcd } from "../voxelmon/game/gen2/platform/screen.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Screens } from "../voxelmon/game/gen2/shared/ui/Screens.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";

const dir = process.argv[2] ?? "/tmp";
useGoldGen();
useGoldTiles();
const game: any = Game2.new();
const lcd = new Lcd(new RecorderHost());
setLcd(lcd);
game.load({ startWorld: false });
game.stack.clear();
const save: any = { player: { id: 7, name: "GOLD", money: 0 }, rtc: {} };
const run = (n: number, b = 0): void => {
  for (let i = 0; i < n; i++) game.frame(i === 0 ? b : 0);
};
const shot = (name: string): void => {
  game.draw(lcd);
  shotLcd(lcd.s, `${dir}/${name}.png`);
  console.log("shot", name, game.stack.top()?.step);
};

Screens.push(game, "Gen2ResetClock", { mode: "password", save, onDone: () => {} });
run(90);
shot("rc_ask");
run(4, VOX_BTN.down);
run(4, VOX_BTN.a);
run(90);
run(4, VOX_BTN.up);
run(4, VOX_BTN.left);
run(4, VOX_BTN.up);
run(4, VOX_BTN.up);
shot("rc_digits");

game.stack.clear();
Screens.push(game, "Gen2ResetClock", { mode: "restart", save, onDone: () => {} });
for (let i = 0; i < 6 && game.stack.top()?.step !== "edit"; i++) {
  run(90);
  run(4, VOX_BTN.a);
}
run(30);
run(4, VOX_BTN.right);
shot("rc_edit");
run(4, VOX_BTN.a);
run(90);
shot("rc_confirm");
