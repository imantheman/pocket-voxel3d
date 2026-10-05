// Port of gen1recomp src/core/game3/quest_log.lua (GPLv3 + additional terms; see LICENSE.md).
// Native Quest Log: bounded, data-only scenes. Playback never runs game logic.
// pret quest_log.c: four scenes, descending scene numbers, A next / B finish.
//
// Shapes (Brian's, serialized by save_schema_firered): a log is
// `{ version: 1, scenes: seq(scene...), final? }`; a scene is
// `{ map, frames: seq(frame...), events: seq(event...), tiles: {"x,y": seq(mid, pair)}, song }`;
// a frame is `{ x, y, actors: seq(actor...) }`.
// NOT FAITHFUL (ties): trimActors sorts with lt.ts sort, which is stable where
// LuaJIT's is not, so actors at equal distance may keep another order.

import { ipairs, len, insert, remove, sort, pairs, seq } from "../platform/lt.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface QuestActor { id: number; x: number; y: number; [k: string]: any }
export interface QuestFrame { x: number; y: number; actors: any; [k: string]: any }
export interface QuestEvent { key: string; args: any; frame: number; [k: string]: any }
export interface QuestScene { map: string; frames: any; events: any; tiles?: any; song?: any; [k: string]: any }
export interface QuestLog { version: number; scenes: any; final?: QuestScene; [k: string]: any }

function isTable(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === "object";
}

// Lua: quest_log.lua:4
function copy<T>(v: T): T {
  if (!isTable(v)) return v;
  if (Array.isArray(v)) {
    const t: any[] = new Array(v.length);
    for (let i = 0; i < v.length; i++) t[i] = v[i] == null ? null : copy(v[i]);
    return t as T;
  }
  const t: any = {};
  for (const k of Object.keys(v)) {
    const x = (v as any)[k];
    if (x != null) t[k] = copy(x);
  }
  return t;
}

// Lua: quest_log.lua:8
function sameFlat(a: any, b: any): boolean {
  if (!isTable(a) || !isTable(b)) return false;
  for (const [k, v] of pairs(b)) if (isTable(v) || a[k] !== v) return false;
  for (const [k] of pairs(a)) if (b[k] == null) return false;
  return true;
}

// Lua: quest_log.lua:30
function empty(): QuestLog { return { version: 1, scenes: seq() }; }

// Lua: quest_log.lua:106
export class Playback {
  scenes: any;
  index: number;
  ticks: number;
  final: QuestScene | undefined;
  done?: boolean;

  constructor(scenes: any, index: number, ticks: number, final: QuestScene | undefined) {
    this.scenes = scenes;
    this.index = index;
    this.ticks = ticks;
    this.final = final;
  }

  // Lua: quest_log.lua:112
  current(): QuestScene | undefined { return this.scenes[this.index] ?? this.final; }

  // Lua: quest_log.lua:113
  number(): number { return Math.max(0, len(this.scenes) - this.index + 1); }

  // Lua: quest_log.lua:114
  isFinal(): boolean { return this.index > len(this.scenes); }

  // Lua: quest_log.lua:115
  next(): void {
    if (this.isFinal()) this.done = true; else {
      this.index = this.index + 1; this.ticks = 0;
      if (this.isFinal() && !this.final) this.done = true;
    }
  }

  // Lua: quest_log.lua:121
  update(input?: any): void {
    if (this.done) return;
    input = input ?? {}; this.ticks = this.ticks + 1;
    if (input.b) { this.done = true; return; }
    if (input.a) { this.next(); return; }
    const scene = this.current()!;
    const duration = this.isFinal() ? 127 : Math.max(180, len(scene.frames) * 6, len(scene.events) * 180);
    if (this.ticks >= duration) this.next();
  }

  // Lua: quest_log.lua:130
  frame(): QuestFrame | undefined {
    const scene = this.current();
    if (!scene) return undefined;
    const frames = scene.frames;
    const i = Math.min(len(frames), Math.floor(this.ticks / 6) + 1);
    const f = copy(frames[i]); const n = frames[i + 1];
    // Smooth the recorded 10 Hz movement to the native 60 Hz presentation.
    if (n) {
      const t = (this.ticks % 6) / 6;
      if (Math.abs(n.x - f.x) <= 32 && Math.abs(n.y - f.y) <= 32) {
        f.x = f.x + (n.x - f.x) * t; f.y = f.y + (n.y - f.y) * t;
      }
      const byId: Record<number, any> = {}; for (const [, a] of ipairs(n.actors)) byId[a.id] = a;
      for (const [, a] of ipairs(f.actors)) {
        const b = byId[a.id];
        if (b && Math.abs(a.x - b.x) <= 32 && Math.abs(a.y - b.y) <= 32) {
          a.x = a.x + (b.x - a.x) * t; a.y = a.y + (b.y - a.y) * t;
        }
      }
    }
    return f;
  }

  // Lua: quest_log.lua:152
  event(): QuestEvent | undefined {
    const scene = this.current(); if (!scene) return undefined;
    const duration = Math.max(180, len(scene.frames) * 6, len(scene.events) * 180);
    return scene.events[Math.min(len(scene.events), Math.floor(this.ticks / (duration / len(scene.events))) + 1)];
  }
}

export const Q = {
  MAX_SCENES: 4, MAX_FRAMES: 300, MAX_EVENTS: 8, MAX_ACTORS: 24, VIEW_DX: 136, VIEW_DY: 112,

  // Lua: quest_log.lua:14
  trimActors(f: QuestFrame): QuestFrame {
    const keep: any = seq(), rest: any = seq();
    for (const [, a] of ipairs(f.actors)) {
      if (a.id === 255) keep[len(keep) + 1] = a;
      else if (Math.abs(a.x - f.x) <= Q.VIEW_DX && Math.abs(a.y - f.y) <= Q.VIEW_DY) rest[len(rest) + 1] = a;
    }
    const room = Q.MAX_ACTORS - len(keep);
    if (len(rest) > room) {
      sort<any>(rest, (a, b) =>
        Math.abs(a.x - f.x) + Math.abs(a.y - f.y) < Math.abs(b.x - f.x) + Math.abs(b.y - f.y));
    }
    const m = Math.min(len(rest), Math.max(0, room));
    for (let i = 1; i <= m; i++) keep[len(keep) + 1] = rest[i];
    f.actors = keep;
    return f;
  },

  // Lua: quest_log.lua:31
  restore(value: any): QuestLog {
    const log = empty();
    if (!isTable(value) || value.version !== 1 || !isTable(value.scenes)) return log;
    const nScenes = len(value.scenes);
    for (let i = Math.max(1, nScenes - Q.MAX_SCENES + 1); i <= nScenes; i++) {
      const scene = value.scenes[i];
      if (isTable(scene) && typeof scene.map === "string" && isTable(scene.frames)
          && len(scene.frames) > 0 && isTable(scene.events) && len(scene.events) > 0) {
        const row: QuestScene = { map: scene.map, frames: seq(), events: seq(), tiles: copy(scene.tiles ?? {}), song: scene.song };
        if (row.song == null) delete row.song;
        const nf = Math.min(len(scene.frames), Q.MAX_FRAMES);
        for (let j = 1; j <= nf; j++) {
          const f = scene.frames[j];
          if (isTable(f) && typeof f.x === "number" && typeof f.y === "number"
              && isTable(f.actors)) {
            const frame = copy(f); frame.actors = seq();
            for (const [, a] of ipairs(f.actors)) {
              if (isTable(a) && typeof a.id === "number") frame.actors[len(frame.actors) + 1] = copy(a);
            }
            row.frames[len(row.frames) + 1] = Q.trimActors(frame as QuestFrame);
          }
        }
        const ne = Math.min(len(scene.events), Q.MAX_EVENTS);
        for (let j = 1; j <= ne; j++) {
          const e = scene.events[j];
          if (isTable(e) && typeof e.key === "string" && isTable(e.args)) {
            row.events[len(row.events) + 1] = copy(e);
          }
        }
        if (len(row.frames) > 0 && len(row.events) > 0) log.scenes[len(log.scenes) + 1] = row;
      }
    }
    if (isTable(value.final) && isTable(value.final.frames) && len(value.final.frames) > 0) {
      log.final = Q.restore({ version: 1, scenes: seq(value.final) }).scenes[1];
      if (log.final == null) delete log.final;
    }
    return log;
  },

  // Lua: quest_log.lua:64
  export(session: any): QuestLog { return Q.restore(session ? session.questLog : session); },

  // Lua: quest_log.lua:65
  record(session: any, key: string, args: any, frame: QuestFrame | null | undefined): void {
    if (!session || !frame || !session.map) return;
    session.questLog = session.questLog ?? empty();
    const scenes = session.questLog.scenes;
    let scene = scenes[len(scenes)];
    if (session._questNewScene || !scene || scene.map !== session.map || len(scene.frames) >= Q.MAX_FRAMES || len(scene.events) >= Q.MAX_EVENTS) {
      delete session._questNewScene;
      scene = { map: session.map, frames: seq(copy(frame)), events: seq() };
      scenes[len(scenes) + 1] = scene;
      if (len(scenes) > Q.MAX_SCENES) remove(scenes, 1);
    }
    const event: QuestEvent = { key, args: copy(args ?? {}), frame: len(scene.frames) };
    const previous = scene.events[len(scene.events)];
    // Repeated healing/arrival at the same spot should not evict useful history.
    if (previous && previous.key === key && previous.frame === event.frame && key === "MonsWereFullyRestoredAtCenter") return;
    insert(scene.events, event);
  },

  // Lua: quest_log.lua:82
  sample(session: any, frame: QuestFrame, elapsed?: number): void {
    const scenes = session && session.questLog && session.questLog.scenes;
    const scene = scenes && scenes[len(scenes)];
    if (session._questNewScene || !scene || scene.map !== session.map || len(scene.frames) >= Q.MAX_FRAMES) return;
    session._questSampleTicks = (session._questSampleTicks ?? 0) + (elapsed ?? 1);
    if (session._questSampleTicks < 6) return;
    session._questSampleTicks = 0;
    scene.frames[len(scene.frames) + 1] = copy(frame);
  },

  // Tiles are deduplicated per scene, outside the 10 Hz actor samples.
  // Lua: quest_log.lua:92
  tileScene(session: any): QuestScene | undefined {
    const scenes = session && session.questLog && session.questLog.scenes;
    const scene = scenes && scenes[len(scenes)];
    if (session._questNewScene || !scene || scene.map !== session.map || len(scene.frames) >= Q.MAX_FRAMES) return undefined;
    scene.tiles = scene.tiles ?? {};
    return scene;
  },

  // Lua: quest_log.lua:99
  addTiles(session: any, tiles: any): void {
    const scene = Q.tileScene(session);
    if (!scene) return;
    for (const [key, tile] of pairs(tiles ?? {})) {
      if (!sameFlat(scene.tiles[key], tile)) scene.tiles[key] = copy(tile);
    }
  },

  // Lua: quest_log.lua:107
  playback(logIn: any, finalScene?: QuestScene | null): Playback | undefined {
    const log = Q.restore(logIn);
    if (len(log.scenes) === 0) return undefined;
    return new Playback(log.scenes, 1, 0, copy(finalScene ?? log.final));
  },
};

export default Q;
