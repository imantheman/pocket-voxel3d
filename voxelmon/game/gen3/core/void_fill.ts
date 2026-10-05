// Port of gen1recomp src/core/game3/void_fill.lua (GPLv3 + additional terms; see LICENSE.md).
// What fills the void outside a map: the map's own border (Brian's default),
// a tree or water border borrowed from a source map, or black.
//
// The Lua probes package.loaded for the runtime's field_view / runtime / map
// modules (never requiring them, so the importer can use this module alone).
// Here those runtime modules register themselves in `VoidFill.loaded` when
// they load; an unregistered module reads as "not loaded", like the probe.
// A layout's borderMids is a Lua sequence (lt.ts: layout.borderMids[i] as in
// the Lua); the returned b.mids is a 0-based array (field_plan reads it so).

import { Family, type FamilyDesc } from "../../../import/gen3/family.ts";
import { Versions } from "../../../import/gen3/versions.ts";
import { Profile } from "./profile.ts";
import { mod } from "../../../import/gen3/lua.ts";

export interface VoidBorder { w: number; h: number; mids: number[] }
interface FamilyRow { primary: string; sources: Record<string, string> }

// package.loaded stand-ins (set by the runtime modules once ported)
const loaded: {
  fieldView?: { _nativeDirty?: boolean };
  runtime?: { _game?: unknown };
  map?: { ensureMidLayout?(game: unknown, mapId: string): [any, boolean?] };
} = {};

// Lua: void_fill.lua:58
function family(): FamilyDesc | undefined {
  try {
    return Family.active();
  } catch {
    return undefined;
  }
}

// Lua: void_fill.lua:63 -- [familyName, row, F]
function config(): [string, FamilyRow, FamilyDesc | undefined] {
  const F = family();
  const name = F ? F.name : "frlg";
  const row = VoidFill.FAMILY[name] ?? VoidFill.FAMILY.frlg!;
  let prof: any;
  if (F) {
    try {
      prof = Profile.of(F.game);
    } catch {
      prof = undefined;
    }
  }
  const over = prof !== undefined && prof !== null && typeof prof === "object" && typeof prof.map === "object" && prof.map !== null
    ? prof.map.voidFill : undefined;
  return [name, over || row, F];
}

// Lua: void_fill.lua:89
function bordersFor(): Record<string, VoidBorder | false> {
  const [name] = config();
  let b = VoidFill._borders[name];
  if (!b) {
    b = {};
    VoidFill._borders[name] = b;
  }
  return b;
}

export const VoidFill = {
  MODES: ["map", "trees", "water", "black"],
  LABELS: { map: "MAP", trees: "TREES", water: "WATER", black: "BLACK" } as Record<string, string>,

  mode: "map",
  _revision: undefined as number | undefined,
  _borders: {} as Record<string, Record<string, VoidBorder | false>>,

  loaded,

  FAMILY: {
    frlg: { primary: "general", sources: { trees: "FR_PALLET_TOWN", water: "FR_CINNABAR_ISLAND" } },
    rse: { primary: "general", sources: { trees: "EM_LITTLEROOT_TOWN", water: "EM_ROUTE105" } },
  } as Record<string, FamilyRow>,

  // Lua: void_fill.lua:75-87 (the DYNAMIC __index fields)
  // pokefirered/include/fieldmap.h:8, pokeemerald/include/fieldmap.h:4
  get PRIMARY(): string {
    return config()[1].primary;
  },
  get PRIMARY_MIDS(): number {
    const F = config()[2];
    return F ? F.numPrimaryMetatiles : 640;
  },
  get SOURCES(): Record<string, string> {
    return config()[1].sources;
  },

  // Lua: void_fill.lua:14
  normalize(mode: unknown): string {
    for (const m of VoidFill.MODES) {
      if (m === mode) return m;
    }
    return "map";
  },

  // Lua: void_fill.lua:21
  setMode(modeIn: unknown): string {
    const mode = VoidFill.normalize(modeIn);
    if (mode !== VoidFill.mode) {
      VoidFill.mode = mode;
      VoidFill.invalidate();
    }
    return VoidFill.mode;
  },

  // Lua: void_fill.lua:30
  cycle(modeIn: unknown, dirIn?: number): string {
    const mode = VoidFill.normalize(modeIn);
    const n = VoidFill.MODES.length;
    let at = 1;
    VoidFill.MODES.forEach((m, i) => {
      if (m === mode) at = i + 1;
    });
    const dir = dirIn !== undefined && dirIn !== null && dirIn < 0 ? -1 : 1;
    return VoidFill.MODES[mod(at - 1 + dir, n)]!;
  },

  // Lua: void_fill.lua:41
  label(mode: unknown): string {
    return VoidFill.LABELS[VoidFill.normalize(mode)]!;
  },

  // Lua: void_fill.lua:45
  invalidate(): void {
    VoidFill._revision = (VoidFill._revision ?? 0) + 1;
    VoidFill._borders = {};
    const FieldView = loaded.fieldView;
    if (FieldView) FieldView._nativeDirty = true;
  },

  // Lua: void_fill.lua:99
  primaryFor(pair: unknown): string | undefined {
    if (typeof pair !== "string") return undefined;
    let spec: any;
    try {
      spec = Versions.TILESET_PAIRS && Versions.TILESET_PAIRS[pair];
    } catch {
      spec = undefined;
    }
    if (spec && spec.primary) return spec.primary;
    const m = /^(.*?)__/.exec(pair);
    return m ? m[1] : undefined;
  },

  // Lua: void_fill.lua:107 -- [layout, pending]
  layoutFor(mapId: string): [any, boolean?] {
    const Runtime = loaded.runtime;
    const game = Runtime && Runtime._game;
    if (!game) return [undefined, true];
    const Map = loaded.map;
    if (!(Map && Map.ensureMidLayout)) return [undefined, true];
    return Map.ensureMidLayout(game, mapId);
  },

  // Lua: void_fill.lua:116
  borderFromLayout(layout: any): VoidBorder | undefined {
    if (layout === null || typeof layout !== "object" || layout.borderMids === null || typeof layout.borderMids !== "object") return undefined;
    if (VoidFill.primaryFor(layout.pair) !== VoidFill.PRIMARY) return undefined;
    const w = layout.borderWidth ?? 0, h = layout.borderHeight ?? 0;
    if (w < 1 || h < 1) return undefined;
    const mids: number[] = [];
    for (let i = 1; i <= w * h; i++) {
      const mid = layout.borderMids[i];
      if (typeof mid !== "number" || mid < 0 || mid >= VoidFill.PRIMARY_MIDS) return undefined;
      mids[i - 1] = mid;
    }
    return { w, h, mids };
  },

  // Lua: void_fill.lua:130
  borderFor(modeIn: unknown): VoidBorder | undefined {
    const mode = VoidFill.normalize(modeIn);
    const mapId = VoidFill.SOURCES[mode];
    if (!mapId) return undefined;
    const cache = bordersFor();
    let b: VoidBorder | false | undefined = cache[mode];
    if (b !== undefined) return b || undefined;
    const [layout, pending] = VoidFill.layoutFor(mapId);
    if (pending) return undefined;
    b = VoidFill.borderFromLayout(layout);
    cache[mode] = b || false;
    return b;
  },

  // Lua: void_fill.lua:145 -- pokefirered/src/fieldmap.c:39
  // A mid, false (black), or undefined (draw the map's own border).
  fillAt(modeIn: unknown, cx?: number, cy?: number, hasMid?: (mid: number) => boolean, primary?: string): number | false | undefined {
    const mode = VoidFill.normalize(modeIn ?? VoidFill.mode);
    if (mode === "map") return undefined;
    if (mode === "black") return false;
    if (primary !== VoidFill.PRIMARY) return undefined;
    const b = VoidFill.borderFor(mode);
    if (!b) return undefined;
    if (hasMid) {
      for (const mid of b.mids) {
        if (!hasMid(mid)) return undefined;
      }
    }
    const bx = mod(cx ?? 0, b.w);
    const by = mod(cy ?? 0, b.h);
    return b.mids[by * b.w + bx];
  },
};

export default VoidFill;
