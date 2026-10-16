// The OPTION screen (engine/menus/main_menu.asm DisplayOptionMenu), ported
// from gen1recomp src/ui/OptionsMenu.lua's vanilla rows.
//
// The original lays each row's choices out side by side with a ▶ cursor on
// the active one, and a second cursor in the left margin marking the row —
// so the whole state of the options is readable at a glance, which is the
// point of the screen. That layout is what scene.ts draws.
//
// Upstream's menu is much longer, but nearly all of it is desktop-renderer
// settings (video mode, tilt, zoom, GBC FX, window scaling) or a mod manager,
// none of which exists here. What is left is the three vanilla rows --
// TEXT SPEED, BATTLE ANIMATION, BATTLE STYLE (SHIFT, the cart's default,
// offers a free switch before a trainer's next mon; SET does not) -- and
// this port's own.
//
// The settings live in save.options under gen1recomp's own key names
// (textSpeed, animations), so a save moves between the two builds intact.
//
// Two pages, turned with L/R (game.ts cycleGearView) or SELECT: SETTINGS,
// the rows above plus CHEATS (which shows the gear's CHEATS app), and
// ENHANCEMENTS (../extras.ts). The words are ui/extras_layout.ts's.
import type { GameState } from "../game.ts";
import { TEXT_SPEEDS, TEXT_SPEED_DEFAULT } from "../world/textbox.ts";
import { TILT_SHIFTS, tiltShiftLevel } from "../tiltshift.ts";
import { SCREENS_2D, VIEW_MODES, ZOOMS_2D, screen2dIndex, viewIndex, zoom2dIndex } from "../viewmode.ts";
import { CAMERA_SPEEDS } from "../cameraspeed.ts";
import {
  CHEATS_ROW, ENHANCEMENT_ROWS, OPTION_PAGES, SPEED_ROW, SPEED_ROW_READY, type ExtrasRowDef,
} from "./extras_layout.ts";

export interface OptionsRow {
  label: string;
  /** Every choice, in menu order — the screen shows them all. */
  choices: string[];
  /** Index into `choices` of the active one. */
  index: number;
}

export interface OptionsView {
  rows: OptionsRow[];
  /** Selected row, or rows.length for CANCEL. */
  index: number;
  /** The first item on screen (rows, then CANCEL) and how many fit. */
  first: number;
  visible: number;
  /** The page shown (ui/extras_layout.ts OPTION_PAGES) and every page's name. */
  page: number;
  pages: readonly string[];
}

/**
 * Each row is four lines (label, blank, choices, blank) on an 18-line
 * screen, so four items fit and the rest scroll under them. The original's
 * three rows never needed this; this port's eight plus CANCEL do.
 */
export const OPTIONS_VISIBLE = 4;

// CAMERA SPEED's choices live in ../cameraspeed.ts (Gold's OPTION screen has
// the row too); re-exported for the callers that import them from here.
export { CAMERA_SPEED_DEFAULT_Q8, CAMERA_SPEEDS } from "../cameraspeed.ts";
import { RUNNING_SHOES, runningShoesOn } from "../runshoes.ts";
import { EVENT_POKEMON, eventPokemonOn } from "../eventmons.ts";
import { GAME_SPEEDS, gameSpeedIndex, setGameSpeedIn } from "../gamespeed.ts";

interface OptionsSave {
  options?: {
    textSpeed?: number;
    animations?: boolean;
    battleStyle?: string;
    movement?: string;
    runningShoes?: boolean;
    cameraSpeed?: string;
    tiltShift?: string;
    view?: string;
    screen2d?: string;
    zoom2d?: number;
    battleView?: string;
    eventPokemon?: boolean;
    devMenu?: boolean;
    cheats?: boolean;
    gameSpeed?: number;
    [extra: string]: unknown;
  };
}

export class OptionsMenuState implements GameState {
  readonly kind = "options";
  private index = 0;
  private first = 0;
  /** OPTION_PAGES index: SETTINGS, ENHANCEMENTS. */
  private page = 0;

  /** L/R (game.ts cycleGearView) or SELECT: the next page, cursor to its top. */
  turnPage(dir: 1 | -1): void {
    const n = OPTION_PAGES.length;
    this.page = (this.page + dir + n) % n;
    this.index = 0;
    this.first = 0;
  }

  /** The ENHANCEMENTS rows on show: SPEED (../gamespeed.ts), then the rest. */
  private enhancementDefs(): ExtrasRowDef[] {
    return [...(SPEED_ROW_READY ? [SPEED_ROW] : []), ...ENHANCEMENT_ROWS];
  }

  constructor(private game: { input: any; pop(): void; save: OptionsSave }) {}

  private opts(): NonNullable<OptionsSave["options"]> {
    const save = this.game.save;
    return (save.options ??= {});
  }

  private cameraIndex(): number {
    const at = CAMERA_SPEEDS.findIndex((s) => s.key === this.opts().cameraSpeed);
    return at >= 0 ? at : 1; // NORMAL
  }

  private speedIndex(): number {
    const cur = this.opts().textSpeed ?? TEXT_SPEED_DEFAULT;
    const at = TEXT_SPEEDS.findIndex((s) => s.delay === cur);
    return at >= 0 ? at : 1; // MEDIUM
  }

  private rows(): OptionsRow[] {
    if (this.page === 1) {
      // ENHANCEMENTS: SPEED's 1X / 2X (../gamespeed.ts, options.gameSpeed),
      // then OFF / ON toggles (extras.ts), OFF unless set
      return this.enhancementDefs().map((d) => ({
        label: d.label,
        choices: [...d.choices],
        index: d === SPEED_ROW ? gameSpeedIndex(this.opts()) : this.opts()[d.key] === true ? 1 : 0,
      }));
    }
    return [...this.settingsRows(), {
      // The gear's CHEATS app (ui/gear/apps/cheats.ts) shows while this is
      // ON. OFF hides the app; the cheats keep their settings.
      label: CHEATS_ROW.label,
      choices: [...CHEATS_ROW.choices],
      index: this.opts().cheats === true ? 1 : 0,
    }];
  }

  private settingsRows(): OptionsRow[] {
    return [
      {
        label: "TEXT SPEED",
        choices: TEXT_SPEEDS.map((s) => s.label),
        index: this.speedIndex(),
      },
      {
        label: "BATTLE ANIMATION",
        choices: ["ON", "OFF"],
        index: this.opts().animations === false ? 1 : 0,
      },
      {
        label: "BATTLE STYLE",
        choices: ["SHIFT", "SET"],
        index: this.opts().battleStyle === "set" ? 1 : 0,
      },
      {
        // FREE walks at any angle, steered by the camera (world/freemove.ts);
        // GRID is the original four-way step.
        label: "MOVEMENT",
        choices: ["FREE", "GRID"],
        index: this.opts().movement === "grid" ? 1 : 0,
      },
      {
        // Hold B to run (../runshoes.ts). This port's row; ON unless set.
        label: "RUNNING SHOES",
        choices: RUNNING_SHOES.map((r) => r.label),
        index: runningShoesOn(this.opts()) ? 0 : 1,
      },
      {
        label: "CAMERA SPEED",
        choices: CAMERA_SPEEDS.map((s) => s.label),
        index: this.cameraIndex(),
      },
      {
        // The miniature look (tiltshift.ts): the host blurs the top and
        // bottom of the world. This port's row, like CAMERA SPEED.
        label: "TILT SHIFT",
        choices: TILT_SHIFTS.map((t) => t.label),
        index: tiltShiftLevel(this.opts().tiltShift),
      },
      {
        // The voxel world, or the cart's 2D screen (viewmode.ts); the same
        // for battles. This port's rows.
        label: "VIEW",
        choices: VIEW_MODES.map((v) => v.label),
        index: viewIndex(this.opts().view),
      },
      {
        // VIEW 2D's map out to the top screen's edges, and zoomed out
        // (viewmode.ts canvasSize; Gold's OPTION screen has them too)
        label: "2D SCREEN",
        choices: SCREENS_2D.map((v) => v.label),
        index: screen2dIndex(this.opts().screen2d),
      },
      {
        label: "2D ZOOM OUT",
        choices: ZOOMS_2D.map((z) => z.label),
        index: zoom2dIndex(this.opts().zoom2d),
      },
      {
        label: "BATTLES",
        choices: VIEW_MODES.map((v) => v.label),
        index: viewIndex(this.opts().battleView),
      },
      {
        // The event distributions (../eventmons.ts): MEW at the CABLE CLUB
        // desk. This port's row; OFF unless set.
        label: "EVENT POKéMON",
        choices: EVENT_POKEMON.map((e) => e.label),
        index: eventPokemonOn(this.opts()) ? 1 : 0,
      },
      {
        // The playtesting tools (ui/devmenu.ts). Off unless asked for, and
        // then DEV appears on the pause menu.
        label: "DEV MENU",
        choices: ["OFF", "ON"],
        index: this.opts().devMenu === true ? 1 : 0,
      },
    ];
  }

  /** Move row `row` to choice `to`, clamped. */
  private set(row: number, to: number): void {
    const rows = this.rows();
    const r = rows[row];
    if (!r) return;
    const at = Math.max(0, Math.min(r.choices.length - 1, to));
    if (this.page === 1) {
      const d = this.enhancementDefs()[row]!;
      // SPEED: 1 or 2 (game.gameSpeed / setGameSpeed read and write the same key)
      if (d === SPEED_ROW) setGameSpeedIn(this.opts(), GAME_SPEEDS[at]!.key);
      else this.opts()[d.key] = at === 1;
      return;
    }
    if (row === rows.length - 1) { this.opts().cheats = at === 1; return; }
    if (row === 0) this.opts().textSpeed = TEXT_SPEEDS[at]!.delay;
    else if (row === 1) this.opts().animations = at === 0;
    else if (row === 2) this.opts().battleStyle = at === 1 ? "set" : "shift";
    else if (row === 3) this.opts().movement = at === 1 ? "grid" : "free";
    else if (row === 4) this.opts().runningShoes = RUNNING_SHOES[at]!.key;
    else if (row === 5) this.opts().cameraSpeed = CAMERA_SPEEDS[at]!.key;
    else if (row === 6) this.opts().tiltShift = TILT_SHIFTS[at]!.key;
    else if (row === 7) this.opts().view = VIEW_MODES[at]!.key;
    else if (row === 8) this.opts().screen2d = SCREENS_2D[at]!.key;
    else if (row === 9) this.opts().zoom2d = ZOOMS_2D[at]!.pct;
    else if (row === 10) this.opts().battleView = VIEW_MODES[at]!.key;
    else if (row === 11) this.opts().eventPokemon = EVENT_POKEMON[at]!.key;
    else if (row === 12) this.opts().devMenu = at === 1;
  }

  update(): void {
    const p = this.game.input.pressed;
    // SELECT turns the page too, for a host without shoulder buttons
    if (p.select) this.turnPage(1);
    const rows = this.rows();
    const n = rows.length + 1; // + CANCEL
    if (p.up) this.index = (this.index + n - 1) % n;
    if (p.down) this.index = (this.index + 1) % n;
    // the window follows the cursor, one item at a time
    if (this.index < this.first) this.first = this.index;
    if (this.index >= this.first + OPTIONS_VISIBLE) this.first = this.index - OPTIONS_VISIBLE + 1;
    // Left/right walk the selected row's choices. The original wraps on
    // right and stops on left (SetCursorPositionsFromOptions); wrapping both
    // ways is friendlier on a d-pad and costs nothing to read.
    if (this.index < rows.length) {
      const r = rows[this.index]!;
      if (p.left) this.set(this.index, (r.index + r.choices.length - 1) % r.choices.length);
      if (p.right) this.set(this.index, (r.index + 1) % r.choices.length);
      // A on a row also advances it, so the screen is usable with one button
      if (p.a) this.set(this.index, (r.index + 1) % r.choices.length);
    } else if (p.a) {
      this.game.pop();
      return;
    }
    if (p.b || p.start) { this.game.pop(); return; }
  }

  view(): OptionsView {
    return {
      rows: this.rows(), index: this.index, first: this.first, visible: OPTIONS_VISIBLE,
      page: this.page, pages: OPTION_PAGES,
    };
  }
}
