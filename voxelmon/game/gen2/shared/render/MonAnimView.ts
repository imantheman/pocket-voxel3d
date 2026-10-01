// gen1recomp src/render/MonAnimView.lua (bdfac727): a MonAnim runner plus
// the sheet its frames are cut from.
// ../pokecrystal/engine/gfx/pic_animation.asm:79-89 AnimateFrontpic
//
// `frame()` returns [sheet, quad, size] for the current frame (or null for
// the base picture); callers G.draw(sheet, quad, x, y) it like the Lua.

import G, { type LcdImage, type Quad } from "../../platform/screen.ts";
import { Unown } from "../../core/Unown.ts";
import { Assets } from "./Assets.ts";
import { MonAnim, type MonAnimData } from "./MonAnim.ts";

export interface MonAnimViewOpts {
  /** Sprites.pic-style resolver: [path, trueColor]. */
  resolve?: (path: string) => [string | undefined, boolean] | string | undefined;
  staticReplaced?: boolean;
}

export class MonAnimView {
  runner: MonAnim;
  sheet: LcdImage;
  size: number;
  quads: Quad[] = [];
  trueColor: boolean;

  constructor(runner: MonAnim, sheet: LcdImage, size: number, trueColor: boolean) {
    this.runner = runner;
    this.sheet = sheet;
    this.size = size;
    this.trueColor = trueColor;
  }

  /** MonAnimView.lua:11 -- ../pokecrystal/engine/gfx/load_pics.asm:105-131 */
  static replaced(vanilla: unknown, resolved: unknown): boolean {
    if (typeof vanilla !== "string") return false;
    if (typeof resolved === "string" && resolved !== vanilla) return true;
    return Assets.resolve(vanilla) !== vanilla;
  }

  /** MonAnimView.lua:18 -- ../pokecrystal/engine/events/halloffame.asm:225-238 */
  static animData(def: any, mon?: any): MonAnimData | undefined {
    if (!def) return undefined;
    let data = def.anim;
    if (mon && mon.species === Unown.SPECIES && def.letters) {
      const entry = def.letters[Unown.name(Unown.monLetter(mon)) as string];
      if (entry && entry.anim) data = entry.anim;
    }
    return data;
  }

  /** MonAnimView.lua:29 -- ../pokecrystal/engine/gfx/load_pics.asm:132-158 */
  static start(
    def: any,
    mon: any,
    scene: string | undefined,
    imageFn: ((path: string) => LcdImage | null | undefined) | null | undefined,
    onCry?: (step: string) => void,
    opts?: MonAnimViewOpts,
  ): MonAnimView | null {
    const data = MonAnimView.animData(def, mon);
    if (!(data && data.tiles && imageFn)) return null;
    let path: unknown = data.sheet;
    let trueColor = false;
    if (opts && opts.resolve && typeof path === "string") {
      const r = opts.resolve(path);
      if (Array.isArray(r)) [path, trueColor] = r;
      else [path, trueColor] = [r, false];
      if (typeof path !== "string" || path === "") path = data.sheet;
    }
    if (opts && opts.staticReplaced && !MonAnimView.replaced(data.sheet, path)) return null;
    const sheet = imageFn(path as string);
    if (!sheet) return null;
    const runner = MonAnim.new(data, scene, onCry);
    if (!runner) return null;
    return new MonAnimView(runner, sheet, data.tiles * 8, !!trueColor);
  }

  /** MonAnimView.lua:54 */
  step(): boolean {
    this.runner.update();
    return this.runner.finished();
  }

  /** MonAnimView.lua:59 */
  finished(): boolean {
    return this.runner.finished();
  }

  /** MonAnimView.lua:61 */
  currentFrame(): number {
    return this.runner.currentFrame();
  }

  /** MonAnimView.lua:64 -- ../pokecrystal/engine/gfx/pic_animation.asm:431-435 */
  frame(): [LcdImage, Quad, number] | null {
    const frame = this.runner.currentFrame();
    if (frame <= 0) return null;
    let quad = this.quads[frame];
    if (!quad) {
      const [w, h] = this.sheet.getDimensions();
      if ((frame + 1) * this.size > h) return null;
      quad = G.newQuad(0, frame * this.size, this.size, this.size, w, h);
      this.quads[frame] = quad;
    }
    return [this.sheet, quad, this.size];
  }
}

export default MonAnimView;
