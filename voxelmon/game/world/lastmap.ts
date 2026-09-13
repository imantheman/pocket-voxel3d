// Maps that rewrite wLastMap, the map a LAST_MAP warp resolves to.
//
// pokered keeps wLastMap as "the outdoor map you came from", and an exit mat
// warps back to it. A handful of scripts overwrite it on their own map, and
// without them a LAST_MAP door sends you somewhere wrong:
//
//   UndergroundPathRoute{5,6,7,8}_Script force it to their OWN route on map
//   load. Without that, crossing the tunnel and taking the far building's
//   exit walks you back out onto the route you entered from — the tunnel
//   becomes a round trip that can never deliver you to the other side.
//   DiglettsCaveRoute{2,11}_Script are the same pattern for the cave.
//
//   Route22Gate_Script rewrites it from the player's Y every frame, which is
//   what makes the gate's north door leave onto Route 23 and its south door
//   onto Route 22. All four of its warps are LAST_MAP.
//
// Ported from gen1recomp FieldDefaults LAST_MAP_REWRITES + syncLastMapRewrite.

export interface LastMapRule {
  /** Matches when the axis value is under this. */
  below?: number;
  /** Matches when the axis value is at least this. */
  atLeast?: number;
  map: string;
}

export interface LastMapRewrite {
  /** Which coordinate the rules read; position-independent rules omit it. */
  axis?: "x" | "y";
  /** Ordered, first match wins; the last row is the default. */
  rules: LastMapRule[];
}

export const LAST_MAP_REWRITES: Record<string, LastMapRewrite> = {
  ROUTE_22_GATE: {
    axis: "y",
    rules: [{ below: 4, map: "ROUTE_23" }, { map: "ROUTE_22" }],
  },
  UNDERGROUND_PATH_ROUTE_5: { rules: [{ map: "ROUTE_5" }] },
  UNDERGROUND_PATH_ROUTE_6: { rules: [{ map: "ROUTE_6" }] },
  UNDERGROUND_PATH_ROUTE_7: { rules: [{ map: "ROUTE_7" }] },
  UNDERGROUND_PATH_ROUTE_8: { rules: [{ map: "ROUTE_8" }] },
  DIGLETTS_CAVE_ROUTE_2: { rules: [{ map: "ROUTE_2" }] },
  DIGLETTS_CAVE_ROUTE_11: { rules: [{ map: "ROUTE_11" }] },
};

/** The map this rewrite names at (cellX, cellY), or null. */
export function rewrittenLastMap(
  rewrite: LastMapRewrite,
  cellX: number,
  cellY: number,
): string | null {
  const value = rewrite.axis === "x" ? cellX : cellY;
  for (const rule of rewrite.rules) {
    if ((rule.below === undefined || value < rule.below)
      && (rule.atLeast === undefined || value >= rule.atLeast)) {
      return rule.map;
    }
  }
  return null;
}
