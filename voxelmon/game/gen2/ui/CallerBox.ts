// The caller-ID box an incoming phone call puts across the top of the
// screen: a port of gen1recomp src/ui/gen2/CallerBox.lua (bdfac727, MIT) --
// Phone_TextboxWithName (pokegold engine/phone/phone.asm:582):
//
//   Phone_CallerTextbox: hlcoord 0, 0 / ld b, 2 / ld c, SCREEN_WIDTH - 2 /
//   call Textbox
//
// so the box is the top four rows (b/c are INTERIOR rows and columns), the
// phone icon sits at (1,1), GetCallerClassAndName places the name from (3,1)
// with a ':' straight after it, and a trainer's class name goes at (6,2); a
// non-trainer (Mom, ELM, the wrong number) has no second line.
//
// The box goes up with the ring and stays for the whole call (Brian's
// choice: the port has no twenty-frame flash to hang the middle beats on).
//
// A state, not a widget: it rides the StateStack UNDER the call's text pages,
// so those draw over it as the cart's speech box draws over the tilemap.
// Deliberately no `update`: Game2's fixed step hands the tick to the TOP
// state, so an update here would stop the world and the script VM running
// the call. Pushed and popped by script/CallAsm.ts.
//
// The factory keeps the Lua's signature, CallerBox.new(name, className),
// which is how script/CallAsm.ts builds it (not through Screens).

import { Chrome } from "./Chrome.ts";
import { PhoneRing } from "../core/PhoneRing.ts";

// Lua: CallerBox.lua:60 -- Phone_CallerTextbox's own coordinates.
const BOX_X = 0;
const BOX_Y = 0;
const BOX_INTERIOR_W = 18;
const BOX_INTERIOR_H = 2;
const ICON_X = 1;
const ICON_Y = 1;
const NAME_X = 3;
const NAME_Y = 1;
const CLASS_X = 6;
const CLASS_Y = 2;

// Lua: CallerBox.lua:72 -- charmap.asm:88 `charmap "☎", $62`.
const PHONE_ICON = "☎";

export class CallerBox {
  [key: string]: any;
  name: string;
  className: string | undefined;
  /** A strip across the top, not a page: the overworld keeps drawing. */
  isOpaque = false;

  // Lua: CallerBox.lua:76 -- Phone.contactName's answer: the caller's name,
  // and the trainer class under it or undefined for a non-trainer.
  constructor(name?: string, className?: string) {
    this.name = name ?? "";
    this.className = className;
  }

  static new(name?: string, className?: string): CallerBox {
    return new CallerBox(name, className);
  }

  // Lua: CallerBox.lua:86
  draw(): void {
    Chrome.textbox(BOX_X, BOX_Y, BOX_INTERIOR_W, BOX_INTERIOR_H);
    Chrome.print(PHONE_ICON, ICON_X, ICON_Y);
    // GetCallerName writes ':' into the cell the string ended on, which is
    // what PhoneRing.callerId composes for the ring page.
    Chrome.print(PhoneRing.callerId(this.name), NAME_X, NAME_Y);
    if (this.className && this.className !== "") {
      Chrome.print(this.className, CLASS_X, CLASS_Y);
    }
  }
}

export default CallerBox;
