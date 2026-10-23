// Test tool, not shipped: saves made and read the way this port does, for
// tools/pvsync/pc_e2e.sh.
//
//   bun tools/pvsync/saves.ts make  <genDir> <game> <out.lua> <version|-> <name>
//       a new game's save as this port writes it, `version` overridden
//       ("-": as the game writes it), the player named <name>
//   bun tools/pvsync/saves.ts check <genDir> <game> <save.lua>
//       CONTINUE on that save in this port, then SAVE: prints the version
//       loaded and the version written
import { readFileSync } from "node:fs";
import { VOX_BTN } from "../../contracts/spec/voxel-spec.ts";
import { loadRuntimeData } from "../../voxelmon/game/data.ts";
import { VoxelmonGame } from "../../voxelmon/game/game.ts";
import { RecorderHost } from "../../voxelmon/game/host.ts";
import { encodeSave } from "../../voxelmon/game/save-lua.ts";
import { decodeSave } from "../../voxelmon/game/save-read.ts";
import { toDisk } from "../../voxelmon/game/savecompat.ts";

const [cmd, dir, game, file, version, name] = process.argv.slice(2);
const data = await loadRuntimeData(dir!);
(data as { version?: string }).version ??= game;

class Card extends RecorderHost {
  card: string | undefined;
  written: string | undefined;
  saveData(): string | undefined { return this.card; }
  saveWrite(t: string): boolean { this.card = t; this.written = t; return true; }
}

if (cmd === "make") {
  const g = new VoxelmonGame(data, new RecorderHost(), 1);
  g.newGame();
  const s: any = JSON.parse(JSON.stringify(g.save));
  s.player.name = name ?? "TEST";
  s.player.map = "PALLET_TOWN"; s.player.x = 5; s.player.y = 6;
  s.money = 1234;
  if (version && version !== "-") s.version = version;
  await Bun.write(file!, encodeSave(toDisk(s)));
  console.log(`made ${file} version=${s.version} name=${s.player.name}`);
} else if (cmd === "check") {
  const host = new Card();
  host.card = readFileSync(file!, "utf8");
  const g = new VoxelmonGame(data, host, 1);
  g.newGame();
  for (let k = 0; k < 400 && (g as any).title()?.phase !== "menu"; k++) g.tick(k % 8 === 0 ? VOX_BTN.start : 0);
  g.tick(0);
  if ((g as any).title()?.menu?.[0] !== "CONTINUE") throw new Error("no CONTINUE");
  g.tick(VOX_BTN.a);
  g.tick(0);
  const s: any = g.save;
  console.log(`loaded name=${s.player?.name} version=${s.version}`);
  g.writeSave();
  console.log(`saved version=${(decodeSave(host.written ?? "") as any).version}`);
}
