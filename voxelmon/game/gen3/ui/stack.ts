// Port of gen1recomp src/ui/game3/stack.lua (GPLv3 + additional terms; see LICENSE.md).
// Modal UI stack for game3 (pret start-menu / submenu layering).
// Top of stack receives input; lower layers stay open but are not drawn
// unless drawUnder is set (rare — default hides under full-screen menus).

import { insert, ipairs, len, remove, seq, type LuaTable } from "../platform/lt.ts";
import { Message } from "./message.ts";

export interface Layer {
  id: string;
  mod: LuaTable;
  isMenu: boolean;
  drawUnder: boolean;
  hideBelow: boolean;
  fullscreen: unknown;
}

export interface PushOpts { isMenu?: boolean; hideBelow?: boolean; drawUnder?: boolean; fullscreen?: unknown }

export const Stack = {
  _layers: seq() as (Layer | null)[],

  // Lua: stack.lua:9
  clear(): void {
    Stack._layers = seq();
  },

  // Lua: stack.lua:13
  depth(): number {
    return len(Stack._layers);
  },

  // Lua: stack.lua:17
  top(): Layer | undefined {
    const n = len(Stack._layers);
    if (n < 1) return undefined;
    return Stack._layers[n]!;
  },

  /**
   * Push a layer. id is a stable string; mod is the menu module table.
   * opts.drawUnder: if true, still draw layers below this one.
   */
  // Lua: stack.lua:25
  push(id: string, mod: LuaTable, opts?: PushOpts): void {
    opts = opts || {};
    let isMenu = opts.isMenu;
    if (isMenu == null) isMenu = mod ? mod.isMenu : undefined;
    if (opts.hideBelow !== false) {
      // package.loaded["src.ui.game3.message"]
      if (Message && Message.closeStay) Message.closeStay();
    }
    // Replace existing same-id layer (re-open).
    for (let i = len(Stack._layers); i >= 1; i--) {
      if (Stack._layers[i]!.id === id) {
        remove(Stack._layers, i);
      }
    }
    insert(Stack._layers, {
      id,
      mod,
      isMenu: isMenu === true,
      drawUnder: opts.drawUnder ? true : false,
      hideBelow: opts.hideBelow !== false, // default hide layers underneath
      fullscreen: opts.fullscreen,
    });
  },

  // Lua: stack.lua:50
  pop(id?: string): boolean {
    if (id) {
      for (let i = len(Stack._layers); i >= 1; i--) {
        if (Stack._layers[i]!.id === id) {
          remove(Stack._layers, i);
          return true;
        }
      }
      return false;
    }
    if (len(Stack._layers) < 1) return false;
    remove(Stack._layers);
    return true;
  },

  // Lua: stack.lua:65
  has(id: string): boolean {
    for (const [, layer] of ipairs<Layer>(Stack._layers)) {
      if (layer.id === id) return true;
    }
    return false;
  },

  /** Layers to draw bottom→top (respecting hideBelow on higher layers). */
  // Lua: stack.lua:73
  drawOrder(): (Layer | null)[] {
    const layers = Stack._layers;
    const n = len(layers);
    if (n < 1) return seq();
    let first = 1;
    for (let i = n; i >= 1; i--) {
      if (layers[i]!.hideBelow && i > 1) {
        first = i;
        break;
      }
    }
    // If top has drawUnder, include below anyway.
    if (layers[n]!.drawUnder) {
      first = 1;
    }
    const out: (Layer | null)[] = seq();
    for (let i = first; i <= n; i++) {
      out[len(out) + 1] = layers[i]!;
    }
    return out;
  },

  // Lua: stack.lua:96
  busy(): boolean {
    return len(Stack._layers) > 0;
  },

  // Lua: stack.lua:100
  fullscreen(): boolean {
    for (const [, layer] of ipairs<Layer>(Stack.drawOrder())) {
      let f = layer.fullscreen;
      if (typeof f === "function") f = f();
      if (f != null && f !== false) return true;
    }
    return false;
  },
};

export default Stack;
