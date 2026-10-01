// Debug: STRENGTH pushes on a map, driven through the real input path, the
// board printed after each (bun tools/dbg_gold_strength.ts MAP x y facing pushes...)
// e.g. CIANWOOD_GYM 4 8 up up up
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";

useGoldGen();
const game: any = Game2.new();
game.load({ startWorld: true });
const lcd = new Lcd(new RecorderHost());
const step = (b = 0) => { game.frame(b); game.draw(lcd); lcd.end(); };
const [id, xs, ys, face, ...pushes] = process.argv.slice(2);
const lead = Mon.new(game.data, "TYPHLOSION", 100, {});
lead.moves[3] = { id: "STRENGTH", pp: 15, ppUps: 0 };
game.save.party = [lead];
// every badge, so no field move is refused for want of one
for (const b of Object.values<any>(require("../voxelmon/game/gen2/world/FieldMoves.ts").FieldMoves.BADGE_FLAG)) {
  game.save.player[b.store] = game.save.player[b.store] ?? {};
  game.save.player[b.store][b.name] = true;
}
const w = game.world;
w.setMap(id, Number(xs), Number(ys), face ?? "up");
for (let i = 0; i < 30; i++) step(0);
const BTN: Record<string, number> = { up: VOX_BTN.up, down: VOX_BTN.down, left: VOX_BTN.left, right: VOX_BTN.right };
const board = () => {
  const p = w.player;
  const rows: string[] = [];
  for (let y = 0; y < w.map.heightCells; y++) {
    let r = "";
    for (let x = 0; x < w.map.widthCells; x++) {
      const n = w.npcAt(x, y);
      r += p.cellX === x && p.cellY === y ? "@" : n ? (n.def?.sprite === "SPRITE_BOULDER" ? "O" : "N") : w.map.isWalkable(x, y) ? "." : "#";
    }
    rows.push(r);
  }
  console.log(rows.join("\n"));
};
board();
// A at the boulder ahead: "use STRENGTH?" YES
step(VOX_BTN.a);
for (let i = 0; i < 400; i++) step(i % 8 === 0 && (w.busy() || game.stack.top()) ? VOX_BTN.a : 0);
for (const d of pushes) {
  for (let i = 0; i < 6; i++) step(BTN[d]!);
  for (let i = 0; i < 60; i++) step(0);
  console.log(`-- ${d}: player (${w.player.cellX},${w.player.cellY})`);
}
board();
