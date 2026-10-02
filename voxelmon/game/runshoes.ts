// RUNNING SHOES, every game's OPTION screen (Red/Blue/Yellow's
// ui/optionsmenu.ts, Gold and Silver's gen2/ui/OptionsMenu.ts): with them on,
// holding B on foot runs -- a step in half the frames, the bicycle's speed --
// the way the later games' running shoes do. Not on a bike (already that
// fast) and not surfing. Saved as options.runningShoes; ON unless set.

/** Frames one running step takes (a walk is 16, as the cart's). */
export const RUN_STEP_FRAMES = 8;

/** The option's two choices, in the order the rows show them. */
export const RUNNING_SHOES = [
  { key: true, label: "ON" },
  { key: false, label: "OFF" },
] as const;

/** Whether the option is on: anything but an explicit false. */
export function runningShoesOn(options: { runningShoes?: unknown } | null | undefined): boolean {
  return options?.runningShoes !== false;
}
