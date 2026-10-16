// A Citra tour of the Gen 1 ENHANCEMENTS and CHEATS screens for screenshots
// (bundled in place of game.js, like tools/bottom_shots_kanto_entry.ts): the
// card's save continued, then the gear's HOME before CHEATS is on; the
// OPTION screen's SETTINGS page walked down to CHEATS and turned ON with the
// d-pad; R to ENHANCEMENTS and its rows toggled; HOME with the CHEATS app;
// every CHEATS page driven by taps (WILD, the toggles, DEX FULL's YES/NO,
// GIVE ITEMS' pockets, pages, quantity and YES/NO); the party menu's field
// moves without the move; and a wild battle won with INSTANT WIN. Each step
// is shot to the card (shot_N.ppm top, shot_N_b.ppm bottom) with a
// "[pv] bpshot N name" line in pvlog.txt. Never shipped.
import "../voxelmon/game/psp-main.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";
import { OptionsMenuState } from "../voxelmon/game/ui/optionsmenu.ts";

const g = globalThis as unknown as { voxelmonGame: any; frame: (b: number) => void };
const game = g.voxelmonGame;
const mainFrame = g.frame;
const RIGHT = 1 << 3;
const DOWN = 1 << 1;
const A = 1 << 4;
const B = 1 << 5;
const START = 1 << 6;
/** The R shoulder as main.rs packs it (bit 26). */
const R = 1 << 26;
/** A held touch at bottom-screen pixel (x, y), as main.rs packs it. */
const touch = (x: number, y: number): number => 0x100 | ((x >> 1) << 9) | ((y >> 1) << 17);
/** The middle of a gear cell. */
const cell = (cx: number, cy: number): number => touch(cx * 16 + 8, Math.floor(cy * (240 / 18) + 6));

let i = 0;
let phase: "title" | "menu" | "load" | "tour" | "done" = "title";
let wait = 0;
let shots = 0;
let step = 0;
let stepAt = 0;

const top = (): any => game.stack?.[game.stack.length - 1];
const shot = (name: string): void => {
  console.log(`[pv] bpshot ${shots} ${name}`);
  shots++;
  native.screenshot?.();
};
const toOverworld = (): void => {
  while (game.stack.length > 1 && top()?.kind !== "overworld") game.pop();
};
const view = (v: string): void => game.setGearView(v);
const opts = (): Record<string, unknown> => (game.save.options ??= {});

/** A step: `set` runs once, then `inputs` are sent one per 8 frames (each
 *  held for 2), then it is shot after `frames`. */
type Step = { name: string; set?: () => void; inputs?: number[]; frames?: number; shoot?: boolean; pad?: () => number };
const bstate = (): any => top()?.battle;

let queue: number[] = [];
let held = 0;
let holdLeft = 0;

const STEPS: Step[] = [
  { name: "before_home", set: () => { opts().cheats = false; view("home"); } },
  { name: "options_settings", set: () => { game.push(new OptionsMenuState(game)); } },
  // down to the last row (CHEATS) with the d-pad, then RIGHT: ON
  { name: "options_cheats_on", inputs: [...Array(13).fill(DOWN), RIGHT], frames: 160 },
  { name: "options_enhancements", inputs: [R], frames: 40 },
  { name: "options_enh_toggled", inputs: [RIGHT, DOWN, RIGHT, DOWN, DOWN, RIGHT], frames: 90 },
  { name: "after_home", inputs: [B], frames: 50, set: () => {} },
  { name: "cheats_list", set: () => { toOverworld(); view("cheats"); } },
  { name: "cheats_wild_more", inputs: [cell(15, 3)] },
  { name: "cheats_toggles_on", inputs: [cell(17, 5), cell(17, 7), cell(17, 9)], frames: 60 },
  // INFINITE MONEY at work: the card's money
  { name: "trainer_money", set: () => view("trainer"), frames: 30 },
  { name: "cheats_list_again", set: () => view("cheats"), frames: 30, shoot: false },
  { name: "cheats_dex_confirm", inputs: [cell(16, 11)] },
  { name: "cheats_dex_done", inputs: [cell(9, 7)] },
  { name: "give_items", inputs: [cell(16, 13)] },
  { name: "give_items_p2", inputs: [cell(18, 13)] },
  { name: "give_balls", inputs: [cell(7, 15)] },
  { name: "give_key", inputs: [cell(12, 15)] },
  { name: "give_tms", inputs: [cell(17, 15)] },
  { name: "give_tm_item", inputs: [cell(5, 3)] },
  { name: "give_items_again", inputs: [cell(3, 17), cell(2, 15)], frames: 60 },
  { name: "give_item", inputs: [cell(5, 4)] },
  { name: "give_qty10", inputs: [cell(7, 12), cell(18, 10)], frames: 60 },
  { name: "give_confirm", inputs: [cell(15, 17)] },
  { name: "give_done", inputs: [cell(9, 7)] },
  { name: "give_back", inputs: [cell(3, 17), cell(3, 17)], frames: 60 },
  // HMS WITHOUT MOVE: CUT on the party menu of a mon that does not know it
  { name: "party_open", set: () => {
    toOverworld();
    Object.assign(game.save.inventory, { HM_CUT: 1, CASCADEBADGE: 1, HM_FLASH: 1, BOULDERBADGE: 1 });
    opts().hmsWithoutMove = true;
    // START -> POKéMON, as a player opens it, then A on the lead
    game.openStartMenu();
    const m = top()?.gearMenu?.();
    if (m) m.select(Math.max(0, m.items.indexOf("POKéMON")));
  }, inputs: [A], frames: 40, shoot: false },
  // the submenu of a mon that knows neither CUT nor FLASH
  { name: "party_hm", set: () => {
    const t = top();
    if (t?.kind !== "party") return;
    const party: any[] = game.save.party ?? [];
    const at = party.findIndex((m) => !(m.moves ?? []).some((mv: any) => mv.id === "CUT" || mv.id === "FLASH"));
    t.index = Math.max(0, at);
    t.mode = "submenu";
    t.submenuIndex = 0;
  }, frames: 40 },
  { name: "party_hm_close", inputs: [B, B, B], frames: 40, shoot: false },
  { name: "tools_hm", set: () => { toOverworld(); view("tools"); } },
  // INSTANT WIN: a wild battle, FIGHT, and the faint
  { name: "battle_menu", set: () => { toOverworld(); view("home"); game.pushStubBattle("PIDGEOTTO", 30); },
    pad: () => (bstate() && bstate().phase !== "menu" && i % 20 === 0 ? A : 0), frames: 400 },
  { name: "battle_instant", set: () => { if (bstate()) bstate().menuIndex = 1; }, inputs: [A], frames: 90 },
  { name: "battle_exp", inputs: [A], frames: 60 },
  { name: "battle_over", pad: () => (top()?.kind === "battle" && i % 20 === 0 ? A : 0), frames: 400 },
];

g.frame = (b: number): void => {
  i++;
  let pad = 0;
  const t = top();
  if (phase === "title") {
    if (t?.kind === "title") {
      if (t.phase === "menu") { phase = "menu"; wait = 40; }
      else if (i % 30 === 0) pad = START;
    } else if (i % 30 === 0) pad = START;
  } else if (phase === "menu") {
    if (--wait === 0) {
      game.pop();
      t.onChoose?.("continue");
      phase = "load";
      wait = 0;
    }
  } else if (phase === "load") {
    if (game.save && t?.kind === "overworld") {
      if (++wait === 30) {
        game.save.options = { ...(game.save.options ?? {}), view: "3d", battleView: "3d" };
        // every app on offer, so HOME shows where CHEATS goes when the grid is full
        game.save.inventory ??= {};
        game.save.inventory.TOWN_MAP = 1;
        (game.save.flags ??= {}).EVENT_GOT_POKEDEX = true;
        game.save.money = 148250;
        toOverworld();
        phase = "tour";
        step = 0;
        STEPS[0]!.set?.();
        queue = [...(STEPS[0]!.inputs ?? [])];
        stepAt = i + 60;
      }
    } else if (t?.kind === "textbox" && i % 30 === 0) pad = A;
  } else if (phase === "tour") {
    const s = STEPS[step];
    if (!s) {
      phase = "done";
      console.log("[pv] bpshot done");
    } else {
      if (s.pad) pad |= s.pad();
      // one queued input every 8 frames, held 2
      if (holdLeft > 0) { pad |= held; holdLeft--; }
      else if (queue.length > 0 && i % 8 === 0) { held = queue.shift()!; pad |= held; holdLeft = 1; }
      if (i >= stepAt && queue.length === 0 && holdLeft === 0) {
        if (s.shoot !== false) shot(s.name);
        step++;
        const n = STEPS[step];
        if (n) {
          n.set?.();
          queue = [...(n.inputs ?? [])];
          stepAt = i + (n.frames ?? 45) + queue.length * 8;
        }
      }
    }
  }
  mainFrame((b & ~0xffffff & ~R) | pad);
};
