// A Citra check of Yellow's PIKACHU faces (FEATURE=yellow cc_kanto_bench.sh
// tools/yellow_pikapic_entry.ts): the card's save continued, then a run of
// face scripts played through overworld.playPikapic -- 10 (the heart), 17,
// 21 (the flower pot) and 25 (the thunderbolt) -- a screenshot partway
// through each, and the pvlog says when each one ended. Never shipped.
import "../voxelmon/game/psp-main.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";

const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const START = 1 << 6;
const SCRIPTS = [10, 17, 21, 25];
let continued = false;
let ready = 0;
let i = 0;
let at = -1;
let started = 0;
let playing = false;

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
  } else if (!ready && top?.kind === "overworld") {
    ready = i;
    console.log(`[pv] bench pikapic: faces in this set: ${game.overworld.hasPikapic()}`);
  } else if (ready && i > ready + 60 && !playing && at < SCRIPTS.length - 1) {
    at++;
    playing = true;
    started = i;
    const ok = game.overworld.playPikapic(SCRIPTS[at], () => {
      playing = false;
      console.log(`[pv] bench pikapic: script ${SCRIPTS[at]} done after ${i - started} frames`);
      ready = i;
    });
    console.log(`[pv] bench pikapic: script ${SCRIPTS[at]} started ${ok}`);
    if (!ok) playing = false;
  } else if (playing && i - started === 30) {
    native.screenshot?.();
  }
  mainFrame((b & ~0xff) | pad);
};
