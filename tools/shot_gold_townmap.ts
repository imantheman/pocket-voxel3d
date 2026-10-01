// The POKeGEAR's town map (its _TownMap mode) drawn to a PNG, to see what a
// bottom-screen MAP page would show (bun tools/shot_gold_townmap.ts OUT [MAP x y])
import { useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { shotLcd, useGoldTiles } from "../voxelmon/game/gen2/platform/shot-node.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { resetDrawState, setLcd } from "../voxelmon/game/gen2/platform/screen.ts";
import { Pokegear } from "../voxelmon/game/gen2/ui/Pokegear.ts";

useGoldGen();
useGoldTiles();
const [out = ".", id, xs, ys] = process.argv.slice(2);
const game: any = Game2.new();
game.load({ startWorld: true });
if (id) game.world.setMap(id, Number(xs ?? 5), Number(ys ?? 5), "down");
const lcd = new Lcd(new RecorderHost());
const pg = Pokegear.new(game, { townMap: true });
setLcd(lcd);
lcd.begin();
resetDrawState();
lcd.shown = true;
pg.draw();
shotLcd(lcd.s, `${out}/townmap_${id ?? "start"}.png`, 2);
console.log("wrote");
