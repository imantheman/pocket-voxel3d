// Port of gen1recomp src/ui/QuantityBox.lua (GPLv3 + additional terms; see LICENSE.md).
// The "how many?" selector (DisplayChooseQuantityMenu, home/list_menu.asm):
// Up/Down step by 1 with 1..max roll-over, A confirms, B cancels.
// Shows a running price when opts.unitPrice is set.
//
// The game3 runtime reaches QuantityBox only from ui/mod_manager (deferred):
// mod_manager.lua:153 compares a stack layer's metatable with it. It draws
// with src.render.Font, the Gen 1 / Gen 2 host font, which has no gen3 module.
// NOT FAITHFUL: draw() stops with NotPortedError (porting it means porting the
// Gen 1 render stack, src/render/Font.lua); new/update are the real logic.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { format, sub } from "../../../../import/gen3/lua.ts";
import { find } from "../../platform/lpattern.ts";
import { notPorted } from "../../notported.ts";

export interface QuantityBoxOpts {
  max?: number;
  start?: number;
  unitPrice?: number;
  onDone?: (qty: number | null) => void;
  keepOpen?: boolean;
}

// home/print_bcd.asm:14-50
// Lua: QuantityBox.lua:23
function moneyField(amount: number | undefined): string {
  const digits = format("%06d", Math.max(0, Math.floor(amount ?? 0)));
  const first = find(digits, "[1-9]")?.[0] ?? digits.length;
  return "\xC2\xA5" + sub(digits, first); // "¥" (UTF-8 bytes)
}

// Lua: QuantityBox.lua:29
function wrap(v: number, max: number): number {
  if (v < 1) return max;
  if (v > max) return 1;
  return v;
}

export class QuantityBox {
  static isOpaque = false;

  game: any;
  max: number;
  qty: number;
  unitPrice: number | undefined;
  onDone: ((qty: number | null) => void) | undefined; // onDone(qty | nil on cancel)
  keepOpen: boolean | undefined;

  private constructor(game: any, opts: QuantityBoxOpts) {
    this.game = game;
    this.max = Math.max(1, opts.max ?? 99);
    this.qty = Math.min(opts.start ?? 1, this.max);
    this.unitPrice = opts.unitPrice;
    this.onDone = opts.onDone;
    this.keepOpen = opts.keepOpen;
  }

  // Lua: QuantityBox.lua:11
  static new(game: any, opts: QuantityBoxOpts): QuantityBox {
    return new QuantityBox(game, opts);
  }

  // Lua: QuantityBox.lua:35
  update(_dt?: number): void {
    const input = this.game.input;
    if (input.wasPressed("up")) {
      this.qty = wrap(this.qty + 1, this.max);
    } else if (input.wasPressed("down")) {
      this.qty = wrap(this.qty - 1, this.max);
    } else if (input.wasPressed("a")) {
      if (!this.keepOpen) this.game.stack.pop();
      if (this.onDone) this.onDone(this.qty);
    } else if (input.wasPressed("b")) {
      if (!this.keepOpen) this.game.stack.pop();
      if (this.onDone) this.onDone(null);
    }
  }

  // Lua: QuantityBox.lua:50
  draw(): void {
    // DisplayChooseQuantityMenu (home/list_menu.asm): non-priced box at
    // hlcoord 15,9 (interior 3x1); priced at hlcoord 7,9 (interior 11x1).
    // TextBoxBorder adds the frame, so outer size is +2 on each axis.
    // NOT FAITHFUL: Font.drawBox / Font.draw / Font.width are the Gen 1 host
    // font (src.render.Font), which has no gen3 module.
    void moneyField;
    notPorted("QuantityBox:draw (NOT FAITHFUL: src.render.Font is the Gen 1 host font)");
  }
}

export default QuantityBox;
