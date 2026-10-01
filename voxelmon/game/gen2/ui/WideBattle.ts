// gen1recomp src/ui/gen2/WideBattle.lua (bdfac727, MIT): the 304x144
// widescreen battle layout (the field centred, the HUDs docked to the window).
//
// The Gold screen is 160x144, so BattleState:wideLayout() is false here and
// nothing reaches this module in play; it is ported for parity. Draws wider
// than the screen are clipped by the Gold screen like any other.

import { Chrome } from "./Chrome.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Playfield } from "../shared/render/Playfield.ts";
import G from "../platform/screen.ts";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Lua: WideBattle.lua:47
function battleIsTopState(battle: any): boolean {
  const stack = battle.game && battle.game.stack;
  return !(stack && stack.top) || stack.top() === battle;
}

// Lua: WideBattle.lua:81
function group(dx: number, dy: number, rect: Rect, fn: () => void): void {
  G.push("all");
  G.translate(dx, dy);
  Chrome.clipTo(rect.x, rect.y, rect.w, rect.h);
  try {
    fn();
  } finally {
    G.pop();
  }
}

export const WideBattle = {
  // Lua: WideBattle.lua:4-11
  WIDTH: 304,
  HEIGHT: 144,
  TILES_W: 38,
  TILES_H: 18,
  FIELD_X: 72,
  EXTRA_TILES: 18,
  // engine/battle/core.asm:4490
  TOP_HUD: { x: 0, y: 0, w: 96, h: 32 } as Rect,
  // engine/battle/core.asm:4352
  BOTTOM: { x: 0, y: 56, w: 304, h: 88 } as Rect,
  battleIsTopState,

  // Lua: WideBattle.lua:13
  fillScale(winW?: number, winH?: number): number {
    let w = winW ?? 0;
    let h = winH ?? 0;
    try {
      const rect = (Playfield as any).rect;
      if (typeof rect === "function") {
        const r = rect(winW, winH);
        const pw = r && r[2];
        const ph = r && r[3];
        if (pw && pw >= 1 && ph && ph >= 1) {
          w = pw;
          h = ph;
        }
      }
    } catch {
      // pcall
    }
    return Math.max(1, Math.min(w / WideBattle.WIDTH, h / WideBattle.HEIGHT));
  },

  // Lua: WideBattle.lua:29
  drawField(battle: any): boolean {
    Chrome.paletteFill(0, 0, WideBattle.WIDTH, WideBattle.HEIGHT);
    if (!battle.hasBattleSides()) {
      Chrome.printThrough(Strings.get("NO BATTLE"), 1, 1, Chrome.DEFAULT_BOX_PALETTE);
      return false;
    }
    G.push();
    G.translate(WideBattle.FIELD_X, 0);
    battle.drawSceneBody(() => {
      Chrome.clear();
      battle.drawPics();
    });
    G.pop();
    return true;
  },

  // Lua: WideBattle.lua:44
  drawTopHud(battle: any): void {
    // engine/battle/core.asm:4730
    battle.drawEnemyHud();
  },

  // Lua: WideBattle.lua:49
  drawBottomHud(battle: any): void {
    // engine/battle/core.asm:4592
    G.push();
    G.translate(WideBattle.EXTRA_TILES * 8, 0);
    battle.drawPlayerHud();
    G.pop();
    battle.drawBottom(WideBattle.EXTRA_TILES);
  },

  // Lua: WideBattle.lua:58
  drawSurface(battle: any): void {
    if (!WideBattle.drawField(battle)) return;
    WideBattle.drawTopHud(battle);
    WideBattle.drawBottomHud(battle);
  },

  // engine/battle/core.asm:7060
  // Lua: WideBattle.lua:72
  docked(battle: any): boolean {
    return battle.extendedHUD != null && battle.extendedHUD() === true && battleIsTopState(battle) && battle.phase !== "stats-box";
  },

  // Lua: WideBattle.lua:90
  dockOffsets(scale: number, oy: number, py: number, ph: number): [number, number] {
    return [Math.ceil((py - oy) / scale), Math.floor((py + ph - WideBattle.HEIGHT * scale - oy) / scale)];
  },

  // Lua: WideBattle.lua:95
  drawDocked(battle: any, scale: number, oy: number, py: number, ph: number): void {
    const [topY, bottomY] = WideBattle.dockOffsets(scale, oy, py, ph);
    const surface: Rect = { x: 0, y: 0, w: WideBattle.WIDTH, h: WideBattle.HEIGHT };
    let sides = false;
    group(0, 0, surface, () => {
      sides = WideBattle.drawField(battle);
    });
    if (!sides) return;
    group(0, topY, WideBattle.TOP_HUD, () => WideBattle.drawTopHud(battle));
    group(0, bottomY, WideBattle.BOTTOM, () => WideBattle.drawBottomHud(battle));
  },

  // Lua: WideBattle.lua:110
  draw(battle: any, winW: number, winH: number): void {
    Chrome.letterbox(winW, winH, 1, 1, 1);
    const scale: number = battle.battlePanelScale(winW, winH) ?? 1;
    const [ox, oy] = (Chrome.fitOriginFor as (...a: unknown[]) => [number, number])(winW, winH, scale, WideBattle.TILES_W, WideBattle.TILES_H);
    if (!WideBattle.docked(battle)) {
      G.push("all");
      Chrome.clipTo(ox, oy, WideBattle.WIDTH * scale, WideBattle.HEIGHT * scale);
      G.translate(ox, oy);
      G.scale(scale, scale);
      battle.drawScene(() => WideBattle.drawSurface(battle));
      G.pop();
      return;
    }
    const [, py, , ph] = Chrome.playfieldRect();
    Chrome.paletteFill(ox, py, WideBattle.WIDTH * scale, ph);
    G.push("all");
    G.translate(ox, oy);
    G.scale(scale, scale);
    battle.drawScene(() => WideBattle.drawDocked(battle, scale, oy, py, ph));
    G.pop();
  },
};

export default WideBattle;
