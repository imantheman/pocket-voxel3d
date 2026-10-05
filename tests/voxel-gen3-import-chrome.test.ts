// The gen3 (FireRed) importer's UI chrome cluster against gen1recomp's own
// importer under LuaJIT (the reference cache ~/gen3ref/frfull). Runs each
// extractor the way its caller does — pokemon_extract.lua (battle moves,
// party/battle/ball-open/storage/transition/summary/bag/shop/TM case/berry
// pouch chrome, all with { cacheRoot }) and RomExtractorGen3's aux list
// (battle_anim_extract with { cacheRoot, force = false }) — then byte-compares
// every file written (PNGs by pixels) and checks nothing the reference holds
// for these modules is missing. ROM-gated.
import { describe, expect, test, beforeAll } from "bun:test";
import { stageCtx, skipReason, compareWrites, referenceFiles, GBA_ROOT, type StageCtx } from "./gen3-import-harness.ts";
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
import { BattleAnimExtract } from "../voxelmon/import/gen3/battle_anim_extract.ts";

const ctx: StageCtx | undefined = stageCtx();
if (!ctx) console.log(`voxel-gen3-import-chrome: skipping — ${skipReason()}`);

const cacheRoot = GBA_ROOT;

/** Reference trees these modules write (whole directories) and single files. */
const OWNED_DIRS = [
  "pokemon/party", "pokemon/battle", "pokemon/storage", "pokemon/battle_transition", "pokemon/summary",
  "items/bag", "items/shop", "items/tm_case", "items/berry_pouch", "pokemon/battle_anims",
];
const OWNED_FILES = ["pokemon/battle_moves.lua"];

describe.skipIf(!ctx)("gen3 import: UI chrome cluster vs gen1recomp", () => {
  const errors: string[] = [];

  beforeAll(() => {
    const { rom, cache } = ctx!;
    // pokemon_extract.lua:1193-1271, in order
    BattleMovesExtract.run(rom, cache, { cacheRoot });
    PartyChromeExtract.run(rom, cache, { cacheRoot });
    BattleChromeExtract.run(rom, cache, { cacheRoot });
    BallOpenExtract.run(rom, cache, { cacheRoot });
    try { StorageChromeExtract.run(rom, cache, { cacheRoot }); } catch (e) { errors.push(`storage: ${(e as Error).stack}`); }
    BattleTransitionExtract.run(rom, cache, { cacheRoot });
    SummaryChromeExtract.run(rom, cache, { cacheRoot });
    BagChromeExtract.run(rom, cache, { cacheRoot });
    ShopChromeExtract.run(rom, cache, { cacheRoot });
    try { TmCaseExtract.run(rom, cache, { cacheRoot }); } catch (e) { errors.push(`tm_case: ${(e as Error).stack}`); }
    try { BerryPouchExtract.run(rom, cache, { cacheRoot }); } catch (e) { errors.push(`berry_pouch: ${(e as Error).stack}`); }
    // RomExtractorGen3 aux entry battle_anim_extract (mode "warn", opts { force = false })
    try { BattleAnimExtract.run(rom, cache, { cacheRoot, force: false }); } catch (e) { errors.push(`battle_anim: ${(e as Error).stack}`); }
  }, 600000);

  test("no extractor raised (the Lua runs some under pcall)", () => {
    expect(errors).toEqual([]);
  });

  test("every file written matches the reference", () => {
    const bad = compareWrites(ctx!.cache.files);
    if (bad.length) console.log(bad.slice(0, 20).map((b) => `${b.path}: ${b.why}`).join("\n"));
    expect(bad).toEqual([]);
  }, 600000);

  test("every reference file of these modules was written", () => {
    const want = [...OWNED_DIRS.flatMap((d) => referenceFiles(`${cacheRoot}/${d}`)), ...OWNED_FILES.map((f) => `${cacheRoot}/${f}`)];
    const missing = want.filter((p) => !ctx!.cache.files.has(p));
    if (missing.length) console.log(`${missing.length} missing, e.g.\n` + missing.slice(0, 20).join("\n"));
    expect(missing).toEqual([]);
  });

  test("item PC backgrounds (bag_chrome writes them into items/item_pc)", () => {
    for (const f of ["bg.rgba", "bg_submenu.rgba"]) expect(ctx!.cache.files.has(`${cacheRoot}/items/item_pc/${f}`)).toBe(true);
  });
});
