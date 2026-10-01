// gen1recomp src/ui/gen2/ElevatorMenu.lua (bdfac727, MIT): the elevator's
// floor list (engine/events/elevator.asm Elevator_AskWhichFloor).
//
// Three maps have one -- Celadon's and Goldenrod's dept stores, and the
// Radio Tower -- and each names its floors with `elevfloor floor, warp, map`.
//
// Two panels, both transcribed:
//
//   "Now on:"   Elevator_GetCurrentFloorText -- `ld b, 4 / ld c, 8` at
//               hlcoord 0,0: a Textbox whose INTERIOR is 8 wide by 4 tall.
//               The label goes at (1,2) and the floor name at (4,4).
//   the list    Elevator_MenuHeader, `menu_coords 12, 1, 18, 9`, a SCROLLING
//               menu of `db 4, 0` -- four visible rows -- rows two apart, the
//               first one below the border (ScrollingMenu_PlaceCursor).
//
// The ride itself is Elevator_GoToFloor, which does NOT warp: World's
// openElevator stores the row's warp and map for the -1 door warp.

import G from "../platform/screen.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Chrome } from "./Chrome.ts";

export interface ElevatorFloor {
  floorId?: number;
  destWarp?: number;
  destMap?: any;
  [key: string]: any;
}

export interface ElevatorMenuOpts {
  floors?: ElevatorFloor[];
  currentMap?: any;
  floorNames?: string[] | null;
  onDone?: (row?: ElevatorFloor | null) => void;
}

// Lua: ElevatorMenu.lua:36 -- Elevator_GetCurrentFloorText's Textbox.
const NOW_X = 0, NOW_Y = 0, NOW_W = 8, NOW_H = 4;
const NOW_LABEL_X = 1, NOW_LABEL_Y = 2;
const NOW_FLOOR_X = 4, NOW_FLOOR_Y = 4;

// Lua: ElevatorMenu.lua:42 -- `menu_coords 12, 1, 18, 9` and
// GetMenuTextStartCoord's border + cursor offsets on it.
const LIST_X = 12, LIST_Y = 1, LIST_W = 7, LIST_H = 9;
const ITEM_X = 14, ITEM_Y = 2;
const VISIBLE = 4;

// Lua: ElevatorMenu.lua:46
const NOW_ON = Strings.source("Now on:");

// Lua: ElevatorMenu.lua:50 -- FloorToString's FLOOR_* names.
const FALLBACK_FLOORS = [
  "B4F", "B3F", "B2F", "B1F", "1F", "2F", "3F", "4F", "5F", "6F", "7F",
  "8F", "9F", "10F", "11F", "ROOF",
];

export class ElevatorMenu {
  // Lua: ElevatorMenu.lua:33
  static isOpaque = false;
  isOpaque = false;

  game: any;
  data: any;
  floors: ElevatorFloor[];
  floorNames: string[] | null | undefined;
  onDone?: (row?: ElevatorFloor | null) => void;
  origin: number | undefined;
  index: number;
  scroll: number;
  done?: boolean;
  [key: string]: any;

  /** Lua: ElevatorMenu.lua:55 -- floorNames is the importer's 0-based array. */
  static floorName(floors: unknown, row: number | null | undefined): string {
    if (Array.isArray(floors) && row != null && floors[row] != null) return floors[row];
    return FALLBACK_FLOORS[row ?? 0] ?? "?";
  }

  /** Lua: ElevatorMenu.lua:64 -- the four-row scroll window follows the cursor. */
  static scrollFor(index: number, count: number, scroll?: number): number {
    let s = scroll ?? 0;
    if (index - 1 < s) s = index - 1;
    if (index > s + VISIBLE) s = index - VISIBLE;
    return Math.max(0, Math.min(s, Math.max(0, count - VISIBLE)));
  }

  /**
   * Lua: ElevatorMenu.lua:73 -- opts: floors (the extracted elevfloor rows),
   * currentMap (the floor the player got in on), floorNames, onDone(row)
   */
  static new(game: any, opts?: ElevatorMenuOpts): ElevatorMenu {
    return new ElevatorMenu(game, opts ?? {});
  }

  constructor(game: any, opts: ElevatorMenuOpts) {
    this.game = game;
    this.data = (game && game.data) || {};
    this.floors = opts.floors || [];
    this.floorNames = opts.floorNames;
    this.onDone = opts.onDone;
    // .FindCurrentFloor: the row whose destination map is the one the player
    // came in from. A miss is `scf`, which the caller checks first.
    this.origin = undefined;
    for (let i = 0; i < this.floors.length; i++) {
      if (this.floors[i]!.destMap === opts.currentMap) {
        this.origin = i + 1;
        break;
      }
    }
    this.index = 1;
    this.scroll = ElevatorMenu.scrollFor(this.index, this.floors.length, 0);
  }

  /** Lua: ElevatorMenu.lua:93 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: ElevatorMenu.lua:95 */
  playSfx(name: string): void {
    const sfx = this.data.audio && this.data.audio.sfx;
    if (sfx && sfx[Sound.resolve(this.data, name)]) Sound.play(this.data, name);
  }

  /** Lua: ElevatorMenu.lua:102 */
  finish(row?: ElevatorFloor | null): void {
    if (this.done) return;
    this.done = true;
    if (this.onDone) this.onDone(row);
  }

  /** Lua: ElevatorMenu.lua:108 */
  update(_dt?: number): void {
    if (this.done) return;
    const input = this.game && this.game.input;
    if (!input) return;
    if (input.wasPressed("up") && this.index > 1) {
      this.index = this.index - 1;
    } else if (input.wasPressed("down") && this.index < this.floors.length) {
      this.index = this.index + 1;
    } else if (input.wasPressed("b")) {
      this.playSfx("Sfx_ReadText2");
      return this.finish(null);
    } else if (input.wasPressed("a")) {
      this.playSfx("Sfx_ReadText2");
      // `ld hl, wElevatorOriginFloor / cp [hl] / jr z, .quit`: picking the
      // floor you are on quits with carry -- the same FALSE a cancel gives.
      if (this.index === this.origin) return this.finish(null);
      return this.finish(this.floors[this.index - 1]);
    }
    this.scroll = ElevatorMenu.scrollFor(this.index, this.floors.length, this.scroll);
  }

  /** Lua: ElevatorMenu.lua:130 */
  drawPanel(): void {
    Chrome.textbox(NOW_X, NOW_Y, NOW_W, NOW_H);
    Chrome.print(NOW_ON, NOW_LABEL_X, NOW_LABEL_Y);
    const origin = this.origin != null ? this.floors[this.origin - 1] : undefined;
    Chrome.print(ElevatorMenu.floorName(this.floorNames, origin && origin.floorId), NOW_FLOOR_X, NOW_FLOOR_Y);

    Chrome.box(LIST_X, LIST_Y, LIST_W, LIST_H);
    for (let slot = 1; slot <= Math.min(VISIBLE, this.floors.length); slot++) {
      const row = this.floors[this.scroll + slot - 1];
      if (row) {
        Chrome.print(ElevatorMenu.floorName(this.floorNames, row.floorId), ITEM_X, ITEM_Y + (slot - 1) * 2);
      }
    }
    Chrome.cursor(ITEM_X - 1, ITEM_Y + (this.index - this.scroll - 1) * 2);
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: ElevatorMenu.lua:150 */
  draw(): void {
    this.drawPanel();
  }
}

export default ElevatorMenu;
