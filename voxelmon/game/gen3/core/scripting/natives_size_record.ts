// Port of gen1recomp src/core/game3/scripting/natives_size_record.lua (GPLv3 + additional terms; see LICENSE.md).
// Script specials for Size Records and Prof Oak's Rating (pokefirered/src/pokemon_size_record.c, prof_pc.c).
// Covers specials 0x77-0x7A and 0xD5 (pokefirered/data/specials.inc:130-133, 224).
//
// Port notes:
// - Handlers return Lua's multiple returns as a 0-based tuple (natives.ts).
// - package.loaded / require of space, runtime, flags: static imports.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber } from "../../../../import/gen3/lua.ts";
import Std from "./stdscripts.ts";
import SR from "../pokemon_size_record.ts";
import PokedexRating from "../pokedex_rating.ts";
import Flags from "./flags.ts";
import Space from "./space.ts";
import Runtime from "../runtime.ts";
import type { Handler } from "./natives.ts";

const VAR_RESULT = 0x800D;

// Lua: natives_size_record.lua:12
function flagsMod(): typeof Flags {
  return Flags;
}

// Lua: natives_size_record.lua:16
function sessionOf(ctx: any): any {
  if (ctx && ctx.session) return ctx.session;
  const S: any = Space;
  if (S && S.store && S.store.flags) return S.store;
  const rt: any = Runtime;
  return (rt && rt.getSession && rt.getSession()) || undefined;
}

// Lua: natives_size_record.lua:24
function scriptStore(ctx: any): any {
  const S: any = Space;
  const session = sessionOf(ctx);
  return (S && S.store) || (ctx && ctx.session) || (session && session.store) || session || undefined;
}

// Lua: natives_size_record.lua:30
function setResult(ctx: any, value: any): void {
  flagsMod().setVar(scriptStore(ctx), ctx, VAR_RESULT, tonumber(value) ?? 0);
}


const BY_NAME: Record<string, Handler> = {
  // Lua: natives_size_record.lua:36
  // pokefirered/src/pokemon_size_record.c:160 GetHeracrossSizeRecordInfo
  GetHeracrossSizeRecordInfo: (ctx, adapters) => {
    SR.getMonSizeRecordInfo(sessionOf(ctx), ctx, adapters, SR.SPECIES_HERACROSS, SR.VAR_HERACROSS_SIZE_RECORD);
    return [false];
  },

  // Lua: natives_size_record.lua:42
  // pokefirered/src/pokemon_size_record.c:167 CompareHeracrossSize
  CompareHeracrossSize: (ctx, adapters) => {
    const code = SR.compareMonSize(sessionOf(ctx), ctx, adapters, SR.SPECIES_HERACROSS, SR.VAR_HERACROSS_SIZE_RECORD);
    setResult(ctx, code);
    return [false];
  },

  // Lua: natives_size_record.lua:49
  // pokefirered/src/pokemon_size_record.c:179 GetMagikarpSizeRecordInfo
  GetMagikarpSizeRecordInfo: (ctx, adapters) => {
    SR.getMonSizeRecordInfo(sessionOf(ctx), ctx, adapters, SR.SPECIES_MAGIKARP, SR.VAR_MAGIKARP_SIZE_RECORD);
    return [false];
  },

  // Lua: natives_size_record.lua:55
  // pokefirered/src/pokemon_size_record.c:186 CompareMagikarpSize
  CompareMagikarpSize: (ctx, adapters) => {
    const code = SR.compareMonSize(sessionOf(ctx), ctx, adapters, SR.SPECIES_MAGIKARP, SR.VAR_MAGIKARP_SIZE_RECORD);
    setResult(ctx, code);
    return [false];
  },

  // Lua: natives_size_record.lua:62
  // pokefirered/src/prof_pc.c:106 GetProfOaksRatingMessage
  GetProfOaksRatingMessage: (ctx, adapters) => {
    PokedexRating.getProfOaksRatingMessage(sessionOf(ctx), ctx, adapters);
    return [false];
  },
};

export const SizeRecordNatives = {
  BY_NAME,
  /** Set by Std.legacyHandlers: special id -> handler. */
  HANDLERS: undefined as Record<number, Handler> | undefined,
};
// Lua: natives_size_record.lua:67
Std.legacyHandlers(SizeRecordNatives);

export default SizeRecordNatives;
