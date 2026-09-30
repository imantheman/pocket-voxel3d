// Ports gen1recomp src/core/gen2/HallOfFame.lua at bdfac727 (MIT).
//
// The Hall of Fame roster: what the save keeps when the champion is beaten.
// Two pokegold routines, neither of which draws: engine/events/halloffame.asm
// HallOfFame (the induction's bookkeeping, GetHallOfFameParty) and
// engine/menus/save.asm AddHallOfFameEntry (push the row in at the front,
// drop the thirtieth). The screens (ui/HallOfFame.ts) read this.
//
// A row is { winCount, mons: [...] } with up to PARTY_LENGTH hof_mons of six
// fields (species, otId, dvs, level, nickname capped at 10) plus shiny/gender.
// No stats, moves or OT name: a Hall of Fame entry is a photograph, not a mon.
//
// Indices: `team(save, index)` keeps the Lua's 1-based index; storage is the
// 0-based JS array `save.hallOfFame.teams`, newest first.
// `induct` returns the tuple [entry, wasEntered] (World uses the second).

import { Breeding } from "./Breeding.ts";
import { sub, tonumber, tostring, truthy } from "../platform/lua.ts";

export interface HofMon {
  species: any;
  otId: number;
  dvs: any;
  level: number;
  nickname: string;
  shiny?: any;
  gender?: any;
}

export interface HofEntry {
  winCount: number;
  mons: HofMon[];
}

export interface HofRecord {
  count: number;
  teams: HofEntry[];
  entered?: boolean;
  [key: string]: any;
}

// Lua: HallOfFame.lua:105 -- isEgg
function isEgg(mon: any): boolean {
  if (!truthy(mon)) return false;
  if (truthy(mon.isEgg) || truthy(mon.egg)) return true;
  if (mon.species === "EGG") return true;
  // pcall(require, "src.core.gen2.Breeding"): a failure (here, a stub that
  // throws) just means "not an egg".
  try {
    if (Breeding && typeof Breeding.isEgg === "function") return truthy(Breeding.isEgg(mon));
  } catch {
    return false;
  }
  return false;
}

// Lua: HallOfFame.lua:117 -- packMon; GetHallOfFameParty's .mon block
function packMon(mon: any): HofMon {
  const out: HofMon = {
    species: mon.species,
    otId: tonumber(mon.otId) ?? 0,
    // MON_DVS kept as the port's nibble table, so the viewer can show a shiny
    // or an Unown letter without a second table.
    dvs: mon.dvs,
    level: tonumber(mon.level) ?? 1,
    // `ld bc, MON_NAME_LENGTH - 1 / call CopyBytes`: ten bytes, no terminator.
    nickname: sub(tostring(mon.nickname ?? mon.name ?? mon.species ?? ""), 1, HallOfFame.NAME_LENGTH),
  };
  // `mon.shiny or nil` / `mon.gender or nil`: absent keys when falsy.
  if (truthy(mon.shiny)) out.shiny = mon.shiny;
  if (truthy(mon.gender)) out.gender = mon.gender;
  return out;
}

export const HallOfFame = {
  // constants/pokemon_data_constants.asm
  NUM_TEAMS: 30, // NUM_HOF_TEAMS
  PARTY_LENGTH: 6, // PARTY_LENGTH
  MON_LENGTH: 0x10, // HOF_MON_LENGTH, for the record
  LENGTH: 0x62, // HOF_LENGTH, ditto
  // constants/text_constants.asm MON_NAME_LENGTH - 1
  NAME_LENGTH: 10,
  // constants/misc_constants.asm
  MASTER_COUNT: 200, // HOF_MASTER_COUNT

  // constants/ram_constants.asm wSpawnAfterChampion, kept as the spawn's name
  // (what World resolves against landmarks.spawns).
  SPAWN_LANCE: "SPAWN_LANCE",
  SPAWN_RED: "SPAWN_RED",
  // engine/menus/intro_menu.asm .SpawnAfterE4 / SpawnAfterRed
  POST_CREDITS_SPAWN: {
    SPAWN_LANCE: "SPAWN_NEW_BARK",
    SPAWN_RED: "SPAWN_MT_SILVER",
  } as Record<string, string>,

  isEgg,
  packMon,

  // Lua: HallOfFame.lua:63 -- sHallOfFame plus wHallOfFameCount, created on demand
  record(save: any): HofRecord | undefined {
    if (save === null || typeof save !== "object") return undefined;
    save.hallOfFame = save.hallOfFame ?? {};
    const record = save.hallOfFame as HofRecord;
    record.count = tonumber(record.count) ?? 0;
    if (record.teams === null || typeof record.teams !== "object") record.teams = [];
    return record;
  },

  // Lua: HallOfFame.lua:76 -- STATUSFLAGS_HALL_OF_FAME_F
  hasEntered(save: any): boolean {
    const record = HallOfFame.record(save);
    if (!record) return false;
    return record.count > 0 || record.entered === true;
  },

  // Lua: HallOfFame.lua:82
  count(save: any): number {
    const record = HallOfFame.record(save);
    return record ? record.count : 0;
  },

  // Lua: HallOfFame.lua:92 -- `ld a, [hl] / cp HOF_MASTER_COUNT / jr nc, .ok / inc [hl]`
  // The test is on the OLD value: a save at exactly 200 stops there.
  bumpCount(save: any): number {
    const record = HallOfFame.record(save);
    if (!record) return 0;
    if (record.count < HallOfFame.MASTER_COUNT) {
      record.count = record.count + 1;
    }
    return record.count;
  },

  // Lua: HallOfFame.lua:142 -- GetHallOfFameParty: the win count, then every
  // party member that is not an EGG (skipped, party index still steps).
  buildParty(save: any, party?: any[]): HofEntry {
    const record = HallOfFame.record(save);
    const entry: HofEntry = { winCount: record ? record.count : 0, mons: [] };
    for (const mon of party ?? []) {
      if (mon == null) break; // ipairs stops at the first nil
      if (entry.mons.length >= HallOfFame.PARTY_LENGTH) break;
      if (truthy(mon) && !isEgg(mon)) {
        entry.mons.push(packMon(mon));
      }
    }
    return entry;
  },

  // Lua: HallOfFame.lua:162 -- AddHallOfFameEntry: newest first, NUM_HOF_TEAMS kept
  addEntry(save: any, entry: HofEntry | undefined): HofEntry | undefined {
    const record = HallOfFame.record(save);
    if (!(record && entry)) return undefined;
    record.teams.unshift(entry);
    while (record.teams.length > HallOfFame.NUM_TEAMS) {
      record.teams.pop();
    }
    return entry;
  },

  // Lua: HallOfFame.lua:176 -- LoadHOFTeam: past the end, or a zero win count, means stop.
  // `index` is 1-based (1 = newest).
  team(save: any, index: any): HofEntry | undefined {
    const record = HallOfFame.record(save);
    if (!record) return undefined;
    const i = tonumber(index) ?? 0;
    if (i < 1 || i > HallOfFame.NUM_TEAMS) return undefined;
    const entry = record.teams[i - 1];
    if (!entry || (tonumber(entry.winCount) ?? 0) === 0) return undefined;
    return entry;
  },

  // Lua: HallOfFame.lua:186
  teamCount(save: any): number {
    const record = HallOfFame.record(save);
    if (!record) return 0;
    let count = 0;
    for (let index = 1; index <= HallOfFame.NUM_TEAMS; index++) {
      if (!HallOfFame.team(save, index)) break;
      count = count + 1;
    }
    return count;
  },

  // Lua: HallOfFame.lua:222 -- everything `HallOfFame::` does to the save:
  // set the flag, wSpawnAfterChampion = SPAWN_LANCE, bump the count, (save),
  // GetHallOfFameParty, AddHallOfFameEntry. Brian calls saveFn AFTER the row
  // lands (the one deliberate reordering). Returns [entry, wasEntered]: the
  // flag's value BEFORE the induction, which Credits uses to allow skipping.
  induct(save: any, party?: any[], opts?: { spawn?: string; saveFn?: (save: any) => void }): [HofEntry, boolean] | undefined {
    opts = opts ?? {};
    const record = HallOfFame.record(save);
    if (!record) return undefined;
    const wasEntered = HallOfFame.hasEntered(save);
    record.entered = true;
    save.spawnAfterChampion = opts.spawn ?? HallOfFame.SPAWN_LANCE;
    HallOfFame.bumpCount(save);
    const entry = HallOfFame.buildParty(save, party ?? save.party);
    HallOfFame.addEntry(save, entry);
    if (opts.saveFn) opts.saveFn(save);
    return [entry, wasEntered];
  },

  // Lua: HallOfFame.lua:239 -- RedCredits: just the spawn that sends CONTINUE to Mt. Silver
  markRedCredits(save: any): void {
    if (save === null || typeof save !== "object") return;
    save.spawnAfterChampion = HallOfFame.SPAWN_RED;
  },

  // Lua: HallOfFame.lua:254 -- intro_menu.asm CONTINUE / PostCreditsSpawn.
  // Returns the SPAWN_* id to start at, or undefined for an ordinary continue.
  consumePostGameSpawn(save: any): string | undefined {
    if (save === null || typeof save !== "object") return undefined;
    const pending = save.spawnAfterChampion;
    if (!truthy(pending)) return undefined;
    delete save.spawnAfterChampion;
    return HallOfFame.POST_CREDITS_SPAWN[pending];
  },
};

export default HallOfFame;
