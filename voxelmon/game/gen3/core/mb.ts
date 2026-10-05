// Port of gen1recomp src/core/game3/mb.lua (GPLv3 + additional terms; see LICENSE.md).
// Canonical metatile-behavior ids: FireRed's MB_* values, plus Emerald-only
// behaviors numbered from RSE_BASE (Emerald names renamed in FRLG alias the
// FRLG id). MB.<NAME> holds each id, as the Lua's module table does.
// NOT FAITHFUL (plumbing): constants.ts does not carry Emerald's tables, so
// Emerald's metatile behaviors (converted mechanically into
// constants/emerald/metatile_behaviors.ts) are read directly here.
// NOT FAITHFUL: MB.translator() for an RSE game needs src.import.gba.mb_<game>
// (Emerald only, not ported) and throws.

import { tonumber, tostring } from "../../../import/gen3/lua.ts";
import { GameVersion } from "../../../import/gen3/game_version.ts";
import { Constants } from "./constants.ts";
import emeraldBehaviors from "./constants/emerald/metatile_behaviors.ts";

type BehaviorConsts = { byId: Record<string, Record<number, string>>; byName: Record<string, number> };

/** A behavior translator (src.import.gba.mb_<game>). */
export interface MbTranslator { canon(raw: number): number; [k: string]: unknown }

const RSE_BASE = 0x100;

// pokeemerald/src/metatile_behavior.c:220
const RENAMES: Record<string, string> = {
  NO_RUNNING: "RUNNING_DISALLOWED",
  NO_SURFACING: "UNDERWATER_BLOCKED_ABOVE",
  NON_ANIMATED_DOOR: "CAVE_DOOR",
  ANIMATED_DOOR: "WARP_DOOR",
};

const ids: Record<string, number> = {};
const names: Record<number, string> = {};
const rseRaw: Record<number, number> = {};

// Lua: mb.lua:19
function strip(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  return name.replace(/^MB_/, "");
}

// Lua: mb.lua:24
function sortedNames(byName: Record<string, unknown>): string[] {
  const list: string[] = [];
  for (const name of Object.keys(byName)) {
    if (/^MB_/.test(name) && typeof byName[name] === "number") list.push(name);
  }
  list.sort((a, b) => {
    const va = byName[a] as number, vb = byName[b] as number;
    if (va !== vb) return va - vb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return list;
}

// Lua: mb.lua:36-69
{
  const fr = Constants.of("firered").metatile_behaviors as BehaviorConsts;
  for (const full of sortedNames(fr.byName)) {
    const name = strip(full)!;
    const v = fr.byName[full]!;
    ids[name] = v;
    if (names[v] === undefined) names[v] = name;
  }
  const frIds = fr.byId.MB_ ?? {};
  for (const k of Object.keys(frIds)) {
    const name = strip(frIds[Number(k)]);
    if (name !== undefined && ids[name] !== undefined) names[ids[name]!] = name;
  }
  const em = emeraldBehaviors as unknown as BehaviorConsts;
  for (const full of sortedNames(em.byName)) {
    const name = strip(full)!;
    const raw = em.byName[full]!;
    if (ids[name] === undefined) {
      const alias = RENAMES[name];
      if (alias !== undefined && ids[alias] !== undefined) {
        ids[name] = ids[alias]!;
      } else {
        const v = RSE_BASE + raw;
        ids[name] = v;
        rseRaw[v] = raw;
        if (names[v] === undefined) names[v] = name;
      }
    }
  }
  const emIds = em.byId.MB_ ?? {};
  for (const k of Object.keys(emIds)) {
    const name = strip(emIds[Number(k)]);
    const v = name !== undefined ? ids[name] : undefined;
    if (v !== undefined && v >= RSE_BASE) names[v] = name!;
  }
}

const translators: Record<string, MbTranslator> = {};

export const MB: Record<string, any> & {
  RSE_BASE: number;
  RENAMES: Record<string, string>;
  id(name: unknown): number | undefined;
  require(name: unknown): number;
  nameOf(id: unknown): string | undefined;
  isRseOnly(id: unknown): boolean;
  all(): Record<string, number>;
  translator(game: string): MbTranslator | undefined;
  fromRaw(game: string, raw: number): number;
} = {
  RSE_BASE,
  RENAMES,

  // Lua: mb.lua:73
  id(name: unknown): number | undefined {
    const s = strip(name);
    return s === undefined ? undefined : ids[s];
  },

  // Lua: mb.lua:77
  require(name: unknown): number {
    const s = strip(name);
    const v = s === undefined ? undefined : ids[s];
    if (v === undefined) throw new Error("mb: unknown metatile behavior '" + tostring(name) + "'");
    return v;
  },

  // Lua: mb.lua:83
  nameOf(id: unknown): string | undefined {
    return names[tonumber(id) ?? -1];
  },

  // Lua: mb.lua:87
  isRseOnly(idv: unknown): boolean {
    const id = tonumber(idv);
    return id !== undefined && id >= RSE_BASE;
  },

  // Lua: mb.lua:92
  all(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const name of Object.keys(ids)) out[name] = ids[name]!;
    return out;
  },

  // Lua: mb.lua:100
  translator(game: string): MbTranslator | undefined {
    const layout = GameVersion.layout(game);
    if (layout === undefined || layout === "frlg") return undefined;
    let t = translators[game];
    if (t === undefined) {
      throw new Error(`NOT FAITHFUL: Emerald only -- module 'src.import.gba.mb_${game}' is not ported`);
    }
    return t;
  },

  // Lua: mb.lua:112
  fromRaw(game: string, raw: number): number {
    const t = MB.translator(game);
    if (!t) return raw;
    return t.canon(raw);
  },
};

// Lua: mb.lua:71
for (const name of Object.keys(ids)) MB[name] = ids[name];

/** The Emerald raw value behind an RSE-only canonical id (the Lua's local rseRaw). */
export const _rseRaw = rseRaw;

export default MB;
