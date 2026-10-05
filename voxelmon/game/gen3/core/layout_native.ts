// Port of gen1recomp src/core/game3/layout_native.lua (GPLv3 + additional terms; see LICENSE.md).
// Native FRLG mid-grid layout handle (16px cells).
//
// Shapes (lt.ts): `decoded.cells` and `decoded.borderMids` are Lua sequences
// (slot 0 unused), as Brian's callers build them. NativePack.decodeMidLayout
// returns 0-based arrays; its callers (dataset, doors) convert with fromArray
// before calling fromDecoded. `overrides` is keyed by cy * 1024 + cx.
// package.loaded["src.core.game3.field_view"] / ["src.render.Assets"]: every
// module is loaded in the bundle, so they are imported directly.

import { pairs, len, isEmpty, ipairs, type LuaTable } from "../platform/lt.ts";
import { tonumber } from "../../../import/gen3/lua.ts";
import { FieldView } from "./field_view.ts";
import { Assets } from "../shared/render/Assets.ts";

export interface LayoutCell { mid: number; coll: number; elev: number }

export interface DecodedLayout {
  width?: number;
  height?: number;
  trueWidth?: number;
  trueHeight?: number;
  borderWidth?: number;
  borderHeight?: number;
  borderMids?: LuaTable;
  cells?: LuaTable;
}

export interface WorkerPacked {
  blob: string;
  off: number;
  width: number;
  trueWidth: number;
  trueHeight: number;
  borderWidth: number;
  borderHeight: number;
  borderMids: LuaTable;
  overrides: Record<number, { mid: number }>;
}

// Lua: layout_native.lua:6
function wrap_border(cx: number, cy: number, _w: number, _h: number, bw: number, bh: number): [number, number] {
  // FRLG: out-of-bounds samples border tiled from (0,0).
  // (Lua's % is floored, so the "< 0" corrections never fire; kept as Brian has them.)
  let bx = ((cx % bw) + bw) % bw;
  if (bx < 0) bx = bx + bw;
  let by = ((cy % bh) + bh) % bh;
  if (by < 0) by = by + bh;
  return [bx, by];
}

export class LayoutNative {
  mapId: string;
  pair: string;
  width: number;
  height: number;
  trueWidth: number;
  trueHeight: number;
  borderWidth: number;
  borderHeight: number;
  borderMids: LuaTable;
  cells: LuaTable;
  overrides: Record<number, LayoutCell>;
  _revision: number;
  _workerSource: {
    blob: string; cells: LuaTable; width?: number; height?: number; trueWidth?: number; trueHeight?: number;
  } | undefined;
  [key: string]: any;

  constructor(decoded: DecodedLayout, mapId: string, pair: string | undefined, sourceBlob?: string) {
    this.mapId = mapId;
    this.pair = pair ?? "sevii_outdoor";
    this.width = decoded.width ?? 0;
    this.height = decoded.height ?? 0;
    this.trueWidth = decoded.trueWidth ?? decoded.width ?? 0;
    this.trueHeight = decoded.trueHeight ?? decoded.height ?? 0;
    this.borderWidth = decoded.borderWidth ?? 1;
    this.borderHeight = decoded.borderHeight ?? 1;
    this.borderMids = decoded.borderMids ?? [null, 0];
    this.cells = decoded.cells ?? [null];
    this.overrides = {}; // [cy*1024+cx] = { mid, coll, elev }
    this._revision = 0;
    this._workerSource = sourceBlob
      ? {
        blob: sourceBlob, cells: decoded.cells,
        width: decoded.width, height: decoded.height, trueWidth: decoded.trueWidth ?? decoded.width,
        trueHeight: decoded.trueHeight ?? decoded.height,
      }
      : undefined;
  }

  // Lua: layout_native.lua:15
  static fromDecoded(decoded: DecodedLayout, mapId: string, pair?: string, sourceBlob?: string): LayoutNative {
    return new LayoutNative(decoded, mapId, pair, sourceBlob);
  }

  // Lua: layout_native.lua:38
  // Imported base grids are immutable in the built-in runtime; edits live in
  // overrides. Custom/mod layouts use sampled snapshots instead of this path.
  workerPacked(): WorkerPacked | undefined {
    const s = this._workerSource;
    if (!s || this.cells !== s.cells || this.width !== s.width || this.height !== s.height
      || this.trueWidth !== s.trueWidth || this.trueHeight !== s.trueHeight
      || this.cellAt !== LayoutNative.prototype.cellAt || this.midAt !== LayoutNative.prototype.midAt) return undefined;
    if (Assets && Assets.loader && len(Assets.loader.overrideOrder()) > 0) return undefined;
    const overrides: Record<number, { mid: number }> = {};
    const borders: LuaTable = [null];
    for (const [k, row] of pairs<LayoutCell>(this.overrides)) overrides[k as number] = { mid: row.mid };
    for (let i = 1; i <= this.borderWidth * this.borderHeight; i++) borders[i] = this.borderMids[i];
    // Lua: 17 + (blob:byte(15) * blob:byte(16)) * 2
    return {
      blob: s.blob, off: 17 + (s.blob.charCodeAt(14) * s.blob.charCodeAt(15)) * 2,
      width: this.width, trueWidth: this.trueWidth, trueHeight: this.trueHeight,
      borderWidth: this.borderWidth, borderHeight: this.borderHeight, borderMids: borders, overrides,
    };
  }

  // Lua: layout_native.lua:53
  cellAt(cx: number, cy: number): LayoutCell {
    const key = cy * 1024 + cx;
    const ov = this.overrides[key];
    if (ov) return ov;
    const tw = this.trueWidth ?? this.width;
    const th = this.trueHeight ?? this.height;
    if (cx >= 0 && cy >= 0 && cx < tw && cy < th) {
      return this.cells[cy * this.width + cx + 1]
        ?? { mid: 0, coll: 0xff, elev: 0 };
    }
    const [bx, by] = wrap_border(
      cx, cy, tw, th, this.borderWidth, this.borderHeight);
    const mid = this.borderMids[by * this.borderWidth + bx + 1] ?? 0;
    return { mid, coll: 0xff, elev: 0 };
  }

  // Lua: layout_native.lua:88
  midAt(cx: number, cy: number): number {
    return field(this, cx, cy, "mid", 0, undefined);
  }

  // Lua: layout_native.lua:92
  collAt(cx: number, cy: number): number {
    return field(this, cx, cy, "coll", 0xff, 0xff);
  }

  // Lua: layout_native.lua:96
  elevAt(cx: number, cy: number): number {
    return field(this, cx, cy, "elev", 0, 0);
  }

  // Lua: layout_native.lua:101
  /** Flat 1-based COLL_* array for Collision.bindMap. */
  collArray(): LuaTable | undefined {
    const w = this.width;
    const h = this.height;
    const tw = this.trueWidth ?? w;
    const th = this.trueHeight ?? h;
    const n = w * h;
    if (n <= 0) return undefined;
    const out: LuaTable = new Array(n + 1);
    out[0] = null;
    for (let cy = 0; cy <= h - 1; cy++) {
      for (let cx = 0; cx <= w - 1; cx++) {
        const i = cy * w + cx + 1;
        if (cx < tw && cy < th) {
          const ov = this.overrides[cy * 1024 + cx];
          const c = this.cells[i];
          out[i] = (ov && ov.coll) ?? (c && c.coll) ?? 0xff;
        } else {
          out[i] = 0xff;
        }
      }
    }
    return out;
  }

  // Lua: layout_native.lua:124
  applyOverride(xIn: unknown, yIn: unknown, mid: unknown, coll?: number | null, elev?: number | null): void {
    this._revision = (this._revision ?? 0) + 1;
    const x = tonumber(xIn) ?? 0, y = tonumber(yIn) ?? 0;
    this.overrides[y * 1024 + x] = {
      mid: tonumber(mid) ?? 0,
      coll: coll != null ? coll : 0xff,
      elev: elev ?? 0,
    };
    if (FieldView) {
      if (FieldView.invalidateLayoutCell) {
        FieldView.invalidateLayoutCell(this, x, y);
      } else {
        FieldView._nativeDirty = true;
      }
    }
  }

  // Lua: layout_native.lua:166 -- pokeemerald/src/battle_pyramid.c:1523
  stamp(src: any, oxIn: unknown, oyIn: unknown): number {
    if (src === null || typeof src !== "object" || src.cells === null || typeof src.cells !== "object") return 0;
    const ox = tonumber(oxIn) ?? 0, oy = tonumber(oyIn) ?? 0;
    const sw = src.trueWidth ?? src.width ?? 0;
    const sh = src.trueHeight ?? src.height ?? 0;
    let n = 0;
    for (let y = 0; y <= sh - 1; y++) {
      for (let x = 0; x <= sw - 1; x++) {
        const c = src.cells[y * src.width + x + 1];
        if (c) {
          this.overrides[(oy + y) * 1024 + ox + x] = {
            mid: c.mid ?? 0, coll: c.coll != null ? c.coll : 0xff, elev: c.elev ?? 0,
          };
          n = n + 1;
        }
      }
    }
    markDirty();
    if (n > 0) this._revision = (this._revision ?? 0) + 1;
    return n;
  }

  // Lua: layout_native.lua:189 -- pokeemerald/src/fieldmap.c:357
  setMetatiles(rows: LuaTable): number {
    let n = 0;
    const cells: LuaTable = [null];
    for (const [, r] of ipairs<any>(rows ?? [null])) {
      const x = tonumber(r.x) ?? 0, y = tonumber(r.y) ?? 0;
      const cur = this.cellAt(x, y);
      this.overrides[y * 1024 + x] = {
        mid: tonumber(r.mid) ?? (cur.mid ?? 0),
        coll: r.coll != null ? r.coll : cur.coll,
        elev: r.elev != null ? r.elev : (cur.elev ?? 0),
      };
      n = n + 1;
      cells[n * 2 - 1] = x;
      cells[n * 2] = y;
    }
    if (n > 0) {
      this._revision = (this._revision ?? 0) + 1;
      markCellsDirty(this, cells, n);
    }
    return n;
  }

  // Lua: layout_native.lua:207
  clearOverrides(): void {
    if (!isEmpty(this.overrides)) {
      this._revision = (this._revision ?? 0) + 1;
      this.overrides = {};
    }
    if (FieldView) {
      FieldView._nativeDirty = true;
    }
  }
}

// Lua: layout_native.lua:69 (`baseCellAt`)
const baseCellAt = LayoutNative.prototype.cellAt;

// Lua: layout_native.lua:71
function field(self: LayoutNative, cx: number, cy: number, name: keyof LayoutCell, missing: number, border: number | undefined): number {
  if (self.cellAt !== baseCellAt) return self.cellAt(cx, cy)[name];
  const ov = self.overrides[cy * 1024 + cx];
  if (ov) return ov[name];
  const tw = self.trueWidth ?? self.width;
  const th = self.trueHeight ?? self.height;
  if (cx >= 0 && cy >= 0 && cx < tw && cy < th) {
    const cell = self.cells[cy * self.width + cx + 1];
    if (cell) return cell[name];
    return missing;
  }
  if (border !== undefined) return border;
  const [bx, by] = wrap_border(
    cx, cy, tw, th, self.borderWidth, self.borderHeight);
  return self.borderMids[by * self.borderWidth + bx + 1] ?? 0;
}

// Lua: layout_native.lua:142
function markDirty(): void {
  if (FieldView) {
    FieldView._nativeDirty = true;
  }
}

// Re-sample only the written cells when there are few of them (per-frame
// metatile animations); bulk writes rebuild the whole view.
const MAX_CELL_INVALIDATIONS = 64;

// Lua: layout_native.lua:153
function markCellsDirty(layout: LayoutNative, cells: LuaTable, n: number): void {
  if (!FieldView) return;
  if (!FieldView.invalidateLayoutCell || n > MAX_CELL_INVALIDATIONS) {
    FieldView._nativeDirty = true;
    return;
  }
  for (let i = 1; i <= n * 2; i += 2) {
    FieldView.invalidateLayoutCell(layout, cells[i], cells[i + 1]);
  }
}

export default LayoutNative;
