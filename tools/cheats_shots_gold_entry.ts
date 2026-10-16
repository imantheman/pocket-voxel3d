// A Citra tour of the Gold/Silver/Crystal ENHANCEMENTS and CHEATS for
// screenshots (bundled in place of game-gold.js; the bottom-screen tour's
// twin, tools/bottom_shots_gold_entry.ts): the card's save continued, then
// the bottom screen with CHEATS off (the four tabs as they were), OPTION's
// top level and its ENHANCEMENTS page toggled with the pad, CHEATS turned on
// from OPTION, and every view of the bottom screen's CHEATS tab tapped
// through the touch bits -- the list, a few rows stepped, DEX FULL's YES/NO
// and its answer, GIVE ITEMS' list, a pocket, an item's QUANTITY, the GIVE
// question and its answer -- then CHEATS off again. Each is shot to the card
// (shot_N.ppm top, shot_N_b.ppm bottom) with a "[pv] bpshot N name" line in
// pvlog.txt. Nothing is saved. Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";

const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;
/** A held touch at bottom-screen pixel (x, y), as the host packs it. */
const touch = (x: number, y: number): number => 0x100 | ((x >> 1) << 9) | ((y >> 1) << 17);
/** The centre of panel cell (cx, cy) (16 px cells on the 320x240 screen). */
const cell = (cx: number, cy: number): number => touch(cx * 16 + 8, cy * 16 + 8);

let started = false;
let world = 0;
let shots = 0;
let i = 0;
let step = 0;
let stepAt = 0;
const SETTLE = 12;
let pendingSet: (() => void) | null = null;
let setAt = 0;

const shot = (name: string): void => {
  console.log(`[pv] bpshot ${shots} ${name}`);
  shots++;
  native.screenshot?.();
};

/** Presses of one button, `n` of them, 12 frames apart, from the step's start. */
const presses = (btn: number, n: number) => (into: number): number =>
  into >= 0 && into < n * 12 && into % 12 < 3 ? btn : 0;

type Step = { name: string; tap?: [number, number]; set?: () => void; pad?: (into: number) => number; frames?: number; shoot?: boolean };
const top = (): any => game.stack.top();
const STEPS: Step[] = [
  // the bottom screen as it was: four tabs
  { name: "off_party" },
  { name: "off_card", tap: [12, 14] },
  // OPTION: the top level, then ENHANCEMENTS
  { name: "option_top", set: () => { game.showOptions(); top().focusRow?.("cheats"); }, frames: 40 },
  { name: "enhancements", set: () => { const m = game.stack.states[game.stack.states.length - 1]; m.focusRow?.("expForCatching"); }, frames: 40 },
  // RIGHT on EXP FOR CATCHING, down twice, RIGHT on TRADE EVO LV.40
  { name: "enhancements_on", pad: (n) => presses(VOX_BTN.right, 1)(n) | presses(VOX_BTN.down, 2)(n - 20) | presses(VOX_BTN.right, 1)(n - 50), frames: 80 },
  // B back to the top level (on ENHANCEMENTS), down past MENU ACCOUNT to
  // CHEATS, RIGHT turns it on
  { name: "option_cheats_on", pad: (n) => presses(VOX_BTN.b, 1)(n) | presses(VOX_BTN.down, 2)(n - 20) | presses(VOX_BTN.right, 1)(n - 50), frames: 80 },
  // START leaves OPTION: the five tabs
  { name: "on_party", pad: presses(VOX_BTN.start, 1), frames: 60 },
  { name: "cheats_list", tap: [18, 14] },
  // WILD ENCOUNTERS -> MORE, SHINY ODDS -> 1/4096, ALWAYS CATCH, INSTANT WIN on
  { name: "cheats_wild_more", tap: [5, 3] },
  { name: "cheats_shiny", tap: [5, 5] },
  { name: "cheats_catch", tap: [5, 6] },
  { name: "cheats_win", tap: [5, 7] },
  { name: "dex_confirm", tap: [4, 11] },
  { name: "dex_done", tap: [4, 11] },
  { name: "cheats_back", tap: [4, 6] },
  { name: "items", tap: [4, 12] },
  { name: "items_page2", tap: [18, 12] },
  { name: "balls", tap: [8, 3] },
  { name: "tms", tap: [16, 3] },
  { name: "items_again", tap: [3, 3] },
  { name: "qty", tap: [3, 4] },
  { name: "qty_10", tap: [7, 8] },
  { name: "give_confirm", tap: [15, 11] },
  { name: "give_done", tap: [4, 11] },
  { name: "items_after", tap: [4, 6] },
  // a key item: one only
  { name: "key_items", tap: [12, 3] },
  { name: "key_qty", tap: [3, 4] },
  // CHEATS off from OPTION: the tab goes, the page with it
  { name: "off_again", set: () => { game.options.cheats = false; }, frames: 40 },
];

g.frame = (_b: number): void => {
  i++;
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
    game.options.view = "3d";
    // a clean slate for the tour, and no options written to the card
    for (const k of ["cheats", "expForCatching", "partyExpShare", "tradeEvoLv40", "hmsWithoutMove", "wildEncounters", "shinyOdds", "alwaysCatch", "instantVictory", "fastEggs", "infiniteMoney"]) delete game.options[k];
    game.persistOptions = () => undefined;
  }
  let b = 0;
  if (game.world?.map) world++;
  if (world === 60) {
    const s = game.save;
    if (!(s.party ?? []).length) s.party = [Mon.new(game.data, "CYNDAQUIL", 20, {})];
    s.player.money = 148250;
    stepAt = i + 90;
  }
  // a step's own set-up waits SETTLE frames after the last shot, and its pad
  // presses as long again (the card's shot is taken a few frames late)
  if (pendingSet && i >= setAt) {
    pendingSet();
    pendingSet = null;
  }
  if (world > 60) {
    const s = STEPS[step];
    if (s) {
      const into = i - (stepAt - (s.frames ?? 60));
      if (s.pad) b |= s.pad(into);
      // a tap: four frames down at the step's start, then up
      if (s.tap && into >= 0 && into < 4) b |= cell(s.tap[0], s.tap[1]);
      if (i >= stepAt) {
        if (s.shoot !== false) shot(s.name);
        step++;
        const n = STEPS[step];
        if (n) {
          if (n.set) {
            pendingSet = n.set;
            setAt = i + SETTLE;
          }
          stepAt = i + (n.frames ?? 60) + (n.set || n.pad ? 2 * SETTLE : 0);
        } else {
          console.log("[pv] bpshot done");
        }
      }
    }
  }
  mainFrame(b);
};
