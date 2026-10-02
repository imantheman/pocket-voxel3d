// Debug: the MYSTERY GIFT specials through the ROM's own scripts, headless
// (bun tools/dbg_gold_mysterygift.ts): Carrie in the Goldenrod Dept. Store 5F
// unlocks it; a gift waiting brings the delivery man out in the Pokecenter
// 2F, and talking to him puts it in the PACK. Prints what happened.
import { useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";

useGoldGen();
const game: any = Game2.new();
game.load({ startWorld: true });
game.writeSave = () => [true];
const w = () => game.world;
const run = (n: number, press?: (k: number) => number): void => {
  for (let k = 0; k < n; k++) game.frame(press ? press(k) : 0);
};
const mash = (n: number): void => run(n, (k) => (k % 12 === 0 ? VOX_BTN.a : 0));
run(30);

// Carrie: object 4 of the 5F, faced and spoken to (her script by key)
w().warpToMapId("GOLDENROD_DEPT_STORE_5F", 7, 6, "up");
run(60);
const carrie = (w().map.def.objects ?? [])[4];
console.log("5F", w().map.id, "carrie", carrie?.scriptKey, "event", carrie?.event ?? carrie?.flag);
console.log("unlocked before", game.save.mysteryGift?.unlocked === true);
if (carrie?.scriptKey) w().vm.start(carrie.scriptKey);
mash(240);
console.log("unlocked after", game.save.mysteryGift?.unlocked === true);

// a gift waiting: the delivery man appears; talk to him
game.save.mysteryGift.item = "RARE_CANDY";
const before = game.save.inventory?.RARE_CANDY ?? 0;
w().warpToMapId("POKECENTER_2F", 1, 4, "up");
run(90);
const def3 = (w().map.def.objects ?? [])[3];
console.log("2F", w().map.id, "guy script", def3?.scriptKey, "at", def3?.x, def3?.y, "flag", def3?.eventFlag, "hidden by flag", w().events.get(def3?.eventFlag));
if (def3?.scriptKey) w().vm.start(def3.scriptKey);
mash(400);
console.log("RARE_CANDY", before, "->", game.save.inventory?.RARE_CANDY ?? 0, "waiting", game.save.mysteryGift.item);

// the TRAINER HOUSE: a partner left behind, then the receptionist mashed
// through until the battle starts; the enemy party is printed
game.save.mysteryGift.trainerHouse = true;
game.save.mysteryGift.partnerName = "BBB";
game.save.mysteryGift.trainer = [{ level: 22, species: "TOTODILE", moves: ["SCRATCH", "WATER_GUN"] }, { level: 9, species: "SENTRET", moves: ["TACKLE"] }];
w().warpToMapId("VIRIDIAN_CITY", 21, 9, "down");
run(60);
const house = Object.keys(game.data.maps ?? {}).filter((k) => k.startsWith("TRAINER_HOUSE"));
console.log("maps", house.join(","));
w().warpToMapId("TRAINER_HOUSE_B1F", 7, 4, "down");
run(60);
const d = w().map.def;
console.log("B1F coords", JSON.stringify((d.coordEvents ?? []).map((c: any) => [c.x, c.y, c.scriptKey])), "scenes", JSON.stringify(d.sceneScripts ?? []));
w().setEngineFlag(86, false);
const coord = (d.coordEvents ?? [])[0];
// the hall's own two ops: loadtrainer CAL, CAL2 / startbattle
void coord;
for (let k = 0; k < 600 && w().vm.running(); k++) game.frame(k % 14 === 0 ? VOX_BTN.a : 0);
console.log("vm idle", !w().vm.running(), "pending", JSON.stringify(w().vm.pending ?? null)?.slice(0, 80));
console.log("started", w().vm.start([{ op: "loadtrainer", class: 12, member: 2 }, { op: "startbattle" }, { op: "end" }]));
let seen = "";
let lastTop = "";
for (let k = 0; k < 3000; k++) {
  game.frame(k % 14 === 0 ? VOX_BTN.a : 0);
  const top = game.stack.top();
  if (String(top?.screenId) !== lastTop) { lastTop = String(top?.screenId); console.log("top", lastTop, "frame", k); }
  if (k % 250 === 0) console.log("frame", k, "vm", w().vm.running?.(), "map", w().map.id, "player", w().player?.cellX, w().player?.cellY, "text", JSON.stringify(String(w().textBox?.text ?? w().dialog?.text ?? w().text?.text ?? "").slice(0, 40)));
  const b = top?.battle;
  if (b && !seen) {
    seen = `${b.trainer?.name}: ${b.enemyParty.map((m: any) => `${m.species} ${m.level} [${m.moves.map((x: any) => x.id ?? x).join(",")}]`).join(" / ")}`;
    console.log("battle", seen);
    break;
  }
}
if (!seen) console.log("no battle; map", w().map.id, "top", game.stack.top()?.screenId);
