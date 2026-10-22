// Citra shots of a move's animation in a 3D battle on Red/Blue/Yellow (bundled
// in place of game.js by cc_kanto_bench.sh, SHOTS=1): the card's save
// continued, a wild battle on ROUTE_1's 3D stage, FIGHT -> EMBER, and a shot
// every 8 frames while it plays -- for the effect sprites lining up with the
// cards rather than with where the 2D pics would be. Each shot is
// shot_N.ppm on the card with a "[pv] bpshot N name" line in pvlog.txt.
// Never shipped.
import "../voxelmon/game/psp-main.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";
import { newMon } from "../voxelmon/game/battle/mon.ts";

const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const A = 1 << 4;
const START = 1 << 6;
const R = 1 << 26;

let i = 0;
let phase: "title" | "load" | "battle" | "done" = "title";
let wait = 0;
let shots = 0;
let chosenAt = -1;
let rounds = 0;

const top = (): any => game.stack?.[game.stack.length - 1];
const shot = (name: string): void => {
  console.log(`[pv] bpshot ${shots} ${name}`);
  shots++;
  native.screenshot?.();
};

/** A 5x5 block of plain walkable cells, as near the map's middle as there is
 *  one (its centre). */
function openSpot(m: any): [number, number] | null {
  const ok = (x: number, y: number): boolean => m.isWalkableCell(x, y) && !m.isWarpTileCell(x, y);
  let best: [number, number] | null = null;
  let bestD = 1e9;
  for (let y = 3; y < m.heightCells - 3; y++) {
    for (let x = 3; x < m.widthCells - 3; x++) {
      let good = true;
      for (let dy = -2; dy <= 2 && good; dy++) for (let dx = -2; dx <= 2 && good; dx++) good = ok(x + dx, y + dy);
      if (!good) continue;
      const d = Math.abs(x - m.widthCells / 2) + Math.abs(y - m.heightCells / 2);
      if (d < bestD) { bestD = d; best = [x, y]; }
    }
  }
  return best;
}

const realPush = game.pushStubBattle.bind(game);
game.pushStubBattle = (): void => {};

g.frame = (b: number): void => {
  i++;
  let pad = 0;
  const t = top();
  if (phase === "title") {
    if (t?.kind === "title") {
      // a new game straight onto the overworld (the tests' path), with a
      // CHARMANDER that knows EMBER: no save needed on the card
      phase = "load";
      game.pop();
      game.newGame();
      game.closeToOverworld();
      game.save.party = [newMon(game.data, "CHARMANDER", 14)];
    } else if (i % 30 === 0) pad = START;
  } else if (phase === "load") {
    if (game.save && t?.kind === "overworld") {
      if (++wait === 30) {
        game.save.options = { ...(game.save.options ?? {}), view: "3d", battleView: "3d", visibleWild: "off", tiltShift: "off", gameSpeed: 1 };
        game.save.repelSteps = 60000;
        const lead = game.save.party?.[0];
        if (lead) {
          lead.moves = [{ id: "EMBER", pp: 25 }];
          lead.hp = lead.maxHp ?? lead.hp;
        }
        // an open spot near the town's middle: the battle stage needs room
        const o = game.overworld;
        o.enter("PALLET_TOWN", 2, 2, "down");
        const at = openSpot(o.map);
        if (at) o.enter("PALLET_TOWN", at[0], at[1], "down");
        console.log(`[pv] bpshot spot ${at ? at.join(",") : "none"}`);
        phase = "battle";
        wait = 0;
      }
    } else if (t?.kind === "textbox" && i % 30 === 0) pad = A;
  } else if (phase === "battle") {
    if (++wait === 90) realPush("ONIX", 14);
    const ph = t?.battle?.phase;
    if (chosenAt < 0) {
      // through the opening pages to FIGHT, then the one move
      if ((ph === "menu" || ph === "moveSelect" || ph === "messages") && i % 12 === 0) {
        pad = A;
        if (ph === "moveSelect") {
          chosenAt = i;
          console.log(`[pv] bpshot chose EMBER at ${i}`);
        }
      }
    } else {
      const k = i - chosenAt;
      if (k > 0 && k % 8 === 0 && k <= 160) shot(`round${rounds}_k${k}`);
      if (k > 160) {
        rounds++;
        chosenAt = -1;
        if (rounds >= 2) {
          phase = "done";
          console.log("[pv] bpshot done");
        }
      } else if (ph === "messages" && i % 12 === 0) pad = A;
    }
  }
  mainFrame((b & ~0xffffff & ~R) | pad);
};
