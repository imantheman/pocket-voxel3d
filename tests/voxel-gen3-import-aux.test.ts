// The gen3 (FireRed) importer's self-contained art extractors and the audio
// extract against gen1recomp's own importer under LuaJIT (the reference cache
// ~/gen3ref/frfull). Runs each module the way its caller does --
// RomExtractorGen3:runAuxExtracts walks plans/frlg.lua's aux list with
// opts { cacheRoot = GBA_ROOT } ("warn" entries under pcall, credits and
// league raising), and runIntroAudio calls extract_audio with the romShim
// { data = <revised ROM> } and { sha1, root = GBA_ROOT .. "/audio" } -- then
// byte-compares every file written (PNGs by pixels) and checks nothing the
// reference holds for these modules is missing. ROM-gated.
import { describe, expect, test, beforeAll } from "bun:test";
import { stageCtx, skipReason, compareWrites, referenceFiles, GBA_ROOT, type StageCtx } from "./gen3-import-harness.ts";
import { Versions } from "../voxelmon/import/gen3/versions.ts";
import { MapCatalog } from "../voxelmon/import/gen3/map_catalog.ts";
import { MapTree } from "../voxelmon/import/gen3/map_tree.ts";
import { SlotMachineExtract } from "../voxelmon/import/gen3/slot_machine_extract.ts";
import { TradeExtract } from "../voxelmon/import/gen3/trade_extract.ts";
import { FameCheckerExtract } from "../voxelmon/import/gen3/fame_checker_extract.ts";
import { TeachyTvExtract } from "../voxelmon/import/gen3/teachy_tv_extract.ts";
import { MysteryGiftExtract } from "../voxelmon/import/gen3/mystery_gift_extract.ts";
import { TrainerTowerExtract } from "../voxelmon/import/gen3/trainer_tower_extract.ts";
import { MuseumExtract } from "../voxelmon/import/gen3/museum_extract.ts";
import { MoveRelearnerExtract } from "../voxelmon/import/gen3/move_relearner_extract.ts";
import { CreditsExtract } from "../voxelmon/import/gen3/credits_extract.ts";
import { LeagueExtract } from "../voxelmon/import/gen3/league_extract.ts";
import { ExtractAudio } from "../voxelmon/import/gen3/extract_audio.ts";

const ctx: StageCtx | undefined = stageCtx();
if (!ctx) console.log(`voxel-gen3-import-aux: skipping -- ${skipReason()}`);

const cacheRoot = GBA_ROOT;

/** Reference trees these modules write (whole directories) and single files. */
const OWNED_DIRS = [
  "credits", "league", "diploma", "hall_of_fame", "fame_checker", "trainer_tower", "museum",
  "move_relearner", "slot_machine", "trade", "teachy_tv", "mystery_gift", "audio",
];
const OWNED_FILES = ["trainer_tower.lua"];
// written by RomExtractorGen3:runIntroAudio itself, not by extract_audio
const NOT_OURS = new Set([`${GBA_ROOT}/audio/extract_status.json`]);

type Run = (rom: any, cache: any, opts: { cacheRoot: string }) => unknown;

describe.skipIf(!ctx)("gen3 import: aux art extractors + audio vs gen1recomp", () => {
  const errors: string[] = [];
  let audioOk: boolean | undefined;

  beforeAll(() => {
    const { rom, cache, sha1, imports, version: importId } = ctx!;
    Versions.select(sha1);
    // The "gba" task runs first (extract_island1.lua:284-307): its map census
    // registers every map into Versions.MAP_HEADERS, which extract_audio's
    // mapSongs walks later. (Seeds only order the list; the set is the same.)
    const [version] = Versions.lookup(imports.info(importId)!.md5);
    MapCatalog.rebuildIndex();
    const [census] = MapTree.walk(rom, version);
    const [mapOrder, byEngine] = MapCatalog.allOrder(census!);
    MapCatalog.registerOrder(rom, version, mapOrder, byEngine);
    // plans/frlg.lua aux list, in order (only this cluster's entries)
    const aux: [string, Run][] = [
      ["slot_machine_extract", SlotMachineExtract.run],
      ["trade_extract", TradeExtract.run],
      ["fame_checker_extract", FameCheckerExtract.run],
      ["teachy_tv_extract", TeachyTvExtract.run],
      ["mystery_gift_extract", MysteryGiftExtract.run],
      ["trainer_tower_extract", TrainerTowerExtract.run],
      ["museum_extract", MuseumExtract.run],
      ["move_relearner_extract", MoveRelearnerExtract.run],
      ["credits_extract", CreditsExtract.run],
      ["league_extract", LeagueExtract.run],
    ];
    for (const [name, run] of aux) {
      try { run(rom, cache, { cacheRoot }); } catch (e) { errors.push(`${name}: ${(e as Error).stack}`); }
    }
    // RomExtractorGen3:runIntroAudio (romShim = { data = RevisionView.forImports(...) })
    try {
      const [ok] = ExtractAudio.run({ data: rom.raw }, cache, { sha1, root: GBA_ROOT + "/audio" });
      audioOk = ok;
    } catch (e) { errors.push(`extract_audio: ${(e as Error).stack}`); }
  }, 600000);

  test("no extractor raised (the Lua runs the warn entries under pcall)", () => {
    expect(errors).toEqual([]);
    expect(audioOk).toBe(true);
  });

  test("every file written matches the reference", () => {
    const bad = compareWrites(ctx!.cache.files);
    if (bad.length) console.log(bad.slice(0, 20).map((b) => `${b.path}: ${b.why}`).join("\n"));
    expect(bad).toEqual([]);
  }, 600000);

  test("every reference file of these modules was written", () => {
    const want = [...OWNED_DIRS.flatMap((d) => referenceFiles(`${cacheRoot}/${d}`)), ...OWNED_FILES.map((f) => `${cacheRoot}/${f}`)]
      .filter((p) => !NOT_OURS.has(p));
    const missing = want.filter((p) => !ctx!.cache.files.has(p));
    if (missing.length) console.log(`${missing.length} missing, e.g.\n` + missing.slice(0, 20).join("\n"));
    expect(missing).toEqual([]);
  });

  test("ready() sees each module's output", () => {
    const c = ctx!.cache;
    for (const m of [SlotMachineExtract, TradeExtract, FameCheckerExtract, TeachyTvExtract, MysteryGiftExtract,
      TrainerTowerExtract, MuseumExtract, MoveRelearnerExtract, CreditsExtract, LeagueExtract]) {
      expect(m.ready(c, cacheRoot)).toBe(true);
    }
    expect(ExtractAudio.ready(c, cacheRoot)).toBe(true);
  });
});
