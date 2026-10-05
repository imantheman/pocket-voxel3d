// Port tooling: where Game3.load's time goes, under the desktop QuickJS
// (cc_g3_qjsbench.sh tools/gen3/qjs_loadprof.ts <card-or-cache root>). Wraps
// every function of the modules the load goes through with a timer
// (inclusive times, so nested calls count in both). Never shipped.
import "./qjs_boot_host.ts";
import { Game3 } from "../../voxelmon/game/gen3/core/Game3.ts";
import { Dataset } from "../../voxelmon/game/gen3/core/dataset.ts";
import { Pokemon } from "../../voxelmon/game/gen3/core/pokemon.ts";
import { Moves } from "../../voxelmon/game/gen3/core/battle/moves.ts";
import { ItemsData } from "../../voxelmon/game/gen3/core/items_data.ts";
import { Audio } from "../../voxelmon/game/gen3/core/audio.ts";
import { Encounters } from "../../voxelmon/game/gen3/core/encounters.ts";
import { Help } from "../../voxelmon/game/gen3/ui/help_system.ts";
import { UI as QuestLog } from "../../voxelmon/game/gen3/ui/quest_log.ts";
import { Boot } from "../../voxelmon/game/gen3/ui/boot.ts";
import { Space } from "../../voxelmon/game/gen3/core/scripting/space.ts";
import { Trainers } from "../../voxelmon/game/gen3/core/scripting/trainers.ts";
import { RomText } from "../../voxelmon/game/gen3/core/rom_text.ts";
import { SaveData } from "../../voxelmon/game/gen3/shared/core/SaveData.ts";
import { ExtractScripts } from "../../voxelmon/import/gen3/extract_scripts.ts";
import { NativePack } from "../../voxelmon/import/gen3/native_pack.ts";
import { LuaData } from "../../voxelmon/game/gen3/platform/luadata.ts";
import { Fs } from "../../voxelmon/game/gen3/platform/fs.ts";
import { Json } from "../../voxelmon/game/gen3/shared/link/Json.ts";
import { MapCatalog } from "../../voxelmon/import/gen3/map_catalog.ts";
import { MapSectionsExtract } from "../../voxelmon/import/gen3/map_sections_extract.ts";
import { Versions } from "../../voxelmon/import/gen3/versions.ts";

declare const print: (s: string) => void;
declare const nowUs: () => number;

const acc = new Map<string, [number, number]>();
function wrap(name: string, o: any): void {
  if (!o) return;
  for (const k of Object.getOwnPropertyNames(o)) {
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (!d || typeof d.value !== "function" || !d.writable || k === "constructor" || k === "new") continue;
    const f = d.value;
    const label = `${name}.${k}`;
    o[k] = function (this: unknown, ...a: unknown[]) {
      const t = nowUs();
      try { return f.apply(this, a); } finally {
        const e = acc.get(label) ?? [0, 0];
        e[0] += nowUs() - t; e[1]++;
        acc.set(label, e);
      }
    };
  }
}
const mods: Record<string, unknown> = { Dataset, Pokemon, Moves, ItemsData, Audio, Encounters, Help, QuestLog, Boot, Space, Trainers, RomText, SaveData, ExtractScripts, NativePack, LuaData, Fs, Json, MapCatalog, MapSectionsExtract };
for (const [n, m] of Object.entries(mods)) wrap(n, m);
wrap("Game3", (Game3 as any).prototype);
wrap("Game3", Game3 as any);

{
  const V: any = Versions;
  const n = (t: any): number => (t ? Object.keys(t).length : -1);
  print(`FRLG_MAP_TO_FR ${n(V.FRLG_MAP_TO_FR)}, FRLG_MAP_TO_SEVII ${n(V.FRLG_MAP_TO_SEVII)}, MAPS ${n(V.MAPS)}`);
}
const t0 = nowUs();
const game: any = Game3.new();
game.load({});
print(`load ${((nowUs() - t0) / 1000).toFixed(0)} ms`);
for (const [k, [us, n]] of [...acc].sort((a, b) => b[1][0] - a[1][0]).slice(0, 45)) print(`${(us / 1000).toFixed(1).padStart(8)} ms ${String(n).padStart(6)}x  ${k}`);
