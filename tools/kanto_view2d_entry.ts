// A Citra check of the Kanto games' 2D modes (cc_kanto_bench.sh): the real
// entry, the card's save continued from the title, BATTLES (and, with
// VIEW2D=1 at bundle time, VIEW) set to 2D, a walk about, then wild
// battles that A carries through. Never shipped.
import "../voxelmon/game/psp-main.ts";

declare const VIEW2D: boolean;
declare const WALKONLY: boolean;
declare const WARP: string;
declare const STILL: boolean;
declare const TO3D: boolean;
declare const PIKA: boolean;
const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const A = 1 << 4;
const START = 1 << 6;
const WALK = [1 << 2, 1 << 2, 1 << 0, 1 << 3, 1 << 3, 1 << 1]; // left left up right right down (VOX_BTN: up 0, down 1, left 2, right 3)
let continued = false;
let worldFrames = 0;
let i = 0;
g.frame = (b: number): void => {
  const top = game.stack?.[game.stack.length - 1];
  let pad = 0;
  if (!continued) {
    if (top?.kind === "title") {
      continued = true;
      game.pop(); // as the title does before it answers
      top.onChoose?.("continue");
      if (typeof WARP !== "undefined") {
        const [map, x, y] = WARP.split(",");
        game.overworld.enter(map, Number(x), Number(y), "down");
        // no save on the card: "continue" started the intro; drop it
        while (game.stack.length > 1 && game.stack[game.stack.length - 1].kind !== "overworld") game.pop();
      }
      game.save.options = { ...(game.save.options ?? {}), battleView: "2d", view: typeof VIEW2D !== "undefined" && VIEW2D ? "2d" : "3d" };
    } else if (i % 30 === 0) pad = START;
  } else if (!game.battleView?.()) {
    worldFrames++;
    if (worldFrames < 600 || (typeof WALKONLY !== "undefined" && WALKONLY)) pad = typeof STILL !== "undefined" && STILL ? 0 : WALK[Math.floor(worldFrames / 20) % WALK.length]!;
    else if (top?.kind === "overworld") {
      worldFrames = 400;
      game.startWildBattle("PIDGEY", 5);
    } else if (i % 8 === 0) pad = A;
  } else if (i % 8 === 0) pad = A;
  // the continue path replaces the save a little later: keep the test's
  // options on it
  if (continued && game.save) {
    const o = (game.save.options ??= {});
    o.battleView = "2d";
    o.view = typeof VIEW2D !== "undefined" && VIEW2D ? "2d" : "3d";
    // TO3D: back to the voxel world partway, which must build it again
    if (typeof TO3D !== "undefined" && TO3D && worldFrames > 300) o.view = "3d";
    // PIKA (Yellow): the starter Pikachu in the party, so the follower walks
    if (typeof PIKA !== "undefined" && PIKA && !(game.save.party ?? []).some((m: any) => m.species === "PIKACHU")) {
      game.save.party = [{ species: "PIKACHU", level: 5, hp: 20, maxHp: 20, moves: [{ id: "THUNDERSHOCK", pp: 30 }] }];
    }
  }
  i++;
  mainFrame((b & ~0xff) | pad);
};
