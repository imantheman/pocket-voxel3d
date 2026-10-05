// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). love.math.random / math.random: one seeded generator for
// the run, with Lua's argument rules (random() float in [0, 1), random(m) in
// [1, m], random(m, n) in [m, n]). Gameplay rolls go through Brian's own
// GBA RNG (core/rng.ts); this is for everything else. The generator is the
// Gen 2 port's (mulberry32).

let state = 0x9e3779b9 >>> 0;

export function seed(s: number): void {
  state = (s >>> 0) || 0x9e3779b9;
}

function next(): number {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function random(m?: number, n?: number): number {
  const f = next();
  if (m === undefined) return f;
  if (n === undefined) return 1 + Math.floor(f * Math.floor(m));
  const lo = Math.floor(m);
  const hi = Math.floor(n);
  return lo + Math.floor(f * (hi - lo + 1));
}

export const Rng = { seed, random };
export default Rng;
