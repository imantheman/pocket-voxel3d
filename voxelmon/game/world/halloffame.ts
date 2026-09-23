// The Hall of Fame record, and what happens to a save once it is written.
//
// pokered's HallOfFamePC (engine/events/hall_of_fame.asm) does three things in
// one predef: it appends the party to the hall of fame, it rolls the induction
// and the credits, and then it resets the run and saves. This module is the
// first and the third — the parts that are state rather than screens, so they
// can be tested without driving a single frame.
//
// The one deliberate difference from the original: pokered finishes on
// `jp Init`, a soft reset through the copyright card and the attract movie to
// the title screen. Here the player keeps playing — healed, standing in their
// own bedroom in Pallet, with the record intact and everything they earned
// still theirs. "Not totally restarting, just putting you back in Pallet."

/** One mon as the hall remembers it — not a live party slot. */
export interface HallOfFameMon {
  species: string;
  level: number;
  nickname?: string;
}

/** One induction: the party, in order, at the moment the record was written. */
export type HallOfFameEntry = HallOfFameMon[];

interface HofSave {
  party?: { species?: string; level?: number; nickname?: string }[];
  hallOfFame?: HallOfFameEntry[];
  /** The blackout / exit-mat anchor. Keyed `id`, not `map` — see game.ts. */
  lastOutdoor?: { id?: string; x?: number; y?: number } | null;
  flags?: Record<string, boolean>;
}

/**
 * NewGameWarp (data/maps/special_warps.asm): the bedroom the game starts in,
 * which is also where a champion comes back to.
 */
export const POST_GAME_HOME = {
  map: "REDS_HOUSE_2F",
  x: 3,
  y: 6,
  facing: "down" as const,
};

/**
 * Where a house's exit mat should put you afterwards. Without retargeting
 * this, the LAST_MAP the league left behind sends the bedroom door back to
 * Indigo Plateau and the player is stranded at the top of the map.
 */
export const POST_GAME_OUTDOOR = { id: "PALLET_TOWN", x: 5, y: 6 };

/** How many inductions a save keeps. The original's HOF_TEAM cap. */
export const HALL_OF_FAME_MAX = 50;

/**
 * Append the current party to the hall of fame and return the new record.
 *
 * Copies rather than references the party: the mons go on being played with
 * — levelled, renamed, evolved, released — and the hall is a photograph of
 * the team that won, not a live view of it.
 */
export function recordHallOfFame(save: HofSave): HallOfFameEntry {
  const entry: HallOfFameEntry = (save.party ?? []).map((mon) => {
    const rec: HallOfFameMon = {
      species: String(mon.species ?? ""),
      level: Number(mon.level ?? 0),
    };
    if (mon.nickname) rec.nickname = mon.nickname;
    return rec;
  });
  const hall = (save.hallOfFame ??= []);
  hall.push(entry);
  // Oldest first out, like the original's rolling record.
  while (hall.length > HALL_OF_FAME_MAX) hall.shift();
  return entry;
}

/**
 * Put a newly crowned champion back where they can play on: the bedroom in
 * Pallet, with the exit mat pointing at the town rather than at the plateau.
 *
 * Healing is the caller's job — it needs the species data this module does
 * not take.
 */
export function applyPostGameHome(save: HofSave): void {
  save.lastOutdoor = { ...POST_GAME_OUTDOOR };
}

/**
 * A save written in the HALL OF FAME after the induction -- which is what
 * every post-game save was until the write took the home position -- comes
 * back standing beside Oak in the hall, with nothing left to happen there.
 * On CONTINUE such a save is moved home once (gen1recomp SaveData
 * needsPostGameRescue). A save with the induction still pending is left
 * where it is: it has not been crowned yet.
 */
export function postGameRescue(save: HofSave & {
  player?: { map?: string; x?: number; y?: number; facing?: string };
}): boolean {
  const p = save.player;
  if (!p || p.map !== "HALL_OF_FAME") return false;
  if ((save.hallOfFame?.length ?? 0) === 0) return false;
  if (save.flags?.EVENT_HALL_OF_FAME_PENDING === true) return false;
  p.map = POST_GAME_HOME.map;
  p.x = POST_GAME_HOME.x;
  p.y = POST_GAME_HOME.y;
  p.facing = POST_GAME_HOME.facing;
  applyPostGameHome(save);
  return true;
}

/** Has this save ever been inducted? What gates the post-game content. */
export function isChampion(save: HofSave): boolean {
  return (save.hallOfFame?.length ?? 0) > 0 || save.flags?.EVENT_BEAT_CHAMPION_RIVAL === true;
}
