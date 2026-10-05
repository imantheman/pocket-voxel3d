// The gen3 (FireRed) importer's "scripts" cluster -- script/event/text BFS,
// marts, flags, wild encounters, global object interactions, help, quest
// log, battle AI, union room classes, in-game trades, easy chat words,
// multichoice lists, Seagallop and cave-transition art -- against
// gen1recomp's own importer under LuaJIT (the reference cache, see
// tests/gen3-import-harness.ts).
//
// The modules are driven exactly as the reference run (RomExtractorGen3)
// drives them:
//  - extract_island1.lua Extract.run: census registered with MAP_ORDER in
//    front (:302-307), extract_scripts.extractFromRom (:366); then on rom2
//    help, quest_log, object_interactions (:484-486), encounters (:497-498),
//    marts_extract.run (:503, a no-op there: scripts.lua is not written
//    yet); then writeBundleFromRom (:557) -- scripts/*, marts.lua,
//    flags_table.lua. (TrainerExtract.run, :563, is the species cluster's.)
//  - RomExtractorGen3:runPokemonExtract: pokemon_extract.run ends with
//    easy_chat_extract.run (pokemon_extract.lua:1274); then the plan's
//    pokemonAfter modules of this cluster: seagallop, cave_transition,
//    ingame_trades, union_room_classes (weather is another cluster's).
//  - RomExtractorGen3:runAuxExtracts: multichoice_extract and
//    battle_ai_extract (mode "raise": mod.run(rom, cache, { cacheRoot })).
// None of these stages reads a file another cluster writes, so nothing is
// seeded from the reference.
import { describe, expect, test } from "bun:test";
import { stageCtx, skipReason, compareWrites, referenceFiles, GBA_ROOT } from "./gen3-import-harness.ts";
import { Versions } from "../voxelmon/import/gen3/versions.ts";
import { Rom } from "../voxelmon/import/gen3/rom.ts";
import { MapTree } from "../voxelmon/import/gen3/map_tree.ts";
import { MapCatalog } from "../voxelmon/import/gen3/map_catalog.ts";
import { ExtractScripts, serialize_lua } from "../voxelmon/import/gen3/extract_scripts.ts";
import { MartsExtract } from "../voxelmon/import/gen3/marts_extract.ts";
import { FlagsExtract } from "../voxelmon/import/gen3/flags_extract.ts";
import { EncountersExtract } from "../voxelmon/import/gen3/encounters_extract.ts";
import { ObjectInteractionsExtract } from "../voxelmon/import/gen3/object_interactions_extract.ts";
import { BattleAiExtract } from "../voxelmon/import/gen3/battle_ai_extract.ts";
import { UnionRoomClassesExtract } from "../voxelmon/import/gen3/union_room_classes_extract.ts";
import { InGameTradesExtract } from "../voxelmon/import/gen3/ingame_trades_extract.ts";
import { EasyChatExtract } from "../voxelmon/import/gen3/easy_chat_extract.ts";
import { MultichoiceExtract } from "../voxelmon/import/gen3/multichoice_extract.ts";
import { HelpExtract } from "../voxelmon/import/gen3/help_extract.ts";
import { QuestLogExtract } from "../voxelmon/import/gen3/quest_log_extract.ts";
import { SeagallopExtract } from "../voxelmon/import/gen3/seagallop_extract.ts";
import { CaveTransitionExtract } from "../voxelmon/import/gen3/cave_transition_extract.ts";
import { Syms } from "../voxelmon/import/gen3/syms.ts";
import { MovementEmerald } from "../voxelmon/import/gen3/movement_emerald.ts";
import { memoryCache } from "../voxelmon/import/gen3/cache.ts";
import { Disasm } from "../voxelmon/game/gen3/core/scripting/disasm.ts";
import { Movement } from "../voxelmon/game/gen3/core/scripting/movement.ts";
import { MB } from "../voxelmon/game/gen3/core/mb.ts";
import { Marts } from "../voxelmon/game/gen3/core/marts.ts";
import { Encounters } from "../voxelmon/game/gen3/core/encounters.ts";

const ctx = stageCtx();
if (!ctx) console.log(`voxel-gen3-import-scripts: skipping -- ${skipReason()}`);

// ------------------------------------------------------------ no ROM

describe("gen3 scripts core modules (no ROM)", () => {
  test("disasm decodes and re-encodes Tier A rows", () => {
    const rows = [
      { op: "setvar", var: 0x4001, value: 3 },
      { op: "goto_if", cond: 1, target: 0x08160000 },
      { op: "message", ptr: 0x081a0000 },
      { op: "end" },
    ];
    const bytes = Disasm.encodeSimple(rows);
    const back = Disasm.decode(bytes);
    expect(back.map((r) => r.op)).toEqual(["setvar", "goto_if", "message", "end"]);
    expect(back[0]).toMatchObject({ 1: 0x4001, 2: 3, var: 0x4001, value: 3, opcode: 0x16 });
    expect(back[1]!.target).toBe(0x08160000);
    expect(Disasm.decodeMovement([0x11, 0x12, 0xfe, 0x13], 1)).toEqual([0x11, 0x12, 0xfe]);
    expect(Disasm.decodeOne([0xff], 1)[0]).toEqual({ op: "unknown", byte: 0xff });
  });

  test("movement actions, emerald canon, behaviors, syms", () => {
    expect(Movement.decodeAction(0x11)).toEqual({ kind: "step", dir: "up" });
    expect(Movement.decodeAction(0xfe)).toEqual({ kind: "end" });
    expect(Movement.decodeAction(0x62)).toMatchObject({ kind: "emote", emoteType: "exclamation" });
    expect(Movement.actionsFromBytes([0x10, 0x00, 0xfe, 0x11]).length).toBe(2);
    expect(MovementEmerald.canonOf("MOVEMENT_ACTION_WALK_NORMAL_UP")).toBe(0x11);
    expect(MovementEmerald.canon().rseCount).toBeGreaterThan(0);
    expect(MovementEmerald.forGame("emerald").translate([0xfe])[0]).toEqual([0xfe]);
    expect(MB.id("TALL_GRASS")).toBe(2);
    expect(MB.TALL_GRASS).toBe(2);
    expect(MB.nameOf(MB.require("MB_SECRET_BASE_WALL"))).toBe("SECRET_BASE_WALL");
    expect(MB.isRseOnly(MB.require("SECRET_BASE_WALL"))).toBe(true);
    expect(MB.id("NO_RUNNING")).toBe(MB.id("RUNNING_DISALLOWED"));
    expect(MB.translator("firered")).toBeUndefined();
    expect(() => Syms.of("emerald").off("gStdScripts")).toThrow(/Emerald only/);
    Syms.register("test", { objs: "a.o\nb.o\n", collide: "dup\n", data: "gFoo 100 20 1\ndup 200 ~8 2\n" });
    const S = Syms.of("test");
    expect(S.off("gFoo")).toBe(0x100);
    expect(S.obj("gFoo")).toBe("a.o");
    expect(S.namesAt(0x200)).toEqual(["dup"]);
    expect(S.sizeKind("b.o:dup")).toBe("span");
    expect(() => S.off("dup")).toThrow(/several objects/);
  });

  test("serializer, marts round trip, flags fallback, encounters load", () => {
    expect(serialize_lua({ 1: 5, op: "x" })).toBe('{\n  [1] = 5,\n  op = "x",\n}');
    expect(serialize_lua([1, 2])).toBe("{\n  1,\n  2,\n}");
    expect(serialize_lua({})).toBe("{\n}");
    const cache = memoryCache();
    const marts = new Map<number | string, any>();
    const e = { ptr: 0x08164000, key: "g3:08164000", items: [2, 3] };
    marts.set(e.ptr, e); marts.set(String(e.ptr), e); marts.set(e.key, e);
    MartsExtract.write(cache, "r", marts, { count: 1 });
    expect(cache.read("r/scripts/marts.lua")).toContain('["135675904"] = {');
    expect(Marts.load(cache, "r")).toBe(1);
    expect(Marts.itemsFor("g3:08164000")[0]).toEqual([2, 3]);
    expect(Marts.itemsFor(0x08164000)[0]).toEqual([2, 3]);
    FlagsExtract.write(cache, "r");
    expect(cache.read("r/flags_table.lua")).toContain("FlagsTable.BADGES = {");
    const ext = FlagsExtract.extract({
      readFile: (p) => (p.endsWith("flags.h") ? "#define FLAG_A 0x10\n#define FLAG_B (FLAG_A + 2) // c\n"
        : p.endsWith("vars.h") ? "#define VAR_X 0x4000\n" : undefined),
    });
    expect(ext.flags).toEqual({ FLAG_A: 16, FLAG_B: 18 });
    expect(ext.vars).toEqual({ VAR_X: 0x4000 });
    Encounters.installEncounterTypes({});
    expect(Encounters._encounterTypes).toBeUndefined();
  });
});

// ------------------------------------------------------------ against the reference

// Lua: extract_island1.lua:262
const MAP_ORDER = [
  "SEVII_ONE_ISLAND",
  "SEVII_ONE_ISLAND_KINDLE_ROAD",
  "SEVII_ONE_ISLAND_TREASURE_BEACH",
  "SEVII_ONE_ISLAND_POKECENTER",
  "SEVII_ONE_ISLAND_POKECENTER_2F",
  "SEVII_ONE_ISLAND_HARBOR",
  "SEVII_ONE_ISLAND_HOUSE1",
  "SEVII_ONE_ISLAND_HOUSE2",
  "FR_PALLET_TOWN",
  "FR_ROUTE_1",
  "FR_VIRIDIAN_CITY",
  "FR_ROUTE_2",
  "FR_PLAYERS_HOUSE_1F",
  "FR_PLAYERS_HOUSE_2F",
  "FR_RIVALS_HOUSE",
  "FR_OAKS_LAB",
  "FR_PEWTER_CITY",
  "FR_PEWTER_CITY_GYM",
];

describe.skipIf(!ctx)("gen3 import scripts cluster against the reference", () => {
  test("the scripts cluster's stages write the reference bytes", () => {
    const { imports, cache } = ctx!;
    const root = GBA_ROOT;

    // Lua: extract_island1.lua:284-307
    const importId = ctx!.version;
    const info = imports.info(importId)!;
    const [version, verr] = Versions.lookup(info.md5);
    expect(verr).toBeUndefined();
    const [rom] = Rom.open(imports, importId);
    MapCatalog.rebuildIndex();
    const [census] = MapTree.walk(rom!, version);
    const [mapOrder, byEngine] = MapCatalog.allOrder(census!, MAP_ORDER);
    MapCatalog.registerOrder(rom!, version, mapOrder, byEngine);

    // Lua: extract_island1.lua:366
    const extractedScripts = ExtractScripts.extractFromRom(rom!, version);
    expect(extractedScripts.unknownOps).toBe(0);

    // Lua: extract_island1.lua:482-510
    {
      const [rom2] = Rom.open(imports, importId);
      HelpExtract.writeExtract(rom2!, cache);
      QuestLogExtract.writeExtract(rom2!, cache);
      ObjectInteractionsExtract.writeExtract(rom2!, cache, root, version);
      EncountersExtract.writeExtract(rom2!, cache, root, version);
      const [detailM] = MartsExtract.run(rom2!, cache, { cacheRoot: root });
      expect(detailM).toBeUndefined(); // scripts.lua is not written yet, as in the Lua
    }

    // Lua: extract_island1.lua:555-558
    {
      const [rom3] = Rom.open(imports, importId);
      const bundle = ExtractScripts.writeBundleFromRom(rom3!, cache, root, version, extractedScripts);
      expect(bundle.martListCount).toBeGreaterThan(0);
    }

    // RomExtractorGen3:runPokemonExtract -- pokemon_extract.lua:1274, then pokemonAfter
    {
      const [rom4] = Rom.open(imports, importId);
      EasyChatExtract.run(rom4!, cache, { cacheRoot: root });
      SeagallopExtract.run(rom4!, cache, { cacheRoot: root });
      CaveTransitionExtract.run(rom4!, cache, { cacheRoot: root });
      InGameTradesExtract.run(rom4!, cache, { cacheRoot: root });
      UnionRoomClassesExtract.run(rom4!, cache, { cacheRoot: root });
    }

    // RomExtractorGen3:runAuxExtracts -- plan order, mode "raise"
    {
      const [rom5] = Rom.open(imports, importId);
      expect(MultichoiceExtract.ready(cache, root)).toBe(false);
      MultichoiceExtract.run(rom5!, cache, { cacheRoot: root });
      expect(BattleAiExtract.ready(cache, root)).toBe(false);
      BattleAiExtract.run(rom5!, cache, { cacheRoot: root });
    }

    // Every file written matches the reference...
    expect(compareWrites(cache.files)).toEqual([]);
    // ...and every reference file of these stages was written.
    const want = [
      ...["scripts.lua", "text.lua", "text_tables.lua", "movements.lua", "events.lua", "meta.json", "marts.lua",
        "multichoice.lua"].map((f) => root + "/scripts/" + f),
      root + "/flags_table.lua",
      root + "/encounters.lua",
      root + "/help/pack.lua",
      root + "/quest_log/pack.lua",
      root + "/objects/pack.lua",
      root + "/battle_ai/pack.lua",
      root + "/trainers/union_room_classes.lua",
      root + "/trades/ingame_trades.lua",
      root + "/easy_chat/words.lua",
      ...referenceFiles(root + "/seagallop"),
      ...referenceFiles(root + "/cave_transition"),
    ];
    expect(want.filter((p) => !cache.files.has(p))).toEqual([]);
    expect(referenceFiles(root + "/scripts").filter((p) => !want.includes(p))).toEqual([]);
    expect(cache.files.size).toBe(want.length);
    console.log(`voxel-gen3-import-scripts: ${cache.files.size} files byte-identical`);
  }, 600000);

  test("ExtractScripts.run (the scripts_ow step path: chunked, canonical, trainer dialogs) runs", () => {
    // Not on the reference run's path (extract_island1 writes the bundle
    // unchunked), so this only checks the path works and agrees with it.
    const out = memoryCache();
    const [rom] = Rom.open(ctx!.imports, ctx!.version);
    const res = ExtractScripts.run(rom!, out, { cacheRoot: "x" });
    expect(res.maps).toBeGreaterThan(400);
    expect(res.unknownOps).toBe(0);
    expect(out.read("x/scripts/scripts.lua")!.startsWith("local T = {}\ndo (function(T)\n")).toBe(true);
    expect(out.read("x/scripts/meta.json")).toContain('"movement":"canonical"');
    expect(out.exists("x/trainers/dialogs.lua")).toBe(true);
    expect(out.exists("x/flags_table.lua")).toBe(false);
    expect(out.read("x/scripts/marts.lua")).toBe(ctx!.cache.read(GBA_ROOT + "/scripts/marts.lua"));
    expect(out.read("x/scripts/text_tables.lua")).toBe(ctx!.cache.read(GBA_ROOT + "/scripts/text_tables.lua"));
  }, 600000);
});
