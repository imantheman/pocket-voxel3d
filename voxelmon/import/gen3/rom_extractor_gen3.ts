// Port of gen1recomp src/import/RomExtractorGen3.lua (GPLv3 + additional terms; see LICENSE.md).
// The Gen 3 import plan runner: required markers, then the plan's stages
// (the "gba" world extract, pokemon + chrome, aux extractors, intro/naming/
// audio), each writing its extract_status.json.
//
// Port notes:
// - NOT FAITHFUL: no threads. runParallel (the love.thread worker pool) is
//   not ported; it returns [false, "love.thread unavailable"], which is what
//   the Lua's returns where love.thread is missing, so run() always takes
//   the sequential fallback (as the reference run under plain LuaJIT does).
// - The ROM SHA-1 is passed in (romSha1) or computed by the caller
//   (love.data.hash is not ported; the importer stays Node-free). hexSha1 is
//   a required option for the case the Lua computes it itself.
// - `require(Plans.moduleFor(name))` is a static module table (MODULES).
// - onStage is a port addition (not in the Lua): a hook around each
//   sequential stage, for the CLI's per-stage timings.

import { format, tostring } from "./lua.ts";
import { CacheFs, type Cache } from "./cache.ts";
import { LuaWriter } from "./lua_writer.ts";
import { CanonicalJson } from "./json.ts";
import { GameVersion } from "./game_version.ts";
import { Versions } from "./versions.ts";
import { Rom } from "./rom.ts";
import { RevisionView, type Imports } from "./revision_view.ts";
import { Plans, type Plan } from "./plans.ts";
import { Extract } from "./extract_island1.ts";
import { PokemonExtract } from "./pokemon_extract.ts";
import { ExtractIntro } from "./extract_intro.ts";
import { ExtractNaming } from "./extract_naming.ts";
import { ExtractAudio } from "./extract_audio.ts";
import { SeagallopExtract } from "./seagallop_extract.ts";
import { CaveTransitionExtract } from "./cave_transition_extract.ts";
import { WeatherExtract } from "./weather_extract.ts";
import { InGameTradesExtract } from "./ingame_trades_extract.ts";
import { UnionRoomClassesExtract } from "./union_room_classes_extract.ts";
import { RegionMapExtract } from "./region_map_extract.ts";
import { MapSectionsExtract } from "./map_sections_extract.ts";
import { MultichoiceExtract } from "./multichoice_extract.ts";
import { HealLocationsExtract } from "./heal_locations_extract.ts";
import { DoorAnimExtract } from "./door_anim_extract.ts";
import { SlotMachineExtract } from "./slot_machine_extract.ts";
import { TradeExtract } from "./trade_extract.ts";
import { LinkArtExtract } from "./link_art_extract.ts";
import { FameCheckerExtract } from "./fame_checker_extract.ts";
import { TeachyTvExtract } from "./teachy_tv_extract.ts";
import { MysteryGiftExtract } from "./mystery_gift_extract.ts";
import { TrainerTowerExtract } from "./trainer_tower_extract.ts";
import { TutorExtract } from "./tutor_extract.ts";
import { MuseumExtract } from "./museum_extract.ts";
import { MoveRelearnerExtract } from "./move_relearner_extract.ts";
import { EggExtract } from "./egg_extract.ts";
import { BattleAnimExtract } from "./battle_anim_extract.ts";
import { BattleAiExtract } from "./battle_ai_extract.ts";
import { MapPreviewExtract } from "./map_preview_extract.ts";
import { CreditsExtract } from "./credits_extract.ts";
import { LeagueExtract } from "./league_extract.ts";
import { CachePaths } from "../../game/gen3/core/cache_paths.ts";
import { Profile } from "../../game/gen3/core/profile.ts";

type Tbl = Record<string, any>;
interface StepModule {
  run(rom: Rom, cache: Cache, opts: Tbl): any;
  ready?(cache: Cache, cacheRoot?: string): boolean;
}

/** The plan step modules, by Lua module name (require(Plans.moduleFor(name))). */
const MODULES: Record<string, StepModule> = {
  "src.import.gba.seagallop_extract": SeagallopExtract,
  "src.import.gba.cave_transition_extract": CaveTransitionExtract,
  "src.import.gba.weather_extract": WeatherExtract,
  "src.import.gba.ingame_trades_extract": InGameTradesExtract,
  "src.import.gba.union_room_classes_extract": UnionRoomClassesExtract,
  "src.import.gba.region_map_extract": RegionMapExtract,
  "src.import.gba.map_sections_extract": MapSectionsExtract as unknown as StepModule,
  "src.import.gba.multichoice_extract": MultichoiceExtract,
  "src.import.gba.heal_locations_extract": HealLocationsExtract,
  "src.import.gba.door_anim_extract": DoorAnimExtract as unknown as StepModule,
  "src.import.gba.slot_machine_extract": SlotMachineExtract,
  "src.import.gba.trade_extract": TradeExtract,
  "src.import.gba.link_art_extract": LinkArtExtract,
  "src.import.gba.fame_checker_extract": FameCheckerExtract,
  "src.import.gba.teachy_tv_extract": TeachyTvExtract,
  "src.import.gba.mystery_gift_extract": MysteryGiftExtract,
  "src.import.gba.trainer_tower_extract": TrainerTowerExtract,
  "src.import.gba.tutor_extract": TutorExtract,
  "src.import.gba.museum_extract": MuseumExtract,
  "src.import.gba.move_relearner_extract": MoveRelearnerExtract,
  "src.import.gba.egg_extract": EggExtract,
  "src.import.gba.battle_anim_extract": BattleAnimExtract as unknown as StepModule,
  "src.import.gba.battle_ai_extract": BattleAiExtract,
  "src.import.gba.map_preview_extract": MapPreviewExtract,
  "src.import.gba.credits_extract": CreditsExtract,
  "src.import.gba.league_extract": LeagueExtract,
};

/** require(name) for a plan step module. */
function requireModule(name: string): StepModule {
  const mod = MODULES[name];
  if (!mod) throw new Error(`module '${name}' not found`);
  return mod;
}

// Lua: RomExtractorGen3.lua:10
const STAGE_COUNT = 5;
const GBA_ROOT = CachePaths.CACHE_ROOT;

// Lua: RomExtractorGen3.lua:13
function canonicalImportId(id: string): string {
  return id === "leafgreen" ? "firered" : id;
}

// Lua: RomExtractorGen3.lua:17
function importVersion(sha1: string): string {
  const version = GameVersion.forSha1(sha1);
  if (!version || GameVersion.generation(version) !== 3) {
    throw new Error("unknown gen 3 ROM sha1 " + tostring(sha1));
  }
  return version;
}

// Lua: RomExtractorGen3.lua:33
function writeText(rel: string, body: string): void {
  const [ok, err] = CacheFs.write(rel, body);
  if (!ok) {
    throw new Error("could not write " + rel + ": " + tostring(err));
  }
}

// Lua: RomExtractorGen3.lua:40
function writeJson(rel: string, obj: unknown): void {
  writeText(rel, CanonicalJson.encode(obj) + "\n");
}

// Lua: RomExtractorGen3.lua:45
function makeImports(romData: Uint8Array, sha1: string, version?: string): Imports {
  const v = version ?? importVersion(sha1);
  return {
    info(id) {
      if (canonicalImportId(id) !== canonicalImportId(v)) {
        return undefined; // nil, "undeclared"
      }
      return {
        id: canonicalImportId(v),
        size: romData.length,
        // versions.lua looks up by SHA-1 (legacy field name is md5).
        md5: sha1,
        file: "memory",
      };
    },
    read(id, offset, length) {
      if (canonicalImportId(id) !== canonicalImportId(v)) {
        return undefined; // nil, "undeclared"
      }
      if (offset < 0 || length < 0 || offset + length > romData.length) {
        return undefined; // nil, "short read"
      }
      let s = "";
      for (let i = offset; i < offset + length; i += 0x2000) {
        s += String.fromCharCode.apply(null, romData.subarray(i, Math.min(i + 0x2000, offset + length)) as unknown as number[]);
      }
      return s;
    },
    bytes() { return romData; },
  };
}

// Lua: RomExtractorGen3.lua:72 -- the extractors' cache handle, onto CacheFs
function makeCache(): Cache {
  return {
    write(rel, bytes) {
      return CacheFs.write(rel, bytes)[0];
    },
    read(rel) {
      return CacheFs.read(rel);
    },
    exists(rel) {
      return CacheFs.exists(rel);
    },
    info(rel) {
      if (CacheFs.exists(rel)) return { type: "file" };
      return undefined;
    },
  };
}

// Lua: RomExtractorGen3.lua:90
const POKEMON_SUBTASKS: Record<string, { min: number; max: number; label: string }> = {
  pokemon: { min: 0.00, max: 0.50, label: "Pok\xc3\xa9mon Species & Sprites" },
  learnsets: { min: 0.50, max: 0.58, label: "Move Learnsets" },
  battle_moves: { min: 0.58, max: 0.62, label: "Battle Moves Data" },
  party_chrome: { min: 0.62, max: 0.68, label: "Party UI Graphics" },
  battle_chrome: { min: 0.68, max: 0.74, label: "Battle UI Graphics" },
  pokedex_entries: { min: 0.74, max: 0.78, label: "Pok\xc3\xa9dex Database" },
  pokedex_categories: { min: 0.78, max: 0.80, label: "Pok\xc3\xa9dex Categories" },
  pokedex_orders: { min: 0.80, max: 0.82, label: "Pok\xc3\xa9dex Sorting" },
  pokedex_done: { min: 0.82, max: 0.84, label: "Pok\xc3\xa9dex Complete" },
  storage_chrome: { min: 0.84, max: 0.88, label: "PC Storage Chrome" },
  battle_transition: { min: 0.88, max: 0.92, label: "Battle Transitions" },
  summary_chrome: { min: 0.92, max: 0.96, label: "Summary Screen Graphics" },
  bag_chrome: { min: 0.96, max: 0.98, label: "Bag & Items Graphics" },
  shop_chrome: { min: 0.98, max: 1.00, label: "Mart & Shop Graphics" },
};

/** progressCb(pct 0..1000, 1000, stageName, current, stageTotal) -- labels are byte strings. */
export type ProgressFn = (permille: number, total: number, stageName: string, current: number, stageTotal: number) => void;

export interface RunResult {
  romSha1: string;
  extractOk: boolean;
  pokemonOk: boolean;
  auxOk: boolean;
  detail?: unknown;
}

export class RomExtractorGen3 {
  version: string;
  plan: Plan;
  romData: Uint8Array;
  manifest: Tbl | undefined;
  progress: ProgressFn | undefined;
  romSha1: string | undefined;
  stage: number;
  _lastPct: number;
  _imports: Imports | undefined;
  /** Port addition: called before ("begin") and after ("end") each sequential stage. */
  onStage: ((name: string, phase: "begin" | "end") => void) | undefined;

  // Lua: RomExtractorGen3.lua:107 (RomExtractorGen3.new)
  constructor(romData: Uint8Array, manifest: Tbl | undefined, progressCb: ProgressFn | undefined, romSha1?: string) {
    const sha1 = romSha1 ?? (manifest && manifest.romSha1);
    // NOT FAITHFUL: hexSha1(romData) (love.data.hash) is not ported; pass romSha1.
    if (typeof sha1 !== "string") throw new Error("RomExtractorGen3: romSha1 is required (love.data.hash is not ported)");
    const version = importVersion(sha1);
    Versions.select(sha1);
    this.version = version;
    this.plan = Plans.of(version);
    this.romData = romData;
    this.manifest = manifest;
    this.progress = progressCb;
    this.romSha1 = romSha1 ?? sha1;
    this.stage = 0;
    this._lastPct = 0;
    this._imports = undefined;
    this.onStage = undefined;
  }

  static new(romData: Uint8Array, manifest: Tbl | undefined, progressCb: ProgressFn | undefined, romSha1?: string): RomExtractorGen3 {
    return new RomExtractorGen3(romData, manifest, progressCb, romSha1);
  }

  // Lua: RomExtractorGen3.lua:123
  sharedImports(sha1: string): Imports {
    if (!this._imports) {
      this._imports = makeImports(this.romData, sha1, importVersion(sha1));
    }
    return this._imports;
  }

  // Lua: RomExtractorGen3.lua:130
  ensureSha1(): string {
    if (typeof this.romSha1 === "string" && this.romSha1 !== "") {
      return this.romSha1;
    }
    throw new Error("RomExtractorGen3: romSha1 is required (love.data.hash is not ported)");
  }

  // Lua: RomExtractorGen3.lua:138
  report(pct: number | undefined, stageName?: string, current?: number, stageTotal?: number): void {
    pct = Math.max(this._lastPct ?? 0, Math.min(1.0, pct ?? 0));
    this._lastPct = pct;
    if (this.progress) {
      this.progress(Math.floor(pct * 1000), 1000, stageName ?? "Extracting", current ?? 0, stageTotal ?? 1);
    }
  }

  // Lua: RomExtractorGen3.lua:146
  beginStage(name: string): void {
    this.stage = this.stage + 1;
    this.report((this.stage - 1) / STAGE_COUNT, name, 0, 1);
  }

  // Lua: RomExtractorGen3.lua:151
  tickPokemon(name: string | undefined, current?: number, total?: number): void {
    const st = name !== undefined ? POKEMON_SUBTASKS[name] : undefined;
    if (st) {
      const curFrac = (current ?? 0) / Math.max(total ?? 1, 1);
      const frac = st.min + curFrac * (st.max - st.min);
      let label = st.label;
      if (total && total > 1) {
        label = label + format(" (%d/%d)", current ?? 0, total);
      }
      this.report(frac, label, current, total);
    } else {
      const frac = (current ?? 0) / Math.max(total ?? 1, 1);
      this.report(frac, name ?? "Pok\xc3\xa9mon Data", current, total);
    }
  }

  // Lua: RomExtractorGen3.lua:168 -- plus semantic module stubs for SEMANTIC_MODULES[3].
  writeRequiredMarkers(sha1: string): void {
    const version = importVersion(sha1);
    const cache = makeCache();
    const metaRaw = cache.read(GBA_ROOT + "/meta.json");
    const S = "[ \\t\\n\\v\\f\\r]*"; // Lua %s*
    if (metaRaw === undefined
      || !new RegExp('"md5"' + S + ":" + S + '"' + sha1 + '"').test(metaRaw)
      || !new RegExp('"cache_version"' + S + ":" + S + tostring(Versions.CACHE_VERSION)).test(metaRaw)) {
      writeJson(GBA_ROOT + "/meta.json", {
        romSha1: sha1,
        md5: sha1,
        version,
        cache_version: Versions.CACHE_VERSION,
        native_version: Versions.NATIVE_VERSION ?? 5,
        stub: false,
      });
    }
    if (!CacheFs.exists(GBA_ROOT + "/maps.json")) {
      writeJson(GBA_ROOT + "/maps.json", {
        maps: {},
        stub: true,
      });
    }
    if (!CacheFs.exists(GBA_ROOT + "/intro/meta.json")) {
      writeJson(GBA_ROOT + "/intro/meta.json", {
        stub: true,
      });
    }
    if (!CacheFs.exists(GBA_ROOT + "/audio/meta.json")) {
      writeJson(GBA_ROOT + "/audio/meta.json", {
        stub: true,
      });
    }
    if (!CacheFs.exists("data/generated/maps.lua")) {
      LuaWriter.write("data/generated/maps.lua", { stub: true, maps: {} });
    }
    if (!CacheFs.exists("data/generated/intro.lua")) {
      LuaWriter.write("data/generated/intro.lua", {
        stub: true,
        generation: 3,
        version,
      });
    }
    if (!CacheFs.exists("data/generated/audio.lua")) {
      LuaWriter.write("data/generated/audio.lua", { stub: true });
    }
    // plan.dirs: love.filesystem.createDirectory for each (the file cache
    // makes directories as it writes; nothing to do here).
  }

  // Lua: RomExtractorGen3.lua:221
  runGbaExtract(sha1: string, skipScriptsAndOw?: boolean): [boolean, any] {
    const prevRoot = Extract.CACHE_ROOT, prevNative = Extract.NATIVE_ROOT;
    Extract.CACHE_ROOT = GBA_ROOT;
    Extract.NATIVE_ROOT = GBA_ROOT + "/native";

    const imports = this.sharedImports(sha1);
    const cache = makeCache();
    let runOk = false, runDetail: any = "extract did not run";
    let callOk = true, err: unknown;
    try {
      [runOk, runDetail] = Extract.run(imports, cache, (stage, n, name, cur, total) => {
        const curFrac = (cur ?? 0) / Math.max(total ?? 1, 1);
        const frac = ((stage ?? 0) + curFrac) / Math.max(n ?? Extract.STAGE_COUNT ?? 7, 1);
        let label = "World Maps: " + tostring(name ?? "Processing");
        if (total && total > 1) {
          label = label + format(" (%d/%d)", cur ?? 0, total);
        }
        this.report(Math.min(frac, 1.0), label, cur ?? 0, total ?? 1);
      }, { skipScriptsAndOw: skipScriptsAndOw === true });
    } catch (e) {
      callOk = false;
      err = e;
    }

    Extract.CACHE_ROOT = prevRoot;
    Extract.NATIVE_ROOT = prevNative;

    if (!callOk) {
      return [false, err];
    }
    return [runOk, runDetail];
  }

  // Lua: RomExtractorGen3.lua:251
  runScriptsAndOwExtract(sha1: string): [boolean, any] {
    const prevRoot = Extract.CACHE_ROOT;
    Extract.CACHE_ROOT = GBA_ROOT;

    const imports = this.sharedImports(sha1);
    const cache = makeCache();
    let runOk = false;
    const runDetail: any = "scripts_ow did not run";
    let callOk = true, err: unknown;
    try {
      [runOk] = Extract.runScriptsAndOw(imports, cache, (cur, total, stageName) => {
        const frac = (cur ?? 0) / Math.max(total ?? 4, 1);
        this.report(frac, "Scripts & OW: " + tostring(stageName ?? "Processing"), cur ?? 0, total ?? 4);
      });
    } catch (e) {
      callOk = false;
      err = e;
    }

    Extract.CACHE_ROOT = prevRoot;
    if (!callOk) return [false, err];
    return [runOk, runDetail];
  }

  // Lua: RomExtractorGen3.lua:273 -- Species pack + party chrome into data/generated/gba/pokemon/.
  runPokemonExtract(sha1: string, spMin?: number, spMax?: number): [boolean, any] {
    const prevRoot = Extract.CACHE_ROOT;
    Extract.CACHE_ROOT = GBA_ROOT;

    const cache = makeCache();
    if (spMin === undefined && PokemonExtract.ready(cache, GBA_ROOT)) {
      Extract.CACHE_ROOT = prevRoot;
      return [true, { skipped: true }];
    }

    const imports = this.sharedImports(sha1);
    const version = importVersion(sha1);
    const [rom, openErr] = Rom.open(imports, version);
    if (!rom) {
      Extract.CACHE_ROOT = prevRoot;
      return [false, openErr ?? "rom open failed"];
    }

    let ok = true, detail: any;
    try {
      const pRes = PokemonExtract.run(rom, cache, {
        cacheRoot: GBA_ROOT,
        spMin: spMin ?? 0,
        spMax,
        progress: (name: string | undefined, cur?: number, total?: number) => {
          this.tickPokemon(name ?? "pokemon", cur ?? 0, total ?? 1);
        },
      });
      for (const module of Plans.list<string>(this.plan.pokemonAfter)) {
        requireModule(Plans.moduleFor(module)).run(rom, cache, { cacheRoot: GBA_ROOT });
      }
      detail = pRes;
    } catch (e) {
      ok = false;
      detail = e;
    }

    Extract.CACHE_ROOT = prevRoot;
    if (!ok) {
      return [false, detail];
    }
    return [true, detail];
  }

  // Lua: RomExtractorGen3.lua:316
  runPokemonGfxExtract(sha1: string, spMin?: number, spMax?: number): [boolean, any] {
    const prevRoot = Extract.CACHE_ROOT;
    Extract.CACHE_ROOT = GBA_ROOT;

    const imports = this.sharedImports(sha1);
    const version = importVersion(sha1);
    const [rom, openErr] = Rom.open(imports, version);
    if (!rom) {
      Extract.CACHE_ROOT = prevRoot;
      return [false, openErr ?? "rom open failed"];
    }

    const cache = makeCache();
    let ok = true, detail: any;
    try {
      detail = PokemonExtract.run(rom, cache, {
        cacheRoot: GBA_ROOT,
        spMin: spMin ?? 0,
        spMax: spMax ?? 200,
        onlySpeciesGfx: true,
        progress: (name: string | undefined, cur?: number, total?: number) => {
          this.tickPokemon(name ?? "pokemon", cur ?? 0, total ?? 1);
        },
      } as Tbl);
    } catch (e) {
      ok = false;
      detail = e;
    }

    Extract.CACHE_ROOT = prevRoot;
    if (!ok) {
      return [false, detail];
    }
    return [true, detail];
  }

  // Lua: RomExtractorGen3.lua:351
  auxWanted(): Set<string> | undefined {
    let row: Tbl | undefined;
    try {
      row = Profile.of(this.version);
    } catch {
      return undefined;
    }
    if (!row || typeof row !== "object" || row.id !== this.version) return undefined;
    const list = row.extractors;
    if (!list || typeof list !== "object" || Plans.list(list).length === 0) return undefined;
    const wanted = new Set<string>();
    for (const name of Plans.list<string>(list)) wanted.add(name);
    return wanted;
  }

  // Lua: RomExtractorGen3.lua:362
  runAuxExtracts(sha1: string): [boolean, any] {
    const wanted = this.auxWanted();
    const entries: { entry: Tbl; mod: StepModule; need?: boolean }[] = [];
    for (const entry of Plans.list<Tbl>(this.plan.aux)) {
      entries.push({ entry, mod: requireModule(Plans.moduleFor(entry.name)) });
    }
    const prevRoot = Extract.CACHE_ROOT;
    Extract.CACHE_ROOT = GBA_ROOT;

    const cache = makeCache();
    let any = false;
    for (const e of entries) {
      const name = e.entry.name, mod = e.mod;
      if (wanted !== undefined && !wanted.has(name)) {
        e.need = false;
      } else if (e.entry.mode === "sections") {
        e.need = !CacheFs.exists(GBA_ROOT + "/region_map/map_sections.lua");
      } else {
        e.need = !(mod.ready && mod.ready(cache, GBA_ROOT));
      }
      any = any || e.need;
    }

    if (!any) {
      Extract.CACHE_ROOT = prevRoot;
      return [true, { skipped: true }];
    }

    const [rom, openErr] = Rom.open(this.sharedImports(sha1), importVersion(sha1));
    if (!rom) {
      Extract.CACHE_ROOT = prevRoot;
      return [false, openErr ?? "rom open failed"];
    }

    let ok = true, detail: any;
    try {
      const out: Tbl = {};
      let step = 0;
      const totalSteps = this.plan.auxSteps ?? entries.length;
      const auxTick = (name: string): void => {
        step = step + 1;
        this.report(step / totalSteps, "Game Data: " + name, step, totalSteps);
      };

      for (const e of entries) {
        const entry = e.entry, mod = e.mod;
        if (e.need) {
          const opts: Tbl = { cacheRoot: GBA_ROOT };
          const extra = entry.opts ?? {};
          for (const k of Object.keys(extra)) opts[k] = extra[k];
          const tag = entry.tag ?? entry.name;
          if (entry.mode === "sections") {
            mod.run(rom, cache, opts);
            const rel = GBA_ROOT + "/region_map/map_sections.lua";
            const body = cache.read(rel);
            if (typeof body !== "string" || body.length < 1024) {
              throw new Error("map_sections extract wrote " + tostring(body !== undefined ? body.length : 0)
                + " bytes to " + rel);
            }
            out[entry.key] = body.length;
          } else if (entry.mode === "result") {
            const [okR, detailR] = mod.run(rom, cache, opts);
            if (!okR) console.log("[" + tag + "] warn: " + tostring(detailR));
            out[entry.key] = detailR;
          } else if (entry.mode === "warn") {
            let okW = true, detailW: any;
            try {
              detailW = mod.run(rom, cache, opts);
            } catch (err) {
              okW = false;
              detailW = err instanceof Error ? err.message : err;
            }
            if (!okW) console.log("[" + tag + "] warn: " + tostring(detailW));
            out[entry.key] = okW ? detailW : false;
          } else {
            out[entry.key] = mod.run(rom, cache, opts);
          }
        }
        auxTick(entry.label ?? entry.name);
      }

      detail = out;
    } catch (e) {
      ok = false;
      detail = e;
    }

    rom.clearCache();
    Extract.CACHE_ROOT = prevRoot;
    if (!ok) return [false, detail];
    return [true, detail];
  }

  // Lua: RomExtractorGen3.lua:446
  runStepsTask(sha1: string, task: Tbl): [boolean, any] {
    const cache = makeCache();
    const steps = Plans.list<Tbl>(task.steps);
    let rom: Rom | undefined;
    let ok = true, detail: any;
    try {
      const out: Tbl = {};
      for (let i = 1; i <= steps.length; i++) {
        const step = steps[i - 1]!;
        const mod = requireModule(Plans.moduleFor(step.name));
        if (!(mod.ready && mod.ready(cache, GBA_ROOT))) {
          if (!rom) {
            const [r, openErr] = Rom.open(this.sharedImports(sha1), importVersion(sha1));
            rom = r;
            if (!rom) throw new Error(openErr ?? "rom open failed");
          }
          const opts: Tbl = { cacheRoot: GBA_ROOT };
          const extra = step.opts ?? {};
          for (const k of Object.keys(extra)) opts[k] = extra[k];
          out[step.name] = mod.run(rom, cache, opts);
        }
        this.report(i / Math.max(steps.length, 1), task.id + ": " + (step.label ?? step.name), i, steps.length);
      }
      detail = out;
    } catch (e) {
      ok = false;
      detail = e;
    }
    if (rom) rom.clearCache();
    if (!ok) return [false, detail];
    return [true, detail];
  }

  // Lua: RomExtractorGen3.lua:473
  speciesRanges(): [number, number] {
    const last = (Versions.NUM_SPECIES ?? 412) - 1;
    const split = this.plan.speciesSplit ?? Math.floor(last / 2);
    return [split, last];
  }

  // Lua: RomExtractorGen3.lua:480
  runTask(task: string, sha1: string): [boolean, any] {
    let spec: Tbl | undefined;
    for (const t of Plans.list<Tbl>(this.plan.tasks)) {
      if (t.id === task) spec = t;
    }
    if (!spec) throw new Error("unknown extract task: " + tostring(task));
    const run = spec.run ?? "steps";
    if (run === "gba") {
      return this.runGbaExtract(sha1, true);
    } else if (run === "scripts_ow") {
      return this.runScriptsAndOwExtract(sha1);
    } else if (run === "pokemon") {
      const [split, last] = this.speciesRanges();
      return this.runPokemonExtract(sha1, split + 1, last);
    } else if (run === "pokemon_gfx") {
      const [split] = this.speciesRanges();
      return this.runPokemonGfxExtract(sha1, 0, split);
    } else if (run === "aux") {
      return this.runAuxExtracts(sha1);
    } else if (run === "intro_audio") {
      const [okI, okA] = this.runIntroAudio(sha1);
      return [okI as boolean, okA];
    } else if (run === "steps") {
      return this.runStepsTask(sha1, spec);
    }
    throw new Error("unknown extract runner: " + tostring(run));
  }

  // Lua: RomExtractorGen3.lua:507
  runIntroAudio(sha1: string): [unknown, unknown, unknown?, unknown?] {
    this.report(0.05, "Audio & Intro: Initializing", 0, 3);
    const cache = makeCache();
    if (cache.exists(GBA_ROOT + "/intro/meta.json") && cache.exists(GBA_ROOT + "/audio/meta.json")) {
      const im = cache.read(GBA_ROOT + "/intro/meta.json");
      if (im !== undefined && !/"stub"[ \t\n\v\f\r]*:[ \t\n\v\f\r]*true/.test(im)) {
        this.report(1.00, "Audio Streams Ready", 3, 3);
        return [true, true];
      }
    }

    const imports = this.sharedImports(sha1);
    const version = importVersion(sha1);
    const info = imports.info(version)!;
    const romShim = { data: RevisionView.forImports(imports, version, info) ?? this.romData };

    this.report(0.20, "Intro: Cutscene Sequence", 1, 3);
    const [okI, metaI] = ExtractIntro.run(romShim, cache, { sha1, root: GBA_ROOT + "/intro" });

    this.report(0.50, "Intro: Naming Screen Graphics", 2, 3);
    const [okN] = ExtractNaming.run(romShim, cache, { sha1, root: GBA_ROOT + "/naming" });

    this.report(0.75, "Audio: Music & Sound Streams", 3, 3);
    const [okA, metaA] = ExtractAudio.run(romShim, cache, { sha1, root: GBA_ROOT + "/audio" });

    writeJson(GBA_ROOT + "/intro/extract_status.json", { ok: okI === true });
    writeJson(GBA_ROOT + "/naming/extract_status.json", { ok: okN === true });
    writeJson(GBA_ROOT + "/audio/extract_status.json", { ok: okA === true });
    this.report(1.00, "Audio & Intro Ready", 3, 3);
    return [okI, okA, metaI, metaA];
  }

  /**
   * Lua: RomExtractorGen3.lua:558 -- the love.thread worker pool.
   * NOT FAITHFUL: no threads. Returns what the Lua returns when love.thread
   * is unavailable, so run() takes the sequential fallback.
   */
  runParallel(_sha1: string): [boolean, string?, boolean?] {
    return [false, "love.thread unavailable"];
  }

  // Lua: RomExtractorGen3.lua:700
  hasTask(id: string): boolean {
    for (const t of Plans.list<Tbl>(this.plan.tasks)) {
      if (t.id === id) return true;
    }
    return false;
  }

  /** Port addition: run one sequential stage between onStage hooks. */
  private stageRun<T>(name: string, fn: () => T): T {
    if (this.onStage) this.onStage(name, "begin");
    const r = fn();
    if (this.onStage) this.onStage(name, "end");
    return r;
  }

  // Lua: RomExtractorGen3.lua:707
  run(): RunResult {
    const sha1 = this.ensureSha1();

    this.report(0.01, "Initializing Markers", 0, 1);
    this.stageRun("markers", () => this.writeRequiredMarkers(sha1));
    this.report(0.03, "Markers Ready", 1, 1);

    let okPar = true, parRes: boolean | undefined, parErr: string | undefined, cleanupFailed: boolean | undefined;
    try {
      [parRes, parErr, cleanupFailed] = this.runParallel(sha1);
    } catch (e) {
      okPar = false;
      parRes = undefined;
      parErr = String(e);
    }
    if (cleanupFailed) throw new Error(tostring(parErr));
    if (okPar && parRes) {
      if (this.hasTask("pokemon")) {
        writeJson(GBA_ROOT + "/pokemon/extract_status.json", { ok: true, error: undefined });
      }
      if (this.hasTask("aux")) {
        writeJson(GBA_ROOT + "/region_map/extract_status.json", { ok: true, error: undefined });
      }
      this.report(1.00, "Ready", 1, 1);
      return {
        romSha1: sha1,
        extractOk: true,
        pokemonOk: true,
        auxOk: true,
      };
    }

    console.log("[RomExtractorGen3] Parallel extraction fell back to sequential: " + tostring(parErr ?? parRes));

    let ok = true, detail: any, okPoke = true, okAux = true;
    for (const stage of Plans.list<string>(this.plan.sequential)) {
      if (stage === "gba") {
        [ok, detail] = this.stageRun(stage, () => this.runGbaExtract(sha1));
        if (ok) {
          if (!CacheFs.exists(GBA_ROOT + "/maps.json")) {
            writeJson(GBA_ROOT + "/maps.json", { maps: {}, from_extract: true });
          }
        } else {
          writeJson(GBA_ROOT + "/extract_status.json", {
            ok: false,
            error: errText(detail),
            romSha1: sha1,
          });
          throw new Error("GBA extract failed: " + errText(detail));
        }
        this.report(0.42, "World Maps Ready", 1, 1);
      } else if (stage === "pokemon") {
        let pokeDetail: any;
        [okPoke, pokeDetail] = this.stageRun(stage, () => this.runPokemonExtract(sha1));
        writeJson(GBA_ROOT + "/pokemon/extract_status.json", {
          ok: okPoke === true,
          error: (!okPoke) ? errText(pokeDetail) : undefined,
        });
        if (!okPoke) {
          throw new Error("Pokemon extract failed: " + errText(pokeDetail));
        }
        this.report(0.88, "Game Data & Chrome Ready", 1, 1);
      } else if (stage === "aux") {
        let auxDetail: any;
        [okAux, auxDetail] = this.stageRun(stage, () => this.runAuxExtracts(sha1));
        writeJson(GBA_ROOT + "/region_map/extract_status.json", {
          ok: okAux === true,
          error: (!okAux) ? errText(auxDetail) : undefined,
        });
        if (!okAux) {
          throw new Error("Region map / script table extract failed: " + errText(auxDetail));
        }
      } else if (stage === "intro_audio") {
        this.stageRun(stage, () => this.runIntroAudio(sha1));
        this.report(0.98, "Finalizing Cache", 1, 1);
      } else {
        const [okS, detailS] = this.stageRun(stage, () => this.runTask(stage, sha1));
        if (!okS) {
          throw new Error(tostring(stage) + " extract failed: " + errText(detailS));
        }
      }
    }

    if (!CacheFs.exists(GBA_ROOT + "/maps.json")) {
      writeJson(GBA_ROOT + "/maps.json", { maps: {}, from_extract: true });
    }
    this.report(1.00, "Ready", 1, 1);
    return {
      romSha1: sha1,
      extractOk: ok === true,
      pokemonOk: okPoke === true,
      auxOk: okAux === true,
      detail,
    };
  }
}

/** tostring(err) for a caught error (an Error's message, as Lua's error string). */
function errText(e: unknown): string {
  if (e instanceof Error) return e.stack ?? e.message;
  return tostring(e);
}

export default RomExtractorGen3;
