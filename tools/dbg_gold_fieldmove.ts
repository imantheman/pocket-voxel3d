// Debug: A facing something with a field move known (bun tools/dbg_gold_fieldmove.ts MAP x y facing MOVE)
// e.g. BURNED_TOWER_1F 4 4 up ROCK_SMASH -- prints each text box and what is left there.
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { FieldMoves } from "../voxelmon/game/gen2/world/FieldMoves.ts";

useGoldGen();
if (process.env.SEED) (await import("../voxelmon/game/gen2/platform/rng.ts")).seed(Number(process.env.SEED));
const game: any = Game2.new();
game.load({ startWorld: true });
const lcd = new Lcd(new RecorderHost());
const step = (b = 0) => { game.frame(b); game.draw(lcd); lcd.end(); };
const [id, xs, ys, face, move] = process.argv.slice(2);
const lead = Mon.new(game.data, "TYPHLOSION", 100, {});
lead.moves[2] = { id: move ?? "ROCK_SMASH", pp: 15, ppUps: 0 };
game.save.party = [lead];
for (const b of Object.values<any>(FieldMoves.BADGE_FLAG)) {
  game.save.player[b.store] = game.save.player[b.store] ?? {};
  game.save.player[b.store][b.name] = true;
}
const w = game.world;
// SCENE=n: the map's scene already moved on (a story scene done)
if (process.env.SCENE) w.mapScenes[id] = Number(process.env.SCENE);
w.setMap(id, Number(xs), Number(ys), face ?? "up");
for (let i = 0; i < 30; i++) step(0);
const [dx, dy] = ({ up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] } as any)[face ?? "up"];
const tx = Number(xs) + dx;
const ty = Number(ys) + dy;
console.log("ahead", tx, ty, "npc", w.npcAt(tx, ty)?.def?.sprite, "coll", w.map.cellCollision(tx, ty).toString(16), "facing", w.player.facing);
step(VOX_BTN.a);
let last = "";
for (let i = 0; i < 12000; i++) {
  const tb = w.textbox;
  const t = tb ? JSON.stringify(tb.text ?? tb.lines ?? tb.page ?? tb).slice(0, 90) : "";
  if (t !== last) {
    console.log(i, "text", t, "screen", game.stack.top()?.screenId ?? "");
    last = t;
  }
  const top = game.stack.top();
  let b = 0;
  if (top?.screenId === "Gen2BattleState" && top.phase === "menu") b = i % 4 === 0 ? (top.menuIndex === 1 ? VOX_BTN.a : VOX_BTN.up) : 0;
  else if (i % 10 === 0 && (w.busy() || top)) b = VOX_BTN.a;
  step(b);
  if (i > 200 && !w.busy() && !top) break;
  if (i % 100 === 0 && i < 2000) console.log(i, "top", top?.screenId, top?.phase, "rock", !!w.npcAt(tx, ty), "lastTalked", w.vm?.lastTalked, "op", w.vm?.current?.op ?? w.vm?.cmd?.op ?? "");
}
console.log("after: npc ahead", w.npcAt(tx, ty)?.def?.sprite, "hidden", w.npcAt(tx, ty)?.hidden, "busy", w.busy());
