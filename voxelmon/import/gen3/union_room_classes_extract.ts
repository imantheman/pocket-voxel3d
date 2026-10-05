// Port of gen1recomp src/import/gba/union_room_classes_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// src/pokemon.c:1666, :6197, :6206
// The per-index tables keep the Lua's 0-based integer keys (objects).

import { Versions } from "./versions.ts";
import { serialize_lua } from "./extract_scripts.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

export interface UnionRoomClasses {
  facilityClass: Record<number, number>;
  trainerClass: Record<number, number>;
  trainerPic: Record<number, number>;
}

export const UnionRoomClassesExtract = {
  CACHE_SUB: "trainers",
  FILE: "union_room_classes.lua",

  // Lua: union_room_classes_extract.lua:10
  extract(rom: Rom): UnionRoomClasses {
    const out: UnionRoomClasses = { facilityClass: {}, trainerClass: {}, trainerPic: {} };
    for (let i = 0; i <= Versions.UNION_ROOM_CLASS_COUNT - 1; i++) {
      const facility = rom.u16(Versions.UNION_ROOM_FACILITY_CLASSES + i * 2);
      out.facilityClass[i] = facility;
      out.trainerClass[i] = rom.get(Versions.FACILITY_CLASS_TO_TRAINER_CLASS + facility);
      out.trainerPic[i] = rom.get(Versions.FACILITY_CLASS_TO_PIC_INDEX + facility);
    }
    return out;
  },

  // Lua: union_room_classes_extract.lua:21
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string } = {}): UnionRoomClasses {
    const root = (opts.cacheRoot ?? "data/generated/gba") + "/" + UnionRoomClassesExtract.CACHE_SUB;
    const pack = UnionRoomClassesExtract.extract(rom);
    cache.write(root + "/" + UnionRoomClassesExtract.FILE, "return " + serialize_lua(pack) + "\n");
    return pack;
  },
};

export default UnionRoomClassesExtract;
