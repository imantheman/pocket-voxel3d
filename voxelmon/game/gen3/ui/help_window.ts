// Port of gen1recomp src/ui/game3/help_window.lua (GPLv3 + additional terms; see LICENSE.md).
// src/new_menu_helpers.c:701-705, src/new_menu_helpers.c:707-710, src/help_message.c:23-31, src/help_message.c:13-19, src/start_menu.c:332, src/help_system.c

import { Window, type WindowTemplate } from "./window.ts";

let open = false;
let text = "";

// Lua: help_window.lua:16
function contentTemplate(): WindowTemplate {
  const c = HelpWindow.CONTENT;
  return Window.template(c.left, c.top, c.width, c.height,
    { paletteNum: HelpWindow.OUTER.paletteNum });
}

export const HelpWindow = {
  // src/help_message.c:13-19
  OUTER: { left: 0, top: 15, width: 30, height: 5, paletteNum: 15 },
  CONTENT: { left: 1, top: 16, width: 28, height: 3 },
  // src/help_message.c:95-98
  TEXT_OFFSET: { x: 2, y: 5 },

  // Lua: help_window.lua:22
  show(value: unknown): boolean {
    text = typeof value === "string" ? value : "";
    open = true;
    return true;
  },

  // Lua: help_window.lua:28
  close(): boolean {
    open = false;
    text = "";
    return true;
  },

  // Lua: help_window.lua:34
  isOpen(): boolean {
    return open;
  },

  // Lua: help_window.lua:38
  getText(): string {
    return text;
  },

  // Lua: help_window.lua:42
  draw(): boolean {
    if (!open) return false;
    const tpl = contentTemplate();
    // src/help_message.c:41
    Window.fill(tpl, 1, 1, 1, 1);
    Window.stdFrame(tpl);
    if (text !== "") {
      const c = HelpWindow.CONTENT;
      const off = HelpWindow.TEXT_OFFSET;
      Window.printPx(text, c.left * 8 + off.x, c.top * 8 + off.y, {
        maxWidth: c.width * 8 - off.x * 2,
      });
    }
    return true;
  },

  // Lua: help_window.lua:58
  reset(): void {
    HelpWindow.close();
  },
};

export default HelpWindow;
