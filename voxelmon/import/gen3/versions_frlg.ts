// Port of gen1recomp src/import/gba/versions_frlg.lua (GPLv3 + additional terms; see LICENSE.md).
// FireRed USA 1.0 file offsets for every table the importer reads; select()
// remaps them onto LeafGreen through the generated edition address map. The
// tables themselves are converted mechanically (data/versions_frlg_data.ts);
// the functions are ported here.

import { format, tonumber } from "./lua.ts";
import data from "./data/versions_frlg_data.ts";
import leafGreenAddresses from "./data/edition_leafgreen_1_0.ts";

type Table = Record<string, unknown> | unknown[];

/** A deep copy of plain data (QuickJS has no structuredClone). */
function deepCopy(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(deepCopy);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) out[k] = deepCopy((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/** The live table: mutated in place by select(), as the Lua does. */
export const VersionsFrlg: Record<string, any> = deepCopy(data) as Record<string, any>;
const V = VersionsFrlg;

// Lua: versions_frlg.lua:65 -- GBA ROM pointer -> file offset, or undefined
V.gbaToFile = (addr: unknown): number | undefined => {
  const a = tonumber(addr);
  if (a === undefined || a < 0x08000000 || a >= 0x0a000000) return undefined;
  return a - 0x08000000;
};

// Lua: versions_frlg.lua:2836
V.seviiMapFor = (group: unknown, num: unknown): string | undefined =>
  V.FRLG_MAP_TO_SEVII[format("%d:%d", tonumber(group) ?? 0, tonumber(num) ?? 0)];

// Lua: versions_frlg.lua:2840
V.frMapFor = (group: unknown, num: unknown): string | undefined => {
  const key = format("%d:%d", tonumber(group) ?? 0, tonumber(num) ?? 0);
  const catalog = mapCatalog?.mapIdFor(group, num);
  return catalog ?? V.FRLG_MAP_TO_FR[key] ?? V.FRLG_MAP_TO_SEVII[key];
};

// Lua: versions_frlg.lua:2847
V.mapIdFor = (group: unknown, num: unknown): string | undefined => V.frMapFor(group, num);

// Lua: versions_frlg.lua:2851
V.normalizeSha1 = (sha1: unknown): string | undefined =>
  typeof sha1 === "string" ? sha1.toLowerCase().replace(/\s+/g, "") : undefined;
V.normalizeMd5 = V.normalizeSha1;

// Lua: versions_frlg.lua:2857 -- canonical FireRed identity SHA-1 (legacy MD5 -> SHA-1)
V.identitySha1 = (hash: unknown): string | undefined => {
  const key = V.normalizeSha1(hash);
  if (!key) return undefined;
  if (typeof V.BY_MD5[key] === "string") return V.BY_MD5[key];
  return key;
};

// Lua: versions_frlg.lua:2869 -- [version] or [undefined, err]
V.lookup = (sha1: unknown): [any, string?] => {
  const key = V.identitySha1(sha1);
  if (!key) return [undefined, "missing sha1"];
  const ver = V.BY_SHA1[key];
  if (!ver) return [undefined, "unsupported or unknown FRLG dump SHA-1"];
  return [ver];
};
V.lookupSha1 = (sha1: unknown): [any, string?] => V.lookup(sha1);

// Lua: versions_frlg.lua:2885-2898 -- retain table identities: every nested
// table and its baseline entries, rebuilt in place when the edition changes
// (never remap an already remapped value)
const baseline: { target: Table; entries: [string, unknown][] }[] = [];
const seen = new Set<object>();
function capture(t: Table): void {
  if (seen.has(t)) return;
  seen.add(t);
  const entries: [string, unknown][] = [];
  for (const k of Object.keys(t)) {
    const v = (t as Record<string, unknown>)[k];
    if (typeof v === "function") continue; // root functions are retained
    entries.push([k, v]);
    if (v !== null && typeof v === "object") capture(v as Table);
  }
  baseline.push({ target: t, entries });
}
capture(V);
let edition = "firered";
let addresses: Record<string, number> | undefined;

// Lua: versions_frlg.lua:2900
V.address = (base: number): number => {
  if (!addresses) return base;
  const a = addresses[String(base)];
  if (a === undefined) throw new Error(format("Missing LeafGreen address 0x%X", base));
  return a;
};

function remapKey(t: Table, k: string): string {
  if (!addresses || Array.isArray(t)) return k; // array indices are never addresses
  const a = addresses[k];
  return a === undefined ? k : String(a);
}
function remapValue(v: unknown): unknown {
  if (!addresses || typeof v !== "number") return v;
  const a = addresses[String(v)];
  return a === undefined ? v : a;
}

// Lua: versions_frlg.lua:2905
V.select = (identity: string): void => {
  let game = identity;
  if (V.BY_SHA1[identity]) game = V.BY_SHA1[identity].game;
  game = game === "leafgreen" ? "leafgreen" : "firered";
  if (game === edition) return;
  addresses = game === "leafgreen" ? (leafGreenAddresses as unknown as Record<string, number>) : undefined;
  for (const record of baseline) {
    const t = record.target as Record<string, unknown>;
    if (Array.isArray(t)) t.length = 0;
    else for (const k of Object.keys(t)) if (typeof t[k] !== "function") delete t[k];
    for (const [k, v] of record.entries) t[remapKey(record.target, k)] = remapValue(v);
  }
  edition = game;
};

// Lua: versions_frlg.lua:2926 -- set by versions.ts (it owns VersionsGame)
V.game = undefined;

/** map_catalog, bound by its own module once ported (breaks the import cycle). */
let mapCatalog: { mapIdFor(group: unknown, num: unknown): string | undefined } | undefined;
export function bindMapCatalog(mc: typeof mapCatalog): void {
  mapCatalog = mc;
}

export default VersionsFrlg;
