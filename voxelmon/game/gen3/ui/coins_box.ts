// Port of gen1recomp src/ui/game3/coins_box.lua (GPLv3 + additional terms; see LICENSE.md).
// The field COINS box (pokefirered/src/coins.c ShowCoinsWindow). Lazily
// required by gen1recomp (pcall(require, "src.ui.game3.coins_box")); it
// registers in G3Lazy at the end.

import { format, tonumber, tostring } from "../../../import/gen3/lua.ts";
import { seq } from "../platform/lt.ts";
import { Window } from "./window.ts";
import { FrlgFont } from "./frlg_font.ts";
import { RomText } from "../core/rom_text.ts";
import { Profile } from "../core/profile.ts";
import { Runtime } from "../core/runtime.ts";
import { G3Lazy } from "../core/lazy_registry.ts";

// Lua: coins_box.lua:16
function session_coins(): number {
  // pcall(require, "src.core.game3.coins"): no such module (G3Lazy; absent = failed require)
  const Coins = G3Lazy["src.core.game3.coins"];
  if (Coins != null && typeof Coins === "object" && typeof Coins.get === "function") {
    let okG = true, n: unknown;
    try { n = Coins.get(); } catch { okG = false; }
    if (okG && tonumber(n) != null) return tonumber(n)!;
  }
  // package.loaded["src.core.game3.runtime"]
  const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
  return tonumber(session ? session.coins : undefined) ?? 0;
}

// Lua: coins_box.lua:27
function clamp(nIn: unknown): number {
  const n = Math.floor(tonumber(nIn) ?? 0);
  if (n < 0) return 0;
  if (n > CoinsBox.MAX_COINS) return CoinsBox.MAX_COINS;
  return n;
}

export const CoinsBox = {
  // pokefirered/include/constants/coins.h:4
  MAX_COINS: 9999,

  visible: false,
  x: 1,
  y: 1,
  _amount: 0,

  // Lua: coins_box.lua:34
  show(x?: unknown, y?: unknown, amount?: unknown): void {
    CoinsBox.visible = true;
    CoinsBox.x = tonumber(x) ?? 1;
    CoinsBox.y = tonumber(y) ?? 1;
    if (amount != null) {
      CoinsBox._amount = clamp(amount);
    } else {
      CoinsBox._amount = clamp(session_coins());
    }
  },

  // Lua: coins_box.lua:45
  hide(): void {
    CoinsBox.visible = false;
  },

  // Lua: coins_box.lua:49
  update(amount?: unknown): void {
    if (!CoinsBox.visible) return;
    if (amount != null) {
      CoinsBox._amount = clamp(amount);
    } else {
      CoinsBox._amount = clamp(session_coins());
    }
  },

  // Lua: coins_box.lua:58
  isVisible(): boolean {
    return CoinsBox.visible;
  },

  // Lua: coins_box.lua:62
  amount(): number {
    return CoinsBox._amount;
  },

  // pokefirered/src/coins.c:52
  // Lua: coins_box.lua:67
  countText(amount: unknown): string {
    return RomText.plain("gText_Coins", { stringVars: seq(format("%4d", clamp(amount))) });
  },

  // Lua: coins_box.lua:71
  draw(): void {
    if (!CoinsBox.visible) return;
    if (Profile.family() === "rse") {
      // pokeemerald/src/coins.c:14 PrintCoinsString, :24 ShowCoinsWindow
      const tpl = Window.template(CoinsBox.x, CoinsBox.y, 8, 2);
      Window.stdFrame(tpl);
      const text = RomText.plain("gText_Coins", { stringVars: seq(tostring(clamp(CoinsBox._amount))) });
      Window.printPx(text, CoinsBox.x * 8 + 64 - FrlgFont.measure(text), CoinsBox.y * 8 + 1);
      return;
    }
    // pokefirered/src/coins.c:79
    const left = CoinsBox.x + 1;
    const top = CoinsBox.y + 1;
    Window.stdFrame(Window.template(left, top, 8, 3));
    Window.printPx(RomText.plain("gText_Coins_2"), left * 8, top * 8);
    const countStr = CoinsBox.countText(CoinsBox._amount);
    const cw = (FrlgFont.measure ? FrlgFont.measure(countStr, { small: true }) : 0) || (6 * countStr.length);
    // pokefirered/src/coins.c:76
    FrlgFont.draw(countStr, Math.max(left * 8, (left + 8) * 8 - cw), top * 8 + 12,
      { small: true, colors: FrlgFont.COLOR.NORMAL });
  },
};

export default CoinsBox;

G3Lazy["src.ui.game3.coins_box"] = CoinsBox;
