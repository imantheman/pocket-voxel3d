// Port of gen1recomp src/core/game3/field_plan.lua (GPLv3 + additional terms; see LICENSE.md).
// Prepare current/near seam cell windows ahead of drawing. Snapshot sampling
// preserves custom layouts; worker results never contain graphics objects.
//
// NOT FAITHFUL: Plan.prefetch starts with Brian's `love.thread` guard, and the
// 3DS has no threads, so it always returns there: no plan is ever queued and
// Plan.get always misses ("not_queued"); FieldView then takes its own direct
// sampling path, as Brian's game does without threads. The rest is ported as
// written. Snapshot tables are Lua sequences (field_cell_prepare.ts).

import { Prepare as Cells } from "./field_cell_prepare.ts";
import { Connections } from "./connections.ts";
import { Map } from "./map.ts";
import { VoidFill } from "./void_fill.ts";
import { Stream, type AssetStream } from "./asset_stream.ts";
import { FieldView } from "./field_view.ts";
import { Player } from "./player.ts";
import { NativeTileset } from "./tileset_native.ts";
import { ipairs, len, pairs, sort, type LuaTable } from "../platform/lt.ts";
import { format, tostring } from "../../../import/gen3/lua.ts";

let records: Record<string, any> = {};
let task: AssetStream | undefined;
const MARGIN = 4;
// love.thread / love.thread.newThread: absent on the 3DS (see header)
const HAS_THREADS = false;

// Lua: field_plan.lua:8
function stamp(layout: any, def: any): any {
  const borders: Record<number, number> = {};
  for (const [i, mid] of pairs<number>(layout.borderMids ?? {})) borders[i as number] = mid;
  return {
    layout, def, defPair: def.pair, revision: layout._revision ?? 0, cells: layout.cells, overrides: layout.overrides,
    width: layout.width, height: layout.height, trueWidth: layout.trueWidth, trueHeight: layout.trueHeight,
    borderWidth: layout.borderWidth, borderHeight: layout.borderHeight, borders,
    pair: layout.pair, midAt: layout.midAt,
  };
}

// Lua: field_plan.lua:16
function valid(record: any, mode: string): boolean {
  if (record.mode !== mode) return false;
  if (record.voidRevision !== (VoidFill._revision ?? 0)) return false;
  for (const [, s] of ipairs<any>(record.stamps)) {
    const l = s.layout;
    if (s.def.midLayout !== l || s.def.pair !== s.defPair || (l._revision ?? 0) !== s.revision || l.cells !== s.cells || l.overrides !== s.overrides
      || l.width !== s.width || l.height !== s.height || l.pair !== s.pair || l.midAt !== s.midAt) return false;
    if (l.trueWidth !== s.trueWidth || l.trueHeight !== s.trueHeight || l.borderWidth !== s.borderWidth
      || l.borderHeight !== s.borderHeight) return false;
    const current = l.borderMids ?? {};
    for (const [i, mid] of pairs(s.borders)) if (current[i] !== mid) return false;
    for (const [i, mid] of pairs(current)) if (s.borders[i] !== mid) return false;
  }
  return true;
}

// Lua: field_plan.lua:31
function graphValid(record: any, M: typeof Map): boolean {
  if (len(record.world) !== len(M.world ?? [null]) || len(record.neighbors) !== len(M.neighborList ?? [null])) {
    Plan._graphMiss = format("counts:%d/%d,%d/%d", len(record.world), len(M.world ?? [null]), len(record.neighbors), len(M.neighborList ?? [null])); return false;
  }
  for (const [i, entry] of ipairs<any>(M.world ?? [null])) {
    const old = record.world[i];
    if (old.id !== entry.id || old.def !== entry.def || old.ox !== entry.ox || old.oy !== entry.oy) {
      Plan._graphMiss = format("world:%s/%s,%s/%s,%s/%s", old.id, entry.id, old.ox, entry.ox, old.oy, entry.oy); return false;
    }
  }
  for (const [i, n] of ipairs<any>(M.neighborList ?? [null])) {
    const old = record.neighbors[i];
    if (old.dir !== n.dir || old.offset !== n.offset || old.def !== n.def) {
      Plan._graphMiss = format("neighbor:%s/%s,%s/%s", old.dir, n.dir, old.offset, n.offset); return false;
    }
  }
  return true;
}

// Lua: field_plan.lua:49
function contains(s: any, x: number, y: number, w: number, h: number): boolean {
  return x >= s.x0 && y >= s.y0 && x + w <= s.x0 + s.cols && y + h <= s.y0 + s.rows;
}

// Lua: field_plan.lua:56 -- [s, stamps, worldDefs, neighborDefs] or []
function snapshot(game: any, id: string, x: number, y: number, cols: number, rows: number, mode: string,
  Native: typeof NativeTileset, reachW: number, reachH: number): [any?, LuaTable?, LuaTable?, LuaTable?] {
  const maps = game.data.maps;
  const def = maps[id];
  const root = def && def.midLayout;
  if (!root) return [];
  // Map.load changes current before the next draw refreshes Map.world. Do not
  // replace a forecast with the previous root's graph during that interval.
  const world = id === Map._worldRoot ? Map.world : Map.computeWorld(maps, id, Map.WORLD_HOPS, reachW, reachH);
  const s: any = {
    x0: x - MARGIN, y0: y - MARGIN, cols: cols + MARGIN * 2, rows: rows + MARGIN * 2,
    mode, layouts: [null], neighbors: [null], world: [null],
  };
  const stamps: LuaTable = [null];
  const added = new globalThis.Map<object, Record<string, number>>();
  const neighborDefs: LuaTable = [null];
  // Lua: field_plan.lua:68
  const add = (d: any, ox: number, oy: number, primary?: boolean): number | undefined => {
    const l = d && d.midLayout;
    if (!l) return undefined;
    let positions = added.get(l);
    if (!positions) { positions = {}; added.set(l, positions); }
    const pair = l.pair ?? d.pair ?? root.pair ?? def.pair;
    const key = tostring(ox) + ":" + tostring(oy) + ":" + tostring(pair);
    if (positions[key] != null) return positions[key];
    let x0 = s.x0 - ox, y0 = s.y0 - oy;
    let x1 = x0 + s.cols - 1, y1 = y0 + s.rows - 1;
    if (!primary) {
      x0 = Math.max(0, x0); y0 = Math.max(0, y0);
      x1 = Math.min(l.width - 1, x1); y1 = Math.min(l.height - 1, y1);
    }
    const w = Math.max(0, x1 - x0 + 1), h = Math.max(0, y1 - y0 + 1);
    const packed = l.workerPacked && l.workerPacked();
    const lines: string[] = [];
    for (let cy = y0; cy <= (packed ? y0 - 1 : y0 + h - 1); cy++) {
      const bytes: string[] = [];
      for (let cx = x0; cx <= x0 + w - 1; cx++) {
        const mid = l.midAt(cx, cy);
        if (typeof mid !== "number" || mid < 0 || mid > 65535) return undefined;
        bytes.push(String.fromCharCode(mid % 256, Math.floor(mid / 256)));
      }
      lines.push(bytes.join(""));
    }
    const n = len(s.layouts) + 1;
    s.layouts[n] = {
      x0, y0, w, h, width: l.width, height: l.height,
      pair, blob: lines.join(""), packed,
    };
    stamps[n] = stamp(l, d); positions[key] = n;
    return n;
  };
  if (!add(def, 0, 0, true)) return [];
  const neighbors = id === Map.current ? Map.neighborList : Connections.each(def);
  for (const [, n] of ipairs<any>(neighbors ?? [null])) {
    const d = n.def ?? maps[n.map];
    const l = d && d.midLayout;
    if (d) neighborDefs[len(neighborDefs) + 1] = { dir: n.dir, offset: n.offset, def: d };
    if (l) {
      let ox = 0, oy = 0;
      if (n.dir === "north") { ox = n.offset; oy = -l.height; }
      else if (n.dir === "south") { ox = n.offset; oy = root.height; }
      else if (n.dir === "west") { ox = -l.width; oy = n.offset; }
      else { ox = root.width; oy = n.offset; }
      const index = add(d, ox, oy);
      if (index) s.neighbors[len(s.neighbors) + 1] = { dir: n.dir, offset: n.offset, layout: index };
    }
  }
  for (const [, entry] of ipairs<any>(world ?? [null])) {
    const index = add(entry.def, entry.ox, entry.oy, entry.id === id);
    if (index) s.world[len(s.world) + 1] = { layout: index, ox: entry.ox, oy: entry.oy };
  }
  const Void = VoidFill;
  if (mode !== "map" && mode !== "black" && Void.primaryFor(s.layouts[1].pair) === Void.PRIMARY) {
    // hasMid(pair) demand-loads the atlas. Forecasting must not bypass the
    // shared main-thread upload budget while the pair is still warming.
    const atlas = Native._pairs && Native._pairs[s.layouts[1].pair];
    if (!atlas) return [];
    const b = Void.borderFor(mode);
    let available = b != null;
    // (void_fill's border mids are a 0-based array)
    for (const mid of (b ? b.mids : [])) if (!Native.hasMid(atlas, mid)) available = false;
    if (available && b) {
      s.fill = { w: b.w, h: b.h, mids: [null] };
      b.mids.forEach((mid, i0) => { s.fill.mids[i0 + 1] = mid; });
    }
  }
  const worldDefs: LuaTable = [null];
  for (const [i, e] of ipairs<any>(world ?? [null])) worldDefs[i] = { id: e.id, def: e.def, ox: e.ox, oy: e.oy };
  return [s, stamps, worldDefs, neighborDefs];
}

export const Plan = {
  _graphMiss: undefined as string | undefined,
  _lastMiss: undefined as string | undefined,

  // Lua: field_plan.lua:52
  invalidate(): void {
    if (task) task.cancel();
    task = undefined; records = {};
  },

  // Lua: field_plan.lua:134
  prefetch(game: any): void {
    if (!(HAS_THREADS && game && game.data && game.data.maps)) return;
    if (Stream.workerFailed) return;
    if (!task) {
      task = Stream.newTask("cells", (id: string, data: any, err: any) => {
        const r = records[id]; if (r) { r.data = data; r.error = err; }
        if (err) console.log("[game3/field-plan] " + tostring(id) + ": " + tostring(err));
      });
    }
    // package.loaded field_view / player / tileset_native
    const View = FieldView;
    const P = Player;
    const Native = NativeTileset;
    if (!(View && P && Native && Map.current)) return;
    const vw = View._viewW ?? 240, vh = View._viewH ?? 160;
    const cols = Math.ceil(vw / 16) + 3, rows = Math.ceil(vh / 16) + 3;
    const cx = Math.floor(((P.px ?? 0) + 8 - vw / 2 + (View.cameraPanX ?? 0)) / 16) - 1;
    const cy = Math.floor(((P.py ?? 0) + 8 - vh / 2 + (View.cameraPanY ?? 0)) / 16) - 1;
    const mode = VoidFill.normalize(VoidFill.mode);
    const candidates: LuaTable = [null, { id: Map.current, ox: 0, oy: 0, distance: -1 }];
    const [x0, y0, x1, y1] = Map.warmRect();
    for (const [, entry] of ipairs<any>(Map.world ?? [null])) {
      if (entry.id !== Map.current && Map.warmNear(entry, x0, y0, x1, y1)) {
        const l = entry.def && entry.def.midLayout;
        if (l) {
          const dx = Math.max(entry.ox - P.cellX, P.cellX - (entry.ox + l.width), 0);
          const dy = Math.max(entry.oy - P.cellY, P.cellY - (entry.oy + l.height), 0);
          candidates[len(candidates) + 1] = { id: entry.id, ox: entry.ox, oy: entry.oy, distance: dx + dy };
        }
      }
    }
    sort<any>(candidates, (a, b) => a.distance < b.distance);
    const wanted: Record<string, boolean> = {};
    for (let i = 1; i <= Math.min(3, len(candidates)); i++) {
      const e = candidates[i];
      wanted[e.id] = true;
      const x = cx - e.ox, y = cy - e.oy;
      const record = records[e.id];
      if (!(record && valid(record, mode) && (e.id !== Map._worldRoot || graphValid(record, Map))
        && contains(record.snapshot, x - 1, y - 1, cols + 2, rows + 2)
        && (record.data || record.error || task.pending[e.id]))) {
        const keep: Record<string, boolean> = {};
        for (const [id] of pairs(records)) if (id !== e.id) keep[id] = true;
        task.retain(keep);
        const [s, stamps, worldDefs, neighborDefs] = snapshot(game, e.id, x, y, cols, rows, mode, Native, Math.ceil(vw / 16), Math.ceil(vh / 16));
        if (s) {
          records[e.id] = {
            def: game.data.maps[e.id], mode, snapshot: s, stamps,
            world: worldDefs, neighbors: neighborDefs, voidRevision: VoidFill._revision ?? 0,
          };
          task.submit!(e.id, s, i === 1 ? 0 : 1);
        } else records[e.id] = null;
      }
    }
    task.retain(wanted);
    for (const [id] of pairs(records)) if (!wanted[id]) records[id] = null;
    Stream.poll();
  },

  // Lua: field_plan.lua:188
  get(def: any, x: number, y: number, cols: number, rows: number, mode: string): any {
    // package.loaded["src.core.game3.asset_stream"]
    if (Stream) Stream.poll();
    const id = Map.current as string;
    const r = records[id];
    Plan._lastMiss = !r ? "not_queued" : r.def !== def ? "map_identity"
      : r.error ? "worker_error" : !r.data ? "pending" : !valid(r, mode) ? "layout_revision"
        : !graphValid(r, Map) ? "connections" : !contains(r.data, x, y, cols, rows) ? "window" : undefined;
    if (!Plan._lastMiss) return r.data;
    return undefined;
  },

  cell: Cells.cell,
};

export default Plan;
