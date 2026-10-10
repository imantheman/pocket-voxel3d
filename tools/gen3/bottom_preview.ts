// FireRed's bottom screen (voxelmon/game/gen3/ui/bottom_screen.ts) on the
// desktop: a new game on the reference cache (DesktopHost), a party, items
// and badges given, then each tab drawn into its canvas and saved as a PNG
// (320x240), in the field and in a wild battle, with the top screen beside it.
//   bun tools/gen3/bottom_preview.ts [outDir=/tmp/g3bottom]
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setHost } from "../../voxelmon/game/gen3/platform/host.ts";
import { DesktopHost } from "../../voxelmon/game/gen3/platform/desktop.ts";
import { G } from "../../voxelmon/game/gen3/platform/graphics.ts";
import { setSaveStore, memorySaveStore } from "../../voxelmon/game/gen3/platform/savefs.ts";
import { setAudio, silentAudio } from "../../voxelmon/game/gen3/platform/audio.ts";
import { encodePng } from "../../voxelmon/import/gen3/png.ts";

const OUT = process.argv[2] ?? "/tmp/g3bottom";
mkdirSync(OUT, { recursive: true });
const host = new DesktopHost(join(homedir(), "gen3ref/frfull"));
setHost(host);
setSaveStore(memorySaveStore());
setAudio(silentAudio());

const { Game3 } = await import("../../voxelmon/game/gen3/core/Game3.ts");
const { Input } = await import("../../voxelmon/game/gen3/shared/core/Input.ts");
const { Runtime } = await import("../../voxelmon/game/gen3/core/runtime.ts");
const { Party } = await import("../../voxelmon/game/gen3/core/party.ts");
const { Bag } = await import("../../voxelmon/game/gen3/core/bag.ts");
const { Flags } = await import("../../voxelmon/game/gen3/core/scripting/flags.ts");
const { Space } = await import("../../voxelmon/game/gen3/core/scripting/space.ts");
const { BattleBridge } = await import("../../voxelmon/game/gen3/core/battle_bridge.ts");
const { BottomScreen } = await import("../../voxelmon/game/gen3/ui/bottom_screen.ts");

const game: any = Game3.new();
game.load({});
const map = process.env.PV_MAP ?? "FR_VIRIDIAN_CITY";
game._handleBootAction({ action: "new_game", name: "RED", rivalName: "BLUE", gender: Number(process.env.PV_GENDER ?? 0), start: { map, x: 20, y: 20, facing: "down" } });
const s = Runtime.getSession();
for (const [sp, lv] of [[6, 36], [3, 32], [9, 34], [25, 26], [94, 30], [143, 29]]) (Party as any).giveMon(s, sp, lv);
s.party[2].hp = Math.floor(s.party[2].maxHp * 0.4);
s.party[3].status = 0x08; // poisoned
s.party[5].hp = 0;
s.party[6].hp = Math.floor(s.party[6].maxHp * 0.15);
for (const [id, q] of [[13, 5], [17, 3], [4, 12], [3, 2], [86, 1], [20, 4], [26, 2], [28, 6], [14, 1]]) (Bag as any).add(s.bag, id, q);
for (let b = 0; b < 5; b++) (Flags as any).setFlag((Space as any).store, null, 0x820 + b, true);
(Flags as any).setFlag((Space as any).store, null, 0x828, true);
(Flags as any).setFlag((Space as any).store, null, 0x829, true);
s.money = 12345;
s.playTime = { hours: 12, minutes: 34, seconds: 0 };

let frames = 0;
function pump(k: number): void {
  for (let i = 0; i < k; i++) {
    (Input as any).hostButtons(0);
    BottomScreen.input(0);
    game.update(1 / 60);
    G.beginFrame();
    game.draw();
    BottomScreen.frame(game);
    G.endFrame();
    frames++;
  }
}
function shot(tag: string): void {
  const id = BottomScreen.canvasId();
  const t = host.raster.tex.get(id);
  if (!t) { console.log(`${tag}: no canvas`); return; }
  writeFileSync(`${OUT}/${tag}_b.png`, encodePng(t.w, t.h, t.px));
  writeFileSync(`${OUT}/${tag}_t.png`, encodePng(240, 160, host.pixels()));
  console.log(`${tag}: ${OUT}/${tag}_b.png (redraws ${BottomScreen.redraws})`);
}

pump(240);
for (const t of ["party", "bag", "map", "card"] as const) {
  BottomScreen.setTab(t);
  pump(20);
  shot(`field_${t}`);
}
// the bag's next pocket and a row touched (taps as the finger lifts)
BottomScreen.setTab("bag");
const tap = (x: number, y: number): void => {
  BottomScreen.input(0x100 | ((x >> 1) << 9) | ((y >> 1) << 17));
  BottomScreen.input(0);
  pump(10);
};
tap(40 + 100, 28 + 10 + 16 * 2 + 4);
shot("field_bag_row3");
tap(40 + 70, 28 + 60);
shot("field_bag_pocket2");
tap(250, 220);
shot("field_tap_map");
BottomScreen.setTab("party");
(BattleBridge as any).startWild(Runtime._mod, game, { species: 16, level: 4 }, {});
pump(400);
shot("battle_party");
BottomScreen.setTab("map");
pump(20);
shot("battle_map");
console.log(`${frames} frames`);
