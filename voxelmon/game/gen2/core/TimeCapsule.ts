// The TIME CAPSULE's conversions: Gold's party records to the Kanto games'
// and back (engine/link/link.asm Link_PrepPartyData_Gen1, Link_Convert-
// PartyStruct1to2; engine/link/time_capsule.asm), and the receptionist's
// check that a party can travel at all (CheckTimeCapsuleCompatibility).
//
// Ported from gen1recomp src/online/Convert.lua at bdfac727 (MIT), onto
// Gold's MonRecord. Two things it did not carry are the cart's own:
//   - Gen 1's catch-rate byte becomes the held item in Gen 2 (the item of
//     that index, through TimeCapsule_CatchRateItems for the indices that
//     name no real item -- why a traded SNORLAX holds LEFTOVERS), and a held
//     item goes back as that byte.
//   - the two species whose names the importers spell differently
//     (FARFETCHD / MR_MIME in the Kanto data).
//
// What goes to the past is finished on the Kanto side (voxelmon/game/battle/
// timecapsule.ts): Gen 1's base SPECIAL is not in Gold's data, so the stat
// block, EXP and PP are rederived there from the Kanto game's own tables.
// What comes from the past is finished here, with Gold's.

import { Mon } from "../battle/Mon.ts";

/** Kanto species ids that Gold's importer spells differently. */
const TO_GEN1: Record<string, string> = { FARFETCH_D: "FARFETCHD", MR__MIME: "MR_MIME" };
const TO_GEN2: Record<string, string> = { FARFETCHD: "FARFETCH_D", MR_MIME: "MR__MIME" };

/** The last Gen 1 move by index (STRUGGLE); Gen 2's start after it. */
const GEN1_LAST_MOVE = 165;
const GEN1_LAST_DEX = 151;

/** data/items/catch_rate_items.asm TimeCapsule_CatchRateItems: catch-rate
 *  bytes that name no real item, and what they are held as instead. */
const CATCH_RATE_ITEMS: Record<number, string> = {
  0x19: "LEFTOVERS", 0x2d: "BITTER_BERRY", 0x32: "GOLD_BERRY",
  0x5a: "BERRY", 0x64: "BERRY", 0x78: "BERRY", 0x87: "BERRY",
  0xbe: "BERRY", 0xc3: "BERRY", 0xdc: "BERRY", 0xfa: "BERRY", 0xff: "BERRY",
};

/** engine/link/link.asm:980 and its inverse: the five majors. */
const STATUS_TO_GEN1: Record<string, string> = {
  sleep: "SLP", poison: "PSN", toxic: "PSN", burn: "BRN", paralyze: "PAR", freeze: "FRZ",
};
const STATUS_TO_GEN2: Record<string, string> = {
  SLP: "sleep", PSN: "poison", BRN: "burn", PAR: "paralyze", FRZ: "freeze",
};

/** engine/link/link.asm:1067 -- friendship a mon from the past arrives with. */
const PAST_HAPPINESS = 70;

export interface CompatAnswer {
  /** CheckTimeCapsuleCompatibility's wScriptVar: 0 fine, 1 a species too
   *  new, 2 a move too new, 3 MAIL. */
  code: 0 | 1 | 2 | 3;
  /** The {STRBUF}s its text reads, in order. */
  buffers: string[];
}

const monLabel = (data: any, m: any): string =>
  String(m?.nickname || data?.pokemon?.[m?.species]?.name || m?.name || m?.species || "?");

function isMail(data: any, item: unknown): boolean {
  if (!item) return false;
  const def = data?.items?.[String(item)];
  return /MAIL$/.test(String(item)) || def?.heldEffect === "HELD_MAIL" || def?.pocketId === "MAIL";
}

export const TimeCapsule = {
  isGen1Species(data: any, species: string): boolean {
    const dex = Number(data?.pokemon?.[species]?.dex);
    return dex >= 1 && dex <= GEN1_LAST_DEX;
  },

  isGen1Move(data: any, move: string): boolean {
    const index = Number(data?.moves?.[move]?.index);
    return index >= 1 && index <= GEN1_LAST_MOVE;
  },

  /** engine/link/link.asm:1970 CheckTimeCapsuleCompatibility, over the
   *  party in order: an EGG or a species past #151, then a move past
   *  STRUGGLE, then MAIL. */
  compatibility(data: any, party: any[]): CompatAnswer {
    for (const m of party ?? []) {
      if (!m) continue;
      if (m.isEgg || m.egg || !TimeCapsule.isGen1Species(data, m.species)) {
        return { code: 1, buffers: [m.isEgg || m.egg ? "EGG" : monLabel(data, m)] };
      }
    }
    for (const m of party ?? []) {
      for (const mv of m?.moves ?? []) {
        if (mv?.id && !TimeCapsule.isGen1Move(data, mv.id)) {
          return { code: 2, buffers: [monLabel(data, m), String(data?.moves?.[mv.id]?.name ?? mv.id)] };
        }
      }
    }
    for (const m of party ?? []) {
      if (isMail(data, m?.item)) return { code: 3, buffers: [monLabel(data, m)] };
    }
    return { code: 0, buffers: [] };
  },

  /** A Gold party record as the Kanto games' PartyMon (Link_PrepPartyData_Gen1).
   *  Its stat block is Gold's, SPECIAL read off SPCL.ATK; the Kanto side
   *  rederives it. The held item rides as the catch-rate byte. */
  toGen1(data: any, mon: any): Record<string, unknown> {
    const d = mon?.dvs ?? {};
    const se = mon?.statExp ?? {};
    const st = mon?.stats ?? {};
    const itemIndex = mon?.item ? Number(data?.items?.[String(mon.item)]?.index) || 0 : 0;
    const out: Record<string, unknown> = {
      species: TO_GEN1[mon.species] ?? mon.species,
      level: mon.level,
      exp: mon.experience ?? 0,
      dvs: { attack: d.attack ?? 0, defense: d.defense ?? 0, speed: d.speed ?? 0,
        special: d.special ?? d.specialAttack ?? 0, hp: d.hp ?? Mon.hpDV(d) },
      statExp: { hp: se.hp ?? 0, attack: se.attack ?? 0, defense: se.defense ?? 0,
        speed: se.speed ?? 0, special: se.special ?? se.specialAttack ?? 0 },
      stats: { hp: st.hp ?? mon.maxHp ?? 1, attack: st.attack ?? 1, defense: st.defense ?? 1,
        speed: st.speed ?? 1, special: st.specialAttack ?? st.special ?? 1 },
      hp: mon.hp ?? 0,
      catchRate: itemIndex,
      status: mon.status ? (STATUS_TO_GEN1[String(mon.status)] ?? null) : null,
      moves: (mon.moves ?? []).filter((m: any) => m?.id).slice(0, 4).map((m: any) => {
        // engine/items/item_effects.asm ComputeMaxPP, run backwards
        const base = Number(data?.moves?.[m.id]?.pp) || 0;
        const step = Math.floor(base / 5);
        const ups = step > 0 ? Math.max(0, Math.min(3, Math.round(((Number(m.maxPp) || base) - base) / step))) : 0;
        return { id: m.id, pp: m.pp ?? base, ppUps: ups };
      }),
    };
    if (mon.nickname) out.nickname = mon.nickname;
    return out;
  },

  /** A Kanto PartyMon as a Gold party record (Link_ConvertPartyStruct1to2),
   *  or null when Gold does not know the species. */
  toGen2(data: any, mon: any): any {
    const species = TO_GEN2[mon?.species] ?? mon?.species;
    const def = data?.pokemon?.[species];
    if (!def) return null;
    const level = Math.max(1, Math.min(100, Math.floor(Number(mon.level) || 1)));
    const d = mon.dvs ?? {};
    const dvs: any = { attack: d.attack ?? 0, defense: d.defense ?? 0, speed: d.speed ?? 0, special: d.special ?? 0 };
    dvs.hp = Mon.hpDV(dvs);
    const s = mon.statExp ?? {};
    const statExp = { hp: s.hp ?? 0, attack: s.attack ?? 0, defense: s.defense ?? 0, speed: s.speed ?? 0, special: s.special ?? 0 };
    const stats: any = Mon.stats(def.baseStats, dvs, level, statExp as never);
    // HP keeps its share of the maximum
    const oldMax = Math.max(1, Number(mon.stats?.hp) || stats.hp);
    const oldHp = Math.max(0, Math.min(oldMax, Number(mon.hp) || 0));
    const hp = oldHp <= 0 ? 0 : oldHp >= oldMax ? stats.hp : Math.max(1, Math.min(stats.hp, Math.round((oldHp * stats.hp) / oldMax)));
    const growth = Mon.growthFor(data, def.growthRate);
    const moves = (mon.moves ?? [])
      .filter((m: any) => m?.id && data?.moves?.[m.id])
      .slice(0, 4)
      .map((m: any) => {
        const base = Number(data.moves[m.id].pp) || 0;
        const ups = Math.max(0, Math.min(3, Math.floor(Number(m.ppUps) || 0)));
        const maxPp = base + ups * Math.floor(base / 5);
        return { id: m.id, pp: Math.max(0, Math.min(maxPp, Math.floor(Number(m.pp ?? maxPp)))), maxPp };
      });
    // the catch-rate byte, held
    const rate = Math.floor(Number(mon.catchRate) || 0) & 0xff;
    let item: string | undefined = CATCH_RATE_ITEMS[rate];
    if (!item && rate > 0) {
      for (const [id, it] of Object.entries<any>(data?.items ?? {})) {
        if (it && typeof it === "object" && Number(it.index) === rate) {
          item = id;
          break;
        }
      }
    }
    const status = mon.status ? STATUS_TO_GEN2[String(mon.status)] : undefined;
    return {
      species,
      name: def.name ?? species,
      nickname: mon.nickname,
      level,
      experience: Mon.experienceForLevel(growth, level),
      dvs,
      statExp,
      pokerus: 0,
      stats,
      hp,
      maxHp: stats.hp,
      types: def.types,
      moves,
      item,
      status,
      happiness: PAST_HAPPINESS,
      caughtLevel: level,
      shiny: Mon.isShiny(dvs, { species, def, level }),
      gender: Mon.gender(def, dvs, { species, level }),
    };
  },
};
