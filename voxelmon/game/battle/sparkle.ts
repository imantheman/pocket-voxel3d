// The Kanto shiny sparkle: a ring of little four-point stars that pops
// around a wild mon whose DVs would make it shiny in Gold and Silver.
//
// Red, Blue and Yellow never had shinies -- the DV pattern only means
// something once the mon goes through the Time Capsule -- so there is no
// cart effect to port. This one is our own: the stars are drawn by the
// core out of flat rects (spec FX_SPARKLE_PAGE), no sheet and no cooked
// art, and the timing below is all there is to it.

/** One star this frame: centre in GB pixels, radius, tone. */
export interface SparkleStar {
  x: number;
  y: number;
  r: number;
  warm: boolean;
}

/** The enemy pic's centre on the GB screen (7x7 tiles at x 96, y 0). */
const CENTRE_X = 96 + 28;
const CENTRE_Y = 28;

const STARS = 8;
/** A new star every this many frames... */
const STAGGER = 4;
/** ...each alive this long, growing then shrinking. */
const LIFE = 18;

/** How long the whole sparkle runs. */
export const SPARKLE_FRAMES = (STARS - 1) * STAGGER + LIFE;

/**
 * The stars on screen `frame` frames into the sparkle. Each one is born on
 * a ring around the pic, spread by a little under a half turn from the
 * last so the ring fills in out of order, drifts outward as it lives, and
 * swells to its peak halfway through.
 */
export function sparkleStars(frame: number): SparkleStar[] {
  const out: SparkleStar[] = [];
  for (let i = 0; i < STARS; i++) {
    const t = frame - i * STAGGER;
    if (t < 0 || t >= LIFE) continue;
    const life = t / (LIFE - 1);
    const swell = 1 - Math.abs(life * 2 - 1);
    const peak = i % 3 === 0 ? 6 : i % 3 === 1 ? 4 : 5;
    const r = Math.max(1, Math.round(peak * swell));
    const angle = (i * 0.4 + 0.1) * Math.PI * 2;
    const dist = 18 + 8 * life + (i % 2) * 4;
    out.push({
      x: Math.round(CENTRE_X + Math.cos(angle) * dist),
      y: Math.round(CENTRE_Y + Math.sin(angle) * dist * 0.85),
      r,
      warm: i % 2 === 0,
    });
  }
  return out;
}
