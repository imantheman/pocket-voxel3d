// VIEW and BATTLES, the OPTION screen's 3D/2D switches (every game): 3D is
// the voxel world and the battles staged in it; 2D is the Game Boy screen as
// the cart drew it -- the map from above, and the flat battle screen. Saved
// as save.options.view / save.options.battleView ("3d" | "2d").

export const VIEW_MODES = [
  { key: "3d", label: "3D" },
  { key: "2d", label: "2D" },
] as const;

/** 0 for 3D (the default, and anything unknown), 1 for 2D. */
export function viewIndex(v: unknown): number {
  return v === "2d" ? 1 : 0;
}

export function is2d(v: unknown): boolean {
  return v === "2d";
}
