// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). The shader effects. gen1recomp's FRLG code creates ~24
// small LÖVE fragment shaders from GLSL sources; the port creates them BY NAME
// (love.graphics.newShader("blend5")) and each name is registered here with:
//
//   pack(uniforms) -> up to 16 floats for OP_STATE (texture uniforms by id), or
//   undefined when the effect is a CPU VARIANT effect (the shim then renders a
//   recoloured copy of the drawn image instead -- palette lookups, colour
//   remaps -- cached by image and uniforms);
//   pixel(...)     -> the GLSL `effect` translated to JS, per pixel, used by
//   the desktop rasteriser (exact screenshots) and by CPU variants.
//
// Each effect lives in platform/effects/<name>.ts and registers itself;
// effects/index.ts imports them all.

export type Rgba = [number, number, number, number];

export interface EffectCtx {
  /** The uniforms as sent (shader:send), by name. */
  u: Record<string, unknown>;
  /** Sample another texture (Image uniforms) at uv; the rasteriser supplies it. */
  sample?: (texId: number, u: number, v: number) => Rgba;
  /** Sample the texture being drawn at another uv (mosaic); the rasteriser supplies it. */
  self?: (u: number, v: number) => Rgba;
  /**
   * The uniforms as an effect has parsed them, kept for the context's life
   * (one CPU variant, whose uniforms do not change): a variant effect reads
   * its arrays once rather than once a pixel (graphics.ts variantFor).
   */
  memo?: Record<string, unknown>;
}

/** `ctx.memo[key]`, made by `make` the first time (EffectCtx.memo). */
export function ctxMemo<T>(ctx: EffectCtx, key: string, make: () => T): T {
  const m = ctx.memo ?? (ctx.memo = {});
  let v = m[key] as T | undefined;
  if (v === undefined) { v = make(); m[key] = v; }
  return v;
}

export interface Effect {
  name: string;
  /** OP_STATE params; undefined = a CPU variant effect. */
  pack?: (u: Record<string, unknown>) => number[];
  /**
   * The fragment shader: texel colour (already sampled, 0..1), vertex colour,
   * texture uv, screen pixel (sc, y down), the packed params, and the context.
   * Returns rgba, or undefined to DISCARD the fragment.
   */
  pixel: (texel: Rgba, color: Rgba, tu: number, tv: number, sx: number, sy: number,
    params: number[], ctx: EffectCtx) => Rgba | undefined;
  /**
   * Optional, for a CPU variant effect: the whole recoloured copy at once --
   * exactly the bytes graphics.ts variantFor's per-pixel loop would write
   * from `pixel` (vertex colour white) -- without an array per pixel.
   */
  variant?: (src: Uint8Array, w: number, h: number, ctx: EffectCtx) => Uint8Array;
}

/** ImageData:setPixel's byte for a channel (variant hooks write what it would). */
export function toByte(v: number): number {
  const b = Math.floor(v * 255 + 0.5);
  return b < 0 ? 0 : b > 255 ? 255 : b;
}

const BY_NAME = new Map<string, Effect>();
const BY_ID: Effect[] = [];
const ID_OF = new Map<string, number>();

/** Register an effect (ids are 1.., in registration order; 0 = none). */
export function registerEffect(e: Effect): number {
  if (ID_OF.has(e.name)) return ID_OF.get(e.name)!;
  BY_NAME.set(e.name, e);
  BY_ID.push(e);
  const id = BY_ID.length;
  ID_OF.set(e.name, id);
  return id;
}

export function effectByName(name: string): Effect | undefined { return BY_NAME.get(name); }
export function effectId(name: string): number { return ID_OF.get(name) ?? 0; }
export function effectById(id: number): Effect | undefined { return id > 0 ? BY_ID[id - 1] : undefined; }

/** GLSL helpers the effects use. */
export const glsl = {
  clamp: (x: number, a = 0, b = 1): number => (x < a ? a : x > b ? b : x),
  mix: (a: number, b: number, t: number): number => a * (1 - t) + b * t,
  floor: Math.floor,
  /** a vec3/vec4 uniform sent as a Lua table (1-based or array) -> [x, y, z, w] */
  vec(v: unknown, n = 3): number[] {
    // a runtime sequence ([null, x, y, z], lt.ts) or a plain JS array
    if (Array.isArray(v)) return (v[0] == null && v.length > n ? v.slice(1, n + 1) : v.slice(0, n)).map(Number);
    if (v && typeof v === "object") {
      const o = v as Record<string, number>;
      return Array.from({ length: n }, (_, i) => Number(o[i + 1] ?? o[String(i + 1)] ?? 0));
    }
    return Array.from({ length: n }, () => Number(v) || 0);
  },
  /** an array uniform (send(name, v1, v2, ...) or one table of tables) -> n vectors */
  arr(v: unknown, count: number, n = 3): number[][] {
    let items: unknown[] = [];
    if (Array.isArray(v) && v.length > 0 && (Array.isArray(v[0]) || typeof v[0] === "object")) items = v;
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      for (let i = 1; o[i] !== undefined; i++) items.push(o[i]);
    } else if (v !== undefined) items = [v];
    return Array.from({ length: count }, (_, i) => glsl.vec(items[i] ?? 0, n));
  },
  /** a 5-bit channel, as `floor(x * 31.0 + 0.5)` */
  c5: (x: number): number => Math.floor(x * 31 + 0.5),
  num(v: unknown, dflt = 0): number {
    return typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : dflt;
  },
};
