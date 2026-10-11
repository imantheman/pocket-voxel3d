// A Citra check of VC saves (Red, Blue or Yellow; bundled in place of
// game.js): through the boot movie and the title, CONTINUE, the save
// choice (VC SAVE, or LUA SAVE with --define VC_PICK='"lua"'), a top-screen
// shot of the choice, then once the world is up a SAVE straight through
// writeSave -- every step on pvlog as "[pv] vcbench: ...", beside the
// host's "[pv] vc: ..." lines. Never shipped.
import "../voxelmon/game/psp-main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";

declare const VC_PICK: string;
const pick = typeof VC_PICK !== "undefined" ? VC_PICK : "vc";
const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const log = (s: string): void => console.log(`[pv] vcbench: ${s}`);
let n = 0;
let phase = 0;
let at = 0;

g.frame = (b: number): void => {
  n++;
  let pad = 0;
  const top = game.stackKinds().at(-1);
  const t = top === "title" ? game.title() : null;
  if (phase === 0) {
    if (t?.phase === "menu") {
      log(`title menu: ${t.menu.join(" / ")}`);
      phase = 1;
      at = n;
    } else if (n % 30 === 0) pad = VOX_BTN.start; // the boot movie, then PRESS START
  } else if (phase === 1 && n - at > 20) {
    if (t?.menu?.[0] !== "CONTINUE") {
      log("no CONTINUE: nothing to load");
      phase = 9;
    } else {
      pad = VOX_BTN.a;
      phase = 2;
      at = n;
    }
  } else if (phase === 2 && n - at > 20) {
    if (t?.phase === "pick") {
      log(`choice: ${t.menu.join(" / ")}; box: ${(t.panel ?? []).join(" | ")}`);
      native.screenshot?.();
      const want = pick === "lua" ? "LUA SAVE" : "VC SAVE";
      if (t.menu[t.index] !== want) pad = VOX_BTN.down;
      phase = 3;
    } else {
      log(`no choice shown (${top}): CONTINUE loaded the Lua save`);
      phase = 4;
    }
    at = n;
  } else if (phase === 3 && n - at > 30) {
    native.screenshot?.();
    pad = VOX_BTN.a;
    phase = 4;
    at = n;
  } else if (phase === 4 && top === "overworld" && n - at > 180) {
    const p = game.save.player;
    log(`continued: target ${game.saveTarget}; ${p.name} at ${p.map} ${p.x},${p.y}; party ${game.save.party.length}`);
    game.writeSave();
    log(`writeSave: ok=${game.lastSaveOk}`);
    phase = 5;
    at = n;
  } else if (phase === 5 && n - at > 60) {
    native.screenshot?.();
    log("done");
    phase = 9;
  }
  mainFrame((b & ~0xff) | pad);
};
