// Gold map tour: a headless boot into the world, then a warp into every map
// (onto its first warp tile, or the middle), a few seconds of frames there,
// and a report of every map that threw, logged an error, or failed to load.
//   bun tools/gold_tour_maps.ts [frames-per-map]
import { RecorderHost } from "../voxelmon/game/host.ts";
import { useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Logger } from "../voxelmon/game/gen2/shared/core/Logger.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";

useGoldGen();
const perMap = Number(process.argv[2] ?? 180);
const errors: string[] = [];
const prevSink = Logger.sink;
Logger.sink = (line: string) => {
  if (/error/i.test(line)) errors.push(line);
};
const game: any = Game2.new();
game.load();
const lcd = new Lcd(new RecorderHost());
const step = (b = 0) => {
  game.frame(b);
  game.draw(lcd);
  lcd.end();
};
for (let f = 0; f < 7000 && !game.world?.map; f++) step(f % 40 === 0 ? 16 : 0);
const perfect = () => ({ attack: 15, defense: 15, speed: 15, special: 15 });
game.save.party = [Mon.new(game.data, "TYPHLOSION", 50, { dvs: perfect() })];
const world = game.world;
const ids = Object.keys(world.maps).sort();
const bad: { id: string; why: string }[] = [];
let ok = 0;
const t0 = performance.now();
for (const id of ids) {
  const def = world.maps[id];
  const w = def.warps?.[0];
  const x = w ? w.x : Math.floor((def.width ?? 10));
  const y = w ? w.y : Math.floor((def.height ?? 10));
  errors.length = 0;
  try {
    game.stack.clear();
    const res = world.warpToMapId(id, x, y, "down");
    if (!res) {
      bad.push({ id, why: "warpToMapId returned false" });
      continue;
    }
    // A press of B now and then dismisses any text a map script raises.
    for (let f = 0; f < perMap; f++) step(f % 30 === 15 ? 32 : 0);
    if (world.map?.id !== id && !game.stack.top()) {
      // left on its own (a script warp): fine, but say so
      bad.push({ id, why: `ended on ${world.map?.id}` });
    } else if (errors.length) {
      bad.push({ id, why: errors.slice(0, 2).join(" | ").slice(0, 300) });
    } else {
      ok++;
    }
  } catch (e) {
    bad.push({ id, why: `THREW ${String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join(" / ").slice(0, 300)}` });
  }
}
Logger.sink = prevSink;
console.log(`${ids.length} maps in ${((performance.now() - t0) / 1000).toFixed(0)} s: ${ok} clean, ${bad.length} flagged`);
for (const b of bad) console.log(`  ${b.id}: ${b.why}`);
