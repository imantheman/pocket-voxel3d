// Save swapping with gen1recomp, Brian's desktop recomp. save.lua is already
// his file format (save-lua.ts writes what his SaveSerializer writes), and
// most fields are his too, because the game was ported from his. Where the
// two drifted, this keeps a save meaning the same thing in both games:
//
//   - a monster's original trainer: his `ot` is our `otName`, and he stamps
//     every monster (his own as well as traded ones); ours leaves your own
//     unstamped. Read: his `ot` becomes `otName` when it is someone else's.
//     Write: every monster carries `ot` / `otId`, as his do.
//   - the PC's items: his `pcItems` (id -> count) and `pcOrder`; this port
//     kept them in `pc = { inventory, bagOrder }` until 2026-10-04 -- such a
//     save is folded back into his fields on load.
//   - Yellow's surfing minigame record: his `surfingHighScore` (was
//     `surfingHiScore` here).
//   - BIT_USED_POKECENTER: his `usedPokecenter`, set by the nurse, which his
//     blackout reads; this port only kept the heal point. Backfilled from it.
//
// And, as his SaveData.validate does, whatever this game does not have -- a
// species, an item, a move or a map from a mod or a newer build -- is set
// aside (save.orphaned, his field) instead of crashing or vanishing; a later
// load in a game that has it brings it back. The report says what was set
// aside, so the player is told.

/**
 * gen1recomp's save.meta.format this file is written to (his Version.lua
 * saveFormat, 5 since 2026-09-02): every mon stamped with `ot` / `otId`,
 * and no traded mon carrying the player's own ID (his 4 -> 5 repair).
 */
export const GEN1RECOMP_FORMAT = 5;

export interface LoadReport {
  /** The save says it is a newer format than GEN1RECOMP_FORMAT. */
  newerFormat?: number;
  lostMons: { species?: string; from: string }[];
  lostItems: { id: string; count: number; from: string }[];
  remappedMaps: { id: string; to?: string; field: string }[];
  droppedMoves: { species: string; move: string }[];
  restoredMons: { species: string }[];
  restoredItems: { id: string; count: number }[];
}

interface DataLike {
  pokemon?: Record<string, unknown>;
  items?: Record<string, unknown>;
  moves?: Record<string, unknown>;
  maps?: Record<string, unknown>;
  constants?: { fallbackMove?: string; bagSize?: number };
}

type Mon = Record<string, any>;

const known = (table: Record<string, unknown> | undefined, id: unknown): boolean =>
  typeof id === "string" && !!table && Object.prototype.hasOwnProperty.call(table, id);

/** Every monster the save holds, with where it is (party, boxes, day-care). */
function eachMon(save: any, fn: (mon: Mon) => void): void {
  for (const mon of save.party ?? []) if (mon && typeof mon === "object") fn(mon);
  for (const box of save.boxes ?? []) for (const mon of box ?? []) if (mon && typeof mon === "object") fn(mon);
  if (save.daycare?.mon && typeof save.daycare.mon === "object") fn(save.daycare.mon);
}

function orphaned(save: any): { mons: Mon[]; items: { id: string; count: number; from?: string }[] } {
  save.orphaned ??= {};
  save.orphaned.mons ??= [];
  save.orphaned.items ??= [];
  return save.orphaned;
}

/** A monster list with the unknown species set aside and the rest's moves checked. */
function scrubMons(list: unknown, where: string, save: any, data: DataLike, report: LoadReport): void {
  // no species table (a tool, a test): nothing to judge the list by
  if (!Array.isArray(list) || !data.pokemon) return;
  for (let i = list.length - 1; i >= 0; i--) {
    const mon = list[i];
    if (!mon || typeof mon !== "object" || !known(data.pokemon, (mon as Mon).species)) {
      list.splice(i, 1);
      orphaned(save).mons.push(mon);
      report.lostMons.push({ species: (mon as Mon)?.species, from: where });
      continue;
    }
    scrubMoves(mon as Mon, data, report);
  }
}

/** A known monster's moves: unknown ones dropped (one kept, as his fallback). */
function scrubMoves(mon: Mon, data: DataLike, report: LoadReport): void {
  if (!Array.isArray(mon.moves) || !data.moves) return;
  const had = mon.moves.length > 0;
  for (let j = mon.moves.length - 1; j >= 0; j--) {
    const slot = mon.moves[j];
    const id = slot && typeof slot === "object" ? slot.id : slot;
    if (!known(data.moves, id)) {
      mon.moves.splice(j, 1);
      report.droppedMoves.push({ species: String(mon.species), move: String(id) });
    }
  }
  if (mon.moves.length > 4) mon.moves.length = 4;
  if (had && mon.moves.length === 0) {
    const fallback = data.constants?.fallbackMove ?? "TACKLE";
    const def = data.moves[fallback] as { pp?: number } | undefined;
    if (def) mon.moves.push({ id: fallback, pp: def.pp ?? 35 });
  }
}

/** An id -> count map with the unknown items set aside. */
function scrubItems(map: unknown, where: string, save: any, data: DataLike, report: LoadReport): void {
  if (!map || typeof map !== "object" || !data.items) return;
  for (const [id, count] of Object.entries(map as Record<string, unknown>)) {
    if (known(data.items, id)) continue;
    delete (map as Record<string, unknown>)[id];
    const n = Number(count) || 0;
    orphaned(save).items.push({ id, count: n, from: where });
    report.lostItems.push({ id, count: n, from: where });
  }
}

/** What was set aside earlier and this game has now: back where it goes. */
function reclaim(save: any, data: DataLike, report: LoadReport): void {
  const o = save.orphaned;
  if (!o) return;
  const mons: Mon[] = o.mons ?? [];
  for (let i = mons.length - 1; i >= 0; i--) {
    const mon = mons[i];
    if (!mon || !known(data.pokemon, mon.species)) continue;
    // into the first box with room (Boxes: 12 of 20)
    save.boxes ??= [];
    for (let b = 0; b < 12; b++) save.boxes[b] ??= [];
    const box = save.boxes.find((bx: Mon[]) => bx.length < 20);
    if (!box) continue;
    box.push(mon);
    mons.splice(i, 1);
    report.restoredMons.push({ species: mon.species });
  }
  const items = o.items ?? [];
  for (let i = items.length - 1; i >= 0; i--) {
    const e = items[i];
    if (!e || !known(data.items, e.id)) continue;
    save.pcItems ??= {};
    save.pcItems[e.id] = Math.min(99, (Number(save.pcItems[e.id]) || 0) + (Number(e.count) || 0));
    if (!Array.isArray(save.pcOrder)) save.pcOrder = [];
    if (!save.pcOrder.includes(e.id)) save.pcOrder.push(e.id);
    items.splice(i, 1);
    report.restoredItems.push({ id: e.id, count: Number(e.count) || 0 });
  }
  if (mons.length === 0 && items.length === 0) delete save.orphaned;
}

/** Maps this game has not got: back to the heal point, else the start. */
function scrubMaps(save: any, data: DataLike, report: LoadReport): void {
  if (!data.maps) return;
  const spawn = { map: "REDS_HOUSE_2F", x: 3, y: 6 };
  if (save.lastHeal && !known(data.maps, save.lastHeal.map)) {
    report.remappedMaps.push({ id: save.lastHeal.map, to: spawn.map, field: "lastHeal" });
    save.lastHeal = { ...spawn };
  }
  if (save.player && !known(data.maps, save.player.map)) {
    const heal = save.lastHeal ?? spawn;
    report.remappedMaps.push({ id: save.player.map, to: heal.map, field: "player" });
    save.player.map = heal.map;
    save.player.x = heal.x;
    save.player.y = heal.y;
  }
  if (save.lastOutdoor && !known(data.maps, save.lastOutdoor.id)) {
    report.remappedMaps.push({ id: save.lastOutdoor.id, field: "lastOutdoor" });
    delete save.lastOutdoor;
  }
  if (save.lastHeal?.outdoor && !known(data.maps, save.lastHeal.outdoor.id)) delete save.lastHeal.outdoor;
}

/** The PC's items as his fields, folding in this port's older `pc` bag. */
export function migratePc(save: any): void {
  const old = save.pc;
  if (!old || typeof old !== "object") return;
  if (!save.pcItems || typeof save.pcItems !== "object") save.pcItems = {};
  if (!Array.isArray(save.pcOrder)) save.pcOrder = [];
  for (const [id, n] of Object.entries((old.inventory ?? {}) as Record<string, number>)) {
    save.pcItems[id] = Math.min(99, (Number(save.pcItems[id]) || 0) + (Number(n) || 0));
  }
  const was = Array.isArray(old.bagOrder) ? old.bagOrder : [];
  for (const id of [...was, ...Object.keys(save.pcItems)]) {
    if (save.pcItems[id] > 0 && !save.pcOrder.includes(id)) save.pcOrder.push(id);
  }
  delete save.pc;
}

/**
 * Item balls taken, in both games' records: this port's pickup flag
 * (EVENT_ITEMBALL_<map>_<text>, mapscripts.ts itemBallFlag) and gen1recomp's
 * `itemsTaken["<map>_obj_<index>"]` (OverworldController.lua pick-up), each
 * filled from the other, so a ball picked up in either game is gone in both.
 */
export function syncItemBalls(
  save: any,
  maps: Record<string, { objects?: { index?: number; item?: string; text?: string }[] }> | undefined,
): void {
  if (!maps || !save || typeof save !== "object") return;
  if (!save.flags || typeof save.flags !== "object") save.flags = {};
  const had = save.itemsTaken && typeof save.itemsTaken === "object";
  const taken: Record<string, boolean> = had ? save.itemsTaken : {};
  for (const [mapId, map] of Object.entries(maps)) {
    for (const o of map?.objects ?? []) {
      if (!o.item || !o.text || o.index === undefined) continue;
      const key = `${mapId}_obj_${o.index}`;
      const flag = `EVENT_ITEMBALL_${mapId}_${o.text}`;
      if (taken[key]) save.flags[flag] = true;
      else if (save.flags[flag]) taken[key] = true;
    }
  }
  if (had || Object.keys(taken).length > 0) save.itemsTaken = taken;
}

/**
 * A save just read off the card, made this game's: his fields read as ours,
 * the unknown set aside. Returns what was set aside or put back.
 */
export function fromDisk(save: any, data: DataLike): LoadReport {
  const report: LoadReport = { lostMons: [], lostItems: [], remappedMaps: [], droppedMoves: [], restoredMons: [], restoredItems: [] };
  if (!save || typeof save !== "object") throw new Error("not a save table");
  if (!save.player || typeof save.player !== "object") throw new Error("the save has no player");
  const fmt = Number(save.meta?.format);
  if (Number.isFinite(fmt) && fmt > GEN1RECOMP_FORMAT) report.newerFormat = fmt;
  const name = save.player.name;
  const id = save.player.id;
  eachMon(save, (mon) => {
    // his `ot`: someone else's name, or a monster marked traded, is ours `otName`
    if (mon.otName === undefined && typeof mon.ot === "string") {
      const mine = mon.ot === name && (mon.otId === undefined || mon.otId === id);
      // (his stamp of your own name on an in-game trade is not a trainer)
      if (!mine) mon.otName = mon.ot;
    }
    if (mon.traded === undefined && mon.otId !== undefined && id !== undefined && mon.otId !== id) mon.traded = true;
  });
  migratePc(save);
  if (save.surfingHighScore === undefined && save.surfingHiScore !== undefined) save.surfingHighScore = save.surfingHiScore;
  delete save.surfingHiScore;
  if (save.usedPokecenter === undefined && typeof save.lastHeal?.map === "string" && save.lastHeal.map.includes("POKECENTER")) {
    save.usedPokecenter = true;
  }
  reclaim(save, data, report);
  scrubMons(save.party, "party", save, data, report);
  (save.boxes ?? []).forEach((box: unknown, b: number) => scrubMons(box, `box ${b + 1}`, save, data, report));
  if (save.daycare?.mon && data.pokemon) {
    const mon = save.daycare.mon;
    if (!known(data.pokemon, mon.species)) {
      orphaned(save).mons.push(mon);
      report.lostMons.push({ species: mon.species, from: "daycare" });
      delete save.daycare.mon;
    } else scrubMoves(mon, data, report);
  }
  scrubItems(save.inventory, "bag", save, data, report);
  scrubItems(save.pcItems, "PC", save, data, report);
  for (const key of ["bagOrder", "pcOrder"]) {
    if (Array.isArray(save[key])) save[key] = save[key].filter((i: unknown) => known(data.items, i));
  }
  scrubMaps(save, data, report);
  for (const k of data.pokemon ? ["seen", "owned"] : []) {
    const set = save.pokedex?.[k];
    if (set && typeof set === "object") for (const s of Object.keys(set)) if (!known(data.pokemon, s)) delete set[s];
  }
  return report;
}

/** Anything to tell the player about what fromDisk did. */
export function reportLines(r: LoadReport): string[] {
  const out: string[] = [];
  if (r.newerFormat !== undefined) out.push("This save is from a\nnewer version; some\nof it may not carry\nover.");
  if (r.lostMons.length) out.push(`${r.lostMons.length} POKéMON this\ngame does not know\nwere set aside.`);
  if (r.lostItems.length) out.push(`${r.lostItems.length} item(s) this\ngame does not know\nwere set aside.`);
  if (r.remappedMaps.some((m) => m.field === "player")) out.push("This game does not\nhave that place, so\nyou are back at the\nlast POKéMON CENTER.");
  if (r.restoredMons.length || r.restoredItems.length) {
    out.push(`${r.restoredMons.length} POKéMON and\n${r.restoredItems.length} item(s) set\naside before are\nback (PC).`);
  }
  return out;
}

/**
 * The save as it goes onto the card: a copy, with every monster carrying his
 * `ot` / `otId` (your name and ID on your own). The live save keeps this
 * game's convention (no stamp on your own), which Yellow's Pikachu and the
 * summary read.
 */
export function toDisk(save: any): any {
  const out = JSON.parse(JSON.stringify(save ?? {}));
  const name = out.player?.name;
  const id = out.player?.id;
  eachMon(out, (mon) => {
    // an in-game trade names no trainer here: leave it unnamed (and his
    // game reads it as traded all the same)
    if (mon.ot === undefined && !(mon.traded && mon.otName === undefined)) mon.ot = mon.otName ?? name;
    if (mon.otId === undefined && !mon.traded && id !== undefined) mon.otId = id;
  });
  if (!out.meta || typeof out.meta !== "object") out.meta = { mods: {} };
  if (!(Number(out.meta.format) >= GEN1RECOMP_FORMAT)) {
    out.meta.format = GEN1RECOMP_FORMAT;
  }
  return out;
}
