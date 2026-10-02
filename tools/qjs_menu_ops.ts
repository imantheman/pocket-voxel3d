// The menu bench (gold_menus_entry.ts) under the desktop QuickJS with the
// world's scene ops logged -- which map slots show and hide as the START
// menu screens open and close (a hidden map is a rebuild on the 3DS when it
// shows again). Run with cc_qjs_bench_entry.sh. Never shipped.
import "./gold_menus_entry.ts";

const v = (globalThis as any).voxel;
for (const op of ["mapShow", "mapHide", "flatWorld", "tint", "arena", "arenaEnd"]) {
  v[op] = (...args: unknown[]): void => {
    console.log(`[pv] op ${op} ${args.join(",")}`);
  };
}
