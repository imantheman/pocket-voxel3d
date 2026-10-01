// voxelmon/game/gen2/main.ts -- the QuickJS entry for Pokémon Gold.
//
// Bundled into crates/pocketvoxel-3ds/game-gold.js (cc_build.sh / the
// `gold` feature embeds it instead of game.js). The Gen 1 entry is
// psp-main.ts; the two share only the host surface (quickjs-host.ts).
//
// Boot: the dataset is Gold's container (platform/container.ts) -- each
// importer table handed to the engine as a lazily parsed string -- then the
// Gold screen learns where the cooked tile pages live, Game2 loads, and per
// host tick `frame(buttons)` runs one 60 Hz step, composes the Gold screen,
// and emits the voxel scene under it.

import { native, QuickJsHost } from "../quickjs-host.ts";
import { tiltShiftLevel } from "../tiltshift.ts";
import { readGen2Container } from "./platform/container.ts";
import { loadGenerated, setGen2Source } from "./platform/data.ts";
import { Lcd } from "./platform/lcd.ts";
import { seed } from "./platform/rng.ts";
import { WorldView } from "./platform/worldview.ts";
import { setSaveIo } from "./platform/saveio.ts";
import { Game2 } from "./core/Game2.ts";
import { Logger } from "./shared/core/Logger.ts";
import { Sound } from "./shared/core/Sound.ts";

/** Same seed as the Gen 1 story tapes; the save carries nothing of it. */
const SEED = 17;

const host = new QuickJsHost();
// the shim's console.log reaches the host's log
Logger.sink = (line) => console.log(line);

// ---- the dataset ----------------------------------------------------------
const sections = readGen2Container(native.gamedata());
setGen2Source(sections);
seed(SEED);
// the Gold save lives in the host's one slot (save_gold.lua on the card)
setSaveIo({
  read: () => host.saveData() ?? undefined,
  write: (text) => host.saveWrite(text) !== false,
});

// the sound seam, when its port provides one
const snd = Sound as unknown as { setHost?: (h: unknown) => void };
snd.setHost?.(host);

// ---- the Gold screen: tile ids -> cooked pages -----------------------------
// the cooked scene table (an older dataset carried the whole walker record)
const walker =
  loadGenerated<{ atlas?: { lcd?: { firstPage: number; counts: number[] } } }>("scene") ??
  loadGenerated<{ atlas?: { lcd?: { firstPage: number; counts: number[] } } }>("walker");
const lcd = new Lcd(host);
const pages = walker?.atlas?.lcd;
if (pages) {
  lcd.banks(pages.counts.map((count, k) => ({ base: k * 1024, page: pages.firstPage + k, count })));
} else {
  Logger.error("gold: the dataset has no Gold screen pages -- recook");
}

// ---- the game ---------------------------------------------------------------
const game = Game2.new();
const view = new WorldView(host, walker as ConstructorParameters<typeof WorldView>[1]);
try {
  game.load();
} catch (e) {
  Logger.error("gold: load failed: %s", String((e as Error)?.stack ?? e));
}

// Optional phase timing: a host that registers `voxel.now()` (microseconds;
// the desktop QuickJS harness, a profiling build) gets a line every 300
// frames saying where the guest's time went.
const clock = (native as unknown as { now?: () => number }).now;
const prof = { n: 0, step: 0, draw: 0, end: 0, view: 0 };

// The 3DS shows 30 frames a second and runs the game at 60 steps a second,
// calling frame() once per step. The logic runs every step; the Gold screen
// is composed (game.draw + lcd.end) every other one -- every frame that is
// shown -- and the scene follows on the same steps. Its ops are all state
// (camera, actors, maps, tint), so the step between two shown frames had
// nothing to say that the next would not overwrite; and World.viewState,
// which feeds them, builds a sizeable object graph each call.
let stepNo = 0;

(globalThis as unknown as { frame: (buttons: number) => void }).frame = (buttons: number): void => {
  const t0 = clock ? clock() : 0;
  const compose = (stepNo++ & 1) === 0;
  try {
    game.frame(buttons & 0xff);
  } catch (e) {
    Logger.error("gold: step: %s", String((e as Error)?.stack ?? e));
  }
  const t1 = clock ? clock() : 0;
  let t2 = t1;
  let t3 = t1;
  try {
    if (compose) {
      game.draw(lcd);
      t2 = clock ? clock() : 0;
      lcd.end();
    }
    t3 = clock ? clock() : 0;
    if (compose) {
      view.emit(game);
      // the OPTION screen's TILT SHIFT, stated every shown frame like Kanto's
      host.tiltShift(tiltShiftLevel(game.options?.tiltShift));
    }
  } catch (e) {
    Logger.error("gold: draw: %s", String((e as Error)?.stack ?? e));
  }
  if (clock) {
    const t4 = clock();
    prof.step += t1 - t0;
    prof.draw += t2 - t1;
    prof.end += t3 - t2;
    prof.view += t4 - t3;
    if (++prof.n === 300) {
      const us = (v: number): string => (v / prof.n).toFixed(0);
      console.log(`[gold] us/frame: step ${us(prof.step)} draw ${us(prof.draw)} lcd ${us(prof.end)} view ${us(prof.view)} (top: ${game.stack.top()?.screenId ?? (game.world ? "world" : "-")})`);
      prof.n = prof.step = prof.draw = prof.end = prof.view = 0;
    }
  }
};
