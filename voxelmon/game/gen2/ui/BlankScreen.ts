// gen1recomp src/ui/gen2/BlankScreen.lua (bdfac727): ClearBGPalettes
// (home/tilemap.asm:1), the white hold every full-screen page opens and
// closes with: _FlyMap (engine/pokegear/pokegear.asm:1979) and ExitAllMenus
// (home/map.asm:2282).

import G from "../platform/screen.ts";
import { Chrome } from "./Chrome.ts";

export class BlankScreen {
  static isOpaque = true;
  /** Lua: BlankScreen.lua:12 -- WaitBGMap's `ld c, 4 / call DelayFrames` (home/tilemap.asm:3) */
  static FRAMES = 4;

  isOpaque = true;
  game: any;
  left: number;
  onDone: (() => void) | null | undefined;

  constructor(game: any, opts: { frames?: number; onDone?: () => void } = {}) {
    this.game = game;
    this.left = opts.frames ?? BlankScreen.FRAMES;
    this.onDone = opts.onDone;
  }

  /** Lua: BlankScreen.lua:14 */
  static new(game: any, opts?: { frames?: number; onDone?: () => void }): BlankScreen {
    return new BlankScreen(game, opts ?? {});
  }

  /** Lua: BlankScreen.lua:23 */
  drawsWidescreen(): boolean {
    return true;
  }

  /** Lua: BlankScreen.lua:25 */
  draw(): void {
    G.setColor(1, 1, 1, 1);
    G.rectangle("fill", 0, 0, Chrome.SCREEN_W * 8, Chrome.SCREEN_H * 8);
  }

  /** Lua: BlankScreen.lua:31 -- the Gold screen is the panel: no letterbox or fit. */
  drawWidescreen(_winW: number, _winH: number): void {
    this.draw();
  }

  /** Lua: BlankScreen.lua:42 */
  update(): void {
    this.left -= 1;
    if (this.left > 0) return;
    const done = this.onDone;
    this.onDone = null;
    if (done) done();
  }
}

export default BlankScreen;
