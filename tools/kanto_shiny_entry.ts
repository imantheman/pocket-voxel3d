// A Citra check of the Kanto shiny sparkle (cc_kanto_bench.sh
// tools/kanto_shiny_entry.ts): the card's save continued, a wild PIDGEY on
// Route 1 whose DVs are forced to the Gold-shiny pattern, the battle in 3D.
// Logs the frames the sparkle runs; screenshots while the stars are up.
// Never shipped.
import "../voxelmon/game/psp-main.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";

const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const A = 1 << 4;
const START = 1 << 6;
let continued = false;
let placed = 0;
let started = 0;
let i = 0;
let sparkled = 0;
let shots = 0;

g.frame = (b: number): void => {
  i++;
  const top = game.stack?.[game.stack.length - 1];
  let pad = 0;
  if (!continued) {
    if (top?.kind === "title") {
      continued = true;
      game.pop();
      top.onChoose?.("continue");
    } else if (i % 30 === 0) pad = START;
  } else if (game.save) {
    game.save.options = { ...(game.save.options ?? {}), view: "3d", battleView: "3d" };
    if (!placed && top?.kind === "overworld") {
      placed = i;
      game.overworld.enter("ROUTE_1", 9, 20, "up");
      while (game.stack.length > 1 && game.stack[game.stack.length - 1].kind !== "overworld") game.pop();
    }
    const t = placed ? i - placed : -1;
    if (t === 90 && !started) {
      started = i;
      // the next four DV rolls are 10: Def/Spd/Spc 10, Atk 10 -- shiny in Gold
      const rng = game.battleRng;
      let forced = 4;
      game.battleRng = {

        int: (n: number) => (forced-- > 0 ? 10 : rng.int(n)),
        byte: () => rng.byte(),
      };
      game.pushStubBattle("PIDGEY", 3);
      game.battleRng = rng;
      console.log("[pv] bench shiny: battle pushed");
    }
    const battle = top?.battle;
    if (battle) {
      const n = battle.sparkles?.().length ?? 0;
      if (n > 0) {
        if (!sparkled) console.log(`[pv] bench shiny: sparkle starts tick ${i - started}`);
        sparkled++;
        if ((sparkled === 10 || sparkled === 22) && shots < 2) {
          shots++;
          native.screenshot?.();
        }
      } else if (sparkled > 0 && sparkled < 1000) {
        console.log(`[pv] bench shiny: sparkle ran ${sparkled} ticks`);
        sparkled = 1000;
      }
      if (sparkled >= 1000 && i % 40 === 0 && battle.phase === "messages") pad = A;
    }
  }
  mainFrame((b & ~0xff) | pad);
};
