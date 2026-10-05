// Port of gen1recomp src/ui/game3/money_box.lua (GPLv3 + additional terms; see LICENSE.md).
// Field money HUD (pret DrawMoneyBox / showmoneybox). Tile coords from script.

import { tonumber, tostring } from "../../../import/gen3/lua.ts";
import { seq } from "../platform/lt.ts";
import { Runtime } from "../core/runtime.ts";
import { RomText } from "../core/rom_text.ts";
import { Window } from "./window.ts";
import { FrlgFont } from "./frlg_font.ts";

// Lua: money_box.lua:12
function session_money(): number {
  // package.loaded["src.core.game3.runtime"]
  const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
  return tonumber(session ? session.money : undefined) ?? 0;
}

export const MoneyBox = {
  visible: false,
  x: 19,
  y: 1,
  _amount: 0,

  // Lua: money_box.lua:18
  show(x?: unknown, y?: unknown, amount?: unknown): void {
    MoneyBox.visible = true;
    MoneyBox.x = tonumber(x) ?? 19;
    MoneyBox.y = tonumber(y) ?? 1;
    if (amount != null) {
      MoneyBox._amount = Math.max(0, Math.floor(tonumber(amount) ?? 0));
    } else {
      MoneyBox._amount = session_money();
    }
  },

  // Lua: money_box.lua:29
  hide(): void {
    MoneyBox.visible = false;
  },

  // Lua: money_box.lua:33
  update(amount?: unknown): void {
    if (!MoneyBox.visible) return;
    if (amount != null) {
      MoneyBox._amount = Math.max(0, Math.floor(tonumber(amount) ?? 0));
    } else {
      MoneyBox._amount = session_money();
    }
  },

  // Lua: money_box.lua:42
  isVisible(): boolean {
    return MoneyBox.visible;
  },

  // Lua: money_box.lua:49
  draw(): void {
    if (!MoneyBox.visible) return;
    const x = MoneyBox.x, y = MoneyBox.y;
    // pret DrawMoneyBox: template = (x + 1, y + 1, 8, 3)
    const left = x + 1;
    const top = y + 1;
    Window.stdFrame(Window.template(left, top, 8, 3));
    // src/money.c:110
    Window.printPx(RomText.plain("gText_TrainerCardMoney"), left * 8, top * 8);
    // src/money.c:86
    const moneyStr: string = RomText.plain("gText_PokedollarVar1", { stringVars: seq(tostring(MoneyBox._amount)) });
    const mw = (FrlgFont.measure ? FrlgFont.measure(moneyStr, { small: true }) : undefined) || (6 * moneyStr.length);
    // pokefirered/src/money.c:87
    FrlgFont.draw(moneyStr, Math.max(left * 8, (left + 8) * 8 - mw), top * 8 + 12,
      { small: true, colors: FrlgFont.COLOR.NORMAL });
  },
};

export default MoneyBox;
