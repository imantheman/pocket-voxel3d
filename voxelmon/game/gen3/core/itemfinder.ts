// Port of gen1recomp src/core/game3/itemfinder.lua (GPLv3 + additional terms; see LICENSE.md).
// The Itemfinder (pokefirered/src/itemfinder.c): the scan for the nearest
// hidden item, the ding / arrow sprite task and its draw.
// Return shapes: arrow_motion -> [dx, dy, turn] (internal).

import { ipairs, len, pairs, type LuaTable } from "../platform/lt.ts";
import { G } from "../platform/graphics.ts";
import { Connections } from "./connections.ts";
import { SE } from "./se_ids.ts";
import { Profile } from "./profile.ts";
import { Audio } from "./audio.ts";
import { FieldEffects } from "./field_effects.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ScanResult { underfoot: boolean; item?: any; itemX: number; itemY: number; dings: number }
export interface FinderSprite { anim: number; dx: number; dy: number; curX: number; curY: number; x: number; y: number; turn: number }
export interface ScanOpts {
  events?: LuaTable;
  px: number;
  py: number;
  flagSet: (ev: any) => boolean;
  width?: number;
  height?: number;
  eventsFor?: (mapId: any) => LuaTable;
  neighbors?: any;
  neighborList?: LuaTable;
}

// Lua: itemfinder.lua:5
const CENTER_X = 120, CENTER_Y = 76;
const STAR_ANIM = 4;

// Lua: itemfinder.lua:11
function is_hidden(ev: any): boolean {
  return ev.type === "hidden_item" || ev.kind === 7;
}

// Lua: itemfinder.lua:16 -- pokefirered/src/itemfinder.c:383
function register_if_closer(t: { found: boolean; itemX: number; itemY: number }, dx: number, dy: number): void {
  if (!t.found) {
    t.itemX = dx; t.itemY = dy; t.found = true;
    return;
  }
  const dx2 = Math.abs(t.itemX), dy2 = Math.abs(t.itemY);
  const dx3 = Math.abs(dx), dy3 = Math.abs(dy);
  if (dx2 + dy2 > dx3 + dy3) {
    t.itemX = dx; t.itemY = dy;
  } else if (dx2 + dy2 === dx3 + dy3 && (dy2 > dy3 || (dy2 === dy3 && t.itemY < dy))) {
    t.itemX = dx; t.itemY = dy;
  }
}

// Lua: itemfinder.lua:31 -- pokefirered/src/itemfinder.c:287
function hidden_item_at_pos(events: LuaTable, x: number, y: number, flagSet: (ev: any) => boolean): boolean {
  for (const [, ev] of ipairs<any>(events ?? {})) {
    if (is_hidden(ev) && ev.x === x && ev.y === y) {
      return !ev.underfoot && !flagSet(ev);
    }
  }
  return false;
}

// Lua: itemfinder.lua:40
function neighbor_list(opts: ScanOpts): LuaTable {
  if (opts.neighborList) return opts.neighborList;
  const list: LuaTable = [null];
  for (const [k, n] of pairs<any>(opts.neighbors ?? {})) {
    const dir = Connections.cardinal(n.dir ?? k);
    if (dir) {
      list[len(list) + 1] = { dir, map: n.map, mapId: n.mapId, def: n.def, offset: n.offset };
    }
  }
  return list;
}

// Lua: itemfinder.lua:53 -- pokefirered/src/fieldmap.c:761, src/itemfinder.c:312
function connected_hidden_item(opts: ScanOpts, lx: number, ly: number): boolean {
  const [conn, cx, cy] = Connections.atPos(neighbor_list(opts), lx, ly, opts.width!, opts.height!);
  if (!conn) return false;
  return hidden_item_at_pos(opts.eventsFor!((conn as any).map ?? (conn as any).mapId), cx!, cy!, opts.flagSet);
}

// Lua: itemfinder.lua:102 -- pokefirered/src/itemfinder.c:434, :535
const AFFINE_TURN = { left: 0, down: 0x40, right: 0x80, up: 0xC0 };
// Lua: itemfinder.lua:103
function arrow_motion(itemX: number, itemY: number, facing: string): [number, number, number] {
  if (itemX === 0 && itemY === 0) {
    if (facing === "left") return [-100, 0, AFFINE_TURN.left];
    if (facing === "up") return [0, -100, AFFINE_TURN.up];
    if (facing === "right") return [100, 0, AFFINE_TURN.right];
    return [0, 100, AFFINE_TURN.down];
  }
  const ax = Math.abs(itemX), ay = Math.abs(itemY);
  if (ax > ay) {
    if (itemX < 0) return [-100, 0, AFFINE_TURN.left];
    return [100, 0, AFFINE_TURN.right];
  }
  if (itemY < 0) return [0, -100, AFFINE_TURN.up];
  return [0, 100, AFFINE_TURN.down];
}

// Lua: itemfinder.lua:119
function spawn(anim: number, dx: number, dy: number, turn?: number): FinderSprite {
  const s = { anim, dx, dy, curX: 0, curY: 0, x: CENTER_X, y: CENTER_Y, turn: turn ?? 0 };
  Itemfinder._sprites[len(Itemfinder._sprites) + 1] = s;
  return s;
}

// Lua: itemfinder.lua:126 -- pokefirered/src/itemfinder.c:595, :632
function step_sprites(): void {
  const keep: (FinderSprite | null)[] = [null];
  for (const [, s] of ipairs<FinderSprite>(Itemfinder._sprites)) {
    s.curX = s.curX + s.dx;
    s.curY = s.curY + s.dy;
    s.x = CENTER_X + Math.floor(s.curX / 256);
    s.y = CENTER_Y + Math.floor(s.curY / 256);
    if (!(s.x <= 104 || s.x > 132 || s.y <= 60 || s.y > 88)) {
      keep[len(keep) + 1] = s;
    }
  }
  Itemfinder._sprites = keep;
}

// Lua: itemfinder.lua:150
const TEXT_KEYS: Record<string, Record<string, string>> = {
  frlg: { nothing: "gText_NopeTheresNoResponse", nearby: "gText_ItemfinderResponding", onTop: "gText_ItemfinderShakingWildly" },
  rse: { nothing: "gText_ItemFinderNothing", nearby: "gText_ItemFinderNearby", onTop: "gText_ItemFinderOnTop" },
};

export const Itemfinder = {
  // Lua: itemfinder.lua:8
  _task: null as any,
  _sprites: [null] as (FinderSprite | null)[],

  // Lua: itemfinder.lua:60 -- pokefirered/src/itemfinder.c:202
  scan(opts: ScanOpts): ScanResult | null {
    const t = { found: false, itemX: 0, itemY: 0 };
    for (const [, ev] of ipairs<any>(opts.events ?? {})) {
      if (is_hidden(ev) && !opts.flagSet(ev)) {
        const dx = ev.x - opts.px, dy = ev.y - opts.py;
        if (ev.underfoot) {
          if (dx === 0 && dy === 0) {
            // pokefirered/src/itemfinder.c:241
            return { underfoot: true, item: ev, itemX: 0, itemY: 0, dings: 3 };
          }
        } else if (dx >= -7 && dx <= 7 && dy >= -5 && dy <= 5) {
          register_if_closer(t, dx, dy);
        }
      }
    }
    // pokefirered/src/itemfinder.c:354
    if (opts.width && opts.height && opts.eventsFor) {
      for (let x = opts.px - 7; x <= opts.px + 7; x++) {
        for (let y = opts.py - 5; y <= opts.py + 5; y++) {
          if (x < 0 || x >= opts.width || y < 0 || y >= opts.height) {
            if (connected_hidden_item(opts, x, y)) {
              register_if_closer(t, x - opts.px, y - opts.py);
            }
          }
        }
      }
    }
    if (!t.found) return null;
    // pokefirered/src/itemfinder.c:255
    const ax = Math.abs(t.itemX), ay = Math.abs(t.itemY);
    let dings = 4;
    if (!(t.itemX === 0 && t.itemY === 0)) {
      if (ax > ay) {
        if (ax > 3) dings = 2;
      } else if (ay > 3) {
        dings = 2;
      }
    }
    return { underfoot: false, itemX: t.itemX, itemY: t.itemY, dings };
  },

  // Lua: itemfinder.lua:141 -- pokefirered/src/itemfinder.c:131
  start(task: any): void {
    Itemfinder._sprites = [null];
    task.timer = 0;
    task.dingNum = 0;
    task.remaining = task.result.dings;
    task.phase = "dings";
    Itemfinder._task = task;
  },

  // Lua: itemfinder.lua:156 -- pokeemerald/src/item_use.c:295
  textKey(kind: string, session?: any): string {
    const family = Profile.family(session);
    return (TEXT_KEYS[family] ?? TEXT_KEYS.frlg)[kind];
  },

  // Lua: itemfinder.lua:161
  isActive(): boolean {
    return Itemfinder._task != null;
  },

  // Lua: itemfinder.lua:165
  sprites(): (FinderSprite | null)[] {
    return Itemfinder._sprites;
  },

  // Lua: itemfinder.lua:170 -- pokefirered/src/itemfinder.c:158, :181
  update(): void {
    Itemfinder.runTask();
    step_sprites();
  },

  // Lua: itemfinder.lua:175
  runTask(): void {
    const t = Itemfinder._task;
    if (!(t && t.phase === "dings")) return;
    if (t.timer % 25 === 0) {
      if (t.remaining === 0) {
        t.phase = "message";
        const key = Itemfinder.textKey(t.result.underfoot ? "onTop" : "nearby");
        t.onMessage(key, () => {
          Itemfinder._task = null;
          Itemfinder._sprites = [null];
          t.onDone();
        });
        return;
      }
      Audio.playSe(SE.SE_ITEMFINDER);
      if (t.result.underfoot) {
        spawn(STAR_ANIM, 0, -100, 0);
      } else {
        const [dx, dy, turn] = arrow_motion(t.result.itemX, t.result.itemY, t.facing);
        spawn(t.dingNum, dx, dy, turn);
      }
      t.dingNum = t.dingNum + 1;
      t.remaining = t.remaining - 1;
    }
    t.timer = t.timer + 1;
  },

  // Lua: itemfinder.lua:203
  draw(): void {
    if (len(Itemfinder._sprites) === 0) return;
    const sheet = FieldEffects.loadSheet("itemfinder_arrow_star", 16, 16, 5);
    if (!sheet) return;
    G.setColor(1, 1, 1, 1);
    for (const [, s] of ipairs<FinderSprite>(Itemfinder._sprites)) {
      const q = sheet.quads[s.anim];
      if (q) {
        G.draw(sheet.image, q, s.x, s.y, -s.turn * Math.PI / 128, 1, 1, 8, 8);
      }
    }
  },

  // Lua: itemfinder.lua:217
  reset(): void {
    Itemfinder._task = null;
    Itemfinder._sprites = [null];
  },
};

export default Itemfinder;
