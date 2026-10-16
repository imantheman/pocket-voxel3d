// Imported ahead of gen2/main.ts by tools/qjs_prof_gen2_fps.ts: with
// BIN=true the harness's host gets the typed-array screen ops the 3DS shim
// has (lcdCellsBin, lcdObjsBin, lcdLinesBin), so Lcd.end sends as it does on
// the console rather than diffing rows into hex. Never shipped.
declare const BIN: boolean;
const v = (globalThis as unknown as { voxel: Record<string, unknown> }).voxel;
if (typeof BIN !== "undefined" && BIN) {
  const nop = (): void => {};
  v.lcdCellsBin = nop;
  v.lcdObjsBin = nop;
  v.lcdLinesBin = nop;
}
export {};
