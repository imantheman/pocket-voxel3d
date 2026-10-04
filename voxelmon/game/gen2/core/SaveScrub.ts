// What a Gold/Silver save holds that this build does not have -- a species,
// an item or a move from a mod, a newer gen1recomp, or Crystal -- set aside
// instead of crashing the first screen that looks it up. Written for this
// port (not a port of the Lua): the shape follows gen1recomp's Gen 1
// SaveData.validate, `save.orphaned = { mons, items }`, so a save that goes
// back to a game that has them gets them back, here or there.
//
// Unknown maps need nothing here: World.ts starts a save whose position
// names a map it does not have at the SPAWN_HOME warp, as his does.

type Mon = Record<string, any>;

export interface Gen2ScrubReport {
  lostMons: { species?: unknown; from: string }[];
  lostItems: { id: string; count: number; from: string }[];
  droppedMoves: { species: unknown; move: unknown }[];
  restoredMons: number;
  restoredItems: number;
}

interface DataLike {
  pokemon?: Record<string, unknown>;
  items?: Record<string, unknown>;
  moves?: Record<string, unknown>;
}

const has = (t: Record<string, unknown> | undefined, id: unknown): boolean =>
  typeof id === "string" && !!t && Object.prototype.hasOwnProperty.call(t, id);

const isTable = (v: unknown): v is Record<string, any> => !!v && typeof v === "object";

function orphaned(save: Mon): { mons: Mon[]; items: { id: string; count: number; from?: string }[] } {
  if (!isTable(save.orphaned)) save.orphaned = {};
  if (!Array.isArray(save.orphaned.mons)) save.orphaned.mons = [];
  if (!Array.isArray(save.orphaned.items)) save.orphaned.items = [];
  return save.orphaned;
}

/** A known mon: unknown moves out, an unknown held item set aside. */
function scrubMon(mon: Mon, where: string, save: Mon, data: DataLike, r: Gen2ScrubReport): void {
  if (data.moves && Array.isArray(mon.moves)) {
    for (let i = mon.moves.length - 1; i >= 0; i--) {
      const slot = mon.moves[i];
      const id = isTable(slot) ? slot.id : slot;
      if (id == null || id === "" || id === "NO_MOVE" || has(data.moves, id)) continue;
      mon.moves.splice(i, 1);
      r.droppedMoves.push({ species: mon.species, move: id });
    }
  }
  if (data.items && typeof mon.item === "string" && mon.item !== "" && mon.item !== "NO_ITEM" && !has(data.items, mon.item)) {
    orphaned(save).items.push({ id: mon.item, count: 1, from: `${where} held` });
    r.lostItems.push({ id: mon.item, count: 1, from: `${where} held` });
    delete mon.item;
  }
}

/** A list of mons (the party, one box): unknown species out, into orphaned. */
function scrubList(list: unknown, where: string, save: Mon, data: DataLike, r: Gen2ScrubReport): void {
  if (!Array.isArray(list)) return;
  for (let i = list.length - 1; i >= 0; i--) {
    const mon = list[i];
    if (!isTable(mon)) continue;
    if (!has(data.pokemon, mon.species)) {
      list.splice(i, 1);
      orphaned(save).mons.push(mon);
      r.lostMons.push({ species: mon.species, from: where });
      continue;
    }
    scrubMon(mon, where, save, data, r);
  }
}

/** An id -> count pocket: unknown ids out, into orphaned. */
function scrubPocket(map: unknown, where: string, save: Mon, data: DataLike, r: Gen2ScrubReport): void {
  if (!isTable(map) || Array.isArray(map) || !data.items) return;
  for (const [id, n] of Object.entries(map)) {
    if (has(data.items, id)) continue;
    delete map[id];
    const count = Number(n) || 0;
    orphaned(save).items.push({ id, count, from: where });
    r.lostItems.push({ id, count, from: where });
  }
}

/** Set-aside things this build has: mons into the first box with room, items to the PC. */
function reclaim(save: Mon, data: DataLike, r: Gen2ScrubReport): void {
  const o = save.orphaned;
  if (!isTable(o)) return;
  const mons: Mon[] = Array.isArray(o.mons) ? o.mons : [];
  for (let i = mons.length - 1; i >= 0; i--) {
    const mon = mons[i];
    if (!isTable(mon) || !has(data.pokemon, mon.species)) continue;
    if (!Array.isArray(save.boxes)) save.boxes = [];
    // Save.NUM_BOXES (14) of Save.MONS_PER_BOX (20)
    let box: Mon[] | undefined;
    for (let b = 0; b < 14 && !box; b++) {
      if (!Array.isArray(save.boxes[b])) save.boxes[b] = [];
      if (save.boxes[b].length < 20) box = save.boxes[b];
    }
    if (!box) continue;
    box.push(mon);
    mons.splice(i, 1);
    r.restoredMons += 1;
  }
  const items = Array.isArray(o.items) ? o.items : [];
  for (let i = items.length - 1; i >= 0; i--) {
    const e = items[i];
    if (!isTable(e) || !has(data.items, e.id)) continue;
    if (!isTable(save.pcItems) || Array.isArray(save.pcItems)) save.pcItems = {};
    save.pcItems[e.id] = Math.min(99, (Number(save.pcItems[e.id]) || 0) + (Number(e.count) || 0));
    if (Array.isArray(save.pcOrder) && !save.pcOrder.includes(e.id)) save.pcOrder.push(e.id);
    items.splice(i, 1);
    r.restoredItems += 1;
  }
  if (mons.length === 0 && items.length === 0) delete save.orphaned;
}

/** Scrub a loaded Gen 2 save against this build's data; says what moved. */
export function scrubGen2Save(save: unknown, data: DataLike | undefined): Gen2ScrubReport {
  const r: Gen2ScrubReport = { lostMons: [], lostItems: [], droppedMoves: [], restoredMons: 0, restoredItems: 0 };
  if (!isTable(save) || !data || !data.pokemon) return r;
  reclaim(save, data, r);
  scrubList(save.party, "party", save, data, r);
  if (isTable(save.boxes)) {
    for (const k of Object.keys(save.boxes)) scrubList(save.boxes[k], `box ${Number(k) + 1}`, save, data, r);
  }
  const dc = save.dayCare;
  if (isTable(dc)) {
    for (const side of ["man", "lady"]) {
      const mon = isTable(dc[side]) ? dc[side].mon : undefined;
      if (!isTable(mon)) continue;
      if (!has(data.pokemon, mon.species)) {
        orphaned(save).mons.push(mon);
        r.lostMons.push({ species: mon.species, from: `day-care ${side}` });
        delete dc[side].mon;
      } else scrubMon(mon, `day-care ${side}`, save, data, r);
    }
    if (isTable(dc.egg) && !has(data.pokemon, dc.egg.species)) {
      orphaned(save).mons.push(dc.egg);
      r.lostMons.push({ species: dc.egg.species, from: "day-care egg" });
      delete dc.egg;
    }
  }
  scrubPocket(save.inventory, "pack", save, data, r);
  scrubPocket(save.pcItems, "PC", save, data, r);
  if (typeof save.registeredItem === "string" && data.items && !has(data.items, save.registeredItem)) {
    delete save.registeredItem;
  }
  for (const k of ["seen", "caught"]) {
    const set = isTable(save.pokedex) ? save.pokedex[k] : undefined;
    if (isTable(set) && !Array.isArray(set)) for (const s of Object.keys(set)) if (!has(data.pokemon, s)) delete set[s];
  }
  return r;
}

/** Text-box lines for the player, empty when nothing moved. */
export function gen2ScrubLines(r: Gen2ScrubReport): string[] {
  const out: string[] = [];
  if (r.lostMons.length) out.push(`${r.lostMons.length} #MON this\ngame does not know\nwere set aside.`);
  if (r.lostItems.length) out.push(`${r.lostItems.length} item(s) this\ngame does not know\nwere set aside.`);
  if (r.restoredMons || r.restoredItems) out.push(`${r.restoredMons} #MON and\n${r.restoredItems} item(s) set\naside before are\nback in the PC.`);
  return out;
}
