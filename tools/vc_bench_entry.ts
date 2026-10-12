// A Citra check of VC saves (Red, Blue or Yellow; bundled in place of
// game.js): through the boot movie and the title, CONTINUE, the save
// choice (VC SAVE, or LUA SAVE with --define VC_PICK='"lua"'), a top-screen
// shot of the choice, then once the world is up a SAVE straight through
// writeSave -- every step on pvlog as "[pv] vcbench: ...", beside the
// host's "[pv] vc: ..." lines. Never shipped.
import "./vc_bench_fake.ts";
import "../voxelmon/game/psp-main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";

declare const VC_PICK: string;
const pick = typeof VC_PICK !== "undefined" ? VC_PICK : "vc";
const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const log = (s: string): void => console.log(`[pv] vcbench: ${s}`);
// --define VC_HANG=true: the conversion never ends, to watch the host cut
// it off (voxel.deadline) and the guest put the title back
// --define VC_FAIL='"convert"' / '"enter"': that step throws (after the
// walk-in has begun, for enter), to watch the failure path end at the title
declare const VC_FAIL: string;
if (typeof VC_FAIL !== "undefined") {
  const why = "TypeError: cannot read property 'x' of undefined {PLAYER} <MAP_ID> #1 _";
  if (VC_FAIL === "convert") game.vcConvert = (): never => { throw new Error(why); };
  if (VC_FAIL === "enter") {
    const real = game.vcEnter.bind(game);
    game.vcEnter = (loaded: any): never => {
      game.overworld.enter(loaded.player.map, loaded.player.x, loaded.player.y, "down");
      void real;
      throw new Error(why);
    };
  }
}
declare const VC_HANG: boolean;
// --define VC_DUMP_LUA=true: the SAVE after the continue goes to the Lua
// save instead, its text printed between LUASAVE-BEGIN and LUASAVE-END
declare const VC_DUMP_LUA: boolean;
if (typeof VC_HANG !== "undefined" && VC_HANG) {
  game.vcConvert = (): never => {
    log("hanging on purpose");
    for (;;) { /* until the deadline */ }
  };
}
let n = 0;
let phase = 0;
let at = 0;

// --define VC_NEW=true: NEW GAME instead -- the save choice, VC SAVE (and
// the replace question, answered YES), Oak's speech pressed through, then a
// few steps in the bedroom and a SAVE to the stand-in VC title.
declare const VC_NEW: boolean;
let nphase = 0;
let nat = 0;
function newGameFrame(): number {
  const top = game.stackKinds().at(-1);
  const t = top === "title" ? game.title() : null;
  let pad = 0;
  if (nphase === 0) {
    if (t?.phase === "menu") {
      log(`title menu: ${t.menu.join(" / ")}`);
      nphase = 1;
      nat = n;
    } else if (n % 30 === 0) pad = VOX_BTN.start;
  } else if (nphase === 1 && n - nat > 20) {
    // to NEW GAME, then A
    if (t?.menu?.[t.index] !== "NEW GAME") { if (n % 10 === 0) pad = VOX_BTN.down; }
    else { pad = VOX_BTN.a; nphase = 2; nat = n; }
  } else if (nphase === 2 && n - nat > 20) {
    log(`new game choice: ${t?.phase} ${(t?.menu ?? []).join(" / ")}`);
    native.screenshot?.();
    pad = VOX_BTN.down;
    nphase = 3;
    nat = n;
  } else if (nphase === 3 && n - nat > 20) {
    log(`picked ${t?.menu?.[t.index]}`);
    pad = VOX_BTN.a;
    nphase = 4;
    nat = n;
  } else if (nphase === 4) {
    // the replace question (YES is up from NO), then Oak's speech and the
    // name lists pressed through with A
    if (top === "choice" && game.saveTarget !== "vc") {
      if (n - nat > 30) { log("replace question: YES"); nat = n; pad = VOX_BTN.up; nphase = 5; }
    } else if (top === "overworld" && game.saveTarget === "vc") { log("in the bedroom"); nphase = 6; nat = n; }
    else if (top === "naming") {
      // the name list: down to the first preset, A; the keyboard: START
      const st = game.stack.at(-1);
      if (n % 8 === 0) pad = st.pick ? (n % 16 === 0 ? VOX_BTN.down : VOX_BTN.a) : VOX_BTN.start;
    } else if (n % 8 === 0) pad = VOX_BTN.a;
  } else if (nphase === 5 && n - nat > 10) {
    pad = VOX_BTN.a;
    nphase = 4;
    nat = n;
  } else if (nphase === 6) {
    if (top !== "overworld") { if (n % 8 === 0) pad = VOX_BTN.a; }
    else if (n - nat < 60) pad = VOX_BTN.right;
    else {
      const p = game.save.player;
      log(`saving: target ${game.saveTarget}; ${p.name} at ${game.overworld.mapId ?? p.map}`);
      game.writeSave();
      log(`writeSave: ok=${game.lastSaveOk}`);
      native.screenshot?.();
      nphase = 9;
    }
  }
  return pad;
}

g.frame = (b: number): void => {
  n++;
  if (typeof VC_NEW !== "undefined" && VC_NEW) {
    mainFrame((b & ~0xff) | newGameFrame());
    if (n % 300 === 0) log(`tick ${n}: ${game.stackKinds().join(",")} target ${game.saveTarget}`);
    return;
  }
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
    if (typeof VC_DUMP_LUA !== "undefined" && VC_DUMP_LUA) {
      // the continued game as a Lua save, printed whole (an A/B save: the
      // same place and party, continued the Lua way)
      const vox = (globalThis as any).voxel;
      const write = vox.saveWrite;
      vox.saveWrite = (text: string): unknown => {
        console.log(`LUASAVE-BEGIN
${text}
LUASAVE-END`);
        return write(text);
      };
      game.saveTarget = "lua";
    }
    game.writeSave();
    log(`writeSave: ok=${game.lastSaveOk}`);
    phase = 5;
    at = n;
  } else if (phase === 5 && n - at > 60) {
    native.screenshot?.();
    log("done");
    phase = 9;
  }
  if (n % 120 === 0 && phase >= 4) log(`tick ${n}: ${game.stackKinds().join(",")} target ${game.saveTarget}`);
  // after a failure, the title should come back: press A through the message
  if (phase === 4 && n - at > 60 && top === "textbox" && n % 20 === 0) pad = VOX_BTN.a;
  mainFrame((b & ~0xff) | pad);
};
