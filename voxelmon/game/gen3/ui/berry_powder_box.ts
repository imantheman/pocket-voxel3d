// Port of gen1recomp src/ui/game3/berry_powder_box.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/berry_powder.c:113 -- the field BERRY POWDER box. Lazily
// required by gen1recomp; it registers in G3Lazy at the end.

import { format, tonumber } from "../../../import/gen3/lua.ts";
import { Window } from "./window.ts";
import { FrlgFont } from "./frlg_font.ts";
import { RomText } from "../core/rom_text.ts";
import { Profile } from "../core/profile.ts";
import { Space } from "../core/scripting/space.ts";
import { Runtime } from "../core/runtime.ts";
import { G3Lazy } from "../core/lazy_registry.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

// pokefirered/src/berry_powder.c:120 (built on first use: no top-level reads of imports)
let _template: ReturnType<typeof Window.template> | undefined;
function TEMPLATE(): ReturnType<typeof Window.template> {
  return (_template ??= Window.template(1, 1, 8, 3));
}

// Lua: berry_powder_box.lua:19
function fieldOwner(): any {
  // package.loaded["src.core.game3.scripting.space"]
  return Space ? (Space.vm ?? undefined) : undefined;
}

// Lua: berry_powder_box.lua:24
function clamp(nIn: unknown): number {
  const n = Math.floor(tonumber(nIn) ?? 0);
  if (n < 0) return 0;
  if (n > BerryPowderBox.MAX_BERRY_POWDER) return BerryPowderBox.MAX_BERRY_POWDER;
  return n;
}

// pokefirered/src/berry_powder.c:90
// Lua: berry_powder_box.lua:32
function sessionPowder(): number {
  // package.loaded["src.core.game3.runtime"]
  const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
  return clamp(session ? session.berryPowder : undefined);
}

// Lua: berry_powder_box.lua:77
function layout(): any {
  let row: any;
  try { row = Profile.forSession(); } catch { row = undefined; }
  return row && row.ui != null && typeof row.ui === "object" ? row.ui.berryPowderBox : undefined;
}

export const BerryPowderBox = {
  // pokefirered/src/berry_powder.c:13
  MAX_BERRY_POWDER: 99999,

  visible: false,
  _amount: 0,
  _owner: undefined as any,

  // Lua: berry_powder_box.lua:38
  show(amount?: unknown): boolean {
    BerryPowderBox.visible = true;
    BerryPowderBox._owner = fieldOwner();
    BerryPowderBox._amount = clamp(amount != null ? amount : sessionPowder());
    return true;
  },

  // pokefirered/src/berry_powder.c:108
  // Lua: berry_powder_box.lua:46
  update(amount?: unknown): boolean {
    if (!BerryPowderBox.visible) return false;
    BerryPowderBox._amount = clamp(amount != null ? amount : sessionPowder());
    return true;
  },

  // pokefirered/src/berry_powder.c:128
  // Lua: berry_powder_box.lua:53
  hide(): boolean {
    BerryPowderBox.visible = false;
    BerryPowderBox._owner = undefined;
    return true;
  },

  // Lua: berry_powder_box.lua:59 (BerryPowderBox.reset = BerryPowderBox.hide)
  reset(): boolean {
    return BerryPowderBox.hide();
  },

  // Lua: berry_powder_box.lua:61
  isVisible(): boolean {
    if (BerryPowderBox.visible && BerryPowderBox._owner !== fieldOwner()) {
      BerryPowderBox.hide();
    }
    return BerryPowderBox.visible;
  },

  // Lua: berry_powder_box.lua:68
  amount(): number {
    return BerryPowderBox._amount;
  },

  // pokefirered/src/berry_powder.c:97
  // Lua: berry_powder_box.lua:73
  amountText(amount: unknown): string {
    return format("%5d", clamp(amount));
  },

  // Lua: berry_powder_box.lua:83
  draw(): void {
    if (!BerryPowderBox.visible) return;
    const L = layout();
    if (L) {
      const t = Window.template(L.left, L.top, L.width, L.height);
      const x = t.tilemapLeft * 8, y = t.tilemapTop * 8;
      Window.stdFrame(t);
      FrlgFont.draw(RomText.plain(L.title), x + L.titleX, y + L.titleY, { colors: FrlgFont.COLOR.NORMAL });
      FrlgFont.draw(BerryPowderBox.amountText(BerryPowderBox._amount), x + L.amountX, y + L.amountY,
        { colors: FrlgFont.COLOR.NORMAL });
      return;
    }
    const tpl = TEMPLATE();
    const px = tpl.tilemapLeft * 8, py = tpl.tilemapTop * 8;
    Window.stdFrame(tpl);
    // pokefirered/src/berry_powder.c:104
    FrlgFont.draw(RomText.plain("gOtherText_Powder"), px, py, { small: true, colors: FrlgFont.COLOR.NORMAL });
    // pokefirered/src/berry_powder.c:105
    FrlgFont.draw(BerryPowderBox.amountText(BerryPowderBox._amount), px + 39, py + 12,
      { small: true, colors: FrlgFont.COLOR.NORMAL });
  },
};

export default BerryPowderBox;

G3Lazy["src.ui.game3.berry_powder_box"] = BerryPowderBox;
