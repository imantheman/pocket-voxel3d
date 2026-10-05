// Port of gen1recomp src/core/game3/options.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG options mirrored into game3 session (option_menu.c fields used on field).

import { tonumber, truthy } from "../../../import/gen3/lua.ts";
import { ipairs, pairs, seq } from "../platform/lt.ts";
import { Profile } from "./profile.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface OptionsBlock {
  textSpeed?: any;
  battleScene?: any;
  battleStyle?: any;
  sound?: any;
  buttonMode?: any;
  frameType?: any;
  voidFill?: any;
  text_speed?: any;
  l_equals_a?: any;
  [k: string]: any;
}

const CART_KEYS = seq(
  "textSpeed", "battleScene", "battleStyle", "sound", "buttonMode", "frameType",
);

function isTable(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === "object";
}

/** Lua type() names for the values option blocks hold. */
function luaType(v: unknown): string {
  if (v == null) return "nil";
  if (typeof v === "object") return "table";
  return typeof v;
}

// Lua: options.lua:20
function fill_defaults(o: OptionsBlock): OptionsBlock {
  for (const [k, v] of pairs(Options.DEFAULTS)) {
    if (o[k] == null) o[k] = v;
  }
  return o;
}

// Lua: options.lua:31
function migrate_root(engine: any, o: OptionsBlock): void {
  if (typeof engine.battleStyle !== "number") return;
  for (const [, k] of ipairs<string>(CART_KEYS)) {
    if (luaType(engine[k]) === luaType((Options.DEFAULTS as any)[k]) && o[k] == null) {
      o[k] = engine[k];
    }
    delete engine[k];
  }
  delete engine.text_speed;
  delete engine.l_equals_a;
}

export const Options = {
  BLOCK: Profile.FALLBACK_ID,

  // pret: textSpeed 0=SLOW 1=MID 2=FAST
  DEFAULTS: {
    textSpeed: 1,
    battleScene: 0,   // 0=ON 1=OFF
    battleStyle: 0,   // 0=SHIFT 1=SET
    sound: 0,         // 0=MONO 1=STEREO
    buttonMode: 0,    // 0=HELP 1=LR 2=L=A
    frameType: 0,
    voidFill: "map",
  } as OptionsBlock,

  // Lua: options.lua:43
  block(engine: any, blockId?: string | null): OptionsBlock {
    if (!isTable(engine)) return fill_defaults({});
    blockId = blockId ?? Profile.active().optionsBlock;
    let o = engine[blockId as string];
    if (!isTable(o)) {
      o = {};
      engine[blockId as string] = o;
      migrate_root(engine, o);
    }
    return fill_defaults(o);
  },

  // Lua: options.lua:55
  blockId(session: any): string {
    if (isTable(session) && typeof session.version === "string") {
      return Profile.of(session.version).optionsBlock;
    }
    return Profile.active().optionsBlock;
  },

  // Lua: options.lua:62
  bind(session: any, engine: any): OptionsBlock | undefined {
    if (!isTable(session)) return undefined;
    if (!isTable(engine)) return Options.ensure(session);
    const o = Options.block(engine, Options.blockId(session));
    session.options = o;
    session.engineOptions = engine;
    o.text_speed = o.textSpeed;
    o.l_equals_a = (tonumber(o.buttonMode) === 2);
    return o;
  },

  // Lua: options.lua:73
  engine(session: any): any {
    const e = isTable(session) && session.engineOptions;
    if (isTable(e)) return e;
    return undefined;
  },

  // Lua: options.lua:79
  ensure(session?: any): OptionsBlock {
    session = session ?? {};
    let o = session.options;
    if (!isTable(o)) {
      o = {};
      session.options = o;
    }
    const blockId = Options.blockId(session);
    if (isTable(o[blockId])) {
      session.engineOptions = o;
      o = Options.block(o, blockId);
      session.options = o;
    }
    return fill_defaults(o);
  },

  // Lua: options.lua:95
  textSpeed(session?: any): number {
    const o = Options.ensure(session);
    // Canonical field is textSpeed; text_speed is a schema alias.
    let n = tonumber(o.textSpeed);
    if (n == null) n = tonumber(o.text_speed);
    n = n ?? 1;
    if (n < 0) n = 0;
    if (n > 2) n = 2;
    return n;
  },

  // Lua: options.lua:106
  lEqualsA(session?: any): boolean {
    const o = Options.ensure(session);
    if (o.l_equals_a != null) return truthy(o.l_equals_a);
    return tonumber(o.buttonMode) === 2;
  },

  // Lua: options.lua:113
  // src/menu_helpers.c:72
  lrMode(session?: any): boolean {
    const o = Options.ensure(session);
    return tonumber(o.buttonMode) === 1;
  },

  // Lua: options.lua:119
  // pokefirered/src/battle_main.c
  battleStyle(session?: any): "set" | "shift" {
    const o = Options.ensure(session);
    return tonumber(o.battleStyle) === 1 ? "set" : "shift";
  },

  // Lua: options.lua:125
  // pokefirered/src/option_menu.c
  battleScene(session?: any): boolean {
    const o = Options.ensure(session);
    return tonumber(o.battleScene) !== 1;
  },

  // Lua: options.lua:130
  frameType(session?: any): number {
    const o = Options.ensure(session);
    return tonumber(o.frameType) ?? 0;
  },

  // Lua: options.lua:135
  mono(session?: any): boolean {
    const o = Options.ensure(session);
    return tonumber(o.sound) === 0;
  },

  // Lua: options.lua:140
  voidFill(session?: any): string {
    const o = Options.ensure(session);
    const v = o.voidFill;
    if (v === "trees" || v === "water" || v === "black") return v;
    return "map";
  },

  // Lua: options.lua:147
  set(session: any, key: string, value: any): OptionsBlock {
    const o = Options.ensure(session);
    o[key] = value;
    if (key === "textSpeed" || key === "text_speed") {
      o.textSpeed = value;
      o.text_speed = value;
    }
    if (key === "buttonMode") {
      o.l_equals_a = (tonumber(value) === 2);
    }
    if (key === "l_equals_a") {
      o.buttonMode = truthy(value) ? 2 : 0;
    }
    return o;
  },
};

export default Options;
