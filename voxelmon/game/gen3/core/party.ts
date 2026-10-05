// Port of gen1recomp src/core/game3/party.lua (GPLv3 + additional terms; see LICENSE.md).
// Opaque host-shaped session party (H6). No DV↔IV / Stat Exp↔EV math.
// Gen3-only moves live in move_overlay; host mon tables stay host-shaped.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Pokemon } from "./pokemon.ts";
import { Rng } from "./rng.ts";
import { SummaryData } from "./summary_data.ts";
import { Storage } from "./storage.ts";
import { GameVersion } from "../shared/core/GameVersion.ts";
import { ipairs, len, pairs, seq } from "../platform/lt.ts";
import { mod, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";

const isTable = (v: unknown): v is Record<string | number, any> => v !== null && typeof v === "object";
/** Lua `a == b` (nil is null or undefined). */
const luaEq = (a: unknown, b: unknown): boolean => (a == null ? b == null : a === b);

/** A copy of a table's non-nil entries, keeping its shape (sequence array or object). */
function copyTable(v: any): any {
  const out: any = Array.isArray(v) ? [null] : {};
  for (const [k, x] of pairs(v)) out[k] = x;
  return out;
}

// Lua: party.lua:6
function shallow_mon(mon: any): any {
  if (!isTable(mon)) return mon;
  const copy: any = Array.isArray(mon) ? [null] : {};
  for (const [k, v] of pairs(mon)) {
    if (isTable(v)) {
      copy[k] = copyTable(v);
    } else {
      copy[k] = v;
    }
  }
  return copy;
}

const BATTLE_FIELD_KEYS: string[] = [
  "hp", "maxHp", "status", "sleep", "level", "exp",
  "happiness", "friendship", "evs", "pokerus", "item", "heldItem",
  "species", "speciesId", "name", "growthRate",
  "attack", "defense", "speed", "spAtk", "spDef",
  "atk", "def", "spe", "spa", "spd", "ppBonusesPacked",
  "ability", "abilityId",
];

export const Party = {
  // Lua: party.lua:22
  /** Snapshot host party by shallow-copying each mon table (opaque blob). */
  takeOpaque(hostParty: any): any[] {
    const out: any[] = seq();
    if (!isTable(hostParty)) return out;
    for (const [i, mon] of ipairs(hostParty)) {
      out[i] = shallow_mon(mon);
    }
    return out;
  },

  // Lua: party.lua:32
  /** Write opaque session party back onto host party slots (structure-preserving). */
  writeBack(hostParty: any, sessionParty: any): void {
    if (!isTable(hostParty) || !isTable(sessionParty)) return;
    for (let i = len(hostParty); i >= 1; i--) {
      hostParty[i] = null;
    }
    // (JS: drop the nil tail Lua leaves; len/ipairs/pairs see no change)
    if (Array.isArray(hostParty)) while (hostParty.length > 1 && hostParty[hostParty.length - 1] == null) hostParty.length--;
    for (const [i, mon] of ipairs(sessionParty)) {
      hostParty[i] = shallow_mon(mon);
    }
  },

  // Lua: party.lua:42
  applyBattleFields(opaqueMon: any, fields: any): void {
    if (!isTable(opaqueMon) || !isTable(fields)) return;
    if (fields.friendship != null) {
      fields.happiness = fields.friendship;
    }
    for (const key of BATTLE_FIELD_KEYS) {
      if (fields[key] != null) opaqueMon[key] = fields[key];
    }
    if (isTable(fields.pp)) {
      opaqueMon.pp = truthy(opaqueMon.pp) ? opaqueMon.pp : seq();
      for (const [i, v] of pairs(fields.pp)) {
        opaqueMon.pp[i] = v;
      }
    }
    if (isTable(fields.maxPp)) {
      opaqueMon.maxPp = truthy(opaqueMon.maxPp) ? opaqueMon.maxPp : seq();
      for (const [i, v] of pairs(fields.maxPp)) {
        opaqueMon.maxPp[i] = v;
      }
    }
    if (isTable(fields.moves) && truthy(fields._allowMoveRewrite)) {
      opaqueMon.moves = seq();
      for (const [i, v] of pairs(fields.moves)) {
        opaqueMon.moves[i] = v;
      }
    }
  },

  // Lua: party.lua:78
  /** Ensure sidecar move_overlay table exists. */
  ensureOverlay(sidecar: any): Record<number, any> {
    sidecar = truthy(sidecar) ? sidecar : {};
    sidecar.move_overlay = truthy(sidecar.move_overlay) ? sidecar.move_overlay : {};
    return sidecar.move_overlay;
  },

  // Lua: party.lua:85
  /** Set quarantined Gen3 move for partySlot/moveSlot (1-based). */
  setOverlayMove(sidecar: any, partySlot: number, moveSlot: number, frlgMoveId: any, pp: any): void {
    const overlay = Party.ensureOverlay(sidecar);
    overlay[partySlot] = truthy(overlay[partySlot]) ? overlay[partySlot] : {};
    overlay[partySlot][moveSlot] = {
      frlgMoveId,
      pp: tonumber(pp) ?? 0,
    };
  },

  // Lua: party.lua:94
  getOverlayMove(sidecar: any, partySlot: number, moveSlot: number): any {
    const overlay = truthy(sidecar) ? sidecar.move_overlay : sidecar;
    const slot = truthy(overlay) ? overlay[partySlot] : overlay;
    return truthy(slot) ? slot[moveSlot] : slot;
  },

  // Lua: party.lua:101
  /** Heal all opaque mons (nurse). */
  healAll(sessionParty: any): void {
    if (!isTable(sessionParty)) return;
    // local Pokemon = require(...): probed for optional members, as Brian does
    const P: any = Pokemon;
    for (const [, mon] of ipairs(sessionParty)) {
      if (isTable(mon)) {
        if (truthy(mon.maxHp)) mon.hp = mon.maxHp;
        delete mon.status;
        delete mon.sleep;
        if (isTable(mon.pp) && isTable(mon.moves)) {
          for (let i = 1; i <= 4; i++) {
            if (truthy(mon.moves[i])) {
              let max = truthy(mon.maxPp) ? mon.maxPp[i] : undefined;
              if (!truthy(max)) {
                const row = truthy(P.battleMove) ? P.battleMove(mon.moves[i]) : undefined;
                max = (truthy(row) && truthy(row.pp)) ? row.pp : 5;
              }
              mon.pp[i] = max;
              mon.maxPp = truthy(mon.maxPp) ? mon.maxPp : seq();
              mon.maxPp[i] = max;
            }
          }
        }
      }
    }
  },

  // Lua: party.lua:127
  size(sessionParty: any): number {
    if (!isTable(sessionParty)) return 0;
    return len(sessionParty);
  },

  PLAYER_HAS_TWO_USABLE_MONS: 0,
  PLAYER_HAS_ONE_MON: 1,
  PLAYER_HAS_ONE_USABLE_MON: 2,

  // Lua: party.lua:137
  // pokefirered/src/pokemon.c:3769
  monsStateToDoubles(sessionParty: any): number {
    if (!isTable(sessionParty)) return Party.PLAYER_HAS_ONE_MON;
    let count = 0;
    for (const [, mon] of ipairs(sessionParty)) {
      if ((tonumber(mon.species ?? mon.speciesId) ?? 0) !== 0) count = count + 1;
    }
    if (count <= 1) return Party.PLAYER_HAS_ONE_MON;
    let usable = 0;
    for (const [, mon] of ipairs(sessionParty)) {
      const sp = tonumber(mon.species ?? mon.speciesId) ?? 0;
      if ((tonumber(mon.hp) ?? 0) !== 0 && sp !== 0 && sp !== 412 && !truthy(mon.isEgg) && !truthy(mon.egg)) {
        usable = usable + 1;
      }
    }
    return (usable > 1) ? Party.PLAYER_HAS_TWO_USABLE_MONS : Party.PLAYER_HAS_ONE_USABLE_MON;
  },

  // pokefirered/include/constants/pokemon.h:193
  MON_GIVEN_TO_PARTY: 0,
  MON_GIVEN_TO_PC: 1,
  MON_CANT_GIVE: 2,

  // pokefirered/include/constants/global.h:11
  VERSION_FIRE_RED: 4,
  // pokefirered/include/constants/global.h:12
  VERSION_LEAF_GREEN: 5,

  // Lua: party.lua:165
  // pokefirered/include/config.h:45 GAME_VERSION
  metGame(): number {
    // pcall(require, "src.core.GameVersion") always succeeds here (static import).
    const code = truthy(GameVersion) && truthy(GameVersion.gameCode)
      ? GameVersion.gameCode(GameVersion.current) : undefined;
    return tonumber(code) ?? Party.VERSION_FIRE_RED;
  },

  // Lua: party.lua:172
  // pokefirered/src/pokemon.c:1822 gSaveBlock2Ptr->playerGender
  otGender(session: any): number {
    const g = truthy(session) ? session.gender : undefined;
    if (g === 1 || g === "female" || g === "F" || g === "girl") return 1;
    return 0;
  },

  // Lua: party.lua:180
  /**
   * Append a Gen3-shaped opaque mon for script givemon (starter / gifts).
   * pokefirered/src/pokemon.c:3686
   * Returns ok, code, mon, boxId, slotIdx.
   */
  giveMon(session: any, species: any, level: any, nickname?: any, opts?: any): [boolean, number, any?, any?, any?] {
    if (!isTable(session)) return [false, Party.MON_CANT_GIVE];
    session.party = truthy(session.party) ? session.party : seq();
    species = tonumber(species) ?? 1;
    level = tonumber(level) ?? 5;
    if (level < 1) level = 1;
    // local Pokemon = require(...): probed for optional members and given fields, as Brian does
    const P: any = Pokemon;
    if (!truthy(P._names)) {
      let okI = true, errI: unknown;
      try { P.install(null); } catch (e) { okI = false; errI = e; }
      if (!okI && !truthy(P._installWarned)) {
        P._installWarned = true;
        console.log("[game3/pokemon] install failed: " + tostring(errI));
      }
    }

    const personality = Rng.Random32();
    const iv1 = Rng.Random();
    const iv2 = Rng.Random();
    const ivs = {
      hp: mod(iv1, 32),
      atk: mod(Math.floor(iv1 / 32), 32),
      def: mod(Math.floor(iv1 / 1024), 32),
      spe: mod(iv2, 32),
      spa: mod(Math.floor(iv2 / 32), 32),
      spd: mod(Math.floor(iv2 / 1024), 32),
    };

    const meta = truthy(P.speciesMeta) ? P.speciesMeta(species) : undefined;
    const friendship = (truthy(meta) && truthy(meta.friendship)) ? meta.friendship : 70;
    const growthRate = (truthy(meta) ? tonumber(meta.growthRate) : undefined) ?? 0;
    const abilityRaw = truthy(P.abilityId) ? P.abilityId(species, personality) : undefined;
    const ability = truthy(abilityRaw) ? abilityRaw : 0;
    const genderRaw = truthy(P.gender) ? P.gender(species, personality) : undefined;
    const gender = truthy(genderRaw) ? genderRaw : "U";
    const name = P.name(species);
    let moves: any = seq(), pp: any = seq(), maxPp: any = seq();
    if (truthy(P.movesAtLevel)) {
      [moves, pp, maxPp] = P.movesAtLevel(species, level);
    }
    if (!truthy(moves) || len(moves) === 0) {
      moves = seq(33);
      pp = seq(35);
      maxPp = seq(35);
    }

    const natureRaw = truthy(P.natureId) ? P.natureId(personality) : undefined;
    const mon: Record<string, any> = {
      species,
      speciesId: species,
      speciesNumbering: P.NUMBERING_INTERNAL,
      name,
      nickname: typeof nickname === "string" ? nickname : "",
      level,
      metLevel: level,
      growthRate,
      exp: SummaryData.expForLevel(growthRate, level),
      // status = nil
      moves,
      pp,
      maxPp,
      personality,
      nature: truthy(natureRaw) ? natureRaw : 0,
      ivs,
      evs: { hp: 0, atk: 0, def: 0, spe: 0, spa: 0, spd: 0 },
      ability,
      abilityId: ability,
      gender,
      happiness: friendship,
      friendship,
      // pokefirered/src/pokemon.c:1815 CreateBoxMon
      metLocation: truthy(P.currentMapSec) ? P.currentMapSec(session) : undefined,
      // pokefirered/src/pokemon.c:1819
      metGame: Party.metGame(),
      pokerus: 0,
      ot: session.name ?? session.playerName ?? "RED",
      otName: session.name ?? session.playerName ?? "RED",
      otId: session.trainerId ?? session.id ?? session.playerId ?? 12345,
      // pokefirered/src/pokemon.c:1796 CreateBoxMon OT_ID_PLAYER_ID
      otSecretId: tonumber(session.secretId),
      // pokefirered/src/pokemon.c:1822
      otGender: Party.otGender(session),
      pokeball: 4, // Poké Ball
    };
    if (mon.metLocation == null || mon.metLocation === false) delete mon.metLocation;
    if (mon.otSecretId === undefined) delete mon.otSecretId;
    P.applyStats(mon);

    let code: number;
    let boxId: any, slotIdx: any;
    if (len(session.party) < 6) {
      session.party[len(session.party) + 1] = mon;
      code = Party.MON_GIVEN_TO_PARTY;
    } else if (truthy(opts) && truthy(opts.toPC)) {
      const [sent, b, s] = Storage.sendMonToPC(session, mon);
      code = sent ? Party.MON_GIVEN_TO_PC : Party.MON_CANT_GIVE;
      boxId = b; slotIdx = s;
    } else {
      code = Party.MON_CANT_GIVE;
    }
    if (code === Party.MON_CANT_GIVE) {
      return [false, code, null];
    }
    // pokefirered/src/script_pokemon_util.c:66
    session.dex = truthy(session.dex) ? session.dex : { seen: {}, owned: {}, caught: {} };
    session.dex.seen = truthy(session.dex.seen) ? session.dex.seen : {};
    session.dex.owned = truthy(session.dex.owned) ? session.dex.owned : {};
    session.dex.caught = truthy(session.dex.caught) ? session.dex.caught : {};
    session.dex.seen[species] = true;
    session.dex.owned[species] = true;
    session.dex.caught[species] = true;
    return [true, code, mon, boxId, slotIdx];
  },

  // Lua: party.lua:292
  /**
   * Give an egg for script giveegg.
   * pokefirered/src/script_pokemon_util.c:75
   */
  giveEgg(session: any, species: any, opts?: any): [boolean, number, any?] {
    if (!truthy(session)) return [false, Party.MON_CANT_GIVE];
    species = tonumber(species) ?? 1;
    const [ok, code, egg] = Party.giveMon(session, species, 5, "EGG", opts);
    if (ok && truthy(egg)) {
      egg.isEgg = true;
      egg.name = "EGG";
      egg.nickname = "EGG";
    }
    return [ok, code, egg];
  },

  // Lua: party.lua:305
  // pokefirered/src/script_pokemon_util.c:48
  giveMonToPlayer(session: any, species: any, level: any, nickname?: any): [number, any, any, any] {
    const [, code, mon, boxId, slotIdx] =
      Party.giveMon(session, species, level, nickname, { toPC: true });
    return [code ?? Party.MON_CANT_GIVE, mon, boxId, slotIdx];
  },

  // Lua: party.lua:312
  // pokefirered/src/script_pokemon_util.c:75
  giveEggToPlayer(session: any, species: any): [number, any] {
    const [, code, egg] = Party.giveEgg(session, species, { toPC: true });
    return [code ?? Party.MON_CANT_GIVE, egg];
  },

  // Lua: party.lua:318
  /** Prove DVs/Stat Exp bit-identical between two opaque snapshots. */
  dvsIdentical(a: any, b: any): boolean {
    if (!isTable(a) || !isTable(b)) return luaEq(a, b);
    if (len(a) !== len(b)) return false;
    for (let i = 1; i <= len(a); i++) {
      const ma = a[i], mb = b[i];
      if (!isTable(ma) || !isTable(mb)) return false;
      const da = ma.dvs ?? ma.DVs ?? ma.dv, db = mb.dvs ?? mb.DVs ?? mb.dv;
      if (isTable(da) && isTable(db)) {
        for (const [k, v] of pairs(da)) {
          if (!luaEq(db[k], v)) return false;
        }
        for (const [k, v] of pairs(db)) {
          if (!luaEq(da[k], v)) return false;
        }
      } else if (!luaEq(da, db)) {
        return false;
      }
      const sa = ma.statExp ?? ma.statexp ?? ma.StatExp;
      const sb = mb.statExp ?? mb.statexp ?? mb.StatExp;
      if (isTable(sa) && isTable(sb)) {
        for (const [k, v] of pairs(sa)) {
          if (!luaEq(sb[k], v)) return false;
        }
      } else if (!luaEq(sa, sb)) {
        return false;
      }
    }
    return true;
  },
};

export default Party;
