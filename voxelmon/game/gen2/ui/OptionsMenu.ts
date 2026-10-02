// Gold's OPTION screen: a port of gen1recomp src/ui/gen2/OptionsMenu.lua
// (bdfac727, MIT) -- engine/menus/options_menu.asm _Option.
//
// Layout is transcribed from the ASM: one full-screen textbox, StringOptions
// placed at (2,2) as label / "        :" pairs, each option's value printed at
// (11, labelRow + 1) -- except FRAME, whose number goes at (16,15) after the
// literal "TYPE". The cursor is a ▶ in column 1 at row 2 + index * 2.
//
// Up/down move between rows, left/right change the value under the cursor, and
// START or B leaves. BACK is a row like any other that simply exits.
//
// Values are stored on the save's options table by name (Save.DEFAULT_OPTIONS)
// rather than as the packed wOptions byte.
//
// The row list runs through the ui.options.rows hook (the null mod bus here),
// so the call site survives.
//
// ROWS DROPPED ON THE 3DS. Brian's list carries the port's desktop settings
// after Gold's own rows. Those that drive a desktop-only module (inert here)
// or a screen that only exists on the desktop are left out of ROWS, so the
// groups that only held them vanish the way groupView already drops an empty
// group:
//   CONTROLS (BindingsMenu), PERFORMANCE (Performance), ZOOM (Zoom),
//   TILT (Tilt), COLOR (PaletteScreen), UI LETTERBOX (Letterbox),
//   SHADER FX / SHADER FX 2 (ShaderFXScreen), VIDEO MODE (VideoMode),
//   SCREEN POS (ScreenPosition), TOUCH PAD / TOUCH LAYOUT / VIBRATION /
//   KEY BAR (TouchControls; hidden off-mobile in the Lua anyway),
//   MAX FPS (FrameCap), VSYNC (VSync/PresentSync),
//   BATTLE LAYOUT / BATTLE HUD / BATTLE SIZE / BATTLE BG (the widescreen
//   battle and the window's void around it; the Gold screen is 160x144).
// Kept: Gold's TEXT SPEED, BATTLE SCENE, BATTLE STYLE, SOUND, PRINT (hidden,
// as the Lua hides it), MENU ACCOUNT, FRAME, BACK; and the port rows that run
// here: MUSIC VOL, SFX VOL, MUSIC FILTER, GAME SPEED, VOID FILL, LOGIC CLOCK.
// Added: TILT SHIFT, this port's own (voxelmon/game/tiltshift.ts), which the
// Kanto games' OPTION screen carries too.

import { Chrome } from "./Chrome.ts";
import { Logger } from "../shared/core/Logger.ts";
import { Marquee } from "../shared/ui/Marquee.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { Save } from "../core/Save.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Music } from "../shared/core/Music.ts";
import { Sound } from "../shared/core/Sound.ts";
import { GameSpeed } from "../shared/core/GameSpeed.ts";
import { LogicClock } from "../shared/core/LogicClock.ts";
import { BorderFill } from "../world/BorderFill.ts";
import { Font } from "../shared/render/Font.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { tonumber, tostring } from "../platform/lua.ts";
import { TILT_SHIFTS, tiltShiftLevel } from "../../tiltshift.ts";
import { SCREENS_2D, VIEW_MODES, ZOOMS_2D, screen2dIndex, viewIndex, zoom2dIndex } from "../../viewmode.ts";
import { CAMERA_SPEEDS, cameraSpeedIndex } from "../../cameraspeed.ts";
import { runningShoesOn } from "../../runshoes.ts";

type Options = Record<string, any>;

export interface OptionRow {
  id?: string;
  label: string;
  key?: string;
  values?: unknown[];
  display?: Record<string, string>;
  frame?: boolean;
  port?: boolean;
  cancel?: boolean;
  group?: boolean;
  cycle?: (options: Options, delta: number, game?: any) => void;
  text?: (options: Options) => string;
  activate?: (game: any) => void;
  value?: (game: any) => unknown;
  step?: (game: any, dir: number) => unknown;
  [k: string]: any;
}

export interface OptionsMenuOpts {
  options?: Options;
  onDone?: (options: Options) => void;
}

// Lua: OptionsMenu.lua:35 -- Music.setFilterLevel's ladder.
const FILTERS = [Strings.source("OFF"), Strings.source("1X"), Strings.source("2X"), Strings.source("3X")];

// Lua: OptionsMenu.lua:66
function volLabel(v: number | undefined): string {
  v = v ?? 7;
  return v === 0 ? Strings.get("OFF") : tostring(v);
}

// Lua: OptionsMenu.lua:71
function stepVolume(v: number | undefined, delta: number): number {
  return Math.max(0, Math.min(7, (v ?? 7) + delta));
}

// Lua: OptionsMenu.lua:122 -- each row: the label, the option key it edits,
// and the cycle of values with the exact strings the cart prints (trailing
// spaces included -- they blank the longer previous value, e.g. "MID " over
// "SLOW"). Boolean values are keyed "true"/"false" in `display`.
const ROWS: OptionRow[] = [
  {
    label: Strings.source("TEXT SPEED"), key: "textSpeed",
    values: ["FAST", "MID", "SLOW"],
    display: { FAST: Strings.source("FAST"), MID: Strings.source("MID "), SLOW: Strings.source("SLOW") },
  },
  {
    label: Strings.source("BATTLE SCENE"), key: "battleScene",
    values: [true, false],
    display: { true: Strings.source("ON "), false: Strings.source("OFF") },
  },
  {
    label: Strings.source("BATTLE STYLE"), key: "battleStyle",
    values: ["SHIFT", "SET"],
    display: { SHIFT: Strings.source("SHIFT"), SET: Strings.source("SET  ") },
  },
  {
    label: Strings.source("SOUND"), key: "sound",
    values: ["MONO", "STEREO"],
    display: { MONO: Strings.source("MONO  "), STEREO: Strings.source("STEREO") },
  },
  {
    label: Strings.source("PRINT"), key: "print",
    values: ["LIGHTEST", "LIGHTER", "NORMAL", "DARKER", "DARKEST"],
    display: {
      LIGHTEST: Strings.source("LIGHTEST"), LIGHTER: Strings.source("LIGHTER "),
      NORMAL: Strings.source("NORMAL  "), DARKER: Strings.source("DARKER  "),
      DARKEST: Strings.source("DARKEST "),
    },
  },
  {
    label: Strings.source("MENU ACCOUNT"), key: "menuAccount",
    values: [false, true],
    display: { false: Strings.source("OFF"), true: Strings.source("ON ") },
  },
  // Lua: OptionsMenu.lua:170 -- FRAME is the textbox border style, 1-8, and
  // prints its number after the word TYPE rather than in the value column.
  { label: Strings.source("FRAME"), key: "frame", frame: true },
  // Everything from here down is the port's, not the cart's. The two volume
  // rows clamp at the ends rather than wrapping.
  // Lua: OptionsMenu.lua:182
  {
    label: Strings.source("MUSIC VOL"), key: "musicVol", port: true,
    cycle: (options, delta) => {
      options.musicVol = stepVolume(options.musicVol, delta);
      Music.setVolumeLevel(options.musicVol);
    },
    text: (options) => volLabel(options.musicVol),
  },
  // Lua: OptionsMenu.lua:188
  {
    label: Strings.source("SFX VOL"), key: "sfxVol", port: true,
    cycle: (options, delta) => {
      options.sfxVol = stepVolume(options.sfxVol, delta);
      Sound.setVolumeLevel(options.sfxVol);
    },
    text: (options) => volLabel(options.sfxVol),
  },
  // Lua: OptionsMenu.lua:196 -- each filter step keeps 40% of the previous
  // step's treble.
  {
    label: Strings.source("MUSIC FILTER"), key: "musicFilter", port: true,
    cycle: (options, delta) => {
      const n = FILTERS.length;
      options.musicFilter = ((((options.musicFilter ?? 0) + delta) % n) + n) % n;
      Music.setFilterLevel(options.musicFilter);
    },
    text: (options) => Strings.get(FILTERS[(options.musicFilter ?? 0)]!),
  },
  // Lua: OptionsMenu.lua:220
  {
    label: Strings.source("GAME SPEED"), key: "speed", port: true,
    cycle: (options, delta) => {
      options.speed = GameSpeed.cycle(options.speed, delta);
    },
    text: (options) => {
      const speed = tonumber(options.speed) ?? 1;
      if (speed === 1) return Strings.get("NORMAL");
      return Strings.get("%dX", speed);
    },
  },
  // Lua: OptionsMenu.lua:249 -- VOID FILL: FADE is each map's own border block
  // with the dissolve across a boundary; WATER / TREES force one outdoor
  // block; BLACK is a flat void.
  {
    label: Strings.source("VOID FILL"), key: "voidFill", port: true,
    cycle: (options, delta) => {
      BorderFill.setVoidFill(options.voidFill || "fade");
      options.voidFill = BorderFill.cycle(delta);
    },
    text: (options) => Strings.get(BorderFill.voidFillLabel(options.voidFill)),
  },
  // Not the Lua's: the 3DS host's miniature look over the voxel world
  // (voxelmon/game/tiltshift.ts), stated to the host every frame by main.ts.
  {
    label: Strings.source("TILT SHIFT"), key: "tiltShift", port: true,
    cycle: (options, delta) => {
      const n = TILT_SHIFTS.length;
      const at = (((tiltShiftLevel(options.tiltShift) + delta) % n) + n) % n;
      options.tiltShift = TILT_SHIFTS[at]!.key;
    },
    text: (options) => Strings.get(TILT_SHIFTS[tiltShiftLevel(options.tiltShift)]!.label),
  },
  // Not the Lua's: the Kanto games' MOVEMENT row -- FREE walks with a
  // continuous position steered by the camera (World.freeWalk), GRID the
  // cart's cell by cell. FREE unless set, as on the Kanto games.
  {
    label: Strings.source("MOVEMENT"), key: "movement", port: true,
    cycle: (options) => {
      options.movement = options.movement === "grid" ? "free" : "grid";
    },
    text: (options) => Strings.get(options.movement === "grid" ? "GRID" : "FREE"),
  },
  // Not the Lua's: RUNNING SHOES, every game's row (voxelmon/game/runshoes.ts)
  // -- hold B on foot to run. ON unless set.
  {
    label: Strings.source("RUNNING SHOES"), key: "runningShoes", port: true,
    cycle: (options) => {
      options.runningShoes = !runningShoesOn(options);
    },
    text: (options) => Strings.get(runningShoesOn(options) ? "ON" : "OFF"),
  },
  // Not the Lua's: how fast the C-stick swings the 3D camera
  // (voxelmon/game/cameraspeed.ts), stated to the host every frame by main.ts
  // -- the Kanto games' CAMERA SPEED row.
  {
    label: Strings.source("CAMERA SPEED"), key: "cameraSpeed", port: true,
    cycle: (options, delta) => {
      const n = CAMERA_SPEEDS.length;
      options.cameraSpeed = CAMERA_SPEEDS[(((cameraSpeedIndex(options.cameraSpeed) + delta) % n) + n) % n]!.key;
    },
    text: (options) => Strings.get(CAMERA_SPEEDS[cameraSpeedIndex(options.cameraSpeed)]!.label),
  },
  // Not the Lua's: the 3D world or the cart's 2D screen, and the same for
  // battles (voxelmon/game/viewmode.ts).
  {
    label: Strings.source("VIEW"), key: "view", port: true,
    cycle: (options) => {
      options.view = VIEW_MODES[1 - viewIndex(options.view)]!.key;
    },
    text: (options) => Strings.get(VIEW_MODES[viewIndex(options.view)]!.label),
  },
  // Not the Lua's: VIEW 2D's map out to the top screen's edges (WIDE) or the
  // Gold screen's box (NORMAL), and zoomed out (viewmode.ts canvasSize) --
  // the Kanto games' rows too. The text boxes and menus keep the box.
  {
    label: Strings.source("2D SCREEN"), key: "screen2d", port: true,
    cycle: (options) => {
      options.screen2d = SCREENS_2D[1 - screen2dIndex(options.screen2d)]!.key;
    },
    text: (options) => Strings.get(SCREENS_2D[screen2dIndex(options.screen2d)]!.label),
  },
  {
    label: Strings.source("2D ZOOM OUT"), key: "zoom2d", port: true,
    cycle: (options, delta) => {
      const n = ZOOMS_2D.length;
      options.zoom2d = ZOOMS_2D[(((zoom2dIndex(options.zoom2d) + delta) % n) + n) % n]!.pct;
    },
    text: (options) => Strings.get(ZOOMS_2D[zoom2dIndex(options.zoom2d)]!.label),
  },
  {
    label: Strings.source("BATTLES"), key: "battleView", port: true,
    cycle: (options) => {
      options.battleView = VIEW_MODES[1 - viewIndex(options.battleView)]!.key;
    },
    text: (options) => Strings.get(VIEW_MODES[viewIndex(options.battleView)]!.label),
  },
  // Not the Lua's: the Kanto games' DEV MENU -- a DEV entry in the START
  // menu with the playtesting tools (ui/DevMenu.ts). OFF unless set.
  {
    label: Strings.source("DEV MENU"), key: "devMenu", port: true,
    cycle: (options) => {
      options.devMenu = options.devMenu !== true;
    },
    text: (options) => Strings.get(options.devMenu === true ? "ON" : "OFF"),
  },
  // Lua: OptionsMenu.lua:428
  {
    label: Strings.source("LOGIC CLOCK"), key: "logicClock", port: true,
    cycle: (options, delta) => {
      options.logicClock = LogicClock.cycle(options.logicClock, delta);
      LogicClock.apply(options.logicClock);
    },
    text: (options) => Strings.get(LogicClock.label(options.logicClock)),
  },
  { label: Strings.source("BACK"), cancel: true },
];

// Lua: OptionsMenu.lua:479 -- the screen shows a window of rows and scrolls.
const VISIBLE_ROWS = 7;

interface Group {
  id: string;
  label: string;
  members: string[];
}

// Lua: OptionsMenu.lua:485 -- the Gen 1 screen's grouping, with Gold's rows.
// Members whose rows were dropped (see the header) simply never match.
const GROUPS: Group[] = [
  { id: "group.speed", label: Strings.source("SPEED"), members: ["textSpeed", "speed"] },
  {
    id: "group.video", label: Strings.source("VIDEO"),
    members: ["videoMode", "screenPos", "fpsCap", "vsync", "logicClock"],
  },
  {
    id: "group.graphics", label: Strings.source("GRAPHICS"),
    members: ["color", "uiLetterbox", "shaderfx", "shaderfx2", "frame", "view", "screen2d", "zoom2d", "battleView", "tiltShift"],
  },
  // Not the Lua's: the Kanto games' MOVEMENT and CAMERA SPEED, together
  {
    id: "group.controls", label: Strings.source("CONTROLS"), members: ["movement", "runningShoes", "cameraSpeed"],
  },
  { id: "group.audio", label: Strings.source("AUDIO"), members: ["sound", "musicVol", "sfxVol", "musicFilter"] },
  {
    id: "group.battle", label: Strings.source("BATTLE OPTIONS"),
    members: ["battleScene", "battleStyle", "battleLayout", "battleHud", "battleFit", "battleBg"],
  },
  { id: "group.extras", label: Strings.source("EXTRAS"), members: ["zoom", "voidFill", "tilt", "devMenu"] },
];

// Lua: OptionsMenu.lua:501
const ORDER = [
  "group.speed", "group.video", "group.graphics", "group.controls", "group.audio",
  "performance", "group.battle", "group.extras",
];

// Lua: OptionsMenu.lua:508 -- a group's page is this same screen driving the
// rows it was handed, with its own BACK on the bottom.
function groupView(rows: OptionRow[], open: (game: any, members: OptionRow[]) => unknown): OptionRow[] {
  const owner: Record<string, Group> = {};
  const picked: Record<string, OptionRow[]> = {};
  for (const group of GROUPS) {
    for (const id of group.members) owner[id] = group;
    picked[group.id] = [];
  }
  for (const row of rows) {
    if (row.id && owner[row.id]) picked[owner[row.id]!.id]!.push(row);
  }
  const made: Record<string, OptionRow> = {};
  const byId: Record<string, OptionRow> = {};
  for (const group of GROUPS) {
    const members = picked[group.id]!;
    if (members.length > 0) {
      made[group.id] = {
        id: group.id, label: group.label, group: true,
        activate: (game) => open(game, members),
      };
    }
  }
  for (const row of rows) {
    if (row.id && !owner[row.id]) byId[row.id] = row;
  }
  const view: OptionRow[] = [];
  const taken: Record<string, boolean> = {};
  for (const id of ORDER) {
    const row = made[id] ?? byId[id];
    if (row) {
      view.push(row);
      taken[id] = true;
    }
  }
  for (const row of rows) {
    const id = row.id;
    if (!(id && (owner[id] || taken[id]))) view.push(row);
  }
  return view;
}

// Lua: OptionsMenu.lua:546 -- ui.options.rows identity.
function sameRows(_game: any, rows: OptionRow[]): OptionRow[] {
  return rows;
}

// Lua: OptionsMenu.lua:558 -- shallow copies of ROWS for one opening.
function buildRows(): OptionRow[] {
  const rows: OptionRow[] = [];
  for (const row of ROWS) {
    // PRINT is wGBPrinterBrightness; there is no printer, so nothing reads the
    // value and the row is hidden rather than offering a dead setting. (The
    // Lua's VIDEO MODE / touch-row tests are moot: those rows are dropped.)
    const hidden = row.key === "print";
    if (!hidden) {
      const copy: OptionRow = { ...row };
      copy.id = copy.id ?? copy.key ?? (copy.cancel ? "cancel" : undefined);
      rows.push(copy);
    }
  }
  return rows;
}

export class OptionsMenu {
  [key: string]: any;
  static isOpaque = true;
  static ROWS = ROWS;
  isOpaque = true;

  game: any;
  rows: OptionRow[] = [];
  view: OptionRow[] = [];
  options: Options = {};
  onDone?: (options: Options) => void;
  index = 1;
  scroll = 0;
  sub = false;

  // Lua: OptionsMenu.lua:588
  wantsFillScale(): boolean {
    return true;
  }

  // Lua: OptionsMenu.lua:589
  drawsWidescreen(): boolean {
    return true;
  }

  // Lua: OptionsMenu.lua:594 pushGroup -- the page edits the SAME options
  // table the parent screen does.
  static pushGroup(parent: OptionsMenu, members: OptionRow[]): OptionsMenu {
    const page = new OptionsMenu();
    page.game = parent.game;
    page.rows = members;
    page.options = parent.options;
    page.index = 1;
    page.scroll = 0;
    page.sub = true;
    page.view = [...members];
    page.view.push({ label: Strings.source("BACK"), cancel: true, id: "cancel" });
    parent.game.stack.push(page);
    return page;
  }

  // Lua: OptionsMenu.lua:608 -- opts: options (edited in place), onDone(options)
  static new(game: any, opts?: OptionsMenuOpts): OptionsMenu {
    const o = opts ?? {};
    const self = new OptionsMenu();
    self.game = game;
    let rows = buildRows();
    const hooked = Runtime.call("ui.options.rows", sameRows, game, rows);
    if (Array.isArray(hooked)) {
      rows = hooked;
    } else {
      Logger.error("ui.options.rows returned %s; keeping the vanilla rows", typeof hooked);
    }
    self.rows = rows;
    self.options = o.options ?? Save.defaultOptions();
    // Fill in anything missing so a row can never read nil.
    for (const key of Object.keys(Save.DEFAULT_OPTIONS)) {
      if (self.options[key] == null) self.options[key] = Save.DEFAULT_OPTIONS[key];
    }
    self.onDone = o.onDone;
    self.index = 1;
    self.scroll = 0;
    self.view = groupView(rows, (_g, members) => OptionsMenu.pushGroup(self, members));
    return self;
  }

  // Lua: OptionsMenu.lua:639
  visible(): OptionRow[] {
    return this.view ?? this.rows;
  }

  // Lua: OptionsMenu.lua:643
  ensureVisible(): void {
    const rows = this.visible();
    if (this.index <= this.scroll) {
      this.scroll = this.index - 1;
    } else if (this.index > this.scroll + VISIBLE_ROWS) {
      this.scroll = this.index - VISIBLE_ROWS;
    }
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - VISIBLE_ROWS)));
  }

  // Lua: OptionsMenu.lua:654
  row(): OptionRow | undefined {
    return this.visible()[this.index - 1];
  }

  // Lua: OptionsMenu.lua:660 -- cursor onto a row by id, opening its group
  // page first if it lives in one. Returns the screen the row ended up on.
  focusRow(id: string): OptionsMenu | null {
    const rows = this.visible();
    for (let i = 0; i < rows.length; i++) {
      if (rows[i]!.id === id) {
        this.index = i + 1;
        this.ensureVisible();
        return this;
      }
    }
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (row.group && row.activate) {
        const group = GROUPS.find((g) => g.id === row.id);
        for (const member of group ? group.members : []) {
          if (member === id) {
            this.index = i + 1;
            row.activate(this.game);
            const page = this.game.stack.top();
            return page.focusRow ? page.focusRow(id) : page;
          }
        }
      }
    }
    return null;
  }

  // Lua: OptionsMenu.lua:686
  cycle(row: OptionRow, delta: number): void {
    // The Gen 1 row vocabulary, answered first so a mod's row steps here too.
    if (row.step) {
      row.step(this.game, delta);
      return;
    }
    // A port row owns its own ladder.
    if (row.cycle) {
      row.cycle(this.options, delta, this.game);
      return;
    }
    if (row.frame) {
      // Eight frames, wrapping (UpdateFrame masks to 3 bits).
      const frame = ((((this.options.frame ?? 1) - 1 + delta) % 8) + 8) % 8 + 1;
      this.options.frame = frame;
      // options_menu.asm:475 UpdateFrame reloads the tiles as the value changes.
      Font.setFrame(frame);
      return;
    }
    if (!row.values) return;
    const current = this.options[row.key!];
    let at = 1;
    for (let i = 0; i < row.values.length; i++) {
      if (row.values[i] === current) {
        at = i + 1;
        break;
      }
    }
    let next = at + delta;
    // Left at the first entry wraps to the last and vice versa, matching
    // Options_TextSpeed's .LeftPressed / .Increase clamps.
    if (next < 1) next = row.values.length;
    if (next > row.values.length) next = 1;
    this.options[row.key!] = row.values[next - 1];
    // SOUND has to apply itself as it steps, or the pan sits on the current
    // song until the next map change (#1471).
    if (row.key === "sound") Music.applyOptions(this.options);
  }

  // Lua: OptionsMenu.lua:729
  leave_(): void {
    if (this.onDone) this.onDone(this.options);
    if (this.game && this.game.stack && this.game.stack.top() === this) this.game.stack.pop();
  }

  // Lua: OptionsMenu.lua:736
  update(_dt?: number): void {
    const input = this.game ? this.game.input : undefined;
    if (!input) return;
    if (input.wasPressed("start") || input.wasPressed("b")) {
      this.leave_();
      return;
    }
    const rows = this.visible();
    if (input.wasPressed("up")) {
      this.index = this.index > 1 ? this.index - 1 : rows.length;
      this.ensureVisible();
      return;
    } else if (input.wasPressed("down")) {
      this.index = this.index < rows.length ? this.index + 1 : 1;
      this.ensureVisible();
      return;
    }
    const row = this.row();
    if (!row) return;
    if (input.wasPressed("a")) {
      if (row.cancel) {
        this.leave_();
      } else if (row.activate) {
        row.activate(this.game);
      } else {
        // A on a value row advances it (the ASM's shared right-press path).
        this.cycle(row, 1);
      }
      return;
    }
    if (input.wasPressed("left")) {
      this.cycle(row, -1);
    } else if (input.wasPressed("right")) {
      this.cycle(row, 1);
    }
  }

  // Lua: OptionsMenu.lua:776
  drawPanel(): void {
    Chrome.clear();
    // hlcoord 0,0 with b = SCREEN_HEIGHT - 2, c = SCREEN_WIDTH - 2.
    Chrome.textbox(0, 0, Chrome.SCREEN_W - 2, Chrome.SCREEN_H - 2);
    // The textbox spends column 19 on its frame: 17 characters from the
    // label's column 2, 8 from the value's column 11. Longer lines scroll
    // under the cursor.
    const rows = this.visible();
    for (let slot = 1; slot <= Math.min(VISIBLE_ROWS, rows.length); slot++) {
      const i = slot + this.scroll;
      const row = rows[i - 1];
      if (row) {
        const labelY = 2 + (slot - 1) * 2;
        const hot = i === this.index;
        const key = tostring(row.id ?? row.label);
        const fit = (text: string, col: number): string => {
          const room = 19 - col;
          if (hot) return Marquee.scroll(text, room, key);
          return Marquee.clip(text, room);
        };
        Chrome.print(fit(Strings.get(row.label), 2), 2, labelY);
        if (row.frame) {
          Chrome.print(Strings.get(":TYPE"), 10, labelY + 1);
          Chrome.print(tostring(this.options.frame ?? 1), 16, labelY + 1);
        } else if (row.text) {
          Chrome.print(":", 10, labelY + 1);
          Chrome.print(fit(row.text(this.options), 11), 11, labelY + 1);
        } else if (row.values) {
          Chrome.print(":", 10, labelY + 1);
          const value = this.options[row.key!];
          const text = row.display ? Strings.get(row.display[String(value)] ?? tostring(value)) : tostring(value);
          Chrome.print(fit(text, 11), 11, labelY + 1);
        } else if (typeof row.value === "function") {
          // the Gen 1 row's value reader, so a mod row shows its setting
          let text: string;
          try {
            text = tostring(row.value(this.game));
          } catch {
            text = "?";
          }
          Chrome.print(":", 10, labelY + 1);
          Chrome.print(fit(text, 11), 11, labelY + 1);
        }
      }
    }
    Chrome.cursor(1, 2 + (this.index - this.scroll - 1) * 2);
    // The ▼ hint every scrolling Gen 2 list shows when there is more below.
    if (this.scroll + VISIBLE_ROWS < rows.length) {
      GbcPalette.with(Chrome.DEFAULT_BOX_PALETTE, () => {
        Font.drawCode(Chrome.DOWN_ARROW, 1 * 8, (2 + VISIBLE_ROWS * 2 - 1) * 8);
      });
    }
  }

  // Lua: OptionsMenu.lua:826
  draw(): void {
    this.drawPanel();
  }

  // Lua: OptionsMenu.lua:830 -- the Gold screen is the panel.
  drawWidescreen(_winW: number, _winH: number): void {
    this.drawPanel();
  }
}

export default OptionsMenu;
