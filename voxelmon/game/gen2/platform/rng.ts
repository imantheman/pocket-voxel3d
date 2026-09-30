// love.math.random / math.random for the Gen 2 port: one seeded generator
// for the whole run, so a Bun replay and the 3DS make the same rolls from
// the same seed and the same input. Lua's argument rules:
//   random()      a float in [0, 1)
//   random(m)     an integer in [1, m]
//   random(m, n)  an integer in [m, n]
// (gen1recomp calls love.math.random and math.random interchangeably; both
// land here.)

let state = 0x9e3779b9 >>> 0;

/** Restart the sequence (the entry seeds it once at boot). */
export function seed(s: number): void {
  state = (s >>> 0) || 0x9e3779b9;
}

/** mulberry32: small, fast, and good enough for game rolls. */
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
