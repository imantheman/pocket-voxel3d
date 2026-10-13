// A Citra check of VC saves for Gold, Silver or Crystal (bundled in place of
// game-gold.js, with tools/vc_bench_fake.ts standing in for the VC title):
// through the boot movie and the title to the main menu, CONTINUE, the save
// choice (VC SAVE, or LUA SAVE with --define VC_PICK='"lua"'), a shot of the
// choice, then once the world is up a while a SAVE straight through the
// game's own writer -- every step on pvlog as "[pv] vcbench: ...", beside
// the guest's "[pv] vc: ..." lines and the fake title's checksum line.
// --define VC_NEW=true: NEW GAME instead -- the choice, VC SAVE, the replace
// question answered YES, the intro pressed through, then a SAVE in the
// bedroom. Never shipped.
import "./vc_bench_fake.ts";
import "../voxelmon/game/gen2/main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";
import { Vc } from "../voxelmon/game/gen2/vc/session.ts";

declare const VC_PICK: string;
declare const VC_NEW: boolean;
const pick = typeof VC_PICK !== "undefined" ? VC_PICK : "vc";
const isNew = typeof VC_NEW !== "undefined" && VC_NEW;
const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;
const log = (s: string): void => console.log(`[pv] vcbench: ${s}`);
let n = 0;
let phase = 0;
let at = 0;
let last = "";

g.frame = (b: number): void => {
  n++;
  let pad = 0;
  const top = game.stack.top();
  const id = String(top?.screenId ?? (game.world?.map ? `world:${game.world.map.id}` : "-"));
  if (id !== last) {
    last = id;
    log(`${id} tick ${n} phase ${phase} target ${Vc.target()}`);
  }
  const menu = id === "Gen2MainMenu" ? top : null;
  if (phase === 0) {
    if (menu) {
      log(`main menu: ${menu.list.items.map((i: any) => i.label).join(" / ")}; VC title ${Vc.present() ? (Vc.hasGame() ? "with a game" : "empty") : "none"}`);
      phase = 1;
      at = n;
    } else if (n % 40 === 0) pad = VOX_BTN.start;
  } else if (phase === 1 && n - at > 30) {
    // CONTINUE is the first row, NEW GAME the second
    if (isNew) { if (menu.list.index === 1) pad = VOX_BTN.down; else { pad = VOX_BTN.a; phase = 2; at = n; } }
    else { pad = VOX_BTN.a; phase = 2; at = n; }
  } else if (phase === 2 && n - at > 30) {
    if (menu?.phase === "pick") {
      log(`choice for ${menu.pickFor}: ${menu.pick.map((p: any) => p.label).join(" / ")}`);
      native.screenshot?.();
      const want = pick === "lua" ? "lua" : "vc";
      if (menu.pick[menu.pickIndex].id !== want) pad = VOX_BTN.down;
      phase = 3;
    } else {
      log(`no choice shown (${id}, ${menu?.phase})`);
      phase = 4;
    }
    at = n;
  } else if (phase === 3 && n - at > 30) {
    native.screenshot?.();
    pad = VOX_BTN.a;
    phase = 4;
    at = n;
  } else if (phase === 4) {
    if (menu?.phase === "replace") {
      if (n - at > 30) {
        native.screenshot?.();
        log(`replace question, cursor on ${menu.replaceChoice === 2 ? "NO" : "YES"}: answering YES`);
        pad = VOX_BTN.up;
        phase = 5;
        at = n;
      }
    } else if (id.startsWith("world:") && !game.world.busy() && game.stack.top() == null) {
      if (!at || n - at > 240) {
        const p = game.save.player;
        log(`in the world: ${p.name} at ${game.world.map.id} ${game.world.player.cellX},${game.world.player.cellY}; party ${(game.save.party ?? []).length}; target ${Vc.target()}`);
        const [ok, err] = game.writeSave();
        log(`writeSave: ok=${ok}${err ? ` (${err})` : ""}`);
        native.screenshot?.();
        phase = 9;
      }
    } else if (!id.startsWith("world:") || game.stack.top() != null) {
      // the intro and its name lists (new game), or text boxes: press on
      // (the keyboard: a letter or two, START to END, A on it)
      if (n % 12 === 0) pad = top?.screenId === "Gen2NamingScreen" ? [VOX_BTN.a, VOX_BTN.a, VOX_BTN.start, VOX_BTN.a][(n / 12) % 4]! : VOX_BTN.a;
      at = n;
    }
  } else if (phase === 5 && n - at > 10) {
    pad = VOX_BTN.a;
    phase = 4;
    at = 0;
  }
  if (n % 300 === 0 && phase >= 4 && phase < 9) log(`tick ${n}: ${id} target ${Vc.target()}`);
  mainFrame((b & ~0xff) | pad);
};
