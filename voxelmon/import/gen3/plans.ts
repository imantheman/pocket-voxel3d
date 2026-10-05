// Port of gen1recomp src/import/gba/plans/registry.lua (GPLv3 + additional terms; see LICENSE.md).
// The per-family import plan (tasks, aux extractors, sequential order). The
// frlg plan is converted data (data/plan_frlg.ts) and keeps Lua's integer
// keys as object keys (plan.tasks[1], ...); walk it with Plans.list().
// NOT FAITHFUL: the Lua require()s each step module by name to read its
// REQUIRED list; there is no dynamic require here, so modules register
// themselves (Plans.register) and required() throws for one that has not,
// as require would for a missing module.

import { GameVersion } from "./game_version.ts";
import { luaGet, luaLen } from "./luatable.ts";
import planFrlg from "./data/plan_frlg.ts";

export type Plan = Record<string, any>;

// The modules src.import.gba.plans.<layout> that exist.
const PLANS: Record<string, Plan> = { frlg: planFrlg as Plan };

const modules: Record<string, { REQUIRED?: string[] } & Record<string, unknown>> = {};

// Lua: plans/registry.lua:13
function add(list: string[], seen: Set<string>, module: unknown): void {
  if (typeof module === "string" && module !== "" && !seen.has(module)) {
    seen.add(module);
    list.push(module);
  }
}

export const Plans = {
  // Lua: plans/registry.lua:5
  of(version: string): Plan {
    const layout = GameVersion.layout(version);
    if (typeof layout !== "string") {
      throw new Error("import plan: '" + String(version) + "' has no gba layout");
    }
    const plan = PLANS[layout];
    if (!plan) throw new Error(`module 'src.import.gba.plans.${layout}' not found`);
    return plan;
  },

  /** Lua's ipairs over a plan sequence (a JS array or an integer-keyed object). */
  list<T = any>(t: unknown): T[] {
    if (t === undefined || t === null || typeof t !== "object") return [];
    const n = luaLen(t as object);
    const out: T[] = [];
    for (let i = 1; i <= n; i++) out.push(luaGet(t as object, i) as T);
    return out;
  },

  // Lua: plans/registry.lua:20
  moduleFor(name: string): string {
    if (name.includes(".")) return name;
    return "src.import.gba." + name;
  },

  // Lua: plans/registry.lua:25
  modules(plan: Plan): string[] {
    const list: string[] = [], seen = new Set<string>();
    for (const task of Plans.list(plan.tasks)) {
      for (const step of Plans.list(task.steps)) {
        add(list, seen, Plans.moduleFor(step.name ?? step.module));
      }
    }
    for (const module of Plans.list<string>(plan.pokemonAfter)) add(list, seen, Plans.moduleFor(module));
    for (const entry of Plans.list(plan.aux)) add(list, seen, Plans.moduleFor(entry.name));
    return list;
  },

  /** Register a step module (its REQUIRED list) under its Lua module name. */
  register(moduleName: string, mod: { REQUIRED?: string[] } & Record<string, unknown>): void {
    modules[Plans.moduleFor(moduleName)] = mod;
  },

  // Lua: plans/registry.lua:38
  required(plan: Plan, cacheRoot: string): string[] {
    const out: string[] = [], seen = new Set<string>();
    for (const module of Plans.modules(plan)) {
      const mod = modules[module];
      if (!mod) throw new Error(`module '${module}' not found`);
      for (const rel of (typeof mod === "object" && mod.REQUIRED) || []) {
        let path = rel;
        if (!(/^data\//.test(rel) || /^assets\//.test(rel))) {
          path = cacheRoot + "/" + rel;
        }
        if (!seen.has(path)) {
          seen.add(path);
          out.push(path);
        }
      }
    }
    return out;
  },
};

export default Plans;
