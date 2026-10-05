// Port of gen1recomp src/core/game3/battle/types.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG type ids + Gen3 singles type chart (owned game3 battle).
//
// Port notes:
// - NOT FAITHFUL (load order): Types.NAME (`RomText.lazy(TYPE_NAME_KEYS)`,
//   types.lua:78) is built on its first read instead of at load, so this
//   module can load while rom_text is still evaluating (an import cycle).
//   It is the same lazy view of TYPE_NAME_KEYS either way.
// - Types.TABLE is a sequence (lt.ts shape: slot 0 unused), indexed as Brian
//   indexes it.
// - typeCalc returns the Lua's three values as a tuple [dmg, flags, product].

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, truthy } from "../../../../import/gen3/lua.ts";
import { len, pairs, seq } from "../../platform/lt.ts";
import { RomText } from "../rom_text.ts";

export interface TypeFlags { super: boolean; notVery: boolean; immune: boolean }

export interface TypesModule {
  ID: Record<string, number>;
  readonly NAME: Record<string, string | undefined>;
  PHYSICAL: Record<number, boolean>;
  name(id: any): string;
  get(id: any): string;
  isPhysical(typeId: any): boolean;
  effectiveness(atkType: any, defType1: any, defType2?: any): number;
  TABLE: (number | null)[];
  typeCalc(atkType: any, def1: any, def2: any, dmg?: number | null, foresight?: any): [number | null | undefined, TypeFlags, number];
  AI_EFFECTIVENESS: Record<string, number>;
  aiTypeCalcUnits(atkType: any, defType1: any, defType2: any, hasStab?: any): number;
  aiEffectiveness(atkType: any, defType1: any, defType2: any): number;
}

export const Types = {} as TypesModule;

// pret pokemon.h TYPE_*
Types.ID = {
  NORMAL: 0, FIGHTING: 1, FLYING: 2, POISON: 3, GROUND: 4,
  ROCK: 5, BUG: 6, GHOST: 7, STEEL: 8, MYSTERY: 9,
  FIRE: 10, WATER: 11, GRASS: 12, ELECTRIC: 13, PSYCHIC: 14,
  ICE: 15, DRAGON: 16, DARK: 17,
};

// src/battle_main.c:428
const TYPE_NAME_KEYS: Record<string, string> = {};
let typeNames: Record<string, string | undefined> | undefined;
Object.defineProperty(Types, "NAME", {
  enumerable: true,
  get(): Record<string, string | undefined> {
    if (typeNames === undefined) {
      for (const [, id] of pairs<number>(Types.ID)) {
        TYPE_NAME_KEYS[id] = RomText.key("gTypeNames", id);
      }
      typeNames = RomText.lazy(TYPE_NAME_KEYS);
    }
    return typeNames;
  },
});

// Gen3 physical/special split by type (before move category override).
Types.PHYSICAL = {
  0: true, 1: true, 2: true, 3: true, 4: true,
  5: true, 6: true, 7: true, 8: true,
};

// Lua: types.lua:28
Types.name = function (id: any): string {
  const n = tonumber(id);
  if (!truthy(n)) throw new Error("type id");
  return RomText.at("gTypeNames", n as number);
};

// Alias used by battle menus / effects.
// Lua: types.lua:33
Types.get = function (id: any): string {
  return Types.name(id);
};

// Lua: types.lua:37
Types.isPhysical = function (typeId: any): boolean {
  return Types.PHYSICAL[tonumber(typeId) ?? 0] === true;
};

// Multipliers in tenths. Chart[atk][def]; missing = 10.
const C: Record<number, Record<number, number>> = {};

// Lua: types.lua:44
function set(atk: number, def: number, mult: number): void {
  C[atk] = C[atk] ?? {};
  C[atk]![def] = mult;
}

const N = 0, FI = 1, FL = 2, PO = 3, GR = 4, RO = 5, BU = 6, GH = 7, ST = 8;
const FIR = 10, WA = 11, GS = 12, EL = 13, PSY = 14, IC = 15, DR = 16, DA = 17;

// NORMAL
set(N, RO, 5); set(N, GH, 0); set(N, ST, 5);
// FIGHTING
set(FI, N, 20); set(FI, FL, 5); set(FI, PO, 5); set(FI, RO, 20);
set(FI, BU, 5); set(FI, GH, 0); set(FI, ST, 20); set(FI, PSY, 5);
set(FI, IC, 20); set(FI, DA, 20);
// FLYING
set(FL, FI, 20); set(FL, RO, 5); set(FL, BU, 20); set(FL, ST, 5);
set(FL, GS, 20); set(FL, EL, 5);
// POISON
set(PO, PO, 5); set(PO, GR, 5); set(PO, RO, 5); set(PO, GH, 5);
set(PO, ST, 0); set(PO, GS, 20);
// GROUND
set(GR, PO, 20); set(GR, RO, 20); set(GR, BU, 5); set(GR, ST, 20);
set(GR, FIR, 20); set(GR, GS, 5); set(GR, EL, 20); set(GR, FL, 0);
// ROCK
set(RO, FI, 5); set(RO, FL, 20); set(RO, GR, 5); set(RO, BU, 20);
set(RO, ST, 5); set(RO, FIR, 20); set(RO, IC, 20);
// BUG
set(BU, FI, 5); set(BU, FL, 5); set(BU, PO, 5); set(BU, GH, 5);
set(BU, ST, 5); set(BU, FIR, 5); set(BU, GS, 20); set(BU, PSY, 20);
set(BU, DA, 20);
// GHOST
set(GH, N, 0); set(GH, PSY, 20); set(GH, DA, 5); set(GH, ST, 5); set(GH, GH, 20);
// STEEL
set(ST, RO, 20); set(ST, ST, 5); set(ST, FIR, 5); set(ST, WA, 5);
set(ST, EL, 5); set(ST, IC, 20);
// FIRE
set(FIR, RO, 5); set(FIR, BU, 20); set(FIR, ST, 20); set(FIR, FIR, 5);
set(FIR, WA, 5); set(FIR, GS, 20); set(FIR, IC, 20); set(FIR, DR, 5);
// WATER
set(WA, GR, 20); set(WA, RO, 20); set(WA, FIR, 20); set(WA, WA, 5);
set(WA, GS, 5); set(WA, DR, 5);
// GRASS
set(GS, FL, 5); set(GS, PO, 5); set(GS, GR, 20); set(GS, BU, 5);
set(GS, ST, 5); set(GS, FIR, 5); set(GS, WA, 20); set(GS, GS, 5); set(GS, DR, 5);
// ELECTRIC
set(EL, FL, 20); set(EL, GR, 0); set(EL, WA, 20); set(EL, GS, 5);
set(EL, EL, 5); set(EL, DR, 5); set(EL, ST, 5);
// PSYCHIC
set(PSY, FI, 20); set(PSY, PO, 20); set(PSY, ST, 5); set(PSY, PSY, 5); set(PSY, DA, 0);
// ICE
set(IC, FL, 20); set(IC, GR, 20); set(IC, ST, 5); set(IC, FIR, 5);
set(IC, WA, 5); set(IC, GS, 20); set(IC, IC, 5); set(IC, DR, 20);
// DRAGON
set(DR, ST, 5); set(DR, DR, 20);
// DARK
set(DA, FI, 5); set(DA, GH, 20); set(DA, PSY, 20); set(DA, DA, 5); set(DA, ST, 5);

// Lua: types.lua:103
Types.effectiveness = function (atkTypeIn: any, defType1In: any, defType2In?: any): number {
  const atkType = tonumber(atkTypeIn) ?? 0;
  const defType1 = tonumber(defType1In) ?? 0;
  const defType2 = tonumber(defType2In);
  // Lua: types.lua:107
  function one(def: number | undefined): number {
    if (def == null || def === 9) return 10;
    const row = C[atkType];
    return (row != null ? row[def] : undefined) ?? 10;
  }
  const m1 = one(defType1);
  let m2 = 10;
  if (defType2 != null && defType2 !== defType1) {
    m2 = one(defType2);
  }
  return (m1 * m2) / 100;
};

// pokefirered/src/battle_main.c:312
Types.TABLE = seq(
  N, RO, 5, N, ST, 5, FIR, FIR, 5, FIR, WA, 5, FIR, GS, 20, FIR, IC, 20, FIR, BU, 20,
  FIR, RO, 5, FIR, DR, 5, FIR, ST, 20, WA, FIR, 20, WA, WA, 5, WA, GS, 5, WA, GR, 20,
  WA, RO, 20, WA, DR, 5, EL, WA, 20, EL, EL, 5, EL, GS, 5, EL, GR, 0, EL, FL, 20,
  EL, DR, 5, GS, FIR, 5, GS, WA, 20, GS, GS, 5, GS, PO, 5, GS, GR, 20, GS, FL, 5,
  GS, BU, 5, GS, RO, 20, GS, DR, 5, GS, ST, 5, IC, WA, 5, IC, GS, 20, IC, IC, 5,
  IC, GR, 20, IC, FL, 20, IC, DR, 20, IC, ST, 5, IC, FIR, 5, FI, N, 20, FI, IC, 20,
  FI, PO, 5, FI, FL, 5, FI, PSY, 5, FI, BU, 5, FI, RO, 20, FI, DA, 20, FI, ST, 20,
  PO, GS, 20, PO, PO, 5, PO, GR, 5, PO, RO, 5, PO, GH, 5, PO, ST, 0, GR, FIR, 20,
  GR, EL, 20, GR, GS, 5, GR, PO, 20, GR, FL, 0, GR, BU, 5, GR, RO, 20, GR, ST, 20,
  FL, EL, 5, FL, GS, 20, FL, FI, 20, FL, BU, 20, FL, RO, 5, FL, ST, 5, PSY, FI, 20,
  PSY, PO, 20, PSY, PSY, 5, PSY, DA, 0, PSY, ST, 5, BU, FIR, 5, BU, GS, 20, BU, FI, 5,
  BU, PO, 5, BU, FL, 5, BU, PSY, 20, BU, GH, 5, BU, DA, 20, BU, ST, 5, RO, FIR, 20,
  RO, IC, 20, RO, FI, 5, RO, GR, 5, RO, FL, 20, RO, BU, 20, RO, ST, 5, GH, N, 0,
  GH, PSY, 20, GH, DA, 5, GH, ST, 5, GH, GH, 20, DR, DR, 20, DR, ST, 5, DA, FI, 5,
  DA, PSY, 20, DA, GH, 20, DA, DA, 5, DA, ST, 5, ST, FIR, 5, ST, WA, 5, ST, EL, 5,
  ST, IC, 20, ST, RO, 20, ST, ST, 5, -1, -1, 0, N, GH, 0, FI, GH, 0,
);

// Lua: types.lua:141 -- pokefirered/src/battle_script_commands.c:1274
Types.typeCalc = function (
  atkTypeIn: any, def1In: any, def2In: any, dmgIn?: number | null, foresight?: any,
): [number | null | undefined, TypeFlags, number] {
  const atkType = tonumber(atkTypeIn) ?? 0;
  const def1 = tonumber(def1In) ?? 0;
  let def2 = tonumber(def2In);
  if (def2 == null) def2 = def1;
  let dmg = dmgIn;
  const flags: TypeFlags = { super: false, notVery: false, immune: false };
  let product = 1;
  const t = Types.TABLE;
  // Lua: types.lua:149
  function modulate(mult: number): void {
    product = product * mult / 10;
    if (truthy(dmg)) {
      dmg = Math.floor((dmg as number) * mult / 10);
      if (dmg === 0 && mult !== 0) dmg = 1;
    }
    if (mult === 0) {
      flags.immune = true;
      flags.super = false;
      flags.notVery = false;
    } else if (mult === 5 && !flags.immune) {
      if (flags.super) flags.super = false; else flags.notVery = true;
    } else if (mult === 20 && !flags.immune) {
      if (flags.notVery) flags.notVery = false; else flags.super = true;
    }
  }
  let i = 1;
  while (i <= len(t)) {
    const a = t[i], d = t[i + 1], m = t[i + 2] as number;
    if (a === -1) {
      if (truthy(foresight)) break;
    } else if (a === atkType) {
      if (d === def1) modulate(m);
      if (d === def2 && def1 !== def2) modulate(m);
    }
    i = i + 3;
  }
  return [dmg, flags, product];
};

// pret AI_EFFECTIVENESS_* (battle_ai.h) — units used by if_type_effectiveness.
// TypeCalc starts at 40 (x1), multiplies by matchups (+ optional STAB 1.5),
// then remaps STAB-distorted values back to the enum (Cmd_if_type_effectiveness).
Types.AI_EFFECTIVENESS = {
  x0: 0,
  x0_25: 10,
  x0_5: 20,
  x1: 40,
  x2: 80,
  x4: 160,
};

// Lua: types.lua:191
Types.aiTypeCalcUnits = function (atkType: any, defType1: any, defType2: any, hasStab?: any): number {
  const m = Types.effectiveness(atkType, defType1, defType2);
  if (m <= 0) return Types.AI_EFFECTIVENESS.x0!;
  let dmg = Types.AI_EFFECTIVENESS.x1! * m;
  if (truthy(hasStab)) dmg = dmg * 1.5;
  dmg = Math.floor(dmg + 1e-9);
  if (dmg === 120) dmg = Types.AI_EFFECTIVENESS.x2!;
  if (dmg === 240) dmg = Types.AI_EFFECTIVENESS.x4!;
  if (dmg === 30) dmg = Types.AI_EFFECTIVENESS.x0_5!;
  if (dmg === 15) dmg = Types.AI_EFFECTIVENESS.x0_25!;
  return dmg;
};

// Back-compat alias (prefer aiTypeCalcUnits for script comparisons).
// Lua: types.lua:205
Types.aiEffectiveness = function (atkType: any, defType1: any, defType2: any): number {
  return Types.aiTypeCalcUnits(atkType, defType1, defType2, false);
};

export default Types;
