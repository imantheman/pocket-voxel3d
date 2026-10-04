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

import { native, QuickJsHost, STICK_RANGE } from "../quickjs-host.ts";
import { tiltShiftLevel } from "../tiltshift.ts";
import { is2d } from "../viewmode.ts";
import { cameraSpeedQ8 } from "../cameraspeed.ts";
import { readGen2Container } from "./platform/container.ts";
import { loadGenerated, setGen2Source } from "./platform/data.ts";
import { Lcd } from "./platform/lcd.ts";
import { seed } from "./platform/rng.ts";
import { WorldView } from "./platform/worldview.ts";
import { setSaveIo } from "./platform/saveio.ts";
import { Game2 } from "./core/Game2.ts";
import { Companion } from "./ui/Companion.ts";
import { Logger } from "./shared/core/Logger.ts";
import { Sound } from "./shared/core/Sound.ts";
import { GameVersion } from "./shared/core/GameVersion.ts";

/** Same seed as the Gen 1 story tapes; the save carries nothing of it. */
const SEED = 17;

const host = new QuickJsHost();
// the shim's console.log reaches the host's log
Logger.sink = (line) => console.log(line);

// ---- the dataset ----------------------------------------------------------
const sections = readGen2Container(native.gamedata());
setGen2Source(sections);
// Which cart this dataset was cooked from (the importer's version.json):
// Gold and Silver run this one engine, and the few things that differ at
// run time read it -- `checkver`, the Game Corner prizes, the preset names,
// the rival's default name, the credits.
GameVersion.set(String(loadGenerated<{ version?: string }>("version")?.version ?? "gold"));
seed(SEED);
// the Gold save lives in the host's one slot (save_gold.lua on the card)
setSaveIo({
  read: () => host.saveData() ?? undefined,
  write: (text) => host.saveWrite(text) !== false,
  // the save the card had at boot, kept as save_gold.lua.unreadable before
  // the game writes over a save it could not read
  backup: () => host.saveBackup(),
  // the OPTION screen's settings in their own file (options_gold.lua), so
  // they stick across boots whether or not the game was saved; a host
  // without the file keeps them for the session only
  readOptions: () => native.optionsData?.() ?? undefined,
  writeOptions: (text) => (native.optionsWrite ? native.optionsWrite(text) !== false : false),
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
const banks = pages ? pages.counts.map((count, k) => ({ base: k * 1024, page: pages.firstPage + k, count })) : [];
if (pages) {
  lcd.banks(banks);
} else {
  Logger.error("gold: the dataset has no Gold screen pages -- recook");
}

// ---- the game ---------------------------------------------------------------
const game = Game2.new();
const view = new WorldView(host, walker as ConstructorParameters<typeof WorldView>[1]);
// for tools that wrap this entry (tools/gold_battle_entry.ts, a Citra bench)
(globalThis as unknown as { goldGame?: Game2 }).goldGame = game;
// the bottom screen's status panel (ui/Companion.ts)
const companion = new Companion(host, banks);
// the DEV menu's CARD TEST asks the host to write and read back a file
(game as unknown as { host?: unknown }).host = host;
try {
  game.load();
} catch (e) {
  Logger.error("gold: load failed: %s", String((e as Error)?.stack ?? e));
}

// Optional phase timing: a host that registers `voxel.now()` (microseconds;
// the desktop QuickJS harness, a profiling build) gets a line every 300
// frames saying where the guest's time went.
// (On the 3DS the clock is there always; the split is taken only when a
// bench entry asks for it -- globalThis.goldProf -- and then as a "[pv]"
// line, which the host keeps in pvlog.txt.)
const nowFn = (native as unknown as { now?: () => number }).now;
let clock: (() => number) | undefined;
const prof = { n: 0, step: 0, draw: 0, end: 0, view: 0 };

// The 3DS shows 30 frames a second and runs the game at 60 steps a second,
// calling frame() once per step. The logic runs every step; the Gold screen
// is composed (game.draw + lcd.end) once per frame that is shown -- on the
// step the host says is the last before it renders (voxel.lastStep), since a
// slow frame makes it run several steps to catch up and a picture composed
// on any but the last is overwritten unseen. (A host without lastStep: every
// other step.) The scene follows on the same steps. Its ops are all state
// (camera, actors, maps, tint), so the step between two shown frames had
// nothing to say that the next would not overwrite; and World.viewState,
// which feeds them, builds a sizeable object graph each call.
let stepNo = 0;
const lastStep = native.lastStep;

(globalThis as unknown as { frame: (buttons: number) => void }).frame = (buttons: number): void => {
  clock = (globalThis as unknown as { goldProf?: boolean }).goldProf || !lastStep ? nowFn : undefined;
  const t0 = clock ? clock() : 0;
  const compose = lastStep ? lastStep() : (stepNo++ & 1) === 0;
  // The camera, as the Kanto entry reads it (psp-main.ts): bits 24-25 its
  // quarter turns, bits 28-31 the low four bits of its yaw in 64ths of a
  // turn (offset half a quadrant, which is what rounds 24-25). VIEW 2D has
  // no camera to be relative to.
  {
    const flatView = is2d(game.options?.view);
    game.camTurns = flatView ? 0 : (buttons >> 24) & 3;
    const e = (((buttons >> 24) & 3) << 4) | ((buttons >>> 28) & 15);
    game.camYaw = flatView ? 0 : ((((e - 8) % 64) + 64) % 64) * ((Math.PI * 2) / 64);
  }
  // The circle pad itself, for the free walk (the button word carries it
  // only quantised to the four d-pad bits), as psp-main.ts reads it.
  {
    const st = native.stick?.();
    if (st !== undefined) {
      const sx = (st >> 16) << 16 >> 16;
      const sy = (st << 16) >> 16;
      const r = STICK_RANGE > 0 ? STICK_RANGE : 1;
      game.stick = { x: Math.max(-1, Math.min(1, sx / r)), y: Math.max(-1, Math.min(1, sy / r)) };
    }
  }
  try {
    game.frame(buttons & 0xff);
    // the CABLE CLUB's link (polled every step, as the carrier needs)
    game.serviceLink();
    // the bottom screen's touch, packed above the pad by the host (bit 8 a
    // finger down, bits 9-16 x/2, bits 17-23 y/2 -- psp-main.ts reads the same)
    companion.touch(game, ((buttons >> 9) & 0xff) * 2, ((buttons >> 17) & 0x7f) * 2, (buttons & 0x100) !== 0);
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
      companion.frame(game);
      // the OPTION screen's TILT SHIFT, stated every shown frame like Kanto's
      host.tiltShift(tiltShiftLevel(game.options?.tiltShift));
      // CAMERA SPEED, the same way (optional on an older native shim)
      native.camSpeed?.(cameraSpeedQ8(game.options?.cameraSpeed));
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
    // a frame long enough to be a visible hitch, split, with what was up
    if (t4 - t0 > 100000) {
      const top = game.stack.top();
      console.log(`[pv] gold slow frame ${((t4 - t0) / 1000).toFixed(0)} ms: step ${((t1 - t0) / 1000).toFixed(0)} draw ${((t2 - t1) / 1000).toFixed(0)} lcd ${((t3 - t2) / 1000).toFixed(0)} view ${((t4 - t3) / 1000).toFixed(0)} (top: ${top?.screenId ?? (game.world ? "world" : "-")} ${top?.phase ?? ""})`);
    }
    if (++prof.n === 300) {
      const us = (v: number): string => (v / prof.n).toFixed(0);
      console.log(`[pv] gold us/frame: step ${us(prof.step)} draw ${us(prof.draw)} lcd ${us(prof.end)} view ${us(prof.view)} (top: ${game.stack.top()?.screenId ?? (game.world ? "world" : "-")})`);
      prof.n = prof.step = prof.draw = prof.end = prof.view = 0;
    }
  }
};
