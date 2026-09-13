// Slot-machine art (engine/slots/slot_machine.asm).
//
// SlotMachineTiles2 is a 32x48 2bpp sheet — 4 columns of 8px by 6 rows — and
// the six symbols are CUT from it rather than laid out in it: each symbol's
// `tiles` value in field.slotSymbols is a 16-bit pair, the high byte naming
// the tile its TOP half starts at and the low byte its bottom half, and each
// half is a 16-wide strip spanning two of the sheet's columns. The cook
// assembles them (cook/atlas.ts), so this stage only has to land the sheet.
//
// Not extracted: SlotMachineTiles1, the machine's own 128x24 frame. Its
// tilemap would cost another 48 tile codes in the UI page, and the port draws
// the chrome from the GB's ordinary box tiles instead — the symbols are the
// part you actually read.
import type { Ctx } from "../ctx.ts";
import { GfxImage, blit, decode2bpp } from "../gfx.ts";

export function extractSlots(ctx: Ctx): Record<string, unknown> {
  const anyCtx = ctx as unknown as { rom: any; gfx: any };
  const out: Record<string, unknown> = {};
  let sym: any;
  try {
    sym = ctx.symbol("SlotMachineTiles2");
  } catch {
    console.warn("slots: no symbol SlotMachineTiles2");
    return out;
  }
  const cols = 4;
  const rows = 6;
  const w = cols * 8;
  const h = rows * 8;
  try {
    const bytes = anyCtx.rom.bytes(sym.bank, sym.address, cols * rows * 16);
    const page = new GfxImage(w, h);
    for (let i = 0; i < cols * rows; i++) {
      const tile = decode2bpp(bytes.slice(i * 16, i * 16 + 16), 8, 8, true);
      blit(page, tile, (i % cols) * 8, Math.floor(i / cols) * 8);
    }
    anyCtx.gfx.add("slots/wheel", page);
    out["slots/wheel"] = { w, h };
    console.log("slots: slots/wheel " + w + "x" + h);
  } catch (e) {
    console.warn("slots: SlotMachineTiles2 failed: " + String(e).slice(0, 80));
  }
  return out;
}
