// Port of gen1recomp src/core/game3/save_mon.lua (GPLv3 + additional terms; see LICENSE.md).
// A saved mon brought up to the runtime's shape on load (species numbering,
// stats, PP), and the cart-import fix-ups a converted cartridge save needs
// once the species pack is loaded.

import { ipairs, pairs, seq } from "../platform/lt.ts";
import { mod, tonumber, truthy } from "../../../import/gen3/lua.ts";
import { Pokemon } from "./pokemon.ts";
import { SummaryData } from "./summary_data.ts";
import { Daycare } from "./daycare.ts";
import { Field } from "./field.ts";
import { HealLocations } from "./heal_locations.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Mon = Record<string, any>;
type Save = Record<string, any>;

// Lua: save_mon.lua:6
// src/pokemon.c:2196
function levelFromExp(growthRate: any, exp: number): number {
  let level = 1;
  while (level <= 100 && SummaryData.expForLevel(growthRate, level) <= exp) level = level + 1;
  return Math.max(1, level - 1);
}

// Lua: save_mon.lua:13
function finishCartMon(mon: Mon, species: number): void {
  const growthRate = Pokemon.growthRate(species);
  mon.growthRate = growthRate;
  if (mon.level == null) mon.level = levelFromExp(growthRate, tonumber(mon.exp) ?? 0);
  if (!truthy(mon.isEgg)) {
    mon.name = Pokemon.name(species);
    if (mon.nickname === mon.name) mon.nickname = "";
  }
  mon.gender = Pokemon.gender(species, mon.personality);
  const pair = Pokemon.abilities(species);
  let ability = pair[(tonumber(mon.abilityNum) ?? 0) + 1];
  if (!truthy(ability) || ability === 0) ability = pair[1];
  mon.ability = ability;
  mon.abilityId = ability;
  mon.maxPp = seq();
  const bonuses = tonumber(mon.ppBonusesPacked) ?? 0;
  for (const [slot, move] of ipairs(mon.moves ?? [null])) {
    const base = Pokemon.movePp(move);
    // src/pokemon.c:3898
    mon.maxPp[slot] = base + Math.floor(base * 20 * mod(Math.floor(bonuses / Math.pow(4, slot - 1)), 4) / 100);
  }
  delete mon.cartImport;
}

// Lua: save_mon.lua:82
// src/heal_location.c:30
function healIdFor(w: Record<string, any>): any {
  if (!truthy(Field.flyDestinationsMounted())) return undefined;
  for (const [, dest] of pairs<any>(Field._flyBaked ?? {})) {
    if (truthy(dest.healLocation) && dest.map === w.map) return dest.healLocation;
  }
  return false;
}

export const save_mon = {
  // Lua: save_mon.lua:36
  normalize(mon: any): any {
    if (mon == null || typeof mon !== "object") return mon;
    const otId = tonumber(mon.otId);
    if (otId != null && otId >= 65536) {
      // pokefirered/src/pokemon.c:6062 IsShinyOtIdPersonality
      mon.otSecretId = mod(Math.floor(otId / 65536), 65536);
      mon.otId = mod(otId, 65536);
    }
    let species = Pokemon.speciesOf(mon);
    if (!truthy(species) && tonumber(mon.speciesId) != null) {
      species = Pokemon.speciesOf({ species: mon.speciesId, speciesNumbering: mon.speciesNumbering });
    }
    if (!truthy(species) || !truthy(Pokemon.isInternalSpecies(species))) return mon;
    mon.species = species;
    mon.speciesId = species;
    mon.speciesNumbering = Pokemon.NUMBERING_INTERNAL;
    if (truthy(mon.cartImport)) finishCartMon(mon, species as number);
    const hp = tonumber(mon.hp);
    Pokemon.applyStats(mon);
    if (hp != null) mon.hp = Math.max(0, Math.min(hp, mon.maxHp));
    mon.stats = mon.stats ?? {};
    const fields: Record<string, any> = {
      hp: mon.maxHp, attack: mon.attack, defense: mon.defense,
      speed: mon.speed, spAtk: mon.spAtk, spDef: mon.spDef,
      specialAttack: mon.spAtk, specialDefense: mon.spDef,
    };
    for (const [key, value] of pairs(fields)) {
      mon.stats[key] = value;
    }
    for (let slot = 1; slot <= 4; slot++) {
      const move = mon.moves && mon.moves[slot];
      if (move != null && typeof move === "object") {
        let id = tonumber(move.moveId ?? move.id ?? move.move);
        if (id == null && typeof move.id === "string") {
          for (let n = 1; n <= 354; n++) {
            if (Pokemon.moveName(n) === move.id) { id = n; break; }
          }
        }
        if (id != null) {
          move.id = id;
          move.moveId = id;
          mon.pp = mon.pp ?? seq();
          mon.maxPp = mon.maxPp ?? seq();
          mon.pp[slot] = move.pp ?? mon.pp[slot] ?? Pokemon.movePp(id);
          mon.maxPp[slot] = move.maxPp ?? mon.maxPp[slot] ?? Pokemon.movePp(id);
        }
      }
    }
    return mon;
  },

  // Lua: save_mon.lua:91
  finishCartImport(save: Save): void {
    const ci = save.modData != null && typeof save.modData === "object" ? save.modData.cartImport : false;
    if (ci == null || typeof ci !== "object" || !truthy(Pokemon.isInternalSpecies(1))) return;
    save.dex = save.dex ?? {};
    const dex = save.dex;
    dex.seen = dex.seen ?? {};
    dex.owned = dex.owned ?? {};
    dex.caught = dex.caught ?? {};
    for (const [, nat] of ipairs(ci.dexSeen ?? [null])) {
      const sp = Pokemon.speciesFromNational(nat);
      if (sp != null && truthy(sp)) dex.seen[sp as number] = true;
    }
    for (const [, nat] of ipairs(ci.dexOwned ?? [null])) {
      const sp = Pokemon.speciesFromNational(nat);
      if (sp != null && truthy(sp)) { dex.owned[sp as number] = true; dex.caught[sp as number] = true; }
    }
    delete ci.dexSeen;
    delete ci.dexOwned;
    const dc = save.modData[Daycare.saveKey(save)];
    if (dc != null && typeof dc === "object") {
      for (const [, mon] of pairs<any>(dc.daycare != null && typeof dc.daycare === "object" ? dc.daycare : {})) {
        if (mon != null && typeof mon === "object" && truthy(mon.cartImport)) save_mon.normalize(mon);
      }
      if (dc.route5Daycare != null && typeof dc.route5Daycare === "object"
          && dc.route5Daycare.mon != null && typeof dc.route5Daycare.mon === "object") {
        save_mon.normalize(dc.route5Daycare.mon);
      }
    }
    if (ci.lastHealLocation != null && typeof ci.lastHealLocation === "object") {
      // src/heal_location.c:79
      const id = healIdFor(ci.lastHealLocation);
      if (id != null && id !== false) HealLocations.applyToSession(save, id);
      if (id != null) delete ci.lastHealLocation;
    } else {
      delete ci.lastHealLocation;
    }
    if (ci.lastHealLocation == null) delete save.modData.cartImport;
  },

  // Lua: save_mon.lua:126
  each(save: Save, fn: (mon: any) => unknown): void {
    save_mon.finishCartImport(save);
    for (const [, mon] of pairs(save.party ?? {})) fn(mon);
    for (const [, box] of pairs<any>(save.storage && save.storage.boxes || {})) {
      for (const [, mon] of pairs(box != null && typeof box === "object" ? box.mons ?? {} : {})) fn(mon);
    }
  },
};

export default save_mon;
