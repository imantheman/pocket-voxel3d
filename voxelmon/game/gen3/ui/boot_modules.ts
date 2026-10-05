// Port of gen1recomp src/ui/game3/boot_modules.lua (GPLv3 + additional terms; see LICENSE.md).
// A profile's custom boot chain (profile.boot: intro / title / main menu / new
// game screen modules on an RSE GBA machine). No FRLG profile has `boot`, so
// FireRed and LeafGreen always take boot.lua's own chain (`custom = false`);
// the custom chain is Emerald only and cannot load here (see load/newState).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Fs } from "../platform/fs.ts";
import { G } from "../platform/graphics.ts";
import { gsub } from "../platform/lpattern.ts";
import { tostring, truthy } from "../../../import/gen3/lua.ts";

const COMBO_PHASE = "title_combo";

const warned: Record<string, boolean> = {};

// Lua: boot_modules.lua:7
function warnOnce(key: string, msg: string): void {
  if (warned[key]) return;
  warned[key] = true;
  console.log("[game3/boot] " + msg); // print; Logger is not ported yet
}

const isTable = (v: unknown): boolean => typeof v === "object" && v !== null;

// Lua: boot_modules.lua:13
function resolve(profile: any): any {
  const b = isTable(profile) ? profile.boot : null;
  if (!isTable(b)) {
    return { custom: false };
  }
  return {
    custom: true,
    intro: b.intro,
    title: b.title,
    mainMenu: b.mainMenu,
    newGame: b.newGame,
    titleCombos: b.titleCombos ?? {},
    params: b,
  };
}

// Lua: boot_modules.lua:31
function load(name: unknown): any {
  if (typeof name !== "string") throw new Error("boot_modules: module path required");
  // NOT FAITHFUL: Emerald only. require(name) loads a Lua module by its path
  // at run time; there is no module loader here, and the only callers are
  // the custom (RSE profile) boot chain.
  throw new Error("NOT FAITHFUL: Emerald only: boot module " + name);
}

// Lua: boot_modules.lua:36
function available(name: unknown): boolean {
  if (typeof name !== "string") return false;
  // NOT FAITHFUL: no Lua package system, so package.loaded[name] and
  // package.searchpath(name, package.path) are always nil; only the
  // love.filesystem probe remains.
  return Fs.getInfo(gsub(name, "%.", "/")[0] + ".lua") != null || false;
}

// The RSE GBA machine (src.ui.game3.rse.gba_machine).
function rseMachine(): any {
  // NOT FAITHFUL: Emerald only. src/ui/game3/rse/ is not ported (and has no stub).
  throw new Error("NOT FAITHFUL: Emerald only: src.ui.game3.rse.gba_machine");
}

// Lua: boot_modules.lua:43
function newState(Boot: any, mods: any, game: any): any {
  const Machine = rseMachine();
  return {
    phase: Boot.PHASE.INTRO,
    timer: 0,
    blink: 0,
    menuIndex: 1,
    hasContinue: false,
    custom: {
      mods,
      machine: Machine.new(),
      coldBoot: true,
      game,
    },
  };
}

// Lua: boot_modules.lua:60
function ctxOf(Boot: any, state: any): any {
  const c = state.custom;
  return { machine: c.machine, params: c.mods.params, boot: Boot, state, game: c.game };
}

// Lua: boot_modules.lua:65
function destroy(obj: any): void {
  if (obj && obj.destroy) obj.destroy();
}

// Lua: boot_modules.lua:69
function drop(c: any): void {
  destroy(c.intro);
  destroy(c.title);
  destroy(c.menu);
  destroy(c.newGame);
  destroy(c.combo);
  c.intro = null; c.title = null; c.menu = null; c.newGame = null; c.combo = null;
}

// Lua: boot_modules.lua:78
function startIntro(Boot: any, state: any): void {
  const c = state.custom;
  drop(c);
  const M = BootModules.load(c.mods.intro);
  c.intro = M.new(c.machine, { coldBoot: c.coldBoot, params: c.mods.params.introParams });
  c.coldBoot = false;
  state.phase = Boot.PHASE.INTRO;
  state.timer = 0;
}

// Lua: boot_modules.lua:88
function enterTitle(Boot: any, state: any): void {
  const c = state.custom;
  drop(c);
  const M = BootModules.load(c.mods.title);
  c.title = M.new(c.machine, {
    params: c.mods.params.titleParams,
    canResetRtc: c.mods.params.canResetRtc ? (() => {
      return BootModules.load(c.mods.params.canResetRtc).canResetRtc(state) === true;
    }) : null,
  });
  state.phase = Boot.PHASE.TITLE;
  state.timer = 0;
}

// Lua: boot_modules.lua:102
function startMenu(Boot: any, state: any): void {
  const c = state.custom;
  drop(c);
  const M = BootModules.load(c.mods.mainMenu);
  c.menu = M.new(state, ctxOf(Boot, state));
  state.phase = Boot.PHASE.MENU;
  state.timer = 0;
}

// Lua: boot_modules.lua:111
function startNewGame(Boot: any, state: any): void {
  const c = state.custom;
  drop(c);
  const M = BootModules.load(c.mods.newGame);
  c.newGame = M.new(state, ctxOf(Boot, state));
  state.phase = Boot.PHASE.OAK;
  state.timer = 0;
}

// Lua: boot_modules.lua:120
function startCombo(Boot: any, state: any, name: any): void {
  const c = state.custom;
  const path = c.mods.titleCombos[name];
  if (!BootModules.available(path)) {
    warnOnce("combo:" + tostring(name), "title combo " + tostring(name) + " has no screen module; back to title");
    BootModules.enterTitle(Boot, state);
    return;
  }
  drop(c);
  c.combo = BootModules.load(path).new(state, ctxOf(Boot, state));
  state.phase = BootModules.COMBO_PHASE;
  state.timer = 0;
}

// Lua: boot_modules.lua:134
function route(Boot: any, state: any, r: any): any {
  if (r == null) return null;
  if (r === "title") {
    BootModules.enterTitle(Boot, state);
  } else if (r === "copyright" || r === "intro") {
    BootModules.startIntro(Boot, state);
  } else if (r === "menu") {
    BootModules.startMenu(Boot, state);
  } else if (r === "newGame") {
    BootModules.startNewGame(Boot, state);
  } else if (isTable(r) && truthy(r.combo)) {
    BootModules.startCombo(Boot, state, r.combo);
  } else if (isTable(r)) {
    return r;
  }
  return null;
}

// Lua: boot_modules.lua:152
function update(Boot: any, state: any, input: any, dt?: number): any {
  dt = dt ?? (1 / 60);
  state.timer = (state.timer ?? 0) + dt;
  state.blink = (state.blink ?? 0) + dt;
  const c = state.custom;
  if (state.phase === Boot.PHASE.INTRO) {
    if (!c.intro) BootModules.startIntro(Boot, state);
    return route(Boot, state, c.intro.update(input, dt));
  } else if (state.phase === Boot.PHASE.TITLE || state.phase === Boot.PHASE.TITLE_CRY
      || state.phase === Boot.PHASE.TITLE_RESTART) {
    if (!c.title) BootModules.enterTitle(Boot, state);
    return route(Boot, state, c.title.update(input, dt));
  } else if (state.phase === Boot.PHASE.MENU) {
    if (!c.menu) BootModules.startMenu(Boot, state);
    return route(Boot, state, c.menu.update(input, dt));
  } else if (state.phase === BootModules.COMBO_PHASE) {
    return route(Boot, state, c.combo.update(input, dt));
  } else if (c.newGame) {
    return route(Boot, state, c.newGame.update(input, dt));
  }
  return null;
}

// Lua: boot_modules.lua:175
function active(state: any): any {
  const c = state.custom;
  return c.intro || c.title || c.menu || c.newGame || c.combo;
}

// Lua: boot_modules.lua:180
function draw(_Boot: any, state: any): void {
  G.clear(0, 0, 0, 1);
  const obj = BootModules.active(state);
  if (obj && obj.draw) obj.draw();
}

export const BootModules = {
  COMBO_PHASE,
  resolve,
  // Lua: boot_modules.lua:29 (BootModules["for"] = BootModules.resolve)
  for: resolve,
  load,
  available,
  newState,
  startIntro,
  enterTitle,
  startMenu,
  startNewGame,
  startCombo,
  update,
  active,
  draw,
};

export default BootModules;
