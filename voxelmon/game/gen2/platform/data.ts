// The imported Gold dataset, as the Gen 2 engine reads it.
//
// gen1recomp's Game2:load pulls each generated table on its own
// (`loadGenerated("data/generated/pokemon.lua")`, Game2.lua:112/1019-1096);
// here each table is one importer JSON file (voxelmon/import/gen2, named
// the same: pokemon.json, scripts.json, ...). On the 3DS they arrive inside
// the cooked gamedata as strings and are parsed the first time something
// asks, so a table nobody reads (credits, until the credits roll) costs its
// string and nothing more. Under Bun, platform/data-node.ts reads the files.
//
// This module must stay free of Node imports: it is in the device bundle.

type Source = Record<string, unknown>;

let source: Source = {};
const parsed = new Map<string, unknown>();

/** Hand the engine its tables: each value a JSON string or a parsed object. */
export function setGen2Source(s: Source): void {
  source = s;
  parsed.clear();
}

function tableName(path: string): string {
  // accept Brian's paths as well as bare names
  const base = path.replace(/^.*\//, "").replace(/\.(lua|json)$/, "");
  return base;
}

/**
 * One generated table, or undefined when the dataset has none -- the Lua's
 * `loadGenerated(path)` returning nil, which call sites answer with `or {}`.
 */
export function loadGenerated<T = any>(path: string): T | undefined {
  const name = tableName(path);
  if (parsed.has(name)) return parsed.get(name) as T;
  const raw = source[name];
  if (raw === undefined) return undefined;
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  parsed.set(name, value);
  return value as T;
}

/** Drop a parsed table (it parses again on the next ask). */
export function releaseGenerated(path: string): void {
  parsed.delete(tableName(path));
}

/** The table names the source carries. */
export function generatedNames(): string[] {
  return Object.keys(source);
}
