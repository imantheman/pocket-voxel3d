// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). NOT FAITHFUL (memory; not LÖVE): the session's byte
// caches sized from the app heap the console has free, not fixed numbers.
//
// The caches that keep bytes only to save a re-read or a re-bake -- the
// derived pixel caches (fs.ts), the battle screen's reads (battle_chrome.ts),
// the CPU colour variants (graphics.ts) -- each have a full size, which they
// keep while the app heap has room, and a least size they shrink to as it
// runs short (a console that granted less heap, a long session). What one
// lets go is read or baked again on its next use: the same bytes, the same
// pixels, only slower.

import { getHost } from "./host.ts";

const MB = 1024 * 1024;
/** Free app heap (beyond what the cache holds) at or under which a cache keeps its least. */
const TIGHT = 14 * MB;
/** ... and at or over which it keeps its full size. */
const ROOMY = 26 * MB;
/** The host is asked at most this often (s): its count walks the heap's free lists. */
const EVERY = 2;

let askedAt = -1e9;
let free = Infinity;

/** The app heap's free bytes as of the last ask (Infinity: a host that does not say). */
export function heapFree(): number {
  const h = getHost();
  if (!h.heapFree) return Infinity;
  const t = h.now();
  if (t - askedAt >= EVERY) {
    askedAt = t;
    free = h.heapFree();
  }
  return free;
}

/**
 * A cache's size now: `full` with ROOMY or more free beside what it holds
 * (`held`, counted as free so the size does not swing with the cache
 * itself), `least` at TIGHT or under, in proportion between.
 */
export function cacheCap(full: number, least: number, held: number): number {
  const f = heapFree();
  if (f === Infinity) return full;
  const avail = f + held;
  if (avail >= ROOMY) return full;
  if (avail <= TIGHT) return least;
  return Math.floor(least + ((full - least) * (avail - TIGHT)) / (ROOMY - TIGHT));
}
