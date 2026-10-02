// Debug: are two Game2s in one process independent (for the link test)?
import { useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
useGoldGen();
const a: any = Game2.new();
a.load({ startWorld: true });
const b: any = Game2.new();
b.load({ startWorld: true });
console.log("same game", a === b, "same save", a.save === b.save, "same party", a.save.party === b.save.party,
  "same club", a.cableClub() === b.cableClub(), "same stack", a.stack === b.stack, "same world", a.world === b.world);
