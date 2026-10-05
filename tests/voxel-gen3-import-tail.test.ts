// The gen3 (FireRed) importer's remaining field/region extractors against
// gen1recomp's own importer under LuaJIT (the reference cache
// ~/gen3ref/frfull). Runs each the way its caller does:
// - extract_island1.lua:1904-1909 (runScriptsAndOw): OwExtract.writeExtract and
//   FieldEffectExtract.writeExtract with (rom, cache, CACHE_ROOT, version);
// - RomExtractorGen3:runPokemonExtract's pokemonAfter: weather_extract.run
//   with { cacheRoot };
// - RomExtractorGen3:runAuxExtracts, plan order and modes: region_map (raise),
//   heal_locations (result), door_anim (warn), link_art (warn), each with
//   { cacheRoot } and only when not ready;
// then byte-compares every file written (PNGs by pixels) and checks nothing
// the reference holds for these modules is missing. ROM-gated.
import { describe, expect, test, beforeAll } from "bun:test";
import { stageCtx, skipReason, compareWrites, referenceFiles, GBA_ROOT, type StageCtx } from "./gen3-import-harness.ts";
import { Versions } from "../voxelmon/import/gen3/versions.ts";
import { Rom } from "../voxelmon/import/gen3/rom.ts";
import { OwExtract } from "../voxelmon/import/gen3/ow_extract.ts";
import { FieldEffectExtract } from "../voxelmon/import/gen3/field_effect_extract.ts";
import { WeatherExtract } from "../voxelmon/import/gen3/weather_extract.ts";
import { RegionMapExtract } from "../voxelmon/import/gen3/region_map_extract.ts";
import { HealLocationsExtract } from "../voxelmon/import/gen3/heal_locations_extract.ts";
import { DoorAnimExtract } from "../voxelmon/import/gen3/door_anim_extract.ts";
import { LinkArtExtract } from "../voxelmon/import/gen3/link_art_extract.ts";
import { SpriteGfx } from "../voxelmon/import/gen3/rse/sprite_gfx.ts";

const ctx: StageCtx | undefined = stageCtx();
if (!ctx) console.log(`voxel-gen3-import-tail: skipping — ${skipReason()}`);

const root = GBA_ROOT;

/** Whole reference directories these modules own. */
const OWNED_DIRS = ["ow", "field_effects", "weather", "doors", "wireless_status"];
/** region_map/ and union_room/ files other modules write. */
const NOT_OURS = new Set([
  "region_map/names.lua", "region_map/dungeon_info.lua", "region_map/map_sections.lua",
  "region_map/extract_status.json", "union_room/avatars.lua",
].map((p) => `${root}/${p}`));

describe.skipIf(!ctx)("gen3 import: field/region tail cluster vs gen1recomp", () => {
  const errors: string[] = [];
  const results: Record<string, unknown> = {};

  beforeAll(() => {
    const { imports, cache } = ctx!;
    const importId = ctx!.version;
    const [version, verr] = Versions.lookup(imports.info(importId)!.md5);
    if (!version) throw new Error(`no version: ${verr}`);

    // extract_island1.lua:1896-1909
    {
      const [rom] = Rom.open(imports, importId);
      results.ow = OwExtract.writeExtract(rom!, cache, root, version);
      results.fx = FieldEffectExtract.writeExtract(rom!, cache, root, version);
    }

    // RomExtractorGen3.lua:303-305 (pokemonAfter)
    {
      const [rom] = Rom.open(imports, importId);
      results.weather = WeatherExtract.run(rom!, cache, { cacheRoot: root });
    }

    // RomExtractorGen3.lua:362-444 (aux, plan order)
    {
      const [rom] = Rom.open(imports, importId);
      if (!RegionMapExtract.ready(cache, root)) {
        results.regionMap = RegionMapExtract.run(rom!, cache, { cacheRoot: root }); // mode "raise"
      }
      if (!HealLocationsExtract.ready(cache, root)) {
        const [okR, detailR] = HealLocationsExtract.run(rom!, cache, { cacheRoot: root }); // mode "result"
        if (!okR) errors.push(`heal_locations: ${detailR}`);
        results.healLocations = detailR;
      }
      if (!DoorAnimExtract.ready(cache, root)) {
        try { results.doors = DoorAnimExtract.run(rom!, cache, { cacheRoot: root }); } // mode "warn"
        catch (e) { errors.push(`door_anim: ${(e as Error).stack}`); }
      }
      if (!LinkArtExtract.ready(cache, root)) {
        try { results.linkArt = LinkArtExtract.run(rom!, cache, { cacheRoot: root }); } // mode "warn"
        catch (e) { errors.push(`link_art: ${(e as Error).stack}`); }
      }
      rom!.clearCache();
    }
  }, 600000);

  test("no extractor failed (the Lua runs some under pcall / result mode)", () => {
    expect(errors).toEqual([]);
    expect((results.ow as { count: number; total: number }).count).toBe(152);
    expect((results.healLocations as { healLocations: number }).healLocations).toBe(20);
  });

  test("every file written matches the reference", () => {
    const bad = compareWrites(ctx!.cache.files);
    if (bad.length) console.log(bad.slice(0, 20).map((b) => `${b.path}: ${b.why}`).join("\n"));
    expect(bad).toEqual([]);
  }, 600000);

  test("every reference file of these modules was written", () => {
    const want = [
      ...OWNED_DIRS.flatMap((d) => referenceFiles(`${root}/${d}`)),
      ...referenceFiles(`${root}/region_map`).filter((p) => !NOT_OURS.has(p)),
      ...referenceFiles(`${root}/union_room`).filter((p) => !NOT_OURS.has(p)),
    ];
    const missing = want.filter((p) => !ctx!.cache.files.has(p));
    if (missing.length) console.log(`${missing.length} missing, e.g.\n` + missing.slice(0, 20).join("\n"));
    expect(missing).toEqual([]);
    console.log(`voxel-gen3-import-tail: ${ctx!.cache.files.size} files written, ${want.length} owned reference files`);
  });

  test("the modules read their own output back as ready", () => {
    const { cache } = ctx!;
    expect(OwExtract.ready(cache, root)).toBe(true);
    expect(WeatherExtract.ready(cache, root)).toBe(true);
    expect(RegionMapExtract.ready(cache, root)).toBe(true);
    expect(HealLocationsExtract.ready(cache, root)).toBe(true);
    expect(DoorAnimExtract.ready(cache, root)).toBe(true);
    expect(LinkArtExtract.ready(cache, root)).toBe(true);
    const [meta] = OwExtract.decodeMeta(cache.read(`${root}/ow/0.meta`));
    expect(meta!.graphicsId).toBe(0);
    expect(RegionMapExtract.loadLayouts(cache, root)[0].name).toBe("kanto");
  });

  test("rse/sprite_gfx helpers (FRLG reaches none of them)", () => {
    expect(SpriteGfx.snake("FieldEffectObjectTemplate_SandFootprints2")).toBe("field_effect_object_template_sand_footprints_2");
    expect(SpriteGfx.snake("ABCDef")).toBe("abc_def");
    expect(SpriteGfx.rgb8(0x7FFF)).toEqual([255, 255, 255]);
    expect(SpriteGfx.palBytes([0x1234])).toBe("\x34\x12" + "\x00".repeat(30));
    const [rom] = Rom.open(ctx!.imports, ctx!.version);
    // the OW sprite palette table: tag 0x1100 (the player) is the first entry
    const byTag = SpriteGfx.objectEventPalettes(rom!, Versions.OW_SPRITE_PALETTES, 4);
    expect(Object.keys(byTag).length).toBeGreaterThan(0);
  });
});
