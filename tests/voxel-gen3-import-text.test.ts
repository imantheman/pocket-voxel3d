// The gen3 (FireRed) "text" cluster against gen1recomp's own Lua:
// - text_ir.ts: tools/gen3/text_ir_oracle.lua runs gen1recomp's text_ir under
//   LuaJIT over every ROM string the importers decode plus synthetic inputs,
//   through every public function; the same cases run here on the port and
//   every result must be equal.
// - extract_intro.ts / extract_naming.ts: run as RomExtractorGen3:runIntroAudio
//   runs them, then every file they write is compared with the reference
//   cache (bytes; PNGs by pixels).
// ROM-gated (tests/gen3-import-harness.ts); the oracle also needs luajit and
// ~/gen1recomp-latest.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareWrites, GBA_ROOT, referenceFiles, ROM_PATH, skipReason, stageCtx } from "./gen3-import-harness.ts";
import { TextIR, bindFrlgFont, type Seg } from "../voxelmon/game/gen3/core/scripting/text_ir.ts";
import { ExtractIntro } from "../voxelmon/import/gen3/extract_intro.ts";
import { ExtractNaming } from "../voxelmon/import/gen3/extract_naming.ts";
import { Versions } from "../voxelmon/import/gen3/versions.ts";

const ctx = stageCtx();
if (!ctx) console.log(`voxel-gen3-import-text: skipping — ${skipReason()}`);

const LUA_SRC = process.env.GEN1RECOMP_LATEST ?? join(homedir(), "gen1recomp-latest");
const ORACLE = join(import.meta.dir, "../tools/gen3/text_ir_oracle.lua");

function haveLuajit(): boolean {
  try { execFileSync("luajit", ["-v"], { stdio: "ignore" }); return true; } catch { return false; }
}
const oracleReady = !!ctx && existsSync(LUA_SRC) && haveLuajit();

// ------------------------------------------------------------ normalising
// Results become what the oracle's JSON encoder prints for the Lua value:
// a table whose keys are exactly 1..n is an array, an empty table is [],
// anything else an object keyed by tostring(key).
function norm(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v.map(norm);
  if (typeof v === "object") {
    const keys = Object.keys(v as object);
    if (keys.length === 0) return [];
    const count = keys.length;
    if (keys.every((k) => /^\d+$/.test(k) && Number(k) >= 1 && Number(k) <= count)) {
      const out: unknown[] = [];
      for (let i = 1; i <= count; i++) out.push(norm((v as Record<string, unknown>)[String(i)]));
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const k of keys.sort()) out[k] = norm((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

type Res = unknown[][];
/** The oracle's try(): [name, [values...]] or [name, "<error>", message]. */
function tryRes(res: Res, name: string, fn: () => unknown, tuple = false): void {
  try {
    const r = fn();
    const vals = tuple ? (r as unknown[]) : r === undefined || r === null ? [] : [r];
    res.push([name, vals.map((x) => (x === undefined ? "<nil>" : x))]);
  } catch (e) {
    res.push([name, "<error>", (e as Error).message]);
  }
}

function deepEqLua(a: unknown, b: unknown): boolean {
  return Bun.deepEquals(norm(a), norm(b));
}

// ------------------------------------------------------------ contexts (as the oracle)
const BATTLE: Record<number, string> = {};
for (let code = 0; code <= 0x34; code++) BATTLE[code] = "B" + code;
const PLACEHOLDERS = {
  KUN: "kun", VERSION: "FR", UNKNOWN: "", MAGMA: "MAG", AQUA: "AQ%",
  byGender: { RIVAL: { male: "RM", female: "RF" }, KUN: { male: "KM", female: "KF" } },
};
function ctxA(extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    playerName: "RED\xc3\xa9", rivalName: "BLUE",
    stringVars: { 1: "ONE", 2: "12", 3: "TH%REE" },
    dynamic: { 0: "D0", 1: "D1", 2: "D2" },
    battle: BATTLE,
    ...(extra ?? {}),
  };
}
function provider(kind: string): unknown {
  if (kind === "playerName") return "PROV";
  if (kind === "gender") return "female";
  if (kind === "stringVars") return { 1: 7, 2: "x" };
  if (kind === "placeholders") return PLACEHOLDERS;
  return undefined;
}
const FakeFont = {
  measure(str: string): number {
    let w = 0;
    for (let i = 0; i < str.length; i++) w += (str.charCodeAt(i) * 7) % 5 + 3;
    return w;
  },
};
const setFont = (on: boolean): void => bindFrlgFont(on ? FakeFont : undefined);

const SRC_OPTS = [
  { named: true, digits: true, trim: true, para: "\f", nl: "\n", scroll: "\\l" },
  { trim: true },
  { digits: true, para: "", trim: true },
  { named: true, scroll: "\\l", trim: true },
];

// ------------------------------------------------------------ runners (as the oracle)
function runIr(res: Res, ir: Seg[]): void {
  TextIR.setContextProvider(undefined);
  setFont(false);
  tryRes(res, "plain", () => TextIR.toPlain(ir, undefined));
  tryRes(res, "ascii", () => TextIR.toAscii(ir, undefined));
  tryRes(res, "src", () => TextIR.toSource(ir, undefined), true);
  tryRes(res, "tb", () => TextIR.toTextBox(ir, undefined));
  {
    const pages: unknown[] = [];
    let idx = 0, kind: string | undefined;
    try {
      do {
        let page: string;
        [page, idx, kind] = TextIR.expandPage(ir, idx, undefined);
        pages.push([page, idx, kind]);
      } while (!(kind === "eos" || !kind || pages.length > 500));
      res.push(["pages", pages]);
    } catch (e) {
      res.push(["pages", "<error>", (e as Error).message]);
    }
  }
  tryRes(res, "plainA", () => TextIR.toPlain(ir, ctxA()));
  SRC_OPTS.forEach((o, i) => tryRes(res, "srcA" + (i + 1), () => TextIR.toSource(ir, ctxA(), o), true));
  tryRes(res, "asciiA", () => TextIR.toAscii(ir, ctxA()));
  setFont(true);
  tryRes(res, "tbFont", () => TextIR.toTextBox(ir, ctxA({ maxWidth: 150 })));
  tryRes(res, "tbFont208", () => TextIR.toTextBox(ir, ctxA()));
  setFont(false);
  tryRes(res, "tbA60", () => TextIR.toTextBox(ir, ctxA({ maxWidth: 60 })));
  TextIR.setContextProvider(provider);
  tryRes(res, "plainP", () => TextIR.toPlain(ir, {}));
  tryRes(res, "tbP", () => TextIR.toTextBox(ir, {}));
  tryRes(res, "plainPrse", () => TextIR.toPlain(ir, { dialect: "rse" }));
  tryRes(res, "asciiPrse", () => TextIR.toAscii(ir, { dialect: "rse", playerGender: "F" }));
  TextIR.setContextProvider(undefined);
  tryRes(res, "plainPh", () => TextIR.toPlain(ir, { dialect: "rse", placeholders: PLACEHOLDERS, playerGender: 0 }));
  let tb: string | undefined;
  try { tb = TextIR.toTextBox(ir, ctxA()); } catch { tb = undefined; }
  if (tb !== undefined) {
    const t = tb;
    tryRes(res, "split", () => TextIR.splitPages(t));
    tryRes(res, "splitKeep", () => TextIR.splitPages(t, true));
    tryRes(res, "prot", () => TextIR.protectExt(t));
    tryRes(res, "rest", () => TextIR.restoreExt(TextIR.protectExt(t)));
  }
  let ascii: string | undefined;
  try { ascii = TextIR.toAscii(ir, undefined); } catch { ascii = undefined; }
  if (ascii !== undefined) {
    const a = ascii;
    tryRes(res, "back", () => TextIR.fromAscii(a));
    tryRes(res, "backRse", () => TextIR.fromAscii(a, { dialect: "rse" }));
  }
}

function runBytes(bytes: number[], battle: boolean): Res {
  const res: Res = [];
  const opts = battle ? { battle: true } : undefined;
  const ir = TextIR.decode(bytes, opts);
  res.push(["ir", ir]);
  res.push(["irStrSame", deepEqLua(ir, TextIR.decode(String.fromCharCode(...bytes), opts))]);
  const irRse = TextIR.decode(Uint8Array.from(bytes), { dialect: "rse", battle: battle || undefined });
  res.push(["irRse", irRse]);
  res.push(["irFrlgNamed", TextIR.decode(bytes, { dialect: "frlg" })]);
  runIr(res, ir);
  TextIR.setContextProvider(undefined);
  tryRes(res, "plainRse", () => TextIR.toPlain(irRse, { dialect: "rse", placeholders: PLACEHOLDERS, battle: BATTLE }));
  return res;
}

function runAscii(s: string): Res {
  const res: Res = [];
  const ir = TextIR.fromAscii(s);
  res.push(["ir", ir]);
  res.push(["irRse", TextIR.fromAscii(s, { dialect: "rse" })]);
  runIr(res, ir);
  tryRes(res, "protRaw", () => TextIR.protectExt(s));
  tryRes(res, "restRaw", () => TextIR.restoreExt(s));
  tryRes(res, "splitRaw", () => TextIR.splitPages(s));
  tryRes(res, "splitRawKeep", () => TextIR.splitPages(s, true));
  return res;
}

function runMisc(): Res {
  const misc: Res = [];
  const SEGS: Seg[] = [
    { t: "ph", code: 5 }, { t: "ph", code: 7, name: "VERSION" }, { t: "ph", name: "STR_VAR_2" },
    { t: "ph", name: "COLOR_X" }, { t: "ph", code: "6" as unknown as number }, { t: "ph", code: 3 }, { t: "ph", name: "KUN" },
    { t: "ph", name: "RIVAL" }, { t: "ph", name: "AQUA" }, { t: "ph" }, { t: "dynamic", n: 3 },
    { t: "dynamic", n: 1 }, { t: "unknown" }, { t: "bph", code: 0x99 }, { t: "bph", code: 0x31 },
    { t: "bph", code: 2 }, { t: "strvar", n: 2 }, { t: "tag", tag: "{X}" }, { t: "text", s: "t" },
  ];
  const CTXS: (() => unknown)[] = [
    () => undefined,
    () => ctxA(),
    () => ({ dialect: "rse" }),
    () => ({ dialect: "rse", placeholders: PLACEHOLDERS, playerGender: "girl" }),
    () => ({ placeholders: PLACEHOLDERS, playerGender: 1, dynamic: false, battle: false }),
  ];
  [false, true].forEach((prov, pi) => {
    TextIR.setContextProvider(prov ? provider : undefined);
    SEGS.forEach((seg, si) => {
      CTXS.forEach((mk, ci) => tryRes(misc, `seg${pi + 1}:${si + 1}:${ci + 1}`, () => TextIR.expandSeg(seg, mk())));
    });
  });
  TextIR.setContextProvider(undefined);
  tryRes(misc, "dialectOf:firered", () => TextIR.dialectOf("firered"));
  tryRes(misc, "dialectOf:leafgreen", () => TextIR.dialectOf("leafgreen"));
  tryRes(misc, "dialectOf:nil", () => TextIR.dialectOf(undefined));
  misc.push(["dialect:rse", TextIR.dialect("rse").name]);
  misc.push(["dialect:nope", TextIR.dialect("nope").name]);
  misc.push(["dialect:nil", TextIR.dialect(undefined).name]);
  misc.push(["dialect:table", TextIR.dialect({ name: "custom" }).name]);
  misc.push(["DEFAULT_DIALECT", TextIR.DEFAULT_DIALECT]);
  for (const k of ["CHARMAP", "CTRL", "PH", "EXTRA_SYMBOL", "B_TXT", "B_TXT_CODE", "KEYGFX", "LIGATURE", "EXT_ARGS", "TAG_NAMES"] as const) {
    misc.push([k, TextIR[k]]);
  }
  for (const d of ["frlg", "rse"]) misc.push(["DIALECTS." + d, TextIR.DIALECTS[d]]);
  return misc;
}

interface OracleCase { op: "bytes" | "ascii" | "misc"; label: string; hex?: string; battle?: boolean; s?: string; res: Res }

function hexBytes(h: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
  return out;
}

describe.skipIf(!oracleReady)("text_ir against gen1recomp's text_ir (LuaJIT oracle)", () => {
  test("every case, every function, equal results", () => {
    selectVersion();
    const json = execFileSync("luajit", [ORACLE, ROM_PATH, ctx!.sha1], {
      cwd: LUA_SRC, maxBuffer: 1 << 30, encoding: "utf8",
    });
    const cases = JSON.parse(json) as OracleCase[];
    expect(cases.length).toBeGreaterThan(9000);
    const bad: string[] = [];
    let compared = 0;
    for (const c of cases) {
      const ours = c.op === "bytes" ? runBytes(hexBytes(c.hex!), !!c.battle)
        : c.op === "ascii" ? runAscii(c.s!) : runMisc();
      const n = Math.max(ours.length, c.res.length);
      for (let i = 0; i < n; i++) {
        compared++;
        const want = c.res[i], got = ours[i] === undefined ? undefined : norm(ours[i]);
        if (!Bun.deepEquals(got, want)) {
          bad.push(`${c.label} #${i} ${JSON.stringify(want?.[0])}\n  lua  ${JSON.stringify(want)?.slice(0, 600)}\n  ours ${JSON.stringify(got)?.slice(0, 600)}`);
          break;
        }
      }
      if (bad.length >= 15) break;
    }
    expect(bad).toEqual([]);
    expect(compared).toBeGreaterThan(100000);
  }, 600_000);
});

function selectVersion(): void {
  // as the oracle: GameVersion "firered" (stageCtx set it; dialectOf(nil)
  // reads it) and the ROM's version table
  Versions.select(ctx!.sha1);
}

describe.skipIf(!ctx)("intro + naming extracts against the reference cache", () => {
  test("ExtractIntro.run and ExtractNaming.run as runIntroAudio runs them", () => {
    const c = ctx!;
    Versions.select(c.sha1);
    // runIntroAudio: romShim = { data = RevisionView.forImports(...) or self.romData }
    // (the port passes the revised ROM bytes; Rom already holds them)
    const romShim = { data: c.rom.raw };
    const [okI, metaI] = ExtractIntro.run(romShim, c.cache, { sha1: c.sha1, root: GBA_ROOT + "/intro" });
    const [okN] = ExtractNaming.run(romShim, c.cache, { sha1: c.sha1, root: GBA_ROOT + "/naming" });
    expect(okI).toBe(true);
    expect(okN).toBe(true);
    expect(metaI.introIndex).toBe("data/generated/intro.lua");
    expect(compareWrites(c.cache.files)).toEqual([]);
    // every reference file under intro/ and naming/ (and the intro index) was
    // written, except the orchestrator's own extract_status.json
    const want = [...referenceFiles(GBA_ROOT + "/intro"), ...referenceFiles(GBA_ROOT + "/naming"), "data/generated/intro.lua"]
      .filter((p) => !p.endsWith("/extract_status.json"));
    const missing = want.filter((p) => !c.cache.files.has(p));
    expect(missing).toEqual([]);
    expect(ExtractNaming.ready(c.cache)).toBe(true);
  }, 300_000);
});
