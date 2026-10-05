// The gen3 (FireRed) "species" cluster against gen1recomp's own importer run
// under LuaJIT (the reference cache, tests/gen3-import-harness.ts):
// pokemon_extract (and the chrome extractors it runs: pokedex, text chrome,
// items, trainer card + the Hoenn-style card), trainer_extract, online_ui_extract,
// and the aux extractors map_sections / tutor / egg / map_preview, each run
// the way RomExtractorGen3 / extract_island1 run them. Every file they write
// is compared with the reference (bytes; PNGs by pixels), and every reference
// file they are responsible for must have been written.
// ROM-gated.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareWrites, GBA_ROOT, REF_ROOT, referenceFiles, skipReason, stageCtx, type Mismatch } from "./gen3-import-harness.ts";
import type { Cache } from "../voxelmon/import/gen3/cache.ts";
import { readLuaLiteral, AssetPack } from "../voxelmon/import/gen3/asset_pack.ts";
import { PokemonExtract } from "../voxelmon/import/gen3/pokemon_extract.ts";
import { TrainerExtract } from "../voxelmon/import/gen3/trainer_extract.ts";
import { OnlineUiExtract } from "../voxelmon/import/gen3/online_ui_extract.ts";
import { MapSectionsExtract } from "../voxelmon/import/gen3/map_sections_extract.ts";
import { MapPreviewExtract } from "../voxelmon/import/gen3/map_preview_extract.ts";
import { TutorExtract } from "../voxelmon/import/gen3/tutor_extract.ts";
import { EggExtract } from "../voxelmon/import/gen3/egg_extract.ts";
import { MonAnimExtract } from "../voxelmon/import/gen3/mon_anim_extract.ts";
import { RegionMapTables } from "../voxelmon/import/gen3/region_map_tables.ts";
import { BattleMovesExtract } from "../voxelmon/import/gen3/battle_moves_extract.ts";
import { PartyChromeExtract } from "../voxelmon/import/gen3/party_chrome_extract.ts";
import { BattleChromeExtract } from "../voxelmon/import/gen3/battle_chrome_extract.ts";
import { BallOpenExtract } from "../voxelmon/import/gen3/ball_open_extract.ts";
import { StorageChromeExtract } from "../voxelmon/import/gen3/storage_chrome_extract.ts";
import { BattleTransitionExtract } from "../voxelmon/import/gen3/battle_transition_extract.ts";
import { SummaryChromeExtract } from "../voxelmon/import/gen3/summary_chrome_extract.ts";
import { BagChromeExtract } from "../voxelmon/import/gen3/bag_chrome_extract.ts";
import { ShopChromeExtract } from "../voxelmon/import/gen3/shop_chrome_extract.ts";
import { TmCaseExtract } from "../voxelmon/import/gen3/tm_case_extract.ts";
import { BerryPouchExtract } from "../voxelmon/import/gen3/berry_pouch_extract.ts";
import { EasyChatExtract } from "../voxelmon/import/gen3/easy_chat_extract.ts";

const ctx = stageCtx();
if (!ctx) console.log(`voxel-gen3-import-species: skipping — ${skipReason()}`);

// ------------------------------------------------------------ who wrote what
// pokemon_extract runs the other clusters' chrome extractors too; their runs
// are wrapped so each write is tagged with its owner, and this test holds
// only the species cluster's own writes to the reference.
let owner = "species";
const ownerOf = new Map<string, string>();
function tagging(cache: Cache): Cache {
  return {
    write(rel, bytes) { if (!ownerOf.has(rel) || owner === "species") ownerOf.set(rel, owner); return cache.write(rel, bytes); },
    read: (rel) => cache.read(rel),
    exists: (rel) => cache.exists(rel),
    info: (rel) => cache.info(rel),
  };
}
const FOREIGN: Record<string, { run: (...a: any[]) => any }> = {
  battle_moves: BattleMovesExtract, party_chrome: PartyChromeExtract, battle_chrome: BattleChromeExtract,
  ball_open: BallOpenExtract, storage_chrome: StorageChromeExtract, battle_transition: BattleTransitionExtract,
  summary_chrome: SummaryChromeExtract, bag_chrome: BagChromeExtract, shop_chrome: ShopChromeExtract,
  tm_case: TmCaseExtract, berry_pouch: BerryPouchExtract, easy_chat: EasyChatExtract,
};
for (const [name, mod] of Object.entries(FOREIGN)) {
  const run = mod.run;
  mod.run = (...a: any[]) => {
    const prev = owner;
    owner = name;
    try { return run.apply(mod, a); } finally { owner = prev; }
  };
}
const mine = (p: string): boolean => (ownerOf.get(p) ?? "species") === "species";

function report(label: string, bad: Mismatch[]): void {
  if (bad.length) console.log(`${label}: ${bad.length} mismatches\n` + bad.slice(0, 12).map((m) => `  ${m.path}: ${m.why}`).join("\n"));
}

function refLua(rel: string): any {
  return readLuaLiteral(readFileSync(join(REF_ROOT, rel)).toString("latin1"));
}

// Cache paths are byte strings (lua.ts THE STRING RULE): a species name with
// a gender sign makes a footprint file name with UTF-8 bytes in it. The
// harness joins paths as JS strings (which Node encodes as UTF-8 again), so
// those few files are compared here through latin1 Buffers.
const isAscii = (p: string): boolean => /^[\x00-\x7f]*$/.test(p);
function compareAll(files: Map<string, string | Uint8Array>, only: (p: string) => boolean): Mismatch[] {
  const bad = compareWrites(files, (p) => isAscii(p) && only(p));
  for (const [path, body] of files) {
    if (isAscii(path) || !only(path)) continue;
    const ref = Buffer.concat([Buffer.from(REF_ROOT + "/", "utf8"), Buffer.from(path, "latin1")]);
    if (!existsSync(ref)) { bad.push({ path, why: "not in the reference (gen1recomp did not write it)" }); continue; }
    const ours = typeof body === "string" ? Buffer.from(body, "latin1") : Buffer.from(body);
    if (!ours.equals(readFileSync(ref))) bad.push({ path, why: "bytes differ" });
  }
  return bad;
}

/** Reference files under `prefix` (optionally filtered) that the run did not write. */
function unwritten(prefix: string, files: Map<string, unknown>, keep: (p: string) => boolean = () => true): string[] {
  return referenceFiles(prefix) // byte-string paths already (the harness reads them as latin1)
    .filter((p) => keep(p) && !files.has(p));
}

describe.skipIf(!ctx)("gen3 import: species cluster", () => {
  const c = ctx!;
  const cache = tagging(c.cache);

  test("pokemon_extract (as RomExtractorGen3:runPokemonExtract, sequential)", () => {
    expect(PokemonExtract.ready(cache, GBA_ROOT)).toBe(false);
    const res = PokemonExtract.run(c.rom, cache, {
      cacheRoot: GBA_ROOT, spMin: 0, spMax: undefined, progress: () => {},
    });
    expect(res.numSpecies).toBe(412);
    const bad = compareAll(c.cache.files, mine);
    console.log(`pokemon_extract: ${[...c.cache.files.keys()].filter(mine).length} species-cluster files compared`);
    report("pokemon_extract", bad);
    expect(bad).toEqual([]);
    // the other clusters' writes, for information only
    report("(foreign chrome written by pokemon_extract)", compareAll(c.cache.files, (p) => !mine(p)));

    const files = c.cache.files;
    const P = GBA_ROOT + "/pokemon";
    const missing = [
      ...unwritten(P, files, (p) => /^[^/]+\/[^/]+\/[^/]+\/pokemon\/[^/]+\.lua$/.test(p)
        && !/(battle_moves|tutor)\.lua$/.test(p)),
      ...["front", "back", "front_shiny", "back_shiny", "icons", "spinda", "pokedex"].flatMap((d) =>
        unwritten(`${P}/${d}`, files, (p) => !/\/(front|icons)\/412\.rgba$/.test(p))),
      ...unwritten(GBA_ROOT + "/chrome", files),
      ...unwritten(GBA_ROOT + "/trainer_card", files),
      ...unwritten(GBA_ROOT + "/rse/trainer_card", files),
      ...unwritten(GBA_ROOT + "/pokedex", files),
      ...unwritten(GBA_ROOT + "/items", files, (p) => p.endsWith("/items/pack.lua")),
    ];
    if (!files.has(GBA_ROOT + "/keypad_icons.rgba")) missing.push(GBA_ROOT + "/keypad_icons.rgba");
    expect(missing).toEqual([]);
  }, 600_000);

  test("trainer_extract (as extract_island1 runs it, with the scripts bundle)", () => {
    const scripts = refLua(GBA_ROOT + "/scripts/scripts.lua");
    const text = refLua(GBA_ROOT + "/scripts/text.lua");
    const before = new Set(c.cache.files.keys());
    const res = TrainerExtract.run(c.rom, cache, { cacheRoot: GBA_ROOT, scripts, text });
    expect(res.frontPics).toBe(148);
    const bad = compareAll(c.cache.files, (p) => !before.has(p));
    report("trainer_extract", bad);
    expect(bad).toEqual([]);
    const missing = unwritten(GBA_ROOT + "/trainers", c.cache.files, (p) => !p.endsWith("/union_room_classes.lua"));
    if (!c.cache.files.has(GBA_ROOT + "/trainers.lua")) missing.push(GBA_ROOT + "/trainers.lua");
    expect(missing).toEqual([]);
  }, 600_000);

  test("trainer_extract reads the scripts bundle back from the cache (load fallback)", () => {
    const fresh = new Map<string, string>();
    const local: Cache = {
      write(rel, bytes) { fresh.set(rel, typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("latin1")); return true; },
      read(rel) {
        if (fresh.has(rel)) return fresh.get(rel);
        if (rel.startsWith(GBA_ROOT + "/scripts/")) return readFileSync(join(REF_ROOT, rel)).toString("latin1");
        return undefined;
      },
      exists: (rel) => fresh.has(rel),
      info: () => undefined,
    };
    TrainerExtract.run(c.rom, local, { cacheRoot: GBA_ROOT });
    expect(fresh.get(GBA_ROOT + "/trainers.lua")).toBe(readFileSync(join(REF_ROOT, GBA_ROOT + "/trainers.lua")).toString("latin1"));
  }, 600_000);

  test("online_ui_extract (as extract_island1 runs it)", () => {
    const before = new Set(c.cache.files.keys());
    OnlineUiExtract.run(c.rom, cache, { cacheRoot: GBA_ROOT });
    const bad = compareAll(c.cache.files, (p) => !before.has(p));
    report("online_ui_extract", bad);
    expect(bad).toEqual([]);
    const missing = unwritten(GBA_ROOT + "/link", c.cache.files);
    if (!c.cache.files.has(GBA_ROOT + "/" + OnlineUiExtract.AVATARS)) missing.push(OnlineUiExtract.AVATARS);
    expect(missing).toEqual([]);
    expect(OnlineUiExtract.ready(cache, GBA_ROOT)).toBe(true);
  });

  test("aux extractors in plan order: map_sections, tutor, egg, map_preview", () => {
    const before = new Set(c.cache.files.keys());
    // mode "sections"
    MapSectionsExtract.run(c.rom, cache, { cacheRoot: GBA_ROOT });
    const body = cache.read(GBA_ROOT + "/region_map/map_sections.lua");
    expect(body !== undefined && body.length >= 1024).toBe(true);
    // mode "warn": pcall(mod.run, ...)
    expect(TutorExtract.ready(cache, GBA_ROOT)).toBe(false);
    TutorExtract.run(c.rom, cache, { cacheRoot: GBA_ROOT });
    expect(EggExtract.ready(cache, GBA_ROOT)).toBe(false);
    EggExtract.run(c.rom, cache, { cacheRoot: GBA_ROOT });
    expect(MapPreviewExtract.ready(cache, GBA_ROOT)).toBe(false);
    const [ok, detail] = MapPreviewExtract.run(c.rom, cache, { cacheRoot: GBA_ROOT });
    expect(ok).toBe(true);
    expect(detail.namesVerified).toBe(true);

    const bad = compareAll(c.cache.files, (p) => !before.has(p));
    report("aux", bad);
    expect(bad).toEqual([]);
    const R = GBA_ROOT;
    const want = [
      R + "/region_map/map_sections.lua", R + "/map_sections.lua", R + "/pokemon/tutor.lua",
      R + "/pokemon/front/412.rgba", R + "/pokemon/icons/412.rgba",
      R + "/region_map/names.lua", R + "/region_map/dungeon_info.lua",
      ...referenceFiles(R + "/pokemon/egg"), ...referenceFiles(R + "/map_preview"),
    ];
    expect(want.filter((p) => !c.cache.files.has(p))).toEqual([]);

    // the generated data reads back, and the runtime lookups work from it
    expect(TutorExtract.ready(cache, GBA_ROOT) && EggExtract.ready(cache, GBA_ROOT)).toBe(true);
    expect(MapPreviewExtract.ready(cache, GBA_ROOT)).toBe(true);
    const names = MapPreviewExtract.loadNames(cache, GBA_ROOT)!;
    expect(names[88]).toBe("PALLET TOWN");
    MapSectionsExtract.installNames(names);
    expect(MapSectionsExtract.getInfo(undefined, "FR_ROUTE_22", 0).id).toBe("MAPSEC_ROUTE_22");
    expect(MapSectionsExtract.getInfo(98, "CeladonCity_DepartmentStore_2F", 2).name).toBe(MapSectionsExtract.SECTIONS[196]!.name + " 2F");
  });

  test("helpers: asset_pack serializer and literal reader round trip; region tables; mon_anim needs syms", () => {
    const v = { b: [1, 2, { x: -3 }], a: "q\"\n", 3: true, f: 0.5 };
    const text = AssetPack.serialize(v);
    expect(text).toBe('return {\n  [3] = true,\n  a = "q\\"\\\n",\n  b = {\n    1,\n    2,\n    {\n      x = -3,\n    },\n  },\n  f = 0.5,\n}\n');
    expect(readLuaLiteral(text)).toEqual({ 3: true, a: 'q"\n', b: [1, 2, { x: -3 }], f: 0.5 });
    const [t] = RegionMapTables.load(c.rom);
    expect(t!.previews.length).toBe(28);
    expect(() => MonAnimExtract.extract(c.rom)).toThrow();
  });
});
