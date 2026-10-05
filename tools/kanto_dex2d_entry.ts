// A Citra check of the catch-time POKéDEX page and the party screen in VIEW 2D
// WIDE (cc_kanto_bench.sh tools/kanto_dex2d_entry.ts): the card's save
// continued, VIEW 2D with 2D SCREEN WIDE, then the "New POKéDEX data" page a
// catch shows (game.showCaughtDexEntry) and the party screen; a top-screen
// shot of each. Isaac saw the map behind the dex text after a catch. Never
// shipped.
import "../voxelmon/game/psp-main.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";

const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void };
const game = g.voxelmonGame;
const mainFrame = g.frame;
let continued = false;
let n = 0;
let step = 0;
g.frame = (b: number): void => {
  const top = game.stack?.[game.stack.length - 1];
  if (!continued && top?.kind === "title") {
    continued = true;
    game.pop();
    top.onChoose?.("continue");
  }
  if (continued && game.overworld?.map) {
    const o = game.save.options;
    o.view = "2d";
    o.screen2d = "wide";
    n++;
    if (step === 0 && n > 120) {
      step = 1;
      console.log("[pv] bench dex2d: showing the catch dex page");
      game.showCaughtDexEntry("CATERPIE");
    }
    if (step === 1 && n > 360) {
      step = 2;
      console.log(`[pv] bench dex2d: shot 0 top=${game.stack[game.stack.length - 1]?.kind}`);
      native.screenshot?.();
    }
    if (step === 2 && n > 420) {
      step = 3;
      while (game.stack.length > 1 && game.stack[game.stack.length - 1].kind !== "overworld") game.pop();
      game.pickPartyMon(() => {}, () => {});
      console.log(`[pv] bench dex2d: party top=${game.stack[game.stack.length - 1]?.kind}`);
    }
    if (step === 3 && n > 520) {
      step = 4;
      console.log(`[pv] bench dex2d: shot 1 top=${game.stack[game.stack.length - 1]?.kind}`);
      native.screenshot?.();
    }
  }
  // A on the text box that precedes the page, nothing else
  const pad = step === 1 && n % 30 === 0 && game.stack[game.stack.length - 1]?.kind !== "pokedex" ? 1 << 4 : 0;
  mainFrame((b & ~0xff) | pad);
};
