// The save's `version` field: which game a playthrough is. gen1recomp
// writes its own game's name ("red", "blue", "yellow"), and checks it when
// a save comes from elsewhere (its SYNC mod refuses a save of another game).
//
// This port's Blue wrote "red" into its saves until it wrote "blue" (the two
// share one save format), so Blue reads either and adopts its old saves as
// "blue", which the next SAVE writes. Red writes "red", as it always did.

/** The `version` a new save of `game` carries. */
export function newSaveVersion(game: string): string {
  return game === "blue" || game === "yellow" ? game : "red";
}

/**
 * A save just loaded into `game`, made that game's: on Blue, a save tagged
 * "red" (this port's older Blue saves) or untagged becomes "blue". True when
 * it changed. Nothing else is touched.
 */
export function adoptSaveVersion(save: { version?: unknown }, game: string): boolean {
  if (game === "blue" && (save.version === "red" || save.version === undefined || save.version === null)) {
    save.version = "blue";
    return true;
  }
  return false;
}
