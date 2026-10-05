// Port of gen1recomp src/ui/game3/screens.lua (GPLv3 + additional terms; see LICENSE.md).
// Screen modules by id (the profile's ui block may swap a screen or skin it).
//
// Lua `require(p)` takes a module path string; here the paths name entries
// of MODULES, a static table of the runtime's screen modules (their default
// exports, what `require` returns).

import { insert, ipairs, len, pairs, seq, sort, type LuaTable } from "../platform/lt.ts";
import { Profile } from "../core/profile.ts";
import { RomText } from "../core/rom_text.ts";
import { Flags } from "../core/scripting/flags.ts";
import { Stack } from "./stack.ts";
import * as start_menu from "./start_menu.ts";
import * as bag_menu from "./bag_menu.ts";
import * as party_menu from "./party_menu.ts";
import * as summary_menu from "./summary_menu.ts";
import * as pokedex from "./pokedex.ts";
import * as region_map from "./region_map.ts";
import * as option_menu from "./option_menu.ts";
import * as save_menu from "./save_menu.ts";
import * as trainer_card from "./trainer_card.ts";
import * as pc_menu from "./pc_menu.ts";
import * as shop_menu from "./shop_menu.ts";
import * as naming from "./naming.ts";

/** `require(path)` for the screen modules this file names. Built on first
 *  use: the screen modules are in the import cycle. */
let modules: Record<string, { default: unknown }> | undefined;
function MODULES(): Record<string, { default: unknown }> {
  return (modules ??= {
    "src.ui.game3.start_menu": start_menu,
    "src.ui.game3.bag_menu": bag_menu,
    "src.ui.game3.party_menu": party_menu,
    "src.ui.game3.summary_menu": summary_menu,
    "src.ui.game3.pokedex": pokedex,
    "src.ui.game3.region_map": region_map,
    "src.ui.game3.option_menu": option_menu,
    "src.ui.game3.save_menu": save_menu,
    "src.ui.game3.trainer_card": trainer_card,
    "src.ui.game3.pc_menu": pc_menu,
    "src.ui.game3.shop_menu": shop_menu,
    "src.ui.game3.naming": naming,
  });
}

function requireScreen(p: string): any {
  const mods = MODULES();
  const m = Object.prototype.hasOwnProperty.call(mods, p) ? mods[p] : undefined;
  // NOT FAITHFUL: src.ui.game3.controls_menu (desktop key bindings) and any
  // module outside MODULES is not in the port; Lua's require would raise too
  if (!m) throw new Error("module '" + p + "' not found");
  return m.default;
}

// Lua: screens.lua:21
function uiBlock(session: unknown): LuaTable | undefined {
  let row: unknown;
  try { row = Profile.forSession(session); } catch { return undefined; }
  if (row === null || typeof row !== "object") return undefined;
  const ui = (row as LuaTable).ui;
  return ui !== null && typeof ui === "object" ? ui : undefined;
}

export const Screens = {
  DEFAULT: {
    start_menu: "src.ui.game3.start_menu",
    bag: "src.ui.game3.bag_menu",
    party: "src.ui.game3.party_menu",
    summary: "src.ui.game3.summary_menu",
    pokedex: "src.ui.game3.pokedex",
    region_map: "src.ui.game3.region_map",
    option: "src.ui.game3.option_menu",
    save: "src.ui.game3.save_menu",
    trainer_card: "src.ui.game3.trainer_card",
    pc: "src.ui.game3.pc_menu",
    shop: "src.ui.game3.shop_menu",
    naming: "src.ui.game3.naming",
    controls: "src.ui.game3.controls_menu",
  } as Record<string, string>,

  // Lua: screens.lua:29
  path(id: string, session?: unknown): string | undefined {
    const ui = uiBlock(session);
    const p = ui && ui.screens ? ui.screens[id] : undefined;
    return p ?? (Object.prototype.hasOwnProperty.call(Screens.DEFAULT, id) ? Screens.DEFAULT[id] : undefined);
  },

  // Lua: screens.lua:35
  get(id: string, session?: unknown): any {
    const p = Screens.path(id, session);
    if (!p) return undefined;
    return requireScreen(p);
  },

  // Lua: screens.lua:41
  redirect(id: string, self: unknown, session?: unknown): any {
    const p = Screens.path(id, session);
    if (!p || p === Screens.DEFAULT[id]) return undefined;
    const mod = requireScreen(p);
    if (mod === self) return undefined;
    return mod;
  },

  // Lua: screens.lua:49
  skin(id: string, session?: unknown): any {
    const ui = uiBlock(session);
    const p = ui && ui.skins ? ui.skins[id] : undefined;
    if (!p) return undefined;
    return requireScreen(p);
  },

  // Lua: screens.lua:56
  draw(id: string | undefined, mod: any, session?: unknown): unknown {
    const skin = id ? Screens.skin(id, session) : undefined;
    if (skin && skin.draw) return skin.draw(mod);
    if (mod && mod.draw) return mod.draw();
    return undefined;
  },

  // Lua: screens.lua:62
  handleInput(id: string | undefined, mod: any, input: unknown, session?: unknown): unknown {
    const skin = id ? Screens.skin(id, session) : undefined;
    if (skin && skin.handleInput) return skin.handleInput(input, mod);
    if (mod && mod.handleInput) return mod.handleInput(input);
    return undefined;
  },

  /** Lua returns fn's results; here fn's (single) return value. */
  // Lua: screens.lua:68
  withTextAliases<R>(session: unknown, fn: (...a: any[]) => R, ...args: any[]): R {
    const ui = uiBlock(session);
    const aliases = ui ? ui.textAliases : undefined;
    if (!aliases) return fn(...args);
    const set: (string | null)[] = seq();
    for (const [from, to] of pairs(aliases)) {
      if (RomText.overrides[from] == null && !RomText.has(from as string) && RomText.has(to as string)) {
        RomText.overrides[from] = RomText.ir(to as string);
        set[len(set) + 1] = from as string;
      }
    }
    let ok = true, result: R | undefined, err: unknown;
    try { result = fn(...args); } catch (e) { ok = false; err = e; }
    for (const [, k] of ipairs<string>(set)) RomText.overrides[k] = undefined;
    if (!ok) throw err;
    return result as R;
  },

  // Lua: screens.lua:86
  flags(session?: unknown): LuaTable {
    let t: unknown;
    let ok = true;
    try { t = Flags.active(session); } catch { ok = false; }
    if (ok && t !== null && typeof t === "object") return t;
    return { IDS: Flags.IDS, VAR_IDS: Flags.VAR_IDS };
  },

  // Lua: screens.lua:93
  openFlag(id: string): () => boolean {
    return () => Stack.has(id);
  },

  // Lua: screens.lua:97
  all(session?: unknown): (string | null)[] {
    const seen: Record<string, boolean> = {};
    const out: (string | null)[] = seq();
    const add = (p: unknown): void => {
      if (typeof p === "string" && !seen[p]) {
        seen[p] = true;
        insert(out, p);
      }
    };
    for (const [, p] of pairs(Screens.DEFAULT)) add(p);
    const ui = uiBlock(session);
    for (const [, p] of pairs(ui && ui.screens ? ui.screens : {})) add(p);
    for (const [, p] of pairs(ui && ui.skins ? ui.skins : {})) add(p);
    sort(out);
    return out;
  },
};

export default Screens;
