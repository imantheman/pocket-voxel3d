// Port of gen1recomp src/core/game3/task.lua (GPLv3 + additional terms; see LICENSE.md).
// Lightweight timed task chain for game3 (pret Task_* analogue). Used by
// Oak intro beats (pokeball, shrink) and reusable from adapters.

import { len, remove } from "../platform/lt.ts";
import { tonumber, tostring } from "../../../import/gen3/lua.ts";

export interface G3Task {
  id: number;
  fn: ((t: G3Task, dt: number) => unknown) | undefined;
  frames: number;
  maxFrames: number | undefined;
  data: any;
  done: boolean;
  onDone: ((t: G3Task) => void) | undefined;
}

export interface TaskOpts { frames?: number; data?: any; onDone?: (t: G3Task) => void }

export const Task = {
  _list: [null] as (G3Task | null)[],
  _nextId: 1,

  // Lua: task.lua:11 -- fn(task, dt) -> true when finished
  spawn(fn: ((t: G3Task, dt: number) => unknown) | undefined, opts?: TaskOpts): G3Task {
    const o = opts || {};
    const id = Task._nextId;
    Task._nextId = id + 1;
    const t: G3Task = {
      id,
      fn,
      frames: 0,
      maxFrames: tonumber(o.frames),
      data: o.data || {},
      done: false,
      onDone: o.onDone,
    };
    Task._list[len(Task._list) + 1] = t;
    return t;
  },

  // Lua: task.lua:28
  cancel(id: number): boolean {
    for (let i = len(Task._list); i >= 1; i--) {
      if (Task._list[i]!.id === id) {
        remove(Task._list, i);
        return true;
      }
    }
    return false;
  },

  // Lua: task.lua:38
  clear(): void {
    Task._list = [null];
  },

  // Lua: task.lua:42
  busy(): boolean {
    return len(Task._list) > 0;
  },

  // Lua: task.lua:46
  count(): number {
    return len(Task._list);
  },

  // Lua: task.lua:50
  update(dt: number): void {
    let i = 1;
    while (i <= len(Task._list)) {
      const t = Task._list[i]!;
      t.frames = t.frames + 1;
      let finished = false;
      if (t.fn) {
        try {
          const res = t.fn(t, dt);
          if (res === true) finished = true;
        } catch (e) {
          console.log("[game3.task] error: " + tostring(e instanceof Error ? e.message : e));
          finished = true;
        }
      }
      if (t.maxFrames !== undefined && t.frames >= t.maxFrames) {
        finished = true;
      }
      if (finished) {
        t.done = true;
        const cb = t.onDone;
        remove(Task._list, i);
        if (cb) {
          try { cb(t); } catch { /* pcall */ }
        }
      } else {
        i = i + 1;
      }
    }
  },

  // Lua: task.lua:79
  waitFrames(n: number | undefined, done?: () => void): G3Task {
    return Task.spawn((t) => t.frames >= (n ?? 1),
      { onDone: () => { if (done) done(); } });
  },

  // Lua: task.lua:86
  tween(framesIn: unknown, onStep?: (u: number, t: G3Task) => void, done?: () => void): G3Task {
    const frames = Math.max(1, tonumber(framesIn) ?? 1);
    return Task.spawn((t) => {
      const u = Math.min(1, t.frames / frames);
      if (onStep) onStep(u, t);
      return u >= 1;
    }, { onDone: () => { if (done) done(); } });
  },
};

export default Task;
