// A Citra tour for the TRAINER card's badges and the app headers' L/R keys on
// Red/Blue/Yellow (bundled in place of game.js; never shipped): the card's
// save continued, then the TRAINER page with none of the badges, three, and
// all eight; the headers of HOME and the apps, with the clock held at 9:47AM
// and at 12:59PM (the widest it gets); and OPTION's two pages on the top
// screen. Each is shot to the card (shot_N.ppm top, shot_N_b.ppm bottom)
// with a "[pv] bpshot N name" line in pvlog.txt.
import "../voxelmon/game/psp-main.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";
import * as Badges from "../voxelmon/game/rules/badges.ts";
import { OptionsMenuState } from "../voxelmon/game/ui/optionsmenu.ts";

const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const START = 1 << 6;
const R = 1 << 26;
const L = 1 << 27;

// the clock, held where a shot wants it (null: the real one)
let clock: [number, number] | null = null;
const realHours = Date.prototype.getHours;
const realMinutes = Date.prototype.getMinutes;
Date.prototype.getHours = function (this: Date): number { return clock ? clock[0] : realHours.call(this); };
Date.prototype.getMinutes = function (this: Date): number { return clock ? clock[1] : realMinutes.call(this); };

let i = 0;
let continued = false;
let at = -1;
let shots = 0;
const shot = (name: string): void => {
  console.log(`[pv] bpshot ${shots} ${name}`);
  shots++;
  native.screenshot?.();
};
const badges = (n: number): void => {
  const inv = (game.save.inventory ??= {});
  Badges.list(game.data).forEach((b, k) => {
    if (k < n) inv[Badges.itemFor(b)] = 1;
    else delete inv[Badges.itemFor(b)];
  });
};

/** [name, view, badges, clock] -- one shot each, a second apart. */
const PLAN: [string, string, number, [number, number]][] = [
  ["trainer_0of8", "trainer", 0, [9, 47]],
  ["trainer_3of8", "trainer", 3, [9, 47]],
  ["trainer_8of8", "trainer", 8, [9, 47]],
  ["home", "home", 8, [9, 47]],
  ["party", "party", 8, [9, 47]],
  ["dex", "pokedex", 8, [9, 47]],
  ["bag", "bag", 8, [9, 47]],
  ["cheats", "cheats", 8, [9, 47]],
  ["enhancements", "enhancements", 8, [9, 47]],
  ["options", "options", 8, [9, 47]],
  ["explorer", "explorer", 8, [9, 47]],
  ["tools", "tools", 8, [9, 47]],
  ["trainer_1259", "trainer", 8, [12, 59]],
  ["explorer_1259", "explorer", 8, [12, 59]],
  ["home_1259", "home", 8, [12, 59]],
];

let menu: OptionsMenuState | null = null;

g.frame = (b: number): void => {
  i++;
  let pad = 0;
  const top = game.stack?.[game.stack.length - 1];
  if (!continued) {
    if (top?.kind === "title") {
      continued = true;
      game.pop();
      top.onChoose?.("continue");
    } else if (i % 30 === 0) pad = START;
  } else if (at < 0 && top?.kind === "overworld") {
    at = i + 60;
  }
  if (at >= 0 && i >= at) {
    const t = i - at;
    if (t === 0) {
      const s = game.save;
      s.options = { ...(s.options ?? {}), view: "3d", cheats: true };
      (s.inventory ??= {}).TOWN_MAP = 1;
      (s.flags ??= {}).EVENT_GOT_POKEDEX = true;
    }
    const k = Math.floor(t / 60);
    const f = t % 60;
    if (k < PLAN.length) {
      const [name, view, n, c] = PLAN[k]!;
      // away and back: the gear redraws a still page only when its key moves
      if (f === 0) { clock = c; badges(n); game.setGearView(view === "party" ? "home" : "party"); }
      if (f === 3) game.setGearView(view);
      if (f === 50) shot(name);
    } else {
      const u = t - PLAN.length * 60;
      if (u === 0) { clock = [9, 47]; menu = new OptionsMenuState(game); game.push(menu); }
      if (u === 50) shot("option_settings");
      if (u === 60) menu?.turnPage(1);
      if (u === 110) shot("option_enhancements");
      if (u === 130) console.log("[pv] bpshot done");
    }
  }
  mainFrame((b & ~0xff & ~R & ~L) | pad);
};
