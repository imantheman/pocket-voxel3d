// Gold's bottom screen, each page to a PNG (bun tools/shot_gold_companion.ts OUTDIR)
// -- a party, some badges, a POKeDEX, then taps on the tabs and a mon.
import { useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { shotLcd, useGoldTiles } from "../voxelmon/game/gen2/platform/shot-node.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { Companion } from "../voxelmon/game/gen2/ui/Companion.ts";

useGoldGen();
useGoldTiles();
const out = process.argv[2] ?? ".";
const game: any = Game2.new();
game.load({ startWorld: true });
const lead = Mon.new(game.data, "TYPHLOSION", 54, {});
lead.hp = Math.floor(lead.hp / 3);
const egg: any = Mon.new(game.data, "TOGEPI", 5, {});
egg.isEgg = true;
const sick: any = Mon.new(game.data, "FERALIGATR", 40, {});
sick.status = "psn";
game.save.party = [lead, sick, Mon.new(game.data, "PIDGEOTTO", 22, {}), egg];
game.save.player.johtoBadges = { ZEPHYR: true, HIVE: true, PLAIN: true, FOG: true };
game.save.player.kantoBadges = { THUNDER: true };
game.save.pokedex = { caught: { 1: true, 155: true, 158: true }, seen: { 1: true, 2: true, 155: true, 158: true, 16: true } };
game.save.playTime = { hours: 12, minutes: 7 };
const noop = (): void => {};
const host: any = {
  lcdTarget: noop, lcdCells: noop, lcdShow: noop, lcdBank: noop, lcdReset: noop,
  lcdRegs: noop, lcdObjs: noop, lcdPals: noop, lcdLines: noop,
};
const c = new Companion(host, []);
const shot = (name: string): void => {
  for (let i = 0; i < 20; i++) c.frame(game);
  shotLcd((c as any).lcd.s, `${out}/companion_${name}.png`, 2);
};
const tap = (cx: number, cy: number): void => {
  c.touch(game, cx * 16 + 8, cy * 16 + 8, true);
  c.touch(game, 0, 0, false);
};
shot("party");
tap(3, 2);
shot("mon1");
tap(3, 6);
shot("mon2");
tap(9, 14);
shot("badges");
tap(17, 14);
shot("card");
console.log("wrote", out);
