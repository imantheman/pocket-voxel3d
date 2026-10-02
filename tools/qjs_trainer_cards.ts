// The trainer-battle bench (gold_battle3d_entry.ts, TRAINERS=1) under the
// desktop QuickJS with every battle card the 3D stage places logged: which
// side, which atlas page, and its palette. Run with cc_qjs_bench_entry.sh.
// Never shipped.
import "./gold_battle3d_entry.ts";

const v = (globalThis as any).voxel;
let last = "";
v.card = (side: number, page: number, x: number, y: number): void => {
  const line = `[pv] card side ${side} page ${page} at ${x},${y}`;
  if (line !== last) console.log(line);
  last = line;
};
v.cardPal = (side: number, c0: number, c1: number, c2: number, c3: number): void => {
  console.log(`[pv] cardPal side ${side} ${[c0, c1, c2, c3].map((c) => c.toString(16)).join(" ")}`);
};
v.cardHide = (side: number): void => {
  console.log(`[pv] cardHide side ${side}`);
  last = "";
};
