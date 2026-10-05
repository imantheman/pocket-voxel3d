// Port of gen1recomp src/core/game3/field_cell_prepare.lua (GPLv3 + additional terms; see LICENSE.md).
// Immutable metatile/void resolution; no graphics or mutable field state.
//
// A snapshot (field_plan.ts) holds Lua sequences: s.layouts, s.neighbors,
// s.world; s.fill.mids. Blobs are byte strings; `blob:byte(i)` (1-based) is
// `blob.charCodeAt(i - 1)`. The result's `pairs` is a sequence; a cell's pair
// id indexes it directly.

import { len, ipairs, type LuaTable } from "../platform/lt.ts";

export interface CellPlan {
  blob: string;
  pairs: LuaTable;
  x0: number;
  y0: number;
  cols: number;
  rows: number;
}

// Lua: field_cell_prepare.lua:3
function sample(layout: any, x: number, y: number): number | undefined {
  const dx = x - layout.x0, dy = y - layout.y0;
  if (dx < 0 || dy < 0 || dx >= layout.w || dy >= layout.h) return undefined;
  const p = layout.packed;
  if (p) {
    const ov = p.overrides[y * 1024 + x];
    if (ov) return ov.mid;
    if (x >= 0 && y >= 0 && x < p.trueWidth && y < p.trueHeight) {
      const i = p.off + (y * p.width + x) * 4;
      const a = p.blob.charCodeAt(i - 1), b = p.blob.charCodeAt(i);
      return a + b * 256;
    }
    // Lua's % is floored
    const by = ((y % p.borderHeight) + p.borderHeight) % p.borderHeight;
    const bx = ((x % p.borderWidth) + p.borderWidth) % p.borderWidth;
    return p.borderMids[by * p.borderWidth + bx + 1] ?? 0;
  }
  const i = (dy * layout.w + dx) * 2 + 1;
  const a = layout.blob.charCodeAt(i - 1), b = layout.blob.charCodeAt(i);
  return a + b * 256;
}

// Lua: field_cell_prepare.lua:21
function inside(l: any, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < l.width && y < l.height;
}

// Lua: field_cell_prepare.lua:24 -- [mid, pair, void]
function resolve(s: any, x: number, y: number): [number | undefined, string | undefined, boolean?] {
  const root = s.layouts[1];
  if (inside(root, x, y)) return [sample(root, x, y), root.pair, false];
  const dir = (direction: string): [number | undefined, string | undefined] => {
    for (let i = len(s.neighbors); i >= 1; i--) {
      const n = s.neighbors[i];
      if (n.dir === direction) {
        const l = s.layouts[n.layout];
        let nx: number, ny: number;
        if (direction === "north") { nx = x - n.offset; ny = l.height + y; }
        else if (direction === "south") { nx = x - n.offset; ny = y - root.height; }
        else if (direction === "west") { nx = l.width + x; ny = y - n.offset; }
        else { nx = x - root.width; ny = y - n.offset; }
        if (inside(l, nx, ny)) return [sample(l, nx, ny), l.pair ?? root.pair];
      }
    }
    return [undefined, undefined];
  };
  let mid: number | undefined, pair: string | undefined;
  if (y < 0) [mid, pair] = dir("north"); else if (y >= root.height) [mid, pair] = dir("south");
  if (mid != null) return [mid, pair, false];
  if (x < 0) [mid, pair] = dir("west"); else if (x >= root.width) [mid, pair] = dir("east");
  if (mid != null) return [mid, pair, false];
  for (const [, entry] of ipairs<any>(s.world)) {
    if (entry.layout !== 1) {
      const l = s.layouts[entry.layout];
      const nx = x - entry.ox, ny = y - entry.oy;
      if (inside(l, nx, ny)) return [sample(l, nx, ny), l.pair ?? root.pair, false];
    }
  }
  return [sample(root, x, y), root.pair, true];
}

export type CellTuple = [number, string, boolean, boolean];
const scratch: CellTuple = [0, "", false, false];
const NONE: readonly [undefined?, undefined?, undefined?, undefined?] = Object.freeze([]);

export const Prepare = {
  // Lua: field_cell_prepare.lua:55
  cells(s: any, cancelled?: () => boolean): CellPlan {
    const pairList: LuaTable = [null];
    const ids: Record<string, number> = {};
    const rows: string[] = [];
    for (let y = s.y0; y <= s.y0 + s.rows - 1; y++) {
      if (cancelled && cancelled()) throw new Error("field cell preparation cancelled");
      const row: string[] = [];
      for (let x = s.x0; x <= s.x0 + s.cols - 1; x++) {
        let [mid, pair, isVoid] = resolve(s, x, y);
        if (mid == null) throw new Error("incomplete field snapshot");
        const skip = isVoid && s.mode === "black";
        if (isVoid && s.fill) {
          const f = s.fill;
          const fy = ((y % f.h) + f.h) % f.h, fx = ((x % f.w) + f.w) % f.w;
          mid = f.mids[fy * f.w + fx + 1] as number;
          pair = s.layouts[1].pair;
        }
        // Lua keys a table by pair; a nil pair would be an error there too
        const pk = pair as string;
        if (ids[pk] == null) { pairList[len(pairList) + 1] = pair; ids[pk] = len(pairList); }
        const id = ids[pk]!;
        row.push(String.fromCharCode(mid % 256, Math.floor(mid / 256), id % 256, Math.floor(id / 256),
          (isVoid ? 1 : 0) + (skip ? 2 : 0)));
      }
      rows.push(row.join(""));
    }
    return { blob: rows.join(""), pairs: pairList, x0: s.x0, y0: s.y0, cols: s.cols, rows: s.rows };
  },

  // Lua: field_cell_prepare.lua:78 -- [mid, pair, void, skip]; [] (all nil) outside the plan.
  // Called per drawn cell per frame, where the Lua returns four values without
  // allocating: the tuple is one shared array, valid until the next call
  // (destructure it at once).
  cell(plan: CellPlan, x: number, y: number): CellTuple | readonly [undefined?, undefined?, undefined?, undefined?] {
    const dx = x - plan.x0, dy = y - plan.y0;
    if (dx < 0 || dy < 0 || dx >= plan.cols || dy >= plan.rows) return NONE;
    const i = (dy * plan.cols + dx) * 5;
    const b = plan.blob;
    const lo = b.charCodeAt(i), hi = b.charCodeAt(i + 1), p0 = b.charCodeAt(i + 2), p1 = b.charCodeAt(i + 3);
    const flags = b.charCodeAt(i + 4);
    const t = scratch;
    t[0] = lo + hi * 256;
    t[1] = plan.pairs[p0 + p1 * 256];
    t[2] = flags % 2 === 1;
    t[3] = flags >= 2;
    return t;
  },
};

export default Prepare;
