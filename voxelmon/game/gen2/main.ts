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

(globalThis as unknown as { frame: (buttons: number) => void }).frame = (buttons: number): void => {
  try {
    game.frame(buttons & 0xff);
  } catch (e) {
    Logger.error("gold: step: %s", String((e as Error)?.stack ?? e));
  }
  try {
    game.draw(lcd);
    lcd.end();
    view.emit(game);
  } catch (e) {
    Logger.error("gold: draw: %s", String((e as Error)?.stack ?? e));
  }
};
