// Port of gen1recomp src/import/gba/layouts/registry.lua + layouts/frlg.lua
// (GPLv3 + additional terms; see LICENSE.md). Per-family struct layouts the
// extractors read (pokedex entry, trainer name length, ...). The Lua requires
// layouts.<game> then layouts.<family>; only "frlg" is ported (Emerald's
// layout is out of scope), so other names fall through like a missing module.

import { GameVersion } from "./game_version.ts";
import { Versions } from "./versions.ts";
import { Constants } from "../../game/gen3/core/constants.ts";

export interface StructLayout {
  id: string;
  constantsGame: string;
  pokedexEntry: Record<string, number>;
  regionalDex?: unknown;
  trainerNameLen: number;
  trainerBackPicCount: number;
  trainerExtras: boolean;
  inlineTrainerDialogs: boolean;
  tutorLearnsetBytes: number;
  [k: string]: unknown;
}

// Lua: layouts/frlg.lua
const FRLG: StructLayout = {
  id: "frlg",
  constantsGame: "firered",
  // pokefirered/include/pokedex.h:102
  pokedexEntry: {
    size: 36,
    category: 0,
    categoryLen: 12,
    height: 12,
    weight: 14,
    desc: 16,
    desc2: 20,
    pokemonScale: 26,
    pokemonOffset: 28,
    trainerScale: 30,
    trainerOffset: 32,
  },
  regionalDex: undefined,
  // pokefirered/include/battle.h:116
  trainerNameLen: 12,
  // pokefirered/src/data/trainer_graphics/back_pic_tables.h:10
  trainerBackPicCount: 6,
  trainerExtras: false,
  inlineTrainerDialogs: true,
  // pokefirered/src/data/pokemon/tutor_learnsets.h:22
  tutorLearnsetBytes: 2,
};

// The modules src.import.gba.layouts.<name> that exist.
const MODULES: Record<string, StructLayout> = { frlg: FRLG };

const cache: Record<string, StructLayout> = {};

// Lua: layouts/registry.lua:7
function tryLoad(name: unknown): StructLayout | undefined {
  if (typeof name !== "string" || name === "") return undefined;
  return MODULES[name];
}

export const Layouts = {
  // Lua: layouts/registry.lua:18
  of(game: string): StructLayout {
    if (cache[game]) return cache[game]!;
    const info = GameVersion.VERSIONS[game];
    if (!info || (info.generation ?? 1) !== 3) {
      throw new Error("layouts: not a gen 3 version id: " + String(game));
    }
    const layout = tryLoad(game) ?? tryLoad(GameVersion.layout(game));
    if (!layout) {
      throw new Error("layouts: no struct layout for " + String(game));
    }
    cache[game] = layout;
    return layout;
  },

  // Lua: layouts/registry.lua:33
  active(): StructLayout {
    return Layouts.of(Versions.active());
  },

  // Lua: layouts/registry.lua:37 -- { [pocket id]: short name }
  pockets(layout: StructLayout): Record<number, string> {
    const enumT = (Constants.of(layout.constantsGame).items.pockets ?? {}) as Record<string, number>;
    const out: Record<number, string> = {};
    for (const name of Object.keys(enumT)) {
      const id = enumT[name]!;
      const m = /^POCKET_(.+)$/.exec(name);
      const short = m ? m[1] : undefined;
      if (short && short !== "NONE" && id > 0) out[id] = short;
    }
    return out;
  },
};

export default Layouts;
