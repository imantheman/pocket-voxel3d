// Port of gen1recomp src/ui/game3/elevator_window.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/field_specials.c:1094
//
// Port notes:
// - Lazily required (pcall(require) from adapters, lazyReq from ui_pass,
//   Game3's soft reset): registers as G3Lazy["src.ui.game3.elevator_window"].
// - package.loaded["src.core.game3.scripting.space"] and the profile require:
//   static imports.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tostring } from "../../../import/gen3/lua.ts";
import { Window } from "./window.ts";
import { FrlgFont } from "./frlg_font.ts";
import { RomText } from "../core/rom_text.ts";
import { Profile } from "../core/profile.ts";
import { Space } from "../core/scripting/space.ts";
import { G3Lazy } from "../core/lazy_registry.ts";

// pokefirered/src/field_specials.c:727
const LEFT = 22;
const TOP = 1;
const WIDTH = 7;
const HEIGHT = 4;

// Lua: elevator_window.lua:18 (built on first use: module scope must not call
// into the import cycle)
let TEMPLATE_: ReturnType<typeof Window.template> | undefined;
function TEMPLATE(): ReturnType<typeof Window.template> {
  if (!TEMPLATE_) TEMPLATE_ = Window.template(LEFT, TOP, WIDTH, HEIGHT);
  return TEMPLATE_;
}

// Lua: elevator_window.lua:25
function fieldOwner(): any {
  const S: any = Space;
  return (S && S.vm) || undefined;
}

// Lua: elevator_window.lua:67
function rseLayout(): any {
  let P: any;
  try { P = (Profile as any).forSession(undefined); } catch { return undefined; }
  return (P && P.ui && P.ui.elevatorWindow) || undefined;
}

// Lua: elevator_window.lua:39
// pokefirered/src/field_specials.c:1113
function hide(): boolean {
  ElevatorWindow.visible = false;
  ElevatorWindow._label = undefined;
  ElevatorWindow._owner = undefined;
  return true;
}

export const ElevatorWindow = {
  LEFT,
  TOP,
  WIDTH,
  HEIGHT,
  // pokefirered/src/field_specials.c:1108
  LABEL_RIGHT: 56,

  visible: false,
  _label: undefined as string | undefined,
  _owner: undefined as any,

  // Lua: elevator_window.lua:31
  // pokefirered/src/field_specials.c:1102
  show(floorLabel?: any): boolean {
    ElevatorWindow.visible = true;
    ElevatorWindow._label = floorLabel ? tostring(floorLabel) : undefined;
    ElevatorWindow._owner = fieldOwner();
    return true;
  },

  hide,
  // Lua: elevator_window.lua:46
  reset: hide,

  // Lua: elevator_window.lua:48
  isVisible(): boolean {
    if (ElevatorWindow.visible && ElevatorWindow._owner !== fieldOwner()) {
      ElevatorWindow.hide();
    }
    return ElevatorWindow.visible;
  },

  // Lua: elevator_window.lua:55
  label(): string | undefined {
    return ElevatorWindow._label;
  },

  // Lua: elevator_window.lua:60
  // pokefirered/src/field_specials.c:1107
  labelX(): number {
    const label = ElevatorWindow._label;
    if (!label) return ElevatorWindow.LEFT * 8;
    const w = (FrlgFont.measure && FrlgFont.measure(label)) || (6 * label.length);
    return ElevatorWindow.LEFT * 8 + ElevatorWindow.LABEL_RIGHT - w;
  },

  // Lua: elevator_window.lua:72
  draw(): void {
    if (!ElevatorWindow.visible) return;
    const L = rseLayout();
    if (L) {
      const t = Window.template(L.left, L.top, L.width, L.height);
      Window.stdFrame(t);
      const centered = (text: any, y: number): void => {
        const w = FrlgFont.measure(text);
        // pokeemerald/src/field_specials.c:1893
        Window.printPx(text, L.left * 8 + Math.floor((L.center - w) / 2), L.top * 8 + y);
      };
      centered(RomText.plain(L.nowOn), L.titleY);
      if (ElevatorWindow._label) centered(ElevatorWindow._label, L.labelY);
      return;
    }
    const tpl = TEMPLATE();
    const left = tpl.tilemapLeft, top = tpl.tilemapTop;
    Window.stdFrame(tpl);
    // pokefirered/src/field_specials.c:1105
    Window.printPx(RomText.plain("gText_NowOn"), left * 8, top * 8 + 2);
    const label = ElevatorWindow._label;
    if (label) {
      // pokefirered/src/field_specials.c:1108
      Window.printPx(label, ElevatorWindow.labelX(), top * 8 + 16);
    }
  },
};

G3Lazy["src.ui.game3.elevator_window"] = ElevatorWindow;

export default ElevatorWindow;
