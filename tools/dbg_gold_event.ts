// Debug: EVENT POKéMON in Gold/Silver, headless (bun tools/dbg_gold_event.ts
// [silver]): the option off brings nobody out in the Pokecenter 2F; on, the
// delivery man appears and talking to him gives CELEBI once. Prints what
// happened.
import { useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { GameVersion } from "../voxelmon/game/gen2/shared/core/GameVersion.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";

const silver = process.argv[2] === "silver";
if (silver) {
  useGoldGen("dist/voxelmon/silver/gen");
  GameVersion.set("silver");
} else useGoldGen();
const game: any = Game2.new();
game.load({ startWorld: true });
game.writeSave = () => [true];
const w = () => game.world;
const run = (n: number, press?: (k: number) => number): void => {
  for (let k = 0; k < n; k++) game.frame(press ? press(k) : 0);
};
const mash = (n: number): void => run(n, (k) => (k % 12 === 0 ? VOX_BTN.a : 0));
run(30);

const visit = (label: string): void => {
  w().warpToMapId("POKECENTER_2F", 1, 4, "up");
  run(90);
  const guy = (w().map.def.objects ?? [])[3];
  const shown = !w().events.get(guy?.eventFlag);
  const before = (game.save.party ?? []).length;
  if (guy?.scriptKey) w().vm.start(guy.scriptKey);
  // A through his lines; once the mon is in, B declines the nickname
  run(500, (k) => (k % 12 !== 0 ? 0 : (game.save.party ?? []).length > before ? VOX_BTN.b : VOX_BTN.a));
  console.log(`  vm still running ${w().vm.running()}, flag ${w().events.get(guy?.eventFlag)}`);
  const party = game.save.party ?? [];
  const last = party[party.length - 1];
  console.log(`${label}: guy shown ${shown}, party ${before} -> ${party.length}, last ${last?.species} L${last?.level} OT ${last?.otName ?? last?.ot} shiny ${last?.shiny}, given ${JSON.stringify(game.save.eventPokemon ?? {})}`);
  w().warpToMapId("POKECENTER_1F", 3, 7, "down");
  run(60);
};

game.options.eventPokemon = false;
visit("off");
if (process.argv.includes("item")) {
  game.save.mysteryGift = game.save.mysteryGift ?? {};
  game.save.mysteryGift.item = "RARE_CANDY";
  visit("item");
  visit("item again");
  console.log("candy", game.save.inventory?.RARE_CANDY, "pages", JSON.stringify(w().lastPages ?? null));
}
game.options.eventPokemon = true;
visit("on");
visit("on again");
