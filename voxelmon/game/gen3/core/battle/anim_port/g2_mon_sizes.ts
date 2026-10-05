// Port of gen1recomp src/core/game3/battle/anim_port/g2_mon_sizes.lua (GPLv3 + additional terms; see LICENSE.md).
// Mon pic sizes in g2_pret's packed form ((w / 8) * 16 + h / 8), built per active g1_pic_sizes table.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod } from "../../../../../import/gen3/lua.ts";
import { pairs } from "../../../platform/lt.ts";
import sizes from "./g1_pic_sizes.ts";

// Lua: g2_mon_sizes.lua:3
function convert(packed: number): number {
  const w = Math.floor(packed / 256);
  const h = mod(packed, 256);
  return (w / 8) * 16 + h / 8;
}

// Lua: g2_mon_sizes.lua:9 -- setmetatable({}, { __mode = "k" })
const built = new WeakMap<object, { front: Record<number, number>; back: Record<number, number> }>();

// Lua: g2_mon_sizes.lua:11
function active(): { front: Record<number, number>; back: Record<number, number> } {
  const src = sizes.active();
  let out = built.get(src);
  if (out) return out;
  out = { front: {}, back: {} };
  for (const [sp, packed] of pairs<number>(src.front ?? {})) out.front[sp as number] = convert(packed);
  for (const [sp, packed] of pairs<number>(src.back ?? {})) out.back[sp as number] = convert(packed);
  built.set(src, out);
  return out;
}

// Lua: g2_mon_sizes.lua:22 -- setmetatable({}, { __index = ... }): only "front" / "back" resolve.
export const MonSizes: Record<string, any> = {
  get front() { return active().front; },
  get back() { return active().back; },
};

export default MonSizes;
