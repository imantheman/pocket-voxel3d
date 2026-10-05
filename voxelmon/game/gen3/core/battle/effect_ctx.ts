// Port of gen1recomp src/core/game3/battle/effect_ctx.lua (GPLv3 + additional terms; see LICENSE.md).
// Pre-allocated effect context stack (owned game3 copy).
//
// Port notes:
// - The pools are Lua sequences (slot 0 unused), as in Brian's.
// - assert(v, m) throws Error(m), as Lua's assert does.

/* eslint-disable @typescript-eslint/no-explicit-any */

/** One effect invocation: what Effects.run hands a handler. */
export interface EffectContext {
  adapter: any;
  user: any;
  target: any;
  move: any;
  moveId: any;
  rng: any;
  opts: any;
}

/** A borrowed options table (borrowOpts). */
export type EffectOpts = Record<string, any> & { phase?: any };

const MAX_DEPTH = 8;
const pool: EffectContext[] = [null as unknown as EffectContext];
for (let i = 1; i <= MAX_DEPTH; i++) pool[i] = {} as EffectContext;
let depth = 0;

const OPTS_POOL_SIZE = 16;
const optsPool: EffectOpts[] = [null as unknown as EffectOpts];
for (let i = 1; i <= OPTS_POOL_SIZE; i++) optsPool[i] = {};
let optsIndex = 0;

export const EffectCtx = {
  // Lua: effect_ctx.lua:10
  push(adapter: any, user: any, target: any, move: any, moveId: any, rng: any, opts: any): EffectContext {
    depth = depth + 1;
    if (!(depth <= MAX_DEPTH)) throw new Error("effect context stack overflow");
    const ctx = pool[depth]!;
    ctx.adapter = adapter;
    ctx.user = user;
    ctx.target = target;
    ctx.move = move;
    ctx.moveId = moveId;
    ctx.rng = rng;
    ctx.opts = opts;
    return ctx;
  },

  // Lua: effect_ctx.lua:24
  pop(): void {
    if (!(depth > 0)) throw new Error("effect context stack underflow");
    const ctx = pool[depth]!;
    ctx.adapter = null;
    ctx.user = null;
    ctx.target = null;
    ctx.move = null;
    ctx.moveId = null;
    ctx.rng = null;
    ctx.opts = null;
    depth = depth - 1;
  },

  // Lua: effect_ctx.lua:37
  current(): EffectContext | null {
    return depth > 0 ? pool[depth]! : null;
  },

  // Lua: effect_ctx.lua:41
  depth(): number {
    return depth;
  },

  // Lua: effect_ctx.lua:45
  reset(): void {
    while (depth > 0) EffectCtx.pop();
  },

  // Lua: effect_ctx.lua:54
  borrowOpts(phase: any): EffectOpts {
    optsIndex = optsIndex + 1;
    if (optsIndex > OPTS_POOL_SIZE) optsIndex = 1;
    const o = optsPool[optsIndex]!;
    o.phase = phase;
    return o;
  },
};

export default EffectCtx;
